"""
Reconciliation run routes — upload, status, results, review, download, replay.
"""
from __future__ import annotations

import asyncio
import io
import json as _json
import uuid
from datetime import datetime, timezone
from typing import Dict, List, Optional
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select, desc, func
from sqlalchemy.ext.asyncio import AsyncSession

from core.audit import log_event
from core.deps import get_current_user, require_reviewer
from core.settings import settings
from db.base import get_db
from db.models import ReconciliationRun, MatchedPair, Unmatched26AS, UnmatchedBook, ExceptionRecord, User, SuggestedMatch
from services.reconcile_service import run_reconciliation
from services import progress_store

router = APIRouter(prefix="/api/runs", tags=["runs"])

# Hold strong references to background tasks to prevent GC from killing them.
# Python's event loop only keeps weak refs — without this, tasks vanish mid-execution.
_background_tasks: set = set()


# ── Schemas ───────────────────────────────────────────────────────────────────

class RunSummary(BaseModel):
    id: str
    run_number: int
    financial_year: str
    deductor_name: Optional[str]
    tan: Optional[str]
    status: str
    match_rate_pct: float
    matched_count: int
    total_26as_entries: int
    total_sap_entries: int = 0
    suggested_count: int
    unmatched_26as_count: int
    high_confidence_count: int
    medium_confidence_count: int
    low_confidence_count: int
    constraint_violations: int
    control_total_balanced: bool
    has_pan_issues: bool
    has_rate_mismatches: bool
    algorithm_version: str
    sap_file_hash: str
    as26_file_hash: str
    created_at: str
    completed_at: Optional[str]
    mode: str
    batch_id: Optional[str]
    error_message: Optional[str] = None
    # Amount totals
    total_26as_amount: float = 0.0
    matched_amount: float = 0.0
    unmatched_26as_amount: float = 0.0


class ReviewRequest(BaseModel):
    action: str       # APPROVED | REJECTED
    notes: Optional[str] = None


class ExceptionReviewRequest(BaseModel):
    exception_id: str
    action: str       # ACCEPTED | REJECTED | ESCALATED
    notes: Optional[str] = None


class SuggestedMatchOut(BaseModel):
    id: str
    run_id: str
    as26_row_hash: Optional[str]
    as26_index: Optional[int]
    as26_amount: Optional[float]
    as26_date: Optional[str]
    section: Optional[str]
    tan: Optional[str]
    deductor_name: Optional[str]
    invoice_refs: Optional[list]
    invoice_amounts: Optional[list]
    invoice_dates: Optional[list]
    clearing_doc: Optional[str]
    books_sum: float
    match_type: Optional[str]
    variance_amt: float
    variance_pct: float
    confidence: str
    composite_score: float
    score_variance: float
    score_date_proximity: float
    score_section_match: float
    score_clearing_doc: float
    score_historical: float
    cross_fy: bool
    is_prior_year: bool
    category: str
    requires_remarks: bool
    alert_message: Optional[str]
    authorized: bool
    authorized_by_id: Optional[str]
    authorized_at: Optional[str]
    remarks: Optional[str]
    rejected: bool
    rejected_by_id: Optional[str]
    rejected_at: Optional[str]
    rejection_reason: Optional[str]
    created_at: str


class BulkSuggestedAuthorizeRequest(BaseModel):
    ids: List[str]
    remarks: Optional[str] = None


class BulkSuggestedRejectRequest(BaseModel):
    ids: List[str]
    reason: Optional[str] = None


class SuggestedSummaryOut(BaseModel):
    total: int
    by_category: Dict[str, int]
    authorized: int
    rejected: int
    pending: int


# ── Upload & Run ──────────────────────────────────────────────────────────────

@router.post("", status_code=202)
async def create_run(
    request: Request,
    sap_file: UploadFile = File(...),
    as26_file: UploadFile = File(...),
    financial_year: str = Form(default=settings.DEFAULT_FINANCIAL_YEAR),
    mappings_json: Optional[str] = Form(default=None),
    run_config_json: Optional[str] = Form(default=None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Upload files and start a reconciliation run (async — returns immediately)."""
    # Size guard
    max_bytes = settings.MAX_UPLOAD_MB * 1024 * 1024
    sap_bytes = await sap_file.read()
    as26_bytes = await as26_file.read()

    if len(sap_bytes) > max_bytes or len(as26_bytes) > max_bytes:
        raise HTTPException(status_code=413, detail=f"File exceeds {settings.MAX_UPLOAD_MB}MB limit")

    # Parse optional party filter (from preview/mapping step)
    deductor_filter_parties: Optional[list] = None
    if mappings_json:
        try:
            deductor_filter_parties = _json.loads(mappings_json)
            if isinstance(deductor_filter_parties, dict):
                deductor_filter_parties = [deductor_filter_parties]
        except Exception:
            raise HTTPException(status_code=422, detail="mappings_json must be valid JSON")

    # Parse optional per-run config overrides
    run_config: Optional[dict] = None
    if run_config_json:
        try:
            run_config = _json.loads(run_config_json)
        except Exception:
            raise HTTPException(status_code=422, detail="run_config_json must be valid JSON")

    # Create a placeholder run record and commit so background task can see it
    run = await _create_placeholder_run(
        db, current_user, sap_bytes, as26_bytes,
        sap_file.filename or "sap.xlsx",
        as26_file.filename or "26as.xlsx",
        financial_year,
        deductor_filter_parties=deductor_filter_parties,
    )
    await db.commit()

    # Launch reconciliation in background with its own DB session
    task = asyncio.create_task(
        _run_reconciliation_background(
            run_id=run.id,
            user_id=current_user.id,
            sap_bytes=sap_bytes,
            as26_bytes=as26_bytes,
            sap_filename=sap_file.filename or "sap.xlsx",
            as26_filename=as26_file.filename or "26as.xlsx",
            financial_year=financial_year,
            run_config=run_config,
            deductor_filter_parties=deductor_filter_parties,
        )
    )
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)

    return {"run_id": run.id, "run_number": run.run_number, "status": "PROCESSING"}


# ── List & Get ────────────────────────────────────────────────────────────────

@router.get("", response_model=List[RunSummary])
async def list_runs(
    limit: int = 50,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(ReconciliationRun)
        .order_by(desc(ReconciliationRun.created_at))
        .limit(limit).offset(offset)
    )
    runs = list(result.scalars().all())
    return [_run_to_summary(r) for r in runs]


@router.get("/batch/{batch_id}/download")
async def download_batch_excel(
    batch_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Generate and download a combined Excel workbook for all completed runs in a batch."""
    result = await db.execute(
        select(ReconciliationRun)
        .where(ReconciliationRun.batch_id == batch_id)
        .order_by(ReconciliationRun.run_number)
    )
    runs = list(result.scalars().all())
    if not runs:
        raise HTTPException(status_code=404, detail="No runs found for this batch")

    completed_runs = [r for r in runs if r.status in ("APPROVED", "PENDING_REVIEW", "REJECTED")]
    if not completed_runs:
        raise HTTPException(status_code=400, detail="No completed runs in this batch")

    # Load data for each completed run
    runs_data = []
    for run in completed_runs:
        matched_result = await db.execute(select(MatchedPair).where(MatchedPair.run_id == run.id))
        unmatched_result = await db.execute(select(Unmatched26AS).where(Unmatched26AS.run_id == run.id))
        books_result = await db.execute(select(UnmatchedBook).where(UnmatchedBook.run_id == run.id))
        exc_result = await db.execute(select(ExceptionRecord).where(ExceptionRecord.run_id == run.id))

        runs_data.append({
            "run": run,
            "matched_pairs": list(matched_result.scalars().all()),
            "unmatched_26as": list(unmatched_result.scalars().all()),
            "unmatched_books": list(books_result.scalars().all()),
            "exceptions": list(exc_result.scalars().all()),
        })

    from services.excel_v2 import generate_batch_excel
    excel_bytes = generate_batch_excel(runs_data)

    from core.security import sha256_file
    output_hash = sha256_file(excel_bytes)

    await log_event(db, "BATCH_EXPORT_DOWNLOADED",
                    f"Batch Excel downloaded for batch {batch_id} ({len(completed_runs)} parties)",
                    run_id=completed_runs[0].id, user_id=current_user.id,
                    metadata={"batch_id": batch_id, "output_hash": output_hash, "party_count": len(completed_runs)})

    fy = completed_runs[0].financial_year
    filename = f"TDS_Batch_{fy}_{len(completed_runs)}parties.xlsx"
    return StreamingResponse(
        io.BytesIO(excel_bytes),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/batch/{batch_id}/rerun", status_code=202)
async def rerun_batch(
    batch_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Rerun an entire batch using the stored file bytes.
    Creates a new batch with fresh runs and processes them in background.
    """
    # Fetch original batch runs
    result = await db.execute(
        select(ReconciliationRun)
        .where(ReconciliationRun.batch_id == batch_id)
        .order_by(ReconciliationRun.run_number)
    )
    original_runs = list(result.scalars().all())
    if not original_runs:
        raise HTTPException(status_code=404, detail="No runs found for this batch")

    # Verify file blobs are available
    missing = [r.sap_filename for r in original_runs if not r.sap_file_blob or not r.as26_file_blob]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"Original files not stored for: {', '.join(missing)}. "
                   "This batch was created before file storage was enabled. Re-upload and run manually."
        )

    new_batch_id = str(uuid.uuid4())
    new_runs_summary = []

    for orig in original_runs:
        run = await _create_placeholder_run(
            db, current_user,
            sap_bytes=orig.sap_file_blob,
            as26_bytes=orig.as26_file_blob,
            sap_filename=orig.sap_filename,
            as26_filename=orig.as26_filename,
            financial_year=orig.financial_year,
            batch_id=new_batch_id,
            deductor_filter_parties=orig.deductor_filter_parties,
        )
        await db.commit()

        task = asyncio.create_task(
            _run_reconciliation_background(
                run_id=run.id,
                user_id=current_user.id,
                sap_bytes=orig.sap_file_blob,
                as26_bytes=orig.as26_file_blob,
                sap_filename=orig.sap_filename,
                as26_filename=orig.as26_filename,
                financial_year=orig.financial_year,
                batch_id=new_batch_id,
                deductor_filter_parties=orig.deductor_filter_parties,
                run_config=orig.run_config,
            )
        )
        _background_tasks.add(task)
        task.add_done_callback(_background_tasks.discard)

        new_runs_summary.append({
            "run_id": run.id,
            "run_number": run.run_number,
            "sap_filename": orig.sap_filename,
            "deductor_name": orig.deductor_name,
            "status": "PROCESSING",
        })

    await log_event(db, "BATCH_RERUN",
                    f"Batch rerun: {len(new_runs_summary)} runs from batch {batch_id} "
                    f"→ new batch {new_batch_id} by {current_user.full_name}",
                    run_id=original_runs[0].id, user_id=current_user.id,
                    metadata={"original_batch_id": batch_id, "new_batch_id": new_batch_id,
                              "run_count": len(new_runs_summary)})

    return {"batch_id": new_batch_id, "runs": new_runs_summary, "total": len(new_runs_summary)}


class BatchAuthorizeAllRequest(BaseModel):
    remarks: Optional[str] = None


@router.post("/batch/{batch_id}/suggested/authorize-all", status_code=200)
async def batch_authorize_all_suggested(
    batch_id: str,
    body: Optional[BatchAuthorizeAllRequest] = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_reviewer),
):
    """
    Authorize ALL pending suggested matches across every run in a batch.
    When remarks are provided, also includes high-variance items that require remarks.
    When no remarks, those items are skipped.
    Promotes each authorized suggestion to a MatchedPair and updates run stats.
    """
    remarks = body.remarks.strip() if body and body.remarks and body.remarks.strip() else None

    # Find all runs in the batch
    runs_result = await db.execute(
        select(ReconciliationRun)
        .where(ReconciliationRun.batch_id == batch_id)
    )
    runs = list(runs_result.scalars().all())
    if not runs:
        raise HTTPException(status_code=404, detail="No runs found for this batch")

    run_ids = [r.id for r in runs]
    run_map = {r.id: r for r in runs}

    # When remarks provided: authorize ALL pending (including requires_remarks)
    # When no remarks: skip requires_remarks items
    base_filters = [
        SuggestedMatch.run_id.in_(run_ids),
        SuggestedMatch.authorized == False,
        SuggestedMatch.rejected == False,
    ]
    if not remarks:
        base_filters.append(SuggestedMatch.requires_remarks == False)

    sm_result = await db.execute(select(SuggestedMatch).where(*base_filters))
    pending = list(sm_result.scalars().all())

    if not pending:
        # Count skipped if no remarks provided
        skipped = 0
        if not remarks:
            skipped_result = await db.execute(
                select(func.count(SuggestedMatch.id)).where(
                    SuggestedMatch.run_id.in_(run_ids),
                    SuggestedMatch.authorized == False,
                    SuggestedMatch.rejected == False,
                    SuggestedMatch.requires_remarks == True,
                )
            )
            skipped = skipped_result.scalar() or 0
        return {
            "success_count": 0,
            "promoted_count": 0,
            "skipped_requires_remarks": skipped,
            "runs_affected": 0,
        }

    # Get suggested ceiling from admin settings
    from db.models import AdminSettings
    admin_result = await db.execute(
        select(AdminSettings).where(AdminSettings.is_active == True)
    )
    admin_settings = admin_result.scalar_one_or_none()
    suggested_ceiling_pct = (
        admin_settings.variance_suggested_ceiling_pct
        if admin_settings and admin_settings.variance_suggested_ceiling_pct is not None
        else 20.0
    )

    now = datetime.now(timezone.utc)
    promoted_per_run: Dict[str, int] = {}
    confidence_per_run: Dict[str, Dict[str, int]] = {}
    success_count = 0
    skipped_dup = 0

    # Pre-load existing MatchedPair hashes per run to prevent duplicate promotion
    existing_mp_hashes: Dict[str, set] = {}
    for rid in run_ids:
        mp_result = await db.execute(
            select(MatchedPair.as26_row_hash).where(MatchedPair.run_id == rid)
        )
        existing_mp_hashes[rid] = {row[0] for row in mp_result.all() if row[0]}

    # Track hashes promoted in THIS batch to avoid duplicates within the same authorize call
    promoted_hashes: Dict[str, set] = {rid: set() for rid in run_ids}

    for sm in pending:
        sm.authorized = True
        sm.authorized_by_id = current_user.id
        sm.authorized_at = now
        sm.remarks = remarks or "Batch-level authorize all"
        success_count += 1

        hash_key = sm.as26_row_hash or ""

        # Skip MatchedPair creation if one already exists for this (run_id, as26_row_hash)
        if hash_key and (
            hash_key in existing_mp_hashes.get(sm.run_id, set()) or
            hash_key in promoted_hashes.get(sm.run_id, set())
        ):
            skipped_dup += 1
            continue

        # Build audit remark for high-variance matches
        mp_remark = None
        if sm.variance_pct > suggested_ceiling_pct:
            mp_remark = (
                f"Authorized via batch authorize-all — variance ({sm.variance_pct:.2f}%) "
                f"exceeds suggested ceiling ({suggested_ceiling_pct:.1f}%). "
                f"Authorized by: {current_user.full_name}."
            )
            if remarks:
                mp_remark += f" Reviewer remarks: {remarks}"

        mp = MatchedPair(
            run_id=sm.run_id,
            as26_row_hash=sm.as26_row_hash or "",
            as26_amount=sm.as26_amount or 0.0,
            as26_date=sm.as26_date,
            section=sm.section or "",
            tan=sm.tan or "",
            deductor_name=sm.deductor_name or "",
            invoice_refs=sm.invoice_refs,
            invoice_amounts=sm.invoice_amounts,
            invoice_dates=sm.invoice_dates,
            clearing_doc=sm.clearing_doc,
            books_sum=sm.books_sum,
            match_type=sm.match_type or "SUGGESTED",
            variance_amt=sm.variance_amt,
            variance_pct=sm.variance_pct,
            confidence=sm.confidence,
            composite_score=sm.composite_score,
            score_variance=sm.score_variance,
            score_date_proximity=sm.score_date_proximity,
            score_section_match=sm.score_section_match,
            score_clearing_doc=sm.score_clearing_doc,
            score_historical=sm.score_historical,
            cross_fy=sm.cross_fy,
            is_prior_year=sm.is_prior_year,
            remark=mp_remark,
        )
        db.add(mp)

        # Track this hash as promoted
        if hash_key:
            promoted_hashes.setdefault(sm.run_id, set()).add(hash_key)

        # Remove from Unmatched26AS
        if sm.as26_row_hash:
            u_result = await db.execute(
                select(Unmatched26AS).where(
                    Unmatched26AS.run_id == sm.run_id,
                    Unmatched26AS.as26_row_hash == sm.as26_row_hash,
                )
            )
            u_entry = u_result.scalar_one_or_none()
            if u_entry:
                await db.delete(u_entry)

        # Track per-run promotion counts
        promoted_per_run[sm.run_id] = promoted_per_run.get(sm.run_id, 0) + 1
        conf = sm.confidence.upper() if sm.confidence else "LOW"
        if sm.run_id not in confidence_per_run:
            confidence_per_run[sm.run_id] = {"HIGH": 0, "MEDIUM": 0, "LOW": 0}
        confidence_per_run[sm.run_id][conf] = confidence_per_run[sm.run_id].get(conf, 0) + 1

    await db.flush()

    # Recount matched_count from actual unique MatchedPair rows (prevents drift from duplicates)
    for rid in promoted_per_run:
        run = run_map[rid]
        count_result = await db.execute(
            select(func.count(func.distinct(MatchedPair.as26_row_hash))).where(
                MatchedPair.run_id == rid
            )
        )
        run.matched_count = count_result.scalar() or 0
        unmatched_result = await db.execute(
            select(func.count(Unmatched26AS.id)).where(Unmatched26AS.run_id == rid)
        )
        run.unmatched_26as_count = unmatched_result.scalar() or 0
        if run.total_26as_entries and run.total_26as_entries > 0:
            run.match_rate_pct = (run.matched_count / run.total_26as_entries) * 100
        # Recount confidence from authoritative MatchedPair rows (prevents double-counting)
        conf_result = await db.execute(
            select(MatchedPair.confidence, func.count(MatchedPair.id))
            .where(MatchedPair.run_id == rid)
            .group_by(MatchedPair.confidence)
        )
        conf_map = {(row[0] or "LOW").upper(): row[1] for row in conf_result.all()}
        run.high_confidence_count = conf_map.get("HIGH", 0)
        run.medium_confidence_count = conf_map.get("MEDIUM", 0)
        run.low_confidence_count = conf_map.get("LOW", 0)

    await db.flush()

    # Count remaining skipped (only when no remarks provided)
    skipped = 0
    if not remarks:
        skipped_result = await db.execute(
            select(func.count(SuggestedMatch.id)).where(
                SuggestedMatch.run_id.in_(run_ids),
                SuggestedMatch.authorized == False,
                SuggestedMatch.rejected == False,
                SuggestedMatch.requires_remarks == True,
            )
        )
        skipped = skipped_result.scalar() or 0

    await log_event(db, "BATCH_SUGGESTED_AUTHORIZED",
                    f"Batch authorize-all: {success_count} suggested match(es) authorized across "
                    f"{len(promoted_per_run)} run(s) in batch {batch_id} by {current_user.full_name}",
                    run_id=runs[0].id, user_id=current_user.id,
                    metadata={"batch_id": batch_id, "count": success_count,
                              "runs_affected": len(promoted_per_run),
                              "skipped_requires_remarks": skipped,
                              "remarks": remarks})

    return {
        "success_count": success_count,
        "promoted_count": sum(promoted_per_run.values()),
        "skipped_requires_remarks": skipped,
        "skipped_duplicates": skipped_dup,
        "runs_affected": len(promoted_per_run),
    }


@router.get("/{run_id}", response_model=RunSummary)
async def get_run(
    run_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    run = await _get_run_or_404(run_id, db)

    # ── Self-healing recount for stale runs ──
    # Old runs may have inflated suggested_count from pre-fix authorize operations.
    # Recount from actual DB state if count integrity is violated.
    if run.status not in ("PROCESSING",) and run.total_26as_entries and run.total_26as_entries > 0:
        stored_sum = (run.matched_count or 0) + (run.suggested_count or 0) + (run.unmatched_26as_count or 0)
        if stored_sum != run.total_26as_entries:
            matched_ct = await db.execute(
                select(func.count(func.distinct(MatchedPair.as26_row_hash)))
                .where(MatchedPair.run_id == run_id)
            )
            run.matched_count = matched_ct.scalar() or 0

            suggested_ct = await db.execute(
                select(func.count(SuggestedMatch.id)).where(
                    SuggestedMatch.run_id == run_id,
                    SuggestedMatch.authorized == False,
                    SuggestedMatch.rejected == False,
                )
            )
            run.suggested_count = suggested_ct.scalar() or 0

            unmatched_ct = await db.execute(
                select(func.count(Unmatched26AS.id)).where(Unmatched26AS.run_id == run_id)
            )
            run.unmatched_26as_count = unmatched_ct.scalar() or 0

            if run.total_26as_entries > 0:
                run.match_rate_pct = round((run.matched_count / run.total_26as_entries) * 100, 2)

            await db.commit()

    return _run_to_summary(run)


@router.post("/{run_id}/rerun", status_code=202)
async def rerun_single(
    run_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Rerun a single reconciliation using the stored file bytes.
    Creates a new run and processes it in the background.
    """
    original = await _get_run_or_404(run_id, db)

    if not original.sap_file_blob or not original.as26_file_blob:
        raise HTTPException(
            status_code=400,
            detail="Original files not stored for this run. Re-upload and run manually.",
        )

    run = await _create_placeholder_run(
        db, current_user,
        sap_bytes=original.sap_file_blob,
        as26_bytes=original.as26_file_blob,
        sap_filename=original.sap_filename,
        as26_filename=original.as26_filename,
        financial_year=original.financial_year,
        batch_id=original.batch_id,
        deductor_filter_parties=original.deductor_filter_parties,
    )
    await db.commit()

    task = asyncio.create_task(
        _run_reconciliation_background(
            run_id=run.id,
            user_id=current_user.id,
            sap_bytes=original.sap_file_blob,
            as26_bytes=original.as26_file_blob,
            sap_filename=original.sap_filename,
            as26_filename=original.as26_filename,
            financial_year=original.financial_year,
            batch_id=original.batch_id,
            deductor_filter_parties=original.deductor_filter_parties,
            run_config=original.run_config,
        )
    )
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)

    await log_event(db, "RUN_RERUN",
                    f"Run #{original.run_number} rerun as #{run.run_number} "
                    f"by {current_user.full_name}",
                    run_id=original.id, user_id=current_user.id,
                    metadata={"original_run_id": original.id, "new_run_id": run.id})

    return {
        "run_id": run.id,
        "run_number": run.run_number,
        "status": "PROCESSING",
        "original_run_id": original.id,
    }


@router.get("/{run_id}/matched")
async def get_matched_pairs(
    run_id: str,
    limit: int = 100,
    offset: int = 0,
    confidence: Optional[str] = None,
    match_type: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await _get_run_or_404(run_id, db)
    q = select(MatchedPair).where(MatchedPair.run_id == run_id)
    if confidence:
        q = q.where(MatchedPair.confidence == confidence.upper())
    if match_type:
        q = q.where(MatchedPair.match_type == match_type.upper())
    q = q.order_by(desc(MatchedPair.composite_score)).limit(limit).offset(offset)
    result = await db.execute(q)
    pairs = result.scalars().all()
    return [_mp_to_dict(p) for p in pairs]


@router.get("/{run_id}/unmatched-26as")
async def get_unmatched_26as(
    run_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await _get_run_or_404(run_id, db)
    result = await db.execute(
        select(Unmatched26AS).where(Unmatched26AS.run_id == run_id)
        .order_by(desc(Unmatched26AS.amount))
    )
    entries = result.scalars().all()
    reason_labels = {
        "U01": "No matching invoice found in SAP",
        "U02": "Amount variance exceeds tolerance",
        "U04": "Below noise threshold",
    }
    return [
        {
            "id": u.id, "index": idx + 1, "deductor_name": u.deductor_name,
            "tan": u.tan, "transaction_date": u.transaction_date,
            "date": u.transaction_date, "amount": u.amount,
            "section": u.section, "reason_code": u.reason_code,
            "reason_label": reason_labels.get(u.reason_code, u.reason_code),
            "reason_detail": u.reason_detail,
        }
        for idx, u in enumerate(entries)
    ]


@router.get("/{run_id}/unmatched-books")
async def get_unmatched_books(
    run_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await _get_run_or_404(run_id, db)
    result = await db.execute(
        select(UnmatchedBook).where(UnmatchedBook.run_id == run_id)
        .order_by(desc(UnmatchedBook.amount))
    )
    return [
        {
            "id": b.id, "invoice_ref": b.invoice_ref, "amount": b.amount,
            "doc_date": b.doc_date, "doc_type": b.doc_type,
            "clearing_doc": b.clearing_doc, "sgl_flag": b.flag,
            "sap_fy": b.sap_fy,
        }
        for b in result.scalars().all()
    ]


@router.get("/{run_id}/exceptions")
async def get_exceptions(
    run_id: str,
    severity: Optional[str] = None,
    reviewed: Optional[bool] = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await _get_run_or_404(run_id, db)
    q = select(ExceptionRecord).where(ExceptionRecord.run_id == run_id)
    if severity:
        q = q.where(ExceptionRecord.severity == severity.upper())
    if reviewed is not None:
        q = q.where(ExceptionRecord.reviewed == reviewed)
    result = await db.execute(q.order_by(ExceptionRecord.severity))
    return [_exc_to_dict(e) for e in result.scalars().all()]


# ── Review Workflow (Maker-Checker) ──────────────────────────────────────────

@router.post("/{run_id}/review")
async def review_run(
    run_id: str,
    body: ReviewRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_reviewer),
):
    """Reviewer approves or rejects the reconciliation run."""
    run = await _get_run_or_404(run_id, db)

    if run.created_by_id == current_user.id:
        raise HTTPException(status_code=403, detail="Cannot review your own run (maker-checker rule)")

    if run.status not in ("PENDING_REVIEW", "PROCESSING"):
        raise HTTPException(status_code=400, detail=f"Run status '{run.status}' cannot be reviewed")

    if body.action not in ("APPROVED", "REJECTED"):
        raise HTTPException(status_code=400, detail="Action must be APPROVED or REJECTED")

    # Block approval if count integrity is broken — recount from live DB state
    if body.action == "APPROVED" and run.total_26as_entries and run.total_26as_entries > 0:
        live_matched = (await db.execute(
            select(func.count(func.distinct(MatchedPair.as26_row_hash)))
            .where(MatchedPair.run_id == run_id)
        )).scalar() or 0
        live_suggested = (await db.execute(
            select(func.count(SuggestedMatch.id)).where(
                SuggestedMatch.run_id == run_id,
                SuggestedMatch.authorized == False,
                SuggestedMatch.rejected == False,
            )
        )).scalar() or 0
        live_unmatched = (await db.execute(
            select(func.count(Unmatched26AS.id)).where(Unmatched26AS.run_id == run_id)
        )).scalar() or 0
        accounted = live_matched + live_suggested + live_unmatched
        if accounted != run.total_26as_entries:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Cannot approve: count integrity violated. "
                    f"Matched ({live_matched}) + Suggested ({live_suggested}) "
                    f"+ Unmatched ({live_unmatched}) = {accounted}, "
                    f"but total 26AS entries = {run.total_26as_entries}. Re-run this reconciliation first."
                ),
            )
        # Sync stored counts with live state
        run.matched_count = live_matched
        run.suggested_count = live_suggested
        run.unmatched_26as_count = live_unmatched
        if run.total_26as_entries > 0:
            run.match_rate_pct = round((live_matched / run.total_26as_entries) * 100, 2)

        # Block approval if match rate is below minimum threshold
        MIN_APPROVAL_MATCH_RATE = 75.0
        if run.match_rate_pct < MIN_APPROVAL_MATCH_RATE:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Cannot approve: match rate {run.match_rate_pct:.1f}% is below the "
                    f"minimum approval threshold of {MIN_APPROVAL_MATCH_RATE:.0f}%. "
                    f"Review unmatched entries or authorize suggested matches first."
                ),
            )

    run.status = body.action
    run.reviewed_by_id = current_user.id
    run.reviewed_at = datetime.now(timezone.utc)
    run.review_notes = body.notes

    # ── On REJECTION: revert any promoted MatchedPairs back to pending suggested ──
    reverted_count = 0
    if body.action == "REJECTED":
        # Find all authorized SuggestedMatches for this run
        auth_sm_result = await db.execute(
            select(SuggestedMatch).where(
                SuggestedMatch.run_id == run_id,
                SuggestedMatch.authorized == True,
            )
        )
        authorized_sms = list(auth_sm_result.scalars().all())

        for sm in authorized_sms:
            # Delete the promoted MatchedPair (identified by matching as26_row_hash)
            if sm.as26_row_hash:
                await db.execute(
                    MatchedPair.__table__.delete().where(
                        MatchedPair.run_id == run_id,
                        MatchedPair.as26_row_hash == sm.as26_row_hash,
                    )
                )
                # Re-create Unmatched26AS entry (restored from suggested match data)
                existing_u = await db.execute(
                    select(Unmatched26AS).where(
                        Unmatched26AS.run_id == run_id,
                        Unmatched26AS.as26_row_hash == sm.as26_row_hash,
                    )
                )
                if not existing_u.scalar_one_or_none():
                    db.add(Unmatched26AS(
                        run_id=run_id,
                        as26_row_hash=sm.as26_row_hash,
                        deductor_name=sm.deductor_name or "",
                        tan=sm.tan or "",
                        transaction_date=sm.as26_date,
                        amount=sm.as26_amount or 0.0,
                        section=sm.section or "",
                        reason_code="U02",
                        reason_detail="Reverted from authorized suggestion after run rejection",
                    ))

            # Un-authorize the SuggestedMatch
            sm.authorized = False
            sm.authorized_by_id = None
            sm.authorized_at = None
            sm.remarks = None
            reverted_count += 1

        if reverted_count > 0:
            await db.flush()
            # Recalculate run stats from actual DB state
            count_result = await db.execute(
                select(func.count(func.distinct(MatchedPair.as26_row_hash))).where(
                    MatchedPair.run_id == run_id
                )
            )
            run.matched_count = count_result.scalar() or 0
            unmatched_result = await db.execute(
                select(func.count(Unmatched26AS.id)).where(Unmatched26AS.run_id == run_id)
            )
            run.unmatched_26as_count = unmatched_result.scalar() or 0
            suggested_result = await db.execute(
                select(func.count(SuggestedMatch.id)).where(
                    SuggestedMatch.run_id == run_id,
                    SuggestedMatch.authorized == False,
                    SuggestedMatch.rejected == False,
                )
            )
            run.suggested_count = suggested_result.scalar() or 0
            if run.total_26as_entries and run.total_26as_entries > 0:
                run.match_rate_pct = (run.matched_count / run.total_26as_entries) * 100

    await log_event(db, f"RUN_{body.action}",
                    f"Run RUN-{run.run_number:04d} {body.action.lower()} by {current_user.full_name}",
                    run_id=run_id, user_id=current_user.id,
                    metadata={"action": body.action, "notes": body.notes,
                              "reverted_promotions": reverted_count})

    return {"status": run.status, "reviewed_by": current_user.full_name}


@router.post("/{run_id}/exceptions/review")
async def review_exception(
    run_id: str,
    body: ExceptionReviewRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_reviewer),
):
    """Review an individual exception."""
    result = await db.execute(
        select(ExceptionRecord).where(
            ExceptionRecord.id == body.exception_id,
            ExceptionRecord.run_id == run_id
        )
    )
    exc = result.scalar_one_or_none()
    if not exc:
        raise HTTPException(status_code=404, detail="Exception not found")

    exc.reviewed = True
    exc.reviewed_by_id = current_user.id
    exc.reviewed_at = datetime.now(timezone.utc)
    exc.review_action = body.action
    exc.review_notes = body.notes

    await log_event(db, "EXCEPTION_REVIEWED",
                    f"Exception {exc.exception_type} {body.action}",
                    run_id=run_id, user_id=current_user.id,
                    metadata={"exception_type": exc.exception_type, "action": body.action})

    return {"exception_id": exc.id, "action": body.action}


# ── Stop / Cancel ─────────────────────────────────────────────────────────

@router.post("/{run_id}/cancel", status_code=200)
async def cancel_run(
    run_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Request cancellation of a PROCESSING run."""
    run = await _get_run_or_404(run_id, db)
    if run.status != "PROCESSING":
        raise HTTPException(status_code=400, detail=f"Cannot cancel run with status '{run.status}'")

    progress_store.request_cancel(run_id)
    run.status = "FAILED"
    run.completed_at = datetime.now(timezone.utc)

    await log_event(db, "RUN_CANCELLED",
                    f"Run RUN-{run.run_number:04d} cancelled by {current_user.full_name}",
                    run_id=run_id, user_id=current_user.id)

    return {"status": "CANCELLED", "run_id": run_id}


# ── Delete ────────────────────────────────────────────────────────────────

@router.delete("/{run_id}", status_code=200)
async def delete_run(
    run_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a completed/failed run and all its associated data.
    Audit logs are PRESERVED for regulatory compliance — only result data is deleted.
    """
    run = await _get_run_or_404(run_id, db)
    if run.status == "PROCESSING":
        raise HTTPException(status_code=400, detail="Cannot delete a run that is still processing. Cancel it first.")

    # Log deletion BEFORE removing data (audit trail must capture the event)
    await log_event(db, "RUN_DELETED",
                    f"Run RUN-{run.run_number:04d} deleted by {current_user.full_name}",
                    run_id=run_id, user_id=current_user.id,
                    metadata={"run_number": run.run_number, "status_at_deletion": run.status,
                              "matched_count": run.matched_count, "match_rate_pct": run.match_rate_pct})

    # Delete child records — AuditLog is intentionally EXCLUDED (immutable audit trail)
    for model in [MatchedPair, SuggestedMatch, Unmatched26AS, UnmatchedBook, ExceptionRecord]:
        await db.execute(
            model.__table__.delete().where(model.run_id == run_id)
        )

    await db.delete(run)
    await db.flush()

    return {"status": "DELETED", "run_id": run_id, "run_number": run.run_number}


# ── Download ──────────────────────────────────────────────────────────────────

@router.get("/{run_id}/download")
async def download_excel(
    run_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Generate and download the Excel output for a completed run."""
    run = await _get_run_or_404(run_id, db)

    if run.status not in ("APPROVED", "PENDING_REVIEW", "REJECTED"):
        raise HTTPException(status_code=400, detail=f"Run not yet complete (status: {run.status})")

    # Load all data
    matched_result = await db.execute(select(MatchedPair).where(MatchedPair.run_id == run_id))
    unmatched_result = await db.execute(select(Unmatched26AS).where(Unmatched26AS.run_id == run_id))
    books_result = await db.execute(select(UnmatchedBook).where(UnmatchedBook.run_id == run_id))
    exc_result = await db.execute(select(ExceptionRecord).where(ExceptionRecord.run_id == run_id))

    matched_pairs = matched_result.scalars().all()
    unmatched_26as = unmatched_result.scalars().all()
    unmatched_books = books_result.scalars().all()
    exceptions = exc_result.scalars().all()

    # Generate Excel using v2 generator
    from services.excel_v2 import generate_excel_v2
    excel_bytes = generate_excel_v2(run, matched_pairs, unmatched_26as, unmatched_books, exceptions)

    # Compute output hash
    from core.security import sha256_file
    output_hash = sha256_file(excel_bytes)
    run.output_hash = output_hash

    await log_event(db, "EXPORT_DOWNLOADED",
                    f"Excel downloaded for RUN-{run.run_number:04d}",
                    run_id=run_id, user_id=current_user.id,
                    metadata={"output_hash": output_hash})

    filename = f"TDS_Reco_{run.deductor_name or 'batch'}_{run.financial_year}_RUN{run.run_number:04d}.xlsx"
    return StreamingResponse(
        io.BytesIO(excel_bytes),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── Audit Trail ───────────────────────────────────────────────────────────────

@router.get("/{run_id}/audit-trail")
async def get_audit_trail(
    run_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    from db.models import AuditLog, User as UserModel
    result = await db.execute(
        select(AuditLog).where(AuditLog.run_id == run_id)
        .order_by(AuditLog.created_at)
    )
    logs = result.scalars().all()

    # Pre-load user names/roles for all referenced user_ids
    user_ids = {l.user_id for l in logs if l.user_id}
    user_map: dict = {}
    if user_ids:
        u_result = await db.execute(select(UserModel).where(UserModel.id.in_(user_ids)))
        for u in u_result.scalars().all():
            user_map[u.id] = u

    return [
        {
            "id": l.id,
            "event_type": l.event_type,
            "actor": user_map[l.user_id].full_name if l.user_id and l.user_id in user_map else "System",
            "actor_role": user_map[l.user_id].role if l.user_id and l.user_id in user_map else "SYSTEM",
            "timestamp": l.created_at.isoformat() if l.created_at else None,
            "notes": l.description,
            "metadata": l.event_metadata,
        }
        for l in logs
    ]


# ── Progress Tracking ─────────────────────────────────────────────────────

@router.get("/{run_id}/progress")
async def get_progress(
    run_id: str,
    current_user: User = Depends(get_current_user),
):
    """Polling endpoint — returns current progress snapshot."""
    state = progress_store.get(run_id)
    if not state:
        return {"run_id": run_id, "status": "NOT_FOUND", "overall_pct": 0}
    return state.to_dict()


@router.get("/{run_id}/progress/stream")
async def stream_progress(
    run_id: str,
    request: Request,
    token: Optional[str] = None,
):
    """SSE endpoint — streams progress updates until run completes.
    Accepts auth via ?token= query param (EventSource can't set headers).
    """
    # Auth: validate JWT token (query param or header)
    from core.security import decode_token
    from jose import JWTError
    auth_token = token
    if not auth_token:
        auth_header = request.headers.get("authorization", "")
        if auth_header.startswith("Bearer "):
            auth_token = auth_header[7:]
    if not auth_token:
        raise HTTPException(status_code=401, detail="Authentication required")
    try:
        payload = decode_token(auth_token)
        if not payload.get("sub"):
            raise HTTPException(status_code=401, detail="Invalid token")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    async def event_generator():
        last_pct = -1.0
        idle_count = 0
        while True:
            # Check if client disconnected
            if await request.is_disconnected():
                break
            state = progress_store.get(run_id)
            if state:
                data = state.to_dict()
                # Only send if changed (avoid duplicate frames)
                if data["overall_pct"] != last_pct or data["status"] in ("COMPLETE", "FAILED"):
                    import json
                    yield f"data: {json.dumps(data)}\n\n"
                    last_pct = data["overall_pct"]
                    idle_count = 0
                else:
                    idle_count += 1
                if data["status"] in ("COMPLETE", "FAILED"):
                    break
            else:
                idle_count += 1
                # If no state found for 60 checks (30s), give up
                if idle_count > 60:
                    import json
                    yield f"data: {json.dumps({'run_id': run_id, 'status': 'NOT_FOUND', 'overall_pct': 0})}\n\n"
                    break
            await asyncio.sleep(0.5)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ── Batch: Preview Mappings (lightweight — filenames only) ────────────────────

@router.post("/batch/preview", status_code=200)
async def preview_batch_mappings(
    as26_file: UploadFile = File(...),
    sap_filenames_json: Optional[str] = Form(default=None),
    sap_files: Optional[List[UploadFile]] = File(default=None),
    current_user: User = Depends(get_current_user),
):
    """
    Dry-run only — no DB writes.
    Parse 26AS and fuzzy-match each SAP filename to a deductor.
    Returns proposed mappings + full party list for manual override.

    Accepts SAP filenames in two ways (for backward compatibility):
    1. sap_filenames_json: JSON array of filename strings (lightweight, preferred)
    2. sap_files: actual file uploads (legacy, only filenames are used)
    """
    from aligner import align_deductor, extract_identity_string
    from parser_26as import parse_26as
    import pandas as pd

    as26_bytes = await as26_file.read()

    # Collect SAP filenames from either source
    filenames: List[str] = []
    if sap_filenames_json:
        try:
            filenames = _json.loads(sap_filenames_json)
            if not isinstance(filenames, list):
                raise ValueError("Expected a list")
        except Exception:
            raise HTTPException(status_code=422, detail="sap_filenames_json must be a JSON array of strings")
    elif sap_files:
        filenames = [f.filename or "unknown.xlsx" for f in sap_files]
    else:
        raise HTTPException(status_code=422, detail="Provide sap_filenames_json or sap_files")

    # Try parsing — 26AS may lack deductor_name column (single-party files)
    no_deductors = False
    try:
        as26_df = parse_26as(as26_bytes)
    except (ValueError, StopIteration, KeyError) as e:
        # Missing deductor columns, bad headers, or no matching header row
        no_deductors = True
        as26_df = pd.DataFrame()
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    # All unique parties in 26AS for manual-selection dropdown
    all_parties: List[dict] = []
    if not as26_df.empty and "deductor_name" in as26_df.columns:
        for (name, tan), grp in as26_df.groupby(["deductor_name", "tan"]):
            all_parties.append({
                "deductor_name": str(name),
                "tan": str(tan),
                "entry_count": int(len(grp)),
            })
        all_parties.sort(key=lambda x: x["deductor_name"])

    mappings = []
    if no_deductors or not all_parties:
        # No deductors found — return identity strings but no candidates
        for filename in filenames:
            mappings.append({
                "sap_filename": filename,
                "identity_string": extract_identity_string(filename),
                "status": "NO_DEDUCTORS",
                "confirmed_name": None,
                "confirmed_tan": None,
                "fuzzy_score": None,
                "top_candidates": [],
            })
    else:
        for filename in filenames:
            result = align_deductor(filename, as26_df)
            mappings.append({
                "sap_filename": filename,
                "identity_string": result.identity_string,
                "status": result.status,
                "confirmed_name": result.confirmed_name,
                "confirmed_tan": result.confirmed_tan,
                "fuzzy_score": result.fuzzy_score,
                "top_candidates": [
                    {
                        "deductor_name": c.deductor_name,
                        "tan": c.tan,
                        "score": c.score,
                        "entry_count": c.entry_count,
                    }
                    for c in result.top_candidates
                ],
            })

    return {"mappings": mappings, "all_parties": all_parties, "no_deductors": no_deductors}


# ── Batch: Chunked flow (init → add-party) ──────────────────────────────────

import time as _time

# In-memory store for batch sessions: batch_id → {as26_bytes, as26_filename, ...}
_batch_sessions: Dict[str, Dict] = {}
_BATCH_SESSION_TTL = 3600  # 1 hour


def _purge_batch_sessions() -> None:
    now = _time.time()
    expired = [k for k, v in _batch_sessions.items() if now - v["created_at"] > _BATCH_SESSION_TTL]
    for k in expired:
        del _batch_sessions[k]


@router.post("/batch/init", status_code=200)
async def init_batch(
    as26_file: UploadFile = File(...),
    financial_year: str = Form(default=settings.DEFAULT_FINANCIAL_YEAR),
    run_config_json: Optional[str] = Form(default=None),
    current_user: User = Depends(get_current_user),
):
    """
    Step 1 of chunked batch: upload 26AS only, get a batch_id back.
    The 26AS bytes are stored in memory for subsequent add-party calls.
    """
    _purge_batch_sessions()

    max_bytes = settings.MAX_UPLOAD_MB * 1024 * 1024
    as26_bytes = await as26_file.read()
    if len(as26_bytes) > max_bytes:
        raise HTTPException(status_code=413, detail=f"26AS file exceeds {settings.MAX_UPLOAD_MB}MB limit")

    run_config: Optional[dict] = None
    if run_config_json:
        try:
            run_config = _json.loads(run_config_json)
        except Exception:
            raise HTTPException(status_code=422, detail="run_config_json must be valid JSON")

    batch_id = str(uuid.uuid4())
    _batch_sessions[batch_id] = {
        "as26_bytes": as26_bytes,
        "as26_filename": as26_file.filename or "26as.xlsx",
        "financial_year": financial_year,
        "run_config": run_config,
        "user_id": current_user.id,
        "created_at": _time.time(),
        "runs": [],
    }

    return {"batch_id": batch_id, "status": "ready"}


@router.post("/batch/{batch_id}/add", status_code=202)
async def add_party_to_batch(
    batch_id: str,
    sap_file: UploadFile = File(...),
    mappings_json: str = Form(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Step 2 of chunked batch: upload ONE SAP file + its mapping.
    Creates a placeholder run, starts processing immediately, returns run summary.
    Call this once per SAP file.
    """
    session = _batch_sessions.get(batch_id)
    if not session:
        raise HTTPException(status_code=404, detail="Batch session not found or expired. Re-init with /batch/init.")

    try:
        parties: list = _json.loads(mappings_json)
        if isinstance(parties, dict):
            parties = [parties]
    except Exception:
        raise HTTPException(status_code=422, detail="mappings_json must be valid JSON")

    max_bytes = settings.MAX_UPLOAD_MB * 1024 * 1024
    sap_bytes = await sap_file.read()
    if len(sap_bytes) > max_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"{sap_file.filename} exceeds {settings.MAX_UPLOAD_MB}MB limit",
        )

    filename = sap_file.filename or "sap.xlsx"
    as26_bytes = session["as26_bytes"]
    as26_filename = session["as26_filename"]
    financial_year = session["financial_year"]
    run_config = session["run_config"]

    run = await _create_placeholder_run(
        db, current_user, sap_bytes, as26_bytes,
        filename, as26_filename, financial_year, batch_id=batch_id,
        deductor_filter_parties=parties if parties else None,
    )
    await db.commit()

    task = asyncio.create_task(
        _run_reconciliation_background(
            run_id=run.id,
            user_id=current_user.id,
            sap_bytes=sap_bytes,
            as26_bytes=as26_bytes,
            sap_filename=filename,
            as26_filename=as26_filename,
            financial_year=financial_year,
            batch_id=batch_id,
            deductor_filter_parties=parties if parties else None,
            run_config=run_config,
        )
    )
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)

    run_summary = {
        "run_id": run.id,
        "run_number": run.run_number,
        "sap_filename": filename,
        "deductor_name": parties[0]["deductor_name"] if parties else None,
        "status": "PROCESSING",
    }
    session["runs"].append(run_summary)

    return {"batch_id": batch_id, "run": run_summary, "total_so_far": len(session["runs"])}


# ── Batch: Run All (legacy — uploads everything at once) ─────────────────────

@router.post("/batch", status_code=202)
async def create_batch_run(
    request: Request,
    as26_file: UploadFile = File(...),
    sap_files: List[UploadFile] = File(...),
    financial_year: str = Form(default=settings.DEFAULT_FINANCIAL_YEAR),
    mappings_json: str = Form(...),
    run_config_json: Optional[str] = Form(default=None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Run reconciliation for each SAP file against the shared 26AS (async).
    Creates placeholder runs immediately, processes each in background.
    Each SAP file → one ReconciliationRun, all linked by a shared batch_id.
    """
    try:
        mappings: dict = _json.loads(mappings_json)
    except Exception:
        raise HTTPException(status_code=422, detail="mappings_json must be valid JSON")

    # Parse optional per-run config overrides
    run_config: Optional[dict] = None
    if run_config_json:
        try:
            run_config = _json.loads(run_config_json)
        except Exception:
            raise HTTPException(status_code=422, detail="run_config_json must be valid JSON")

    max_bytes = settings.MAX_UPLOAD_MB * 1024 * 1024
    as26_bytes = await as26_file.read()
    if len(as26_bytes) > max_bytes:
        raise HTTPException(status_code=413, detail=f"26AS file exceeds {settings.MAX_UPLOAD_MB}MB limit")

    batch_id = str(uuid.uuid4())
    runs_summary = []

    # Read all SAP files upfront and create placeholder runs (fast)
    sap_data = []
    for sap_file in sap_files:
        sap_bytes = await sap_file.read()
        if len(sap_bytes) > max_bytes:
            raise HTTPException(status_code=413, detail=f"{sap_file.filename} exceeds {settings.MAX_UPLOAD_MB}MB limit")
        sap_data.append((sap_file.filename or "sap.xlsx", sap_bytes))

    as26_filename = as26_file.filename or "26as.xlsx"

    for filename, sap_bytes in sap_data:
        parties: list = mappings.get(filename, [])
        if isinstance(parties, dict):
            parties = [parties]

        run = await _create_placeholder_run(
            db, current_user, sap_bytes, as26_bytes,
            filename, as26_filename, financial_year, batch_id=batch_id,
            deductor_filter_parties=parties if parties else None,
        )
        await db.commit()  # Commit so background task's separate session can see this row

        # Launch background processing for this run
        task = asyncio.create_task(
            _run_reconciliation_background(
                run_id=run.id,
                user_id=current_user.id,
                sap_bytes=sap_bytes,
                as26_bytes=as26_bytes,
                sap_filename=filename,
                as26_filename=as26_filename,
                financial_year=financial_year,
                batch_id=batch_id,
                deductor_filter_parties=parties if parties else None,
                run_config=run_config,
            )
        )
        _background_tasks.add(task)
        task.add_done_callback(_background_tasks.discard)

        runs_summary.append({
            "run_id": run.id,
            "run_number": run.run_number,
            "sap_filename": filename,
            "deductor_name": None,
            "match_rate_pct": 0,
            "status": "PROCESSING",
        })

    return {"batch_id": batch_id, "runs": runs_summary, "total": len(runs_summary)}


# ── Suggested Matches ─────────────────────────────────────────────────────────

@router.get("/{run_id}/suggested", response_model=List[SuggestedMatchOut])
async def get_suggested_matches(
    run_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all suggested matches for a run, ordered by requires_remarks DESC then variance_pct DESC."""
    await _get_run_or_404(run_id, db)
    result = await db.execute(
        select(SuggestedMatch)
        .where(SuggestedMatch.run_id == run_id)
        .order_by(desc(SuggestedMatch.requires_remarks), desc(SuggestedMatch.variance_pct))
    )
    return [_suggested_to_out(s) for s in result.scalars().all()]


@router.post("/{run_id}/suggested/authorize", status_code=200)
async def authorize_suggested_matches(
    run_id: str,
    body: BulkSuggestedAuthorizeRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_reviewer),
):
    """Bulk authorize suggested matches, promote them to matched pairs, and update run summary."""
    run = await _get_run_or_404(run_id, db)

    # Get suggested ceiling from active admin settings (fallback: 20%)
    from db.models import AdminSettings
    admin_result = await db.execute(
        select(AdminSettings).where(AdminSettings.is_active == True)
    )
    admin_settings = admin_result.scalar_one_or_none()
    suggested_ceiling_pct = (
        admin_settings.variance_suggested_ceiling_pct
        if admin_settings and admin_settings.variance_suggested_ceiling_pct is not None
        else 20.0
    )

    success_count = 0
    promoted_count = 0
    now = datetime.now(timezone.utc)

    # Pre-load existing MatchedPair hashes for this run to prevent duplicate promotion
    existing_mp_result = await db.execute(
        select(MatchedPair.as26_row_hash).where(MatchedPair.run_id == run_id)
    )
    existing_mp_hashes = {row[0] for row in existing_mp_result.all() if row[0]}
    promoted_hashes: set = set()

    for sm_id in body.ids:
        result = await db.execute(
            select(SuggestedMatch).where(
                SuggestedMatch.id == sm_id,
                SuggestedMatch.run_id == run_id,
            )
        )
        sm = result.scalar_one_or_none()
        if not sm:
            raise HTTPException(status_code=404, detail=f"Suggested match {sm_id} not found")

        # Guard: prevent double-approve or approve-after-reject
        if sm.authorized:
            continue  # already authorized, skip silently
        if sm.rejected:
            raise HTTPException(
                status_code=400,
                detail=f"Suggested match {sm_id} was already rejected and cannot be authorized",
            )

        if sm.requires_remarks and not body.remarks:
            raise HTTPException(
                status_code=400,
                detail=f"Remarks are mandatory for suggested match {sm_id} (category: {sm.category})",
            )

        # Variance-based gate: >50% variance requires mandatory justification
        if (sm.variance_pct or 0) > 50.0 and not body.remarks:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Suggested match {sm_id} has extreme variance ({sm.variance_pct:.1f}%). "
                    f"Remarks/justification are mandatory for authorizing matches with >50% variance."
                ),
            )

        # Mark as authorized
        sm.authorized = True
        sm.authorized_by_id = current_user.id
        sm.authorized_at = now
        sm.remarks = body.remarks
        success_count += 1

        # ── Promote to MatchedPair (skip if already exists for this as26_row_hash) ──
        hash_key = sm.as26_row_hash or ""
        if hash_key and (hash_key in existing_mp_hashes or hash_key in promoted_hashes):
            continue

        # Build remark for matches above suggested ceiling
        remark = None
        if sm.variance_pct > suggested_ceiling_pct:
            remark = (
                f"Authorized via suggested match review — variance ({sm.variance_pct:.2f}%) "
                f"exceeds suggested ceiling ({suggested_ceiling_pct:.1f}%). "
                f"Requires additional audit verification. "
                f"Authorized by: {current_user.full_name}."
            )
            if body.remarks:
                remark += f" Reviewer remarks: {body.remarks}"

        mp = MatchedPair(
            run_id=run_id,
            as26_row_hash=sm.as26_row_hash or "",
            as26_amount=sm.as26_amount or 0.0,
            as26_date=sm.as26_date,
            section=sm.section or "",
            tan=sm.tan or "",
            deductor_name=sm.deductor_name or "",
            invoice_refs=sm.invoice_refs,
            invoice_amounts=sm.invoice_amounts,
            invoice_dates=sm.invoice_dates,
            clearing_doc=sm.clearing_doc,
            books_sum=sm.books_sum,
            match_type=sm.match_type or "SUGGESTED",
            variance_amt=sm.variance_amt,
            variance_pct=sm.variance_pct,
            confidence=sm.confidence,
            composite_score=sm.composite_score,
            score_variance=sm.score_variance,
            score_date_proximity=sm.score_date_proximity,
            score_section_match=sm.score_section_match,
            score_clearing_doc=sm.score_clearing_doc,
            score_historical=sm.score_historical,
            cross_fy=sm.cross_fy,
            is_prior_year=sm.is_prior_year,
            remark=remark,
        )
        db.add(mp)

        if hash_key:
            promoted_hashes.add(hash_key)

        # Remove from Unmatched26AS (if entry exists there)
        if sm.as26_row_hash:
            u_result = await db.execute(
                select(Unmatched26AS).where(
                    Unmatched26AS.run_id == run_id,
                    Unmatched26AS.as26_row_hash == sm.as26_row_hash,
                )
            )
            u_entry = u_result.scalar_one_or_none()
            if u_entry:
                await db.delete(u_entry)

        promoted_count += 1

    await db.flush()

    # ── Recount from actual DB state (prevents drift from duplicates) ──
    if promoted_count > 0:
        count_result = await db.execute(
            select(func.count(func.distinct(MatchedPair.as26_row_hash))).where(
                MatchedPair.run_id == run_id
            )
        )
        run.matched_count = count_result.scalar() or 0
        unmatched_result = await db.execute(
            select(func.count(Unmatched26AS.id)).where(Unmatched26AS.run_id == run_id)
        )
        run.unmatched_26as_count = unmatched_result.scalar() or 0
        # ── Recount suggested_count (pending only — not authorized/rejected) ──
        suggested_pending_result = await db.execute(
            select(func.count(SuggestedMatch.id)).where(
                SuggestedMatch.run_id == run_id,
                SuggestedMatch.authorized == False,
                SuggestedMatch.rejected == False,
            )
        )
        run.suggested_count = suggested_pending_result.scalar() or 0
        if run.total_26as_entries and run.total_26as_entries > 0:
            run.match_rate_pct = (run.matched_count / run.total_26as_entries) * 100
        # Recount confidence from authoritative MatchedPair rows (prevents double-counting)
        conf_result = await db.execute(
            select(MatchedPair.confidence, func.count(MatchedPair.id))
            .where(MatchedPair.run_id == run_id)
            .group_by(MatchedPair.confidence)
        )
        conf_map = {(row[0] or "LOW").upper(): row[1] for row in conf_result.all()}
        run.high_confidence_count = conf_map.get("HIGH", 0)
        run.medium_confidence_count = conf_map.get("MEDIUM", 0)
        run.low_confidence_count = conf_map.get("LOW", 0)
        await db.flush()

    # Build detailed audit metadata with before/after context per match
    authorized_details = []
    for sm_id in body.ids:
        sm_r = await db.execute(select(SuggestedMatch).where(SuggestedMatch.id == sm_id))
        sm_obj = sm_r.scalar_one_or_none()
        if sm_obj and sm_obj.authorized:
            authorized_details.append({
                "id": sm_id,
                "variance_pct": sm_obj.variance_pct,
                "confidence": sm_obj.confidence,
                "match_type": sm_obj.match_type,
                "as26_amount": sm_obj.as26_amount,
                "books_sum": sm_obj.books_sum,
                "invoice_refs": sm_obj.invoice_refs,
                "category": sm_obj.category,
            })

    await log_event(db, "SUGGESTED_MATCHES_AUTHORIZED",
                    f"{success_count} suggested match(es) authorized and promoted to matched pairs by {current_user.full_name}",
                    run_id=run_id, user_id=current_user.id,
                    metadata={"ids": body.ids, "remarks": body.remarks, "count": success_count,
                              "promoted_to_matched": promoted_count,
                              "authorized_details": authorized_details})

    return {"success_count": success_count, "promoted_count": promoted_count}


@router.post("/{run_id}/suggested/reject", status_code=200)
async def reject_suggested_matches(
    run_id: str,
    body: BulkSuggestedRejectRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_reviewer),
):
    """Bulk reject suggested matches."""
    await _get_run_or_404(run_id, db)
    success_count = 0

    for sm_id in body.ids:
        result = await db.execute(
            select(SuggestedMatch).where(
                SuggestedMatch.id == sm_id,
                SuggestedMatch.run_id == run_id,
            )
        )
        sm = result.scalar_one_or_none()
        if not sm:
            raise HTTPException(status_code=404, detail=f"Suggested match {sm_id} not found")

        # Guard: prevent double-reject or reject-after-authorize
        if sm.rejected:
            continue  # already rejected, skip silently
        if sm.authorized:
            raise HTTPException(
                status_code=400,
                detail=f"Suggested match {sm_id} was already authorized and cannot be rejected",
            )

        sm.rejected = True
        sm.rejected_by_id = current_user.id
        sm.rejected_at = datetime.now(timezone.utc)
        sm.rejection_reason = body.reason
        success_count += 1

    await db.flush()

    # ── Recount suggested_count from actual DB state ──
    run = await _get_run_or_404(run_id, db)
    pending_result = await db.execute(
        select(func.count(SuggestedMatch.id)).where(
            SuggestedMatch.run_id == run_id,
            SuggestedMatch.authorized == False,
            SuggestedMatch.rejected == False,
        )
    )
    run.suggested_count = pending_result.scalar() or 0
    await db.flush()

    await log_event(db, "SUGGESTED_MATCHES_REJECTED",
                    f"{success_count} suggested match(es) rejected by {current_user.full_name}",
                    run_id=run_id, user_id=current_user.id,
                    metadata={"ids": body.ids, "reason": body.reason, "count": success_count})

    return {"success_count": success_count}


@router.get("/{run_id}/suggested/summary", response_model=SuggestedSummaryOut)
async def get_suggested_summary(
    run_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Returns summary counts of suggested matches by category and status."""
    await _get_run_or_404(run_id, db)

    # Total count
    total_result = await db.execute(
        select(func.count(SuggestedMatch.id))
        .where(SuggestedMatch.run_id == run_id)
    )
    total = total_result.scalar() or 0

    # Count by category
    cat_result = await db.execute(
        select(SuggestedMatch.category, func.count(SuggestedMatch.id))
        .where(SuggestedMatch.run_id == run_id)
        .group_by(SuggestedMatch.category)
    )
    by_category: Dict[str, int] = {row[0]: row[1] for row in cat_result.all()}

    # Authorized count
    auth_result = await db.execute(
        select(func.count(SuggestedMatch.id))
        .where(SuggestedMatch.run_id == run_id, SuggestedMatch.authorized == True)
    )
    authorized = auth_result.scalar() or 0

    # Rejected count
    rej_result = await db.execute(
        select(func.count(SuggestedMatch.id))
        .where(SuggestedMatch.run_id == run_id, SuggestedMatch.rejected == True)
    )
    rejected = rej_result.scalar() or 0

    pending = total - authorized - rejected

    return SuggestedSummaryOut(
        total=total,
        by_category=by_category,
        authorized=authorized,
        rejected=rejected,
        pending=pending,
    )


# ── Async run helpers ─────────────────────────────────────────────────────────

async def _create_placeholder_run(
    db: AsyncSession,
    current_user: User,
    sap_bytes: bytes,
    as26_bytes: bytes,
    sap_filename: str,
    as26_filename: str,
    financial_year: str,
    batch_id: Optional[str] = None,
    deductor_filter_parties: Optional[list] = None,
) -> ReconciliationRun:
    """Create a PROCESSING run record so we can return run_id immediately."""
    from core.security import sha256_file
    from core.audit import log_event as _log
    from db.models import RunCounter

    sap_hash = sha256_file(sap_bytes)
    as26_hash = sha256_file(as26_bytes)

    # Atomic run number increment — use with_for_update() to prevent race conditions
    # (SQLite serializes writes via WAL; PostgreSQL uses SELECT FOR UPDATE row lock)
    result = await db.execute(
        select(RunCounter).where(RunCounter.id == 1).with_for_update()
    )
    counter = result.scalar_one_or_none()
    if not counter:
        counter = RunCounter(id=1, current_value=0)
        db.add(counter)
        await db.flush()
    counter.current_value += 1
    await db.flush()
    run_num = counter.current_value

    run = ReconciliationRun(
        run_number=run_num,
        financial_year=financial_year,
        sap_filename=sap_filename,
        as26_filename=as26_filename,
        sap_file_hash=sap_hash,
        as26_file_hash=as26_hash,
        sap_file_blob=sap_bytes,
        as26_file_blob=as26_bytes,
        deductor_filter_parties=deductor_filter_parties,
        algorithm_version=settings.ALGORITHM_VERSION,
        config_snapshot={},
        status="PROCESSING",
        mode="BATCH" if batch_id else "SINGLE",
        batch_id=batch_id,
        created_by_id=current_user.id,
        started_at=datetime.now(timezone.utc),
    )
    db.add(run)
    await db.flush()

    await _log(db, "RUN_STARTED",
               f"Run RUN-{run_num:04d} queued for FY {financial_year}",
               run_id=run.id, user_id=current_user.id,
               metadata={"sap_hash": sap_hash, "as26_hash": as26_hash})
    return run


async def _run_reconciliation_background(
    run_id: str,
    user_id: str,
    sap_bytes: bytes,
    as26_bytes: bytes,
    sap_filename: str,
    as26_filename: str,
    financial_year: str,
    batch_id: Optional[str] = None,
    deductor_filter_parties: Optional[list] = None,
    run_config: Optional[dict] = None,
):
    """Run reconciliation in a background task with its own DB session."""
    from db.base import AsyncSessionLocal
    from services.reconcile_service import run_reconciliation_on_existing_run
    import logging as _log
    import traceback

    logger = _log.getLogger(__name__)
    logger.info(f"Background task started for run {run_id}")

    try:
        async with AsyncSessionLocal() as db:
            try:
                user_result = await db.execute(select(User).where(User.id == user_id))
                user = user_result.scalar_one()

                await run_reconciliation_on_existing_run(
                    db=db,
                    current_user=user,
                    run_id=run_id,
                    sap_bytes=sap_bytes,
                    as26_bytes=as26_bytes,
                    sap_filename=sap_filename,
                    as26_filename=as26_filename,
                    financial_year=financial_year,
                    batch_id=batch_id,
                    deductor_filter_parties=deductor_filter_parties,
                    run_config=run_config,
                )
                await db.commit()
                # Mark progress COMPLETE only after DB commit so UI reads consistent state
                progress_store.mark_complete(run_id)
                logger.info(f"Background task completed for run {run_id}")
            except Exception as e:
                logger.error(f"Background run {run_id} failed: {e}\n{traceback.format_exc()}")
                await db.rollback()
                # Mark run as FAILED in a fresh transaction, with error message
                err_msg = str(e)[:2000]  # Truncate to prevent overflow
                try:
                    from sqlalchemy import text as sql_text
                    await db.execute(
                        sql_text("UPDATE reconciliation_runs SET status='FAILED', error_message=:err WHERE id=:rid"),
                        {"rid": run_id, "err": err_msg},
                    )
                    await db.commit()
                except Exception as e2:
                    logger.error(f"Failed to mark run {run_id} as FAILED: {e2}")
                progress_store.mark_failed(run_id, err_msg)
    except Exception as outer:
        logger.error(f"Background task outer crash for run {run_id}: {outer}\n{traceback.format_exc()}")
        err_msg = str(outer)[:2000]
        progress_store.mark_failed(run_id, err_msg)
        # Last resort: raw SQL to mark failed
        try:
            from db.base import AsyncSessionLocal as _ASL
            async with _ASL() as emergency_db:
                from sqlalchemy import text as sql_text
                await emergency_db.execute(
                    sql_text("UPDATE reconciliation_runs SET status='FAILED', error_message=:err WHERE id=:rid"),
                    {"rid": run_id, "err": err_msg},
                )
                await emergency_db.commit()
        except Exception:
            pass


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _get_run_or_404(run_id: str, db: AsyncSession) -> ReconciliationRun:
    result = await db.execute(select(ReconciliationRun).where(ReconciliationRun.id == run_id))
    run = result.scalar_one_or_none()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return run


def _run_to_summary(r: ReconciliationRun) -> RunSummary:
    return RunSummary(
        id=r.id, run_number=r.run_number, financial_year=r.financial_year,
        deductor_name=r.deductor_name, tan=r.tan, status=r.status,
        match_rate_pct=r.match_rate_pct, matched_count=r.matched_count,
        total_26as_entries=r.total_26as_entries,
        total_sap_entries=r.total_sap_entries or 0,
        suggested_count=r.suggested_count or 0,
        unmatched_26as_count=r.unmatched_26as_count,
        high_confidence_count=r.high_confidence_count,
        medium_confidence_count=r.medium_confidence_count,
        low_confidence_count=r.low_confidence_count,
        constraint_violations=r.constraint_violations,
        control_total_balanced=r.control_total_balanced,
        has_pan_issues=r.has_pan_issues,
        has_rate_mismatches=r.has_rate_mismatches,
        algorithm_version=r.algorithm_version,
        sap_file_hash=r.sap_file_hash,
        as26_file_hash=r.as26_file_hash,
        created_at=r.created_at.isoformat(),
        completed_at=r.completed_at.isoformat() if r.completed_at else None,
        mode=r.mode,
        batch_id=r.batch_id,
        error_message=r.error_message,
        total_26as_amount=r.total_26as_amount or 0.0,
        matched_amount=r.matched_amount or 0.0,
        unmatched_26as_amount=r.unmatched_26as_amount or 0.0,
    )


def _mp_to_dict(p: MatchedPair) -> dict:
    refs = p.invoice_refs or []
    return {
        "id": p.id, "as26_index": p.as26_index, "as26_amount": p.as26_amount,
        "as26_date": p.as26_date, "section": p.section, "books_sum": p.books_sum,
        "variance_pct": p.variance_pct, "variance_amt": p.variance_amt,
        "match_type": p.match_type, "confidence": p.confidence,
        "composite_score": p.composite_score,
        "invoice_count": len(refs),
        "score_breakdown": {
            "variance": p.score_variance, "date_proximity": p.score_date_proximity,
            "section": p.score_section_match, "clearing_doc": p.score_clearing_doc,
            "historical": p.score_historical,
        },
        "invoice_refs": refs, "invoice_amounts": p.invoice_amounts,
        "invoice_dates": p.invoice_dates, "clearing_doc": p.clearing_doc,
        "cross_fy": p.cross_fy, "is_prior_year": p.is_prior_year,
        "ai_risk_flag": p.ai_risk_flag, "ai_risk_reason": p.ai_risk_reason,
        "remark": p.remark,
    }


def _exc_to_dict(e: ExceptionRecord) -> dict:
    return {
        "id": e.id, "exception_type": e.exception_type, "severity": e.severity,
        "category": e.exception_type,
        "description": e.description, "amount": e.amount, "section": e.section,
        "reviewed": e.reviewed, "review_action": e.review_action,
        "review_notes": e.review_notes, "reviewed_at": e.reviewed_at.isoformat() if e.reviewed_at else None,
        "created_at": e.created_at.isoformat(),
    }


def _suggested_to_out(s: SuggestedMatch) -> SuggestedMatchOut:
    return SuggestedMatchOut(
        id=s.id,
        run_id=s.run_id,
        as26_row_hash=s.as26_row_hash,
        as26_index=s.as26_index,
        as26_amount=s.as26_amount,
        as26_date=s.as26_date,
        section=s.section,
        tan=s.tan,
        deductor_name=s.deductor_name,
        invoice_refs=s.invoice_refs,
        invoice_amounts=s.invoice_amounts,
        invoice_dates=s.invoice_dates,
        clearing_doc=s.clearing_doc,
        books_sum=s.books_sum,
        match_type=s.match_type,
        variance_amt=s.variance_amt,
        variance_pct=s.variance_pct,
        confidence=s.confidence,
        composite_score=s.composite_score,
        score_variance=s.score_variance,
        score_date_proximity=s.score_date_proximity,
        score_section_match=s.score_section_match,
        score_clearing_doc=s.score_clearing_doc,
        score_historical=s.score_historical,
        cross_fy=s.cross_fy,
        is_prior_year=s.is_prior_year,
        category=s.category,
        requires_remarks=s.requires_remarks,
        alert_message=s.alert_message,
        authorized=s.authorized,
        authorized_by_id=s.authorized_by_id,
        authorized_at=s.authorized_at.isoformat() if s.authorized_at else None,
        remarks=s.remarks,
        rejected=s.rejected,
        rejected_by_id=s.rejected_by_id,
        rejected_at=s.rejected_at.isoformat() if s.rejected_at else None,
        rejection_reason=s.rejection_reason,
        created_at=s.created_at.isoformat(),
    )
