"""
Reconciliation Service — orchestrates the full pipeline:
1. File hashing + intake
2. Cleaning (SAP + 26AS)
3. Validation
4. Global optimization (matching)
5. Exception generation
6. DB persistence
7. Audit logging
8. Excel output generation
"""
from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, List, Tuple

import pandas as pd
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func

from core.settings import settings
from core.security import sha256_file
from core.audit import log_event, log_sync
from db.models import (
    ReconciliationRun, MatchedPair, Unmatched26AS, UnmatchedBook,
    ExceptionRecord, RunCounter, User
)
from engine.validator import validate_26as, validate_sap_books, compute_control_totals
from engine.exception_engine import generate_exceptions
from engine.optimizer import (
    run_global_optimizer, BookEntry, As26Entry, AssignmentResult
)
from config import (
    ALLOW_CROSS_FY, DEFAULT_FINANCIAL_YEAR,
    fy_date_range, sap_date_window, date_to_fy_label,
    MAX_COMBO_SIZE, VARIANCE_CAP_SINGLE, VARIANCE_CAP_COMBO,
    VARIANCE_CAP_FORCE_SINGLE, FORCE_COMBO_MAX_INVOICES,
)

# Import existing v1.0 parsers (reused)
import sys
sys.path.insert(0, str(Path(__file__).parent.parent))
from cleaner import clean_sap_books
from parser_26as import parse_26as

UPLOAD_DIR = Path(settings.UPLOAD_DIR)
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


async def _next_run_number(db: AsyncSession) -> int:
    """Atomic monotonic run counter."""
    result = await db.execute(select(RunCounter).where(RunCounter.id == 1))
    counter = result.scalar_one_or_none()
    if not counter:
        counter = RunCounter(id=1, current_value=0)
        db.add(counter)
    counter.current_value += 1
    await db.flush()
    return counter.current_value


def _config_snapshot() -> dict:
    """Capture current config state for reproducibility."""
    return {
        "algorithm_version": settings.ALGORITHM_VERSION,
        "ALLOW_CROSS_FY": ALLOW_CROSS_FY,
        "MAX_COMBO_SIZE": MAX_COMBO_SIZE,
        "VARIANCE_CAP_SINGLE": VARIANCE_CAP_SINGLE,
        "VARIANCE_CAP_COMBO": VARIANCE_CAP_COMBO,
        "VARIANCE_CAP_FORCE_SINGLE": VARIANCE_CAP_FORCE_SINGLE,
        "FORCE_COMBO_MAX_INVOICES": FORCE_COMBO_MAX_INVOICES,
        "captured_at": datetime.now(timezone.utc).isoformat(),
    }


async def run_reconciliation(
    db: AsyncSession,
    current_user: User,
    sap_bytes: bytes,
    as26_bytes: bytes,
    sap_filename: str,
    as26_filename: str,
    financial_year: str = DEFAULT_FINANCIAL_YEAR,
    batch_id: Optional[str] = None,
    deductor_filter_parties: Optional[List[dict]] = None,
) -> ReconciliationRun:
    """
    deductor_filter_parties: list of {deductor_name, tan} dicts.
    When provided (batch mode), 26AS is filtered to only those parties
    before matching — supporting multi-TAN / same-PAN scenarios.
    """
    """
    Full reconciliation pipeline. Returns the persisted ReconciliationRun.
    """
    started_at = datetime.now(timezone.utc)

    # ── 1. File integrity hashing ─────────────────────────────────────────────
    sap_hash = sha256_file(sap_bytes)
    as26_hash = sha256_file(as26_bytes)
    run_num = await _next_run_number(db)

    # ── 2. Create run record ──────────────────────────────────────────────────
    run = ReconciliationRun(
        run_number=run_num,
        financial_year=financial_year,
        sap_filename=sap_filename,
        as26_filename=as26_filename,
        sap_file_hash=sap_hash,
        as26_file_hash=as26_hash,
        algorithm_version=settings.ALGORITHM_VERSION,
        config_snapshot=_config_snapshot(),
        status="PROCESSING",
        mode="BATCH" if batch_id else "SINGLE",
        batch_id=batch_id,
        created_by_id=current_user.id,
        started_at=started_at,
    )
    db.add(run)
    await db.flush()  # Get run.id

    await log_event(db, "RUN_STARTED",
                    f"Run RUN-{run_num:04d} started for FY {financial_year}",
                    run_id=run.id, user_id=current_user.id,
                    metadata={"sap_hash": sap_hash, "as26_hash": as26_hash})

    try:
        fy_start, fy_end = fy_date_range(financial_year)
        sap_start, sap_end = sap_date_window(financial_year)

        # ── 3. Parse and clean SAP ────────────────────────────────────────────
        clean_df, cleaning_report = clean_sap_books(
            sap_bytes, fy_start=sap_start, fy_end=sap_end
        )

        # ── 4. Parse and validate 26AS ────────────────────────────────────────
        as26_df = parse_26as(as26_bytes)

        # In batch mode, filter 26AS to selected parties (OR of all entries)
        if deductor_filter_parties and not as26_df.empty:
            import numpy as np
            mask = pd.Series([False] * len(as26_df), index=as26_df.index)
            for party in deductor_filter_parties:
                name = party.get("deductor_name", "")
                tan = party.get("tan", "")
                if name:
                    mask = mask | (as26_df["deductor_name"] == name)
                elif tan:
                    mask = mask | (as26_df["tan"] == tan)
            as26_df = as26_df[mask].copy()

        validated_df, val_report = validate_26as(as26_df)

        # SAP book validation (light)
        clean_df, sap_issues = validate_sap_books(clean_df)

        # ── 5. Build entry objects ────────────────────────────────────────────
        book_entries = _df_to_book_entries(clean_df)
        as26_entries = _df_to_as26_entries(validated_df[validated_df["_valid"] == True])

        # FY segregation
        target_fy = financial_year
        current_books = [b for b in book_entries if b.sap_fy == target_fy or not b.sap_fy]
        prior_books = [b for b in book_entries if b.sap_fy and b.sap_fy != target_fy]

        total_26as_amount = float(validated_df[validated_df["_valid"] == True]["amount"].sum())

        # ── 6. Run global optimizer ───────────────────────────────────────────
        matched_results, unmatched_entries = run_global_optimizer(
            as26_entries=as26_entries,
            book_pool=book_entries,
            current_books=current_books,
            prior_books=prior_books,
            allow_cross_fy=ALLOW_CROSS_FY,
        )

        # ── 7. Compute metrics ────────────────────────────────────────────────
        matched_amount = sum(r.as26_amount for r in matched_results)
        unmatched_amount = sum(e.amount for e in unmatched_entries)
        control_totals = compute_control_totals(total_26as_amount, matched_amount, unmatched_amount)

        match_rate = (len(matched_results) / len(as26_entries) * 100) if as26_entries else 0.0
        high_conf = sum(1 for r in matched_results if r.confidence == "HIGH")
        med_conf = sum(1 for r in matched_results if r.confidence == "MEDIUM")
        low_conf = sum(1 for r in matched_results if r.confidence == "LOW")

        # ── 8. Persist matched pairs ──────────────────────────────────────────
        deductor_name = ""
        tan = ""
        if deductor_filter_parties and len(deductor_filter_parties) > 1:
            names = [p["deductor_name"] for p in deductor_filter_parties if p.get("deductor_name")]
            deductor_name = " + ".join(names)
            tan = deductor_filter_parties[0].get("tan", "")
        elif as26_entries:
            deductor_name = as26_entries[0].deductor_name
            tan = as26_entries[0].tan

        for result in matched_results:
            score_d = result.score.to_dict()
            mp = MatchedPair(
                run_id=run.id,
                as26_row_hash=_hash_as26_entry(result),
                as26_amount=result.as26_amount,
                as26_date=result.as26_date,
                section=result.as26_section,
                tan=tan,
                deductor_name=deductor_name,
                invoice_refs=[b.invoice_ref for b in result.books],
                invoice_amounts=[b.amount for b in result.books],
                invoice_dates=[b.doc_date for b in result.books],
                clearing_doc=result.books[0].clearing_doc if result.books else None,
                books_sum=sum(b.amount for b in result.books),
                match_type=result.match_type,
                variance_amt=result.variance_amt,
                variance_pct=result.variance_pct,
                confidence=result.confidence,
                composite_score=score_d["composite_score"],
                score_variance=score_d["score_variance"],
                score_date_proximity=score_d["score_date_proximity"],
                score_section_match=score_d["score_section_match"],
                score_clearing_doc=score_d["score_clearing_doc"],
                score_historical=score_d["score_historical"],
                cross_fy=result.cross_fy,
                is_prior_year=result.is_prior_year,
            )
            db.add(mp)

        # ── 9. Persist unmatched ──────────────────────────────────────────────
        for entry in unmatched_entries:
            db.add(Unmatched26AS(
                run_id=run.id,
                as26_row_hash=_hash_as26_idx(entry.index),
                deductor_name=entry.deductor_name,
                tan=entry.tan,
                transaction_date=entry.transaction_date,
                amount=entry.amount,
                section=entry.section,
                reason_code="U02",
                reason_detail="No match found within variance ceiling",
            ))

        for b in book_entries:
            if not _book_was_matched(b.index, matched_results):
                db.add(UnmatchedBook(
                    run_id=run.id,
                    invoice_ref=b.invoice_ref,
                    amount=b.amount,
                    doc_date=b.doc_date,
                    doc_type=b.doc_type,
                    clearing_doc=b.clearing_doc,
                    flag=b.flag,
                    sap_fy=b.sap_fy,
                ))

        # ── 10. Generate exceptions ───────────────────────────────────────────
        exc_dicts = generate_exceptions(matched_results, unmatched_entries, val_report, run.id)
        for exc in exc_dicts:
            db.add(ExceptionRecord(**exc))

        # ── 11. Update run summary ────────────────────────────────────────────
        run.deductor_name = deductor_name
        run.tan = tan
        run.status = "PENDING_REVIEW" if exc_dicts else "APPROVED"
        run.total_26as_entries = len(as26_entries)
        run.total_sap_entries = len(book_entries)
        run.matched_count = len(matched_results)
        run.unmatched_26as_count = len(unmatched_entries)
        run.unmatched_books_count = len(book_entries) - sum(1 for r in matched_results for b in r.books)
        run.match_rate_pct = round(match_rate, 2)
        run.high_confidence_count = high_conf
        run.medium_confidence_count = med_conf
        run.low_confidence_count = low_conf
        run.total_26as_amount = total_26as_amount
        run.matched_amount = matched_amount
        run.unmatched_26as_amount = unmatched_amount
        run.control_total_balanced = control_totals["balanced"]
        run.validation_errors = val_report.to_dict() if val_report.issues else None
        run.has_pan_issues = val_report.pan_issues > 0
        run.has_rate_mismatches = val_report.rate_mismatches > 0
        run.has_duplicate_26as = val_report.duplicates_found > 0
        run.completed_at = datetime.now(timezone.utc)

        await log_event(db, "RUN_COMPLETED",
                        f"Run RUN-{run_num:04d} completed. "
                        f"Match rate: {match_rate:.1f}%. Exceptions: {len(exc_dicts)}",
                        run_id=run.id, user_id=current_user.id,
                        metadata={
                            "match_rate": match_rate,
                            "matched": len(matched_results),
                            "unmatched": len(unmatched_entries),
                            "exceptions": len(exc_dicts),
                            "control_balanced": control_totals["balanced"],
                        })

        return run

    except Exception as e:
        run.status = "FAILED"
        await log_event(db, "RUN_FAILED", f"Run failed: {str(e)}",
                        run_id=run.id, user_id=current_user.id,
                        metadata={"error": str(e)})
        raise


# ── Helpers ───────────────────────────────────────────────────────────────────

def _df_to_book_entries(df: pd.DataFrame) -> List[BookEntry]:
    entries = []
    for i, (_, row) in enumerate(df.iterrows()):
        entries.append(BookEntry(
            index=i,
            invoice_ref=str(row.get("invoice_ref", "") or ""),
            amount=float(row.get("amount", 0)),
            doc_date=str(row.get("doc_date", "") or ""),
            doc_type=str(row.get("doc_type", "") or ""),
            clearing_doc=str(row.get("clearing_doc", "") or ""),
            sap_fy=str(row.get("sap_fy", "") or ""),
            flag=str(row.get("flag", "") or ""),
        ))
    return entries


def _df_to_as26_entries(df: pd.DataFrame) -> List[As26Entry]:
    entries = []
    for i, (_, row) in enumerate(df.iterrows()):
        entries.append(As26Entry(
            index=i,
            amount=float(row.get("amount", 0)),
            transaction_date=str(row.get("transaction_date", "") or ""),
            section=str(row.get("section", "") or ""),
            tan=str(row.get("tan", "") or ""),
            deductor_name=str(row.get("deductor_name", "") or ""),
            tds_amount=float(row["tds_amount"]) if "tds_amount" in row and row["tds_amount"] else None,
        ))
    return entries


def _hash_as26_entry(result: AssignmentResult) -> str:
    sig = f"{result.as26_amount}|{result.as26_date}|{result.as26_section}"
    return hashlib.sha256(sig.encode()).hexdigest()[:16]


def _hash_as26_idx(idx: int) -> str:
    return hashlib.sha256(str(idx).encode()).hexdigest()[:16]


def _book_was_matched(book_index: int, results: List[AssignmentResult]) -> bool:
    return any(b.index == book_index for r in results for b in r.books)
