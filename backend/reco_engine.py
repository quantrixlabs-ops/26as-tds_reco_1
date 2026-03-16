"""
TDS Reconciliation Engine — 3-Round Combination Match Algorithm
Pure function: run_reco(clean_books, as26_entries, config) → RecoResult

Legal constraint (Section 199, Income Tax Act):
    books_sum MUST NEVER exceed as26_amount in any committed match.
    Enforced at assertion level — never relaxed.

Algorithm:
    Round 1 — Exact match  (abs diff < EXACT_TOLERANCE)
    Round 2 — Best single  (lowest abs diff, books ≤ as26)
    Round 3 — Best combo   (itertools combinations, books_sum ≤ as26)
    Commit best candidate after all three rounds.
"""
from __future__ import annotations

import itertools
import logging
import uuid
from typing import Dict, List, Optional, Set, Tuple

import pandas as pd

from config import COMBO_LIMIT, EXACT_TOLERANCE, MAX_COMBO_SIZE
from models import As26Entry, BookEntry, MatchedPair, RecoResult

logger = logging.getLogger(__name__)


def _possible_reason_books(entry: BookEntry) -> str:
    """Auto-generate 'Possible Reason' for unmatched book invoices."""
    if "SGL_V" in entry.flag:
        return "Advance payment — TDS may be on advance, not invoice"
    if entry.amount > 1_000_000:
        return "Large milestone / different financial year"
    return "Timing difference — may appear in 26AS next period"


def _df_to_book_entries(clean_df: pd.DataFrame) -> List[BookEntry]:
    entries = []
    for idx, row in clean_df.iterrows():
        entries.append(BookEntry(
            index=int(idx),
            doc_date=row.get("doc_date"),
            amount=float(row["amount"]),
            invoice_ref=str(row.get("invoice_ref", "")),
            doc_type=str(row.get("doc_type", "")),
            sgl_ind=str(row.get("sgl_ind", "")),
            flag=str(row.get("flag", "")),
        ))
    return entries


def _df_to_as26_entries(as26_slice: pd.DataFrame) -> List[As26Entry]:
    entries = []
    for idx, row in as26_slice.iterrows():
        entries.append(As26Entry(
            index=int(idx),
            transaction_date=row.get("transaction_date"),
            amount=float(row["amount"]),
            section=str(row.get("section", "")),
            tan=str(row.get("tan", "")),
            deductor_name=str(row.get("deductor_name", "")),
        ))
    return entries


def run_reco(
    clean_df: pd.DataFrame,
    as26_slice: pd.DataFrame,
    deductor_name: str,
    tan: str,
    fuzzy_score: Optional[float],
    session_id: Optional[str] = None,
) -> RecoResult:
    """
    Run the 3-round combination match reconciliation.

    Parameters
    ----------
    clean_df     : Cleaned SAP books DataFrame (output of cleaner.py)
    as26_slice   : 26AS DataFrame filtered to confirmed deductor + Status=F
    deductor_name: Confirmed deductor name
    tan          : Confirmed TAN
    fuzzy_score  : Name match score (None if manual override)
    session_id   : Session UUID (generated if not provided)
    """
    if session_id is None:
        session_id = str(uuid.uuid4())

    book_entries = _df_to_book_entries(clean_df)
    as26_entries = _df_to_as26_entries(as26_slice)

    # ── Step 1: Sort 26AS ascending by amount ─────────────────────────────
    as26_entries.sort(key=lambda x: x.amount)

    used_book_indices: Set[int] = set()
    matched_pairs: List[MatchedPair] = []
    unmatched_26as: List[As26Entry] = []
    constraint_violations = 0

    for as26 in as26_entries:
        # ── Step 2: Pre-filter available books ────────────────────────────
        available = [
            b for b in book_entries
            if b.index not in used_book_indices and b.amount <= as26.amount + EXACT_TOLERANCE
        ]

        if not available:
            unmatched_26as.append(as26)
            continue

        best_books: Optional[List[BookEntry]] = None
        best_diff: float = float("inf")
        best_match_type: str = ""

        # ── Round 1: Exact match ───────────────────────────────────────────
        for b in available:
            if abs(b.amount - as26.amount) < EXACT_TOLERANCE:
                best_books = [b]
                best_diff = abs(b.amount - as26.amount)
                best_match_type = "EXACT"
                break

        # ── Round 2: Best single (if no exact found) ───────────────────────
        if best_books is None:
            for b in available:
                diff = abs(as26.amount - b.amount)
                if diff < best_diff:
                    best_diff = diff
                    best_books = [b]
                    best_match_type = "SINGLE"

        # ── Round 3: Combo (may improve on single) ─────────────────────────
        if best_match_type != "EXACT":
            combo_count = 0
            for size in range(2, min(MAX_COMBO_SIZE + 1, len(available) + 1)):
                if combo_count >= COMBO_LIMIT:
                    break
                for combo in itertools.combinations(available, size):
                    if combo_count >= COMBO_LIMIT:
                        break
                    combo_count += 1
                    combo_sum = sum(b.amount for b in combo)
                    if combo_sum > as26.amount + EXACT_TOLERANCE:
                        continue
                    diff = abs(as26.amount - combo_sum)
                    if diff < best_diff:
                        best_diff = diff
                        best_books = list(combo)
                        best_match_type = f"COMBO_{size}"

        # ── Step 4: Assert + Commit ────────────────────────────────────────
        if best_books is None:
            unmatched_26as.append(as26)
            continue

        books_sum = sum(b.amount for b in best_books)

        # Legal assertion: books_sum must not exceed as26_amount
        if books_sum > as26.amount + EXACT_TOLERANCE:
            constraint_violations += 1
            logger.error(
                "CONSTRAINT VIOLATION: books_sum=%.2f > as26=%.2f for TAN=%s",
                books_sum, as26.amount, tan,
            )
            unmatched_26as.append(as26)
            continue

        # Commit match
        for b in best_books:
            used_book_indices.add(b.index)

        variance_amt = as26.amount - books_sum
        variance_pct = (variance_amt / as26.amount * 100) if as26.amount > 0 else 0.0

        matched_pairs.append(MatchedPair(
            as26_index=as26.index,
            as26_date=as26.transaction_date,
            as26_amount=as26.amount,
            section=as26.section,
            books_sum=books_sum,
            variance_amt=variance_amt,
            variance_pct=variance_pct,
            match_type=best_match_type,
            invoice_count=len(best_books),
            invoice_refs=[b.invoice_ref for b in best_books],
            invoice_dates=[b.doc_date for b in best_books],
            invoice_amounts=[b.amount for b in best_books],
            sgl_flags=[b.flag for b in best_books],
        ))

    # ── Step 5: Classify unmatched books ──────────────────────────────────
    unmatched_books = [
        b for b in book_entries if b.index not in used_book_indices
    ]

    # ── Compute summary stats ──────────────────────────────────────────────
    total_26as = len(as26_entries)
    matched_count = len(matched_pairs)
    match_rate = (matched_count / total_26as * 100) if total_26as > 0 else 0.0
    avg_variance = (
        sum(p.variance_pct for p in matched_pairs) / matched_count
        if matched_count > 0 else 0.0
    )

    logger.info(
        "Reco complete: %d/%d matched (%.1f%%) | avg_var=%.2f%% | violations=%d | "
        "unmatched_26as=%d | unmatched_books=%d",
        matched_count, total_26as, match_rate,
        avg_variance, constraint_violations,
        len(unmatched_26as), len(unmatched_books),
    )

    return RecoResult(
        deductor_name=deductor_name,
        tan=tan,
        fuzzy_score=fuzzy_score,
        total_26as_entries=total_26as,
        matched_count=matched_count,
        match_rate_pct=round(match_rate, 2),
        unmatched_26as_count=len(unmatched_26as),
        unmatched_books_count=len(unmatched_books),
        avg_variance_pct=round(avg_variance, 2),
        constraint_violations=constraint_violations,
        matched_pairs=matched_pairs,
        unmatched_26as=unmatched_26as,
        unmatched_books=unmatched_books,
        session_id=session_id,
    )
