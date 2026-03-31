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

from core.audit import log_event, verify_audit_chain
from core.deps import get_current_user, require_reviewer
from core.security import sha256_file
from core.settings import settings
from db.base import get_db
from db.models import ReconciliationRun, MatchedPair, Unmatched26AS, UnmatchedBook, ExceptionRecord, User, SuggestedMatch, RunComment, AdminSettings
from services.reconcile_service import run_reconciliation
from services import progress_store

router = APIRouter(prefix="/api/runs", tags=["runs"])

# Hold strong references to background tasks to prevent GC from killing them.
# Python's event loop only keeps weak refs — without this, tasks vanish mid-execution.
_background_tasks: set = set()

# Per-batch semaphores for concurrency control.
# batch_id → asyncio.Semaphore. Cleaned up when batch sessions expire or on reuse.
_batch_semaphores: Dict[str, asyncio.Semaphore] = {}

# Per-batch failure counters for stop-on-failure (7I).
# batch_id → count of failed runs. Checked before each run starts processing.
_batch_failure_counts: Dict[str, int] = {}


async def _get_batch_concurrency_limit(db: AsyncSession) -> int:
    """Read current batch_concurrency_limit from active AdminSettings.
    SQLite only supports one writer at a time, so cap at 2 to avoid 'database is locked'.
    """
    from db.models import AdminSettings
    from db.base import _is_sqlite
    result = await db.execute(
        select(AdminSettings).where(AdminSettings.is_active == True)
    )
    s = result.scalar_one_or_none()
    limit = (s.batch_concurrency_limit if s and s.batch_concurrency_limit else 10)
    if _is_sqlite:
        limit = min(limit, 2)
    return limit


def _get_or_create_batch_semaphore(batch_id: str, limit: int) -> asyncio.Semaphore:
    """Get or create a semaphore for the given batch."""
    if batch_id not in _batch_semaphores:
        _batch_semaphores[batch_id] = asyncio.Semaphore(limit)
    return _batch_semaphores[batch_id]


async def _is_duplicate_detection_enabled(db: AsyncSession) -> bool:
    """Check if smart duplicate detection is enabled in admin settings."""
    from db.models import AdminSettings
    result = await db.execute(
        select(AdminSettings).where(AdminSettings.is_active == True)
    )
    s = result.scalar_one_or_none()
    return bool(s and s.batch_duplicate_detection_enabled)


async def _check_duplicate_sap_hash(
    db: AsyncSession, sap_hash: str, current_batch_id: Optional[str] = None,
) -> list[dict]:
    """
    Check if an SAP file hash already exists in prior completed runs.
    Returns list of prior run summaries that share the same hash.
    Excludes runs from the current batch (same file is expected within a batch).
    """
    query = (
        select(ReconciliationRun)
        .where(
            ReconciliationRun.sap_file_hash == sap_hash,
            ReconciliationRun.status.in_(["PENDING_REVIEW", "APPROVED", "REJECTED"]),
        )
        .order_by(desc(ReconciliationRun.created_at))
        .limit(5)
    )
    if current_batch_id:
        query = query.where(ReconciliationRun.batch_id != current_batch_id)
    result = await db.execute(query)
    rows = result.scalars().all()
    return [
        {
            "run_id": r.id,
            "run_number": r.run_number,
            "batch_id": r.batch_id,
            "deductor_name": r.deductor_name,
            "financial_year": r.financial_year,
            "status": r.status,
            "match_rate_pct": r.match_rate_pct,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "sap_filename": r.sap_filename,
        }
        for r in rows
    ]


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
    batch_name: Optional[str] = None
    batch_tags: Optional[list] = None
    parent_batch_id: Optional[str] = None
    error_message: Optional[str] = None
    # Amount totals
    total_26as_amount: float = 0.0
    total_sap_amount: float = 0.0
    matched_amount: float = 0.0
    unmatched_26as_amount: float = 0.0
    # Phase 4 fields
    assigned_reviewer_id: Optional[str] = None
    archived: bool = False


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
    # Phase 7G: Admin-configurable upload size limit
    _adm_r = await db.execute(select(AdminSettings).where(AdminSettings.is_active == True))
    _adm = _adm_r.scalar_one_or_none()
    _max_mb = getattr(_adm, 'max_upload_size_mb', None) or settings.MAX_UPLOAD_MB
    max_bytes = _max_mb * 1024 * 1024
    sap_bytes = await sap_file.read()
    as26_bytes = await as26_file.read()

    if len(sap_bytes) > max_bytes or len(as26_bytes) > max_bytes:
        raise HTTPException(status_code=413, detail=f"File exceeds {_max_mb}MB limit")

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
    include_archived: bool = False,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    q = select(ReconciliationRun)
    if not include_archived:
        q = q.where(ReconciliationRun.archived == False)
    q = q.order_by(desc(ReconciliationRun.created_at)).limit(limit).offset(offset)
    result = await db.execute(q)
    runs = list(result.scalars().all())
    return [_run_to_summary(r) for r in runs]


@router.get("/trends")
async def variance_trends(
    deductor_name: Optional[str] = None,
    financial_year: Optional[str] = None,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Historical match rate trends for a deductor across batches.
    Returns data points sorted by date — useful for trend charts.
    Omit deductor_name for overall trends across all parties.
    """
    query = (
        select(ReconciliationRun)
        .where(ReconciliationRun.status.in_(["PENDING_REVIEW", "APPROVED", "REJECTED"]))
    )
    if deductor_name:
        query = query.where(func.lower(ReconciliationRun.deductor_name) == deductor_name.lower().strip())
    if financial_year:
        query = query.where(ReconciliationRun.financial_year == financial_year)
    query = query.order_by(ReconciliationRun.created_at.asc()).limit(limit)

    result = await db.execute(query)
    runs = result.scalars().all()

    data_points = []
    for r in runs:
        data_points.append({
            "run_id": r.id,
            "run_number": r.run_number,
            "deductor_name": r.deductor_name,
            "financial_year": r.financial_year,
            "batch_id": r.batch_id,
            "match_rate_pct": r.match_rate_pct,
            "matched_count": r.matched_count,
            "suggested_count": r.suggested_count,
            "unmatched_26as_count": r.unmatched_26as_count,
            "total_26as_entries": r.total_26as_entries,
            "constraint_violations": r.constraint_violations,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        })

    # Aggregate stats
    rates = [p["match_rate_pct"] for p in data_points if p["match_rate_pct"] is not None]
    return {
        "data_points": data_points,
        "count": len(data_points),
        "avg_match_rate": round(sum(rates) / len(rates), 2) if rates else None,
        "min_match_rate": round(min(rates), 2) if rates else None,
        "max_match_rate": round(max(rates), 2) if rates else None,
        "trend_direction": (
            "improving" if len(rates) >= 2 and rates[-1] > rates[0]
            else "declining" if len(rates) >= 2 and rates[-1] < rates[0]
            else "stable"
        ),
    }


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
        matched_result = await db.execute(
            select(MatchedPair).where(MatchedPair.run_id == run.id).order_by(MatchedPair.as26_index)
        )
        unmatched_result = await db.execute(
            select(Unmatched26AS).where(Unmatched26AS.run_id == run.id).order_by(Unmatched26AS.amount.desc())
        )
        books_result = await db.execute(
            select(UnmatchedBook).where(UnmatchedBook.run_id == run.id).order_by(UnmatchedBook.amount.desc())
        )
        exc_result = await db.execute(
            select(ExceptionRecord).where(ExceptionRecord.run_id == run.id).order_by(ExceptionRecord.severity)
        )
        suggested_result = await db.execute(
            select(SuggestedMatch).where(SuggestedMatch.run_id == run.id)
        )

        rd = {
            "run": run,
            "matched_pairs": list(matched_result.scalars().all()),
            "unmatched_26as": list(unmatched_result.scalars().all()),
            "unmatched_books": list(books_result.scalars().all()),
            "exceptions": list(exc_result.scalars().all()),
            "suggested_matches": list(suggested_result.scalars().all()),
        }
        runs_data.append(rd)

    # Load admin-configured variance thresholds for Excel color coding
    from db.models import AdminSettings
    adm_result = await db.execute(
        select(AdminSettings).where(AdminSettings.is_active == True)
    )
    adm = adm_result.scalar_one_or_none()
    var_ceiling = adm.variance_normal_ceiling_pct if adm and adm.variance_normal_ceiling_pct is not None else 3.0
    var_thresholds = (1.0, var_ceiling)
    export_template = (adm.batch_export_template if adm and adm.batch_export_template else "standard")

    _ctrl_totals = adm.amount_control_totals_enabled if adm and adm.amount_control_totals_enabled is not None else True
    _match_dist = adm.match_type_distribution_enabled if adm and adm.match_type_distribution_enabled is not None else True
    # Phase 6H: Excel sheet selection overrides
    if adm and hasattr(adm, 'excel_include_control_totals') and adm.excel_include_control_totals is not None:
        _ctrl_totals = adm.excel_include_control_totals
    if adm and hasattr(adm, 'excel_include_match_distribution') and adm.excel_include_match_distribution is not None:
        _match_dist = adm.excel_include_match_distribution
    _var_analysis = adm.excel_include_variance_analysis if adm and hasattr(adm, 'excel_include_variance_analysis') and adm.excel_include_variance_analysis is not None else True

    from services.excel_v2 import generate_batch_excel
    excel_bytes = generate_batch_excel(
        runs_data, variance_thresholds=var_thresholds, template=export_template,
        amount_control_totals_enabled=_ctrl_totals,
        match_type_distribution_enabled=_match_dist,
        variance_analysis_enabled=_var_analysis,
        watermark_text=(getattr(adm, 'export_watermark_text', 'CONFIDENTIAL') or 'CONFIDENTIAL') if adm and getattr(adm, 'export_watermark_enabled', False) else None,
        redact_pan=bool(adm and getattr(adm, 'redact_pan_in_exports', False)),
    )

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
    Rerun an entire batch in-place using the stored file bytes.
    Clears existing results for each run and re-processes with current settings.
    """
    # Fetch batch runs
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

    # 7I: Check partial resume — skip already-successful runs
    partial_resume = False
    try:
        from db.models import AdminSettings as _AS
        _adm_res = await db.execute(select(_AS).where(_AS.is_active == True))
        _adm = _adm_res.scalar_one_or_none()
        partial_resume = bool(_adm and getattr(_adm, 'batch_partial_resume_enabled', False))
    except Exception:
        pass

    if partial_resume:
        _success_statuses = {"APPROVED", "PENDING_REVIEW", "COMPLETED"}
        runs_to_rerun = [r for r in original_runs if r.status not in _success_statuses]
        skipped_count = len(original_runs) - len(runs_to_rerun)
    else:
        runs_to_rerun = original_runs
        skipped_count = 0

    runs_summary = []

    # Create batch semaphore for concurrency control (same batch_id)
    concurrency_limit = await _get_batch_concurrency_limit(db)
    batch_sem = _get_or_create_batch_semaphore(batch_id, concurrency_limit)

    for run in runs_to_rerun:
        await _reset_run_for_rerun(db, run)

        runs_summary.append({
            "run_id": run.id,
            "run_number": run.run_number,
            "sap_filename": run.sap_filename,
            "deductor_name": run.deductor_name,
            "status": "PROCESSING",
        })

    await db.commit()

    # Launch background tasks after commit so all runs are visible as PROCESSING
    for run in runs_to_rerun:
        task = asyncio.create_task(
            _run_reconciliation_background(
                run_id=run.id,
                user_id=current_user.id,
                sap_bytes=run.sap_file_blob,
                as26_bytes=run.as26_file_blob,
                sap_filename=run.sap_filename,
                as26_filename=run.as26_filename,
                financial_year=run.financial_year,
                batch_id=batch_id,
                deductor_filter_parties=run.deductor_filter_parties,
                run_config=None,
                semaphore=batch_sem,
            )
        )
        _background_tasks.add(task)
        task.add_done_callback(_background_tasks.discard)

    _rerun_detail = f"Batch rerun in-place: {len(runs_summary)} runs in batch {batch_id} by {current_user.full_name}"
    if skipped_count > 0:
        _rerun_detail += f" (partial resume: {skipped_count} successful runs skipped)"
    await log_event(db, "BATCH_RERUN", _rerun_detail,
                    run_id=original_runs[0].id, user_id=current_user.id,
                    metadata={"batch_id": batch_id,
                              "run_count": len(runs_summary), "skipped_count": skipped_count})

    return {"batch_id": batch_id, "runs": runs_summary, "total": len(runs_summary)}


# ── Batch Analytics ──────────────────────────────────────────────────────────

@router.get("/batch/{batch_id}/analytics")
async def batch_analytics(
    batch_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Aggregated analytics for a batch: confidence distribution, match type breakdown,
    section heatmap, financial waterfall, and per-party risk matrix.
    """
    result = await db.execute(
        select(ReconciliationRun)
        .where(ReconciliationRun.batch_id == batch_id)
        .order_by(ReconciliationRun.run_number)
    )
    runs = list(result.scalars().all())
    if not runs:
        raise HTTPException(status_code=404, detail="Batch not found")

    completed = [r for r in runs if r.status not in ("PROCESSING", "FAILED")]

    # ── Confidence distribution (across all matched pairs) ──
    conf_counts = {"HIGH": 0, "MEDIUM": 0, "LOW": 0}
    match_type_counts: Dict[str, int] = {}
    section_amounts: Dict[str, float] = {}

    for run in completed:
        mp_result = await db.execute(
            select(MatchedPair).where(MatchedPair.run_id == run.id)
        )
        pairs = list(mp_result.scalars().all())
        for mp in pairs:
            conf_counts[mp.confidence] = conf_counts.get(mp.confidence, 0) + 1
            mt = mp.match_type or "UNKNOWN"
            match_type_counts[mt] = match_type_counts.get(mt, 0) + 1
            sec = mp.section or "N/A"
            section_amounts[sec] = section_amounts.get(sec, 0) + (mp.as26_amount or 0)

    # ── Financial waterfall ──
    total_26as = sum(r.total_26as_amount or 0 for r in completed)
    total_matched = sum(r.matched_amount or 0 for r in completed)
    total_unmatched = sum(r.unmatched_26as_amount or 0 for r in completed)
    total_suggested = total_26as - total_matched - total_unmatched

    # ── Per-party risk matrix ──
    risk_matrix = []
    for run in completed:
        risk_matrix.append({
            "run_id": run.id,
            "deductor_name": run.deductor_name or "—",
            "match_rate_pct": round(run.match_rate_pct, 2),
            "violations": run.constraint_violations or 0,
            "unmatched_count": run.unmatched_26as_count or 0,
            "unmatched_amount": round(run.unmatched_26as_amount or 0, 2),
            "low_confidence_count": run.low_confidence_count or 0,
            "has_pan_issues": run.has_pan_issues or False,
            "control_total_balanced": run.control_total_balanced if run.control_total_balanced is not None else True,
            # Risk score: weighted composite (higher = more risky)
            "risk_score": round(
                (100 - (run.match_rate_pct or 0)) * 0.4
                + (run.constraint_violations or 0) * 10
                + (run.low_confidence_count or 0) * 2
                + (20 if run.has_pan_issues else 0)
                + (15 if not (run.control_total_balanced if run.control_total_balanced is not None else True) else 0),
                1,
            ),
        })

    risk_matrix.sort(key=lambda x: x["risk_score"], reverse=True)

    return {
        "batch_id": batch_id,
        "total_parties": len(runs),
        "completed_parties": len(completed),
        "confidence_distribution": conf_counts,
        "match_type_breakdown": match_type_counts,
        "section_heatmap": section_amounts,
        "financial_waterfall": {
            "total_26as": round(total_26as, 2),
            "matched": round(total_matched, 2),
            "suggested": round(max(total_suggested, 0), 2),
            "unmatched": round(total_unmatched, 2),
        },
        "risk_matrix": risk_matrix,
    }


@router.get("/batch/{batch_id}/progress")
async def batch_progress(
    batch_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Aggregate real-time progress for all runs in a batch.
    Combines per-run progress from the in-memory progress store
    with DB status for completed/failed runs.
    """
    result = await db.execute(
        select(ReconciliationRun).where(ReconciliationRun.batch_id == batch_id)
    )
    runs = result.scalars().all()
    if not runs:
        raise HTTPException(status_code=404, detail="Batch not found")

    per_run = []
    total_pct = 0.0
    statuses = {"PROCESSING": 0, "PENDING_REVIEW": 0, "APPROVED": 0, "REJECTED": 0, "FAILED": 0}

    for r in runs:
        prog = progress_store.get(r.id)
        if prog:
            run_pct = prog.overall_pct
            stage = prog.stage_label
            status = prog.status
        else:
            # Run completed/failed — no live progress
            run_pct = 100.0 if r.status != "FAILED" else 0.0
            stage = "Complete" if r.status != "FAILED" else "Failed"
            status = r.status

        total_pct += run_pct
        if r.status in statuses:
            statuses[r.status] += 1
        elif status in statuses:
            statuses[status] += 1

        per_run.append({
            "run_id": r.id,
            "run_number": r.run_number,
            "deductor_name": r.deductor_name,
            "sap_filename": r.sap_filename,
            "status": r.status or status,
            "stage": stage,
            "progress_pct": round(run_pct, 1),
            "match_rate_pct": r.match_rate_pct if r.status not in ("PROCESSING", "FAILED") else None,
        })

    total_runs = len(runs)
    overall_pct = round(total_pct / total_runs, 1) if total_runs > 0 else 0.0
    completed = statuses["PENDING_REVIEW"] + statuses["APPROVED"] + statuses["REJECTED"]
    is_complete = (completed + statuses["FAILED"]) == total_runs

    return {
        "batch_id": batch_id,
        "total_runs": total_runs,
        "overall_pct": overall_pct,
        "is_complete": is_complete,
        "statuses": statuses,
        "completed": completed,
        "failed": statuses["FAILED"],
        "processing": statuses["PROCESSING"],
        "runs": per_run,
    }


@router.get("/batch/{batch_id}/compare")
async def batch_compare(
    batch_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Compare a rerun batch against its parent batch.
    Returns per-party deltas for match rate, counts, and amounts.
    """
    # Get current batch runs
    result = await db.execute(
        select(ReconciliationRun).where(ReconciliationRun.batch_id == batch_id)
    )
    current_runs = result.scalars().all()
    if not current_runs:
        raise HTTPException(status_code=404, detail="Batch not found")

    # Find parent batch
    parent_batch_id = current_runs[0].parent_batch_id if current_runs else None
    if not parent_batch_id:
        return {"batch_id": batch_id, "parent_batch_id": None, "has_parent": False, "parties": []}

    # Get parent batch runs
    parent_result = await db.execute(
        select(ReconciliationRun).where(ReconciliationRun.batch_id == parent_batch_id)
    )
    parent_runs = parent_result.scalars().all()

    # Build lookup: deductor_name → parent run stats
    parent_lookup = {}
    for r in parent_runs:
        key = (r.deductor_name or "").lower().strip()
        parent_lookup[key] = {
            "run_id": r.id,
            "run_number": r.run_number,
            "match_rate_pct": r.match_rate_pct,
            "matched_count": r.matched_count,
            "suggested_count": r.suggested_count,
            "unmatched_26as_count": r.unmatched_26as_count,
            "constraint_violations": r.constraint_violations,
            "total_26as_entries": r.total_26as_entries,
            "matched_amount": float(r.matched_amount or 0),
            "unmatched_26as_amount": float(r.unmatched_26as_amount or 0),
        }

    parties = []
    for r in current_runs:
        key = (r.deductor_name or "").lower().strip()
        parent = parent_lookup.get(key)

        current_stats = {
            "run_id": r.id,
            "run_number": r.run_number,
            "deductor_name": r.deductor_name,
            "match_rate_pct": r.match_rate_pct,
            "matched_count": r.matched_count,
            "suggested_count": r.suggested_count,
            "unmatched_26as_count": r.unmatched_26as_count,
            "constraint_violations": r.constraint_violations,
            "total_26as_entries": r.total_26as_entries,
            "matched_amount": float(r.matched_amount or 0),
            "unmatched_26as_amount": float(r.unmatched_26as_amount or 0),
        }

        delta = None
        if parent:
            delta = {
                "match_rate_pct": round((r.match_rate_pct or 0) - (parent["match_rate_pct"] or 0), 2),
                "matched_count": (r.matched_count or 0) - (parent["matched_count"] or 0),
                "suggested_count": (r.suggested_count or 0) - (parent["suggested_count"] or 0),
                "unmatched_26as_count": (r.unmatched_26as_count or 0) - (parent["unmatched_26as_count"] or 0),
                "constraint_violations": (r.constraint_violations or 0) - (parent["constraint_violations"] or 0),
                "matched_amount": round(float(r.matched_amount or 0) - parent["matched_amount"], 2),
                "unmatched_26as_amount": round(float(r.unmatched_26as_amount or 0) - parent["unmatched_26as_amount"], 2),
            }

        parties.append({
            "current": current_stats,
            "parent": parent,
            "delta": delta,
        })

    return {
        "batch_id": batch_id,
        "parent_batch_id": parent_batch_id,
        "has_parent": True,
        "parties": parties,
    }


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
    authorized_run_ids: set = set()  # Track ALL runs with authorized suggestions (for recount)
    confidence_per_run: Dict[str, Dict[str, int]] = {}
    success_count = 0
    skipped_dup = 0

    # Pre-load existing MatchedPair hashes per run to prevent duplicate promotion
    existing_mp_hashes: Dict[str, set] = {}
    # Pre-load consumed invoice refs per run to enforce invoice uniqueness (Section 199 compliance)
    consumed_invoice_refs: Dict[str, set] = {}
    for rid in run_ids:
        mp_result = await db.execute(
            select(MatchedPair.as26_row_hash, MatchedPair.invoice_refs).where(MatchedPair.run_id == rid)
        )
        hashes = set()
        refs = set()
        for row in mp_result.all():
            if row[0]:
                hashes.add(row[0])
            if row[1]:
                try:
                    for ref in (_json.loads(row[1]) if isinstance(row[1], str) else row[1]):
                        if ref:
                            refs.add(ref)
                except (TypeError, _json.JSONDecodeError):
                    pass
        existing_mp_hashes[rid] = hashes
        consumed_invoice_refs[rid] = refs

    # Track hashes promoted in THIS batch to avoid duplicates within the same authorize call
    promoted_hashes: Dict[str, set] = {rid: set() for rid in run_ids}
    skipped_invoice_reuse = 0

    for sm in pending:
        hash_key = sm.as26_row_hash or ""

        # Skip MatchedPair creation if one already exists for this (run_id, as26_row_hash)
        if hash_key and (
            hash_key in existing_mp_hashes.get(sm.run_id, set()) or
            hash_key in promoted_hashes.get(sm.run_id, set())
        ):
            skipped_dup += 1
            sm.authorized = True
            sm.authorized_by_id = current_user.id
            sm.authorized_at = now
            sm.remarks = remarks or "Batch-level authorize all (hash duplicate — promotion skipped)"
            success_count += 1
            authorized_run_ids.add(sm.run_id)
            continue

        # Mark as authorized (same as individual endpoint behaviour)
        sm.authorized = True
        sm.authorized_by_id = current_user.id
        sm.authorized_at = now
        sm.remarks = remarks or "Batch-level authorize all"
        success_count += 1
        authorized_run_ids.add(sm.run_id)

        # Check invoice overlap for audit trail (promote regardless — user explicitly authorized)
        sm_refs = set()
        if sm.invoice_refs:
            try:
                parsed = _json.loads(sm.invoice_refs) if isinstance(sm.invoice_refs, str) else sm.invoice_refs
                sm_refs = {r for r in parsed if r}
            except (TypeError, _json.JSONDecodeError):
                pass
        run_consumed = consumed_invoice_refs.get(sm.run_id, set())
        overlap = sm_refs & run_consumed
        has_invoice_reuse = bool(overlap)
        if has_invoice_reuse:
            skipped_invoice_reuse += 1  # track count for reporting (no longer skips)

        # Build audit remark for high-variance or invoice-reuse matches
        mp_remark = None
        remark_parts = []
        if has_invoice_reuse:
            remark_parts.append(
                f"Invoice reuse: {', '.join(sorted(overlap))} also used in another match. "
                f"Authorized explicitly by {current_user.full_name}."
            )
        if sm.variance_pct > suggested_ceiling_pct:
            remark_parts.append(
                f"Variance ({sm.variance_pct:.2f}%) exceeds suggested ceiling ({suggested_ceiling_pct:.1f}%)."
            )
        if remarks:
            remark_parts.append(f"Reviewer remarks: {remarks}")
        if remark_parts:
            mp_remark = f"Authorized via batch authorize-all by {current_user.full_name}. " + " ".join(remark_parts)

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

        # Track this hash and invoice refs as promoted/consumed
        if hash_key:
            promoted_hashes.setdefault(sm.run_id, set()).add(hash_key)
        if sm_refs:
            consumed_invoice_refs.setdefault(sm.run_id, set()).update(sm_refs)

        # Soft-delete: mark Unmatched26AS as PROMOTED (preserves audit trail)
        if sm.as26_row_hash:
            u_result = await db.execute(
                select(Unmatched26AS).where(
                    Unmatched26AS.run_id == sm.run_id,
                    Unmatched26AS.as26_row_hash == sm.as26_row_hash,
                )
            )
            u_entry = u_result.scalar_one_or_none()
            if u_entry:
                u_entry.status = "PROMOTED"
                u_entry.promoted_at = now
                u_entry.promoted_by_id = current_user.id

        # Track per-run promotion counts
        promoted_per_run[sm.run_id] = promoted_per_run.get(sm.run_id, 0) + 1
        conf = sm.confidence.upper() if sm.confidence else "LOW"
        if sm.run_id not in confidence_per_run:
            confidence_per_run[sm.run_id] = {"HIGH": 0, "MEDIUM": 0, "LOW": 0}
        confidence_per_run[sm.run_id][conf] = confidence_per_run[sm.run_id].get(conf, 0) + 1

    await db.flush()

    # Recount stats for ALL runs that had suggestions authorized (not just promoted)
    for rid in authorized_run_ids:
        run = run_map[rid]
        count_result = await db.execute(
            select(func.count(func.distinct(MatchedPair.as26_row_hash))).where(
                MatchedPair.run_id == rid
            )
        )
        run.matched_count = count_result.scalar() or 0
        unmatched_result = await db.execute(
            select(func.count(Unmatched26AS.id)).where(Unmatched26AS.run_id == rid, Unmatched26AS.status == "ACTIVE")
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

        # ── Recount suggested_count (pending only — not authorized/rejected) ──
        suggested_pending_result = await db.execute(
            select(func.count(SuggestedMatch.id)).where(
                SuggestedMatch.run_id == rid,
                SuggestedMatch.authorized == False,
                SuggestedMatch.rejected == False,
            )
        )
        run.suggested_count = suggested_pending_result.scalar() or 0

        # ── Recompute matched_amount and control_total from live DB amounts ──
        matched_amt_result = await db.execute(
            select(func.sum(MatchedPair.as26_amount)).where(MatchedPair.run_id == rid)
        )
        live_matched_amt = matched_amt_result.scalar() or 0.0
        suggested_amt_result = await db.execute(
            select(func.sum(SuggestedMatch.as26_amount)).where(
                SuggestedMatch.run_id == rid,
                SuggestedMatch.authorized == False,
                SuggestedMatch.rejected == False,
            )
        )
        live_suggested_amt = suggested_amt_result.scalar() or 0.0
        unmatched_amt_result = await db.execute(
            select(func.sum(Unmatched26AS.amount)).where(
                Unmatched26AS.run_id == rid, Unmatched26AS.status == "ACTIVE"
            )
        )
        live_unmatched_amt = unmatched_amt_result.scalar() or 0.0
        run.matched_amount = round(live_matched_amt, 2)
        run.unmatched_26as_amount = round(live_unmatched_amt, 2)
        computed_sum = live_matched_amt + live_suggested_amt + live_unmatched_amt
        run.control_total_balanced = abs(run.total_26as_amount - computed_sum) < 0.02

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

    # Per-item audit trail: log each authorized suggestion with amount and match details
    authorized_items = []
    for sm in pending:
        if sm.authorized:
            authorized_items.append({
                "suggested_match_id": sm.id,
                "run_id": sm.run_id,
                "as26_amount": sm.as26_amount,
                "books_sum": sm.books_sum,
                "variance_pct": round(sm.variance_pct, 2),
                "match_type": sm.match_type,
                "confidence": sm.confidence,
                "invoice_refs": sm.invoice_refs,
            })

    await log_event(db, "BATCH_SUGGESTED_AUTHORIZED",
                    f"Batch authorize-all: {success_count} suggested match(es) authorized across "
                    f"{len(promoted_per_run)} run(s) in batch {batch_id} by {current_user.full_name}",
                    run_id=runs[0].id, user_id=current_user.id,
                    metadata={"batch_id": batch_id, "count": success_count,
                              "runs_affected": len(authorized_run_ids),
                              "skipped_requires_remarks": skipped,
                              "remarks": remarks,
                              "authorized_items": authorized_items})

    return {
        "success_count": success_count,
        "promoted_count": sum(promoted_per_run.values()),
        "skipped_requires_remarks": skipped,
        "skipped_duplicates": skipped_dup,
        "skipped_invoice_reuse": skipped_invoice_reuse,
        "runs_affected": len(authorized_run_ids),
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
                select(func.count(Unmatched26AS.id)).where(Unmatched26AS.run_id == run_id, Unmatched26AS.status == "ACTIVE")
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
    Rerun a single reconciliation in-place using the stored file bytes.
    Clears existing results and re-processes with current settings.
    """
    run = await _get_run_or_404(run_id, db)

    if not run.sap_file_blob or not run.as26_file_blob:
        raise HTTPException(
            status_code=400,
            detail="Original files not stored for this run. Re-upload and run manually.",
        )

    old_config = await _reset_run_for_rerun(db, run)
    await db.commit()

    # Pass run_config=None so rerun picks up CURRENT admin settings
    task = asyncio.create_task(
        _run_reconciliation_background(
            run_id=run.id,
            user_id=current_user.id,
            sap_bytes=run.sap_file_blob,
            as26_bytes=run.as26_file_blob,
            sap_filename=run.sap_filename,
            as26_filename=run.as26_filename,
            financial_year=run.financial_year,
            batch_id=run.batch_id,
            deductor_filter_parties=run.deductor_filter_parties,
            run_config=None,
        )
    )
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)

    await log_event(db, "RUN_RERUN",
                    f"Run #{run.run_number} re-run in-place by {current_user.full_name}",
                    run_id=run.id, user_id=current_user.id,
                    metadata={"previous_config": old_config})

    return {
        "run_id": run.id,
        "run_number": run.run_number,
        "status": "PROCESSING",
    }


@router.get("/{run_id}/matched")
async def get_matched_pairs(
    run_id: str,
    limit: int = 10000,
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
        select(Unmatched26AS).where(Unmatched26AS.run_id == run_id, Unmatched26AS.status == "ACTIVE")
        .order_by(desc(Unmatched26AS.amount))
    )
    entries = result.scalars().all()
    reason_labels = {
        "U01": "No matching invoice found in SAP",
        "U02": "Candidate invoice consumed by another match",
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


# ── Reviewer Assignment (Phase 4C) ───────────────────────────────────────────

class AssignReviewerRequest(BaseModel):
    reviewer_id: Optional[str] = None  # None to unassign


@router.post("/{run_id}/assign-reviewer")
async def assign_reviewer(
    run_id: str,
    body: AssignReviewerRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_reviewer),
):
    """Assign or unassign a reviewer for this run."""
    # Check feature toggle
    _as_result = await db.execute(select(AdminSettings).where(AdminSettings.is_active == True))
    _as = _as_result.scalar_one_or_none()
    if not _as or not _as.reviewer_assignment_enabled:
        raise HTTPException(status_code=400, detail="Reviewer assignment is disabled")

    run = await _get_run_or_404(run_id, db)

    if body.reviewer_id:
        # Validate reviewer exists and has reviewer/admin role
        reviewer_result = await db.execute(select(User).where(User.id == body.reviewer_id))
        reviewer = reviewer_result.scalar_one_or_none()
        if not reviewer:
            raise HTTPException(status_code=404, detail="Reviewer not found")
        if reviewer.role not in ("REVIEWER", "ADMIN"):
            raise HTTPException(status_code=400, detail="User is not a reviewer")
        run.assigned_reviewer_id = reviewer.id
        run.assigned_at = datetime.now(timezone.utc)
        await log_event(db, "REVIEWER_ASSIGNED",
                        f"Run assigned to {reviewer.full_name} by {current_user.full_name}",
                        run_id=run_id)
    else:
        run.assigned_reviewer_id = None
        run.assigned_at = None
        await log_event(db, "REVIEWER_UNASSIGNED",
                        f"Reviewer unassigned by {current_user.full_name}",
                        run_id=run_id)

    await db.commit()
    return {"status": "ok", "assigned_reviewer_id": run.assigned_reviewer_id}


# ── Review Workflow (Maker-Checker) ──────────────────────────────────────────

@router.post("/{run_id}/review")
async def review_run(
    run_id: str,
    body: ReviewRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_reviewer),
):
    """Reviewer approves or rejects the reconciliation run."""
    # Check if approval workflow is enabled
    from db.models import AdminSettings as _AS
    _as_result = await db.execute(select(_AS).where(_AS.is_active == True))
    _as = _as_result.scalar_one_or_none()
    if _as and _as.approval_workflow_enabled is False:
        raise HTTPException(status_code=400, detail="Approval workflow is disabled. Runs are auto-approved.")

    run = await _get_run_or_404(run_id, db)

    # Enforce reviewer assignment if enabled
    if _as and _as.reviewer_assignment_enabled and run.assigned_reviewer_id:
        if run.assigned_reviewer_id != current_user.id:
            raise HTTPException(
                status_code=403,
                detail="This run is assigned to another reviewer. Only the assigned reviewer can approve/reject.",
            )

    if run.created_by_id == current_user.id and not settings.ALLOW_SELF_REVIEW:
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
            select(func.count(Unmatched26AS.id)).where(Unmatched26AS.run_id == run_id, Unmatched26AS.status == "ACTIVE")
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
        from config import MIN_APPROVAL_MATCH_RATE
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
                # Restore Unmatched26AS entry (revert soft-delete, or create if missing)
                existing_u = await db.execute(
                    select(Unmatched26AS).where(
                        Unmatched26AS.run_id == run_id,
                        Unmatched26AS.as26_row_hash == sm.as26_row_hash,
                    )
                )
                u_entry = existing_u.scalar_one_or_none()
                if u_entry:
                    u_entry.status = "ACTIVE"
                    u_entry.promoted_at = None
                    u_entry.promoted_by_id = None
                else:
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
                select(func.count(Unmatched26AS.id)).where(Unmatched26AS.run_id == run_id, Unmatched26AS.status == "ACTIVE")
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
    # Explicit REVIEW_ event for audit trail tab filtering
    await log_event(db, f"REVIEW_{body.action}",
                    f"Run RUN-{run.run_number:04d} reviewed ({body.action.lower()}) by {current_user.full_name}",
                    run_id=run_id, user_id=current_user.id,
                    metadata={"reviewer": current_user.full_name, "reviewer_role": current_user.role,
                              "action": body.action, "notes": body.notes,
                              "match_rate_pct": run.match_rate_pct})

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


# ── Batch Metadata ─────────────────────────────────────────────────────────

class BatchMetadataUpdate(BaseModel):
    batch_name: Optional[str] = None
    batch_tags: Optional[list] = None


@router.patch("/batch/{batch_id}/metadata", status_code=200)
async def update_batch_metadata(
    batch_id: str,
    body: BatchMetadataUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update batch name and/or tags across all runs in a batch."""
    result = await db.execute(
        select(ReconciliationRun).where(ReconciliationRun.batch_id == batch_id)
    )
    runs = list(result.scalars().all())
    if not runs:
        raise HTTPException(status_code=404, detail="Batch not found")

    for run in runs:
        if body.batch_name is not None:
            run.batch_name = body.batch_name
        if body.batch_tags is not None:
            run.batch_tags = body.batch_tags

    await db.commit()
    return {
        "batch_id": batch_id,
        "batch_name": body.batch_name or runs[0].batch_name,
        "batch_tags": body.batch_tags or runs[0].batch_tags,
        "updated_runs": len(runs),
    }


# ── Batch Scheduling ─────────────────────────────────────────────────────

class BatchScheduleRequest(BaseModel):
    scheduled_at: str  # ISO 8601 UTC datetime


@router.post("/batch/{batch_id}/schedule", status_code=200)
async def schedule_batch_rerun(
    batch_id: str,
    body: BatchScheduleRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Schedule a batch rerun at a future time. Requires scheduling to be enabled."""
    from db.models import AdminSettings
    adm_result = await db.execute(
        select(AdminSettings).where(AdminSettings.is_active == True)
    )
    adm = adm_result.scalar_one_or_none()
    if not (adm and adm.batch_scheduling_enabled):
        raise HTTPException(status_code=400, detail="Batch scheduling is not enabled")

    # Verify batch exists
    result = await db.execute(
        select(ReconciliationRun).where(ReconciliationRun.batch_id == batch_id).limit(1)
    )
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Batch not found")

    try:
        scheduled_at = datetime.fromisoformat(body.scheduled_at.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid datetime format — use ISO 8601")

    if scheduled_at <= datetime.now(timezone.utc):
        raise HTTPException(status_code=422, detail="Scheduled time must be in the future")

    from services.scheduler import schedule_batch_rerun as _schedule

    async def _rerun_callback(bid: str, uid: str):
        from db.base import AsyncSessionLocal
        async with AsyncSessionLocal() as sched_db:
            user_result = await sched_db.execute(select(User).where(User.id == uid))
            user = user_result.scalar_one()
            # Re-use the existing rerun logic
            result = await sched_db.execute(
                select(ReconciliationRun).where(ReconciliationRun.batch_id == bid)
            )
            original_runs = list(result.scalars().all())
            new_batch_id = str(uuid.uuid4())
            limit = await _get_batch_concurrency_limit(sched_db)
            sem = _get_or_create_batch_semaphore(new_batch_id, limit)

            for orig in original_runs:
                if not orig.sap_file_blob or not orig.as26_file_blob:
                    continue
                new_run = await _create_placeholder_run(
                    sched_db, user, orig.sap_file_blob, orig.as26_file_blob,
                    orig.sap_filename, orig.as26_filename, orig.financial_year,
                    batch_id=new_batch_id,
                    deductor_filter_parties=orig.deductor_filter_parties,
                    parent_batch_id=bid,
                )
                await sched_db.commit()
                task = asyncio.create_task(
                    _run_reconciliation_background(
                        run_id=new_run.id, user_id=uid,
                        sap_bytes=orig.sap_file_blob, as26_bytes=orig.as26_file_blob,
                        sap_filename=orig.sap_filename, as26_filename=orig.as26_filename,
                        financial_year=orig.financial_year,
                        batch_id=new_batch_id,
                        deductor_filter_parties=orig.deductor_filter_parties,
                        semaphore=sem,
                    )
                )
                _background_tasks.add(task)
                task.add_done_callback(_background_tasks.discard)

    info = await _schedule(batch_id, scheduled_at, current_user.id, _rerun_callback)
    return info


@router.get("/batch/{batch_id}/schedule")
async def get_batch_schedule(
    batch_id: str,
    current_user: User = Depends(get_current_user),
):
    """Check the schedule status for a batch."""
    from services.scheduler import get_schedule
    schedule = get_schedule(batch_id)
    if not schedule:
        return {"batch_id": batch_id, "scheduled": False}
    return {"batch_id": batch_id, "scheduled": True, **schedule}


@router.delete("/batch/{batch_id}/schedule")
async def cancel_batch_schedule(
    batch_id: str,
    current_user: User = Depends(get_current_user),
):
    """Cancel a pending scheduled rerun."""
    from services.scheduler import cancel_schedule
    cancelled = cancel_schedule(batch_id)
    if not cancelled:
        raise HTTPException(status_code=404, detail="No pending schedule found for this batch")
    return {"batch_id": batch_id, "status": "cancelled"}


# ── Config Snapshot Diff ──────────────────────────────────────────────────

@router.get("/{run_id}/config-diff")
async def get_config_diff(
    run_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Compare this run's config snapshot against its parent (rerun source).
    Returns the diff: fields that changed between the original and this run.
    """
    run = await _get_run_or_404(run_id, db)
    current_config = run.config_snapshot or run.run_config or {}

    # Find parent run to diff against
    parent_config = {}
    parent_id = None

    if run.parent_batch_id:
        # This is a rerun — find the original batch's first run
        result = await db.execute(
            select(ReconciliationRun)
            .where(ReconciliationRun.batch_id == run.parent_batch_id)
            .order_by(ReconciliationRun.run_number)
            .limit(1)
        )
        parent_run = result.scalar_one_or_none()
        if parent_run:
            parent_config = parent_run.config_snapshot or parent_run.run_config or {}
            parent_id = parent_run.id

    if not parent_config:
        return {
            "run_id": run_id,
            "parent_id": None,
            "has_parent": False,
            "diff": [],
            "current_config": current_config,
        }

    # Compute diff
    all_keys = set(current_config.keys()) | set(parent_config.keys())
    diff = []
    for key in sorted(all_keys):
        old_val = parent_config.get(key)
        new_val = current_config.get(key)
        if old_val != new_val:
            diff.append({
                "field": key,
                "old_value": old_val,
                "new_value": new_val,
            })

    return {
        "run_id": run_id,
        "parent_id": parent_id,
        "has_parent": True,
        "diff": diff,
        "current_config": current_config,
        "parent_config": parent_config,
    }


# ── Delete ────────────────────────────────────────────────────────────────

@router.delete("/batch/{batch_id}", status_code=200)
async def delete_batch(
    batch_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete an entire batch and all its runs with associated data.
    Audit logs are PRESERVED for regulatory compliance — only result data is deleted.
    """
    result = await db.execute(
        select(ReconciliationRun).where(ReconciliationRun.batch_id == batch_id)
    )
    runs = list(result.scalars().all())
    if not runs:
        raise HTTPException(status_code=404, detail=f"Batch {batch_id} not found")

    processing = [r for r in runs if r.status == "PROCESSING"]
    if processing:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot delete batch — {len(processing)} run(s) still processing. Wait for them to finish or cancel first.",
        )

    run_numbers = [r.run_number for r in runs]
    await log_event(db, "BATCH_DELETED",
                    f"Batch {batch_id} ({len(runs)} runs) deleted by {current_user.full_name}",
                    run_id=runs[0].id, user_id=current_user.id,
                    metadata={"batch_id": batch_id, "run_count": len(runs),
                              "run_numbers": run_numbers})

    for run in runs:
        for model in [MatchedPair, SuggestedMatch, Unmatched26AS, UnmatchedBook, ExceptionRecord]:
            await db.execute(
                model.__table__.delete().where(model.run_id == run.id)
            )
        await db.delete(run)

    await db.flush()

    return {"status": "DELETED", "batch_id": batch_id, "deleted_runs": len(runs),
            "run_numbers": run_numbers}


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
    matched_result = await db.execute(
        select(MatchedPair).where(MatchedPair.run_id == run_id).order_by(MatchedPair.as26_index)
    )
    unmatched_result = await db.execute(
        select(Unmatched26AS).where(Unmatched26AS.run_id == run_id).order_by(Unmatched26AS.amount.desc())
    )
    books_result = await db.execute(
        select(UnmatchedBook).where(UnmatchedBook.run_id == run_id).order_by(UnmatchedBook.amount.desc())
    )
    exc_result = await db.execute(
        select(ExceptionRecord).where(ExceptionRecord.run_id == run_id).order_by(ExceptionRecord.severity)
    )
    suggested_result = await db.execute(
        select(SuggestedMatch).where(SuggestedMatch.run_id == run_id)
    )

    matched_pairs = matched_result.scalars().all()
    unmatched_26as = unmatched_result.scalars().all()
    unmatched_books = books_result.scalars().all()
    exceptions = exc_result.scalars().all()
    suggested_matches = list(suggested_result.scalars().all())

    # Load admin-configured variance thresholds for Excel color coding
    from db.models import AdminSettings
    adm_result = await db.execute(
        select(AdminSettings).where(AdminSettings.is_active == True)
    )
    adm = adm_result.scalar_one_or_none()
    var_ceiling = adm.variance_normal_ceiling_pct if adm and adm.variance_normal_ceiling_pct is not None else 3.0
    var_thresholds = (1.0, var_ceiling)

    # Generate Excel using v2 generator
    _ctrl_totals_s = adm.amount_control_totals_enabled if adm and adm.amount_control_totals_enabled is not None else True
    _match_dist_s = adm.match_type_distribution_enabled if adm and adm.match_type_distribution_enabled is not None else True
    # Phase 6H: Excel sheet selection
    _var_analysis_s = adm.excel_include_variance_analysis if adm and hasattr(adm, 'excel_include_variance_analysis') and adm.excel_include_variance_analysis is not None else True
    _ctrl_totals_s = adm.excel_include_control_totals if adm and hasattr(adm, 'excel_include_control_totals') and adm.excel_include_control_totals is not None else _ctrl_totals_s
    _match_dist_s = adm.excel_include_match_distribution if adm and hasattr(adm, 'excel_include_match_distribution') and adm.excel_include_match_distribution is not None else _match_dist_s

    # Phase 7E/7F: Export security + PII protection
    _wm_text = None
    if adm and getattr(adm, 'export_watermark_enabled', False):
        _wm_text = getattr(adm, 'export_watermark_text', 'CONFIDENTIAL') or 'CONFIDENTIAL'
    _redact_pan = adm and getattr(adm, 'redact_pan_in_exports', False)

    from services.excel_v2 import generate_excel_v2
    excel_bytes = generate_excel_v2(run, matched_pairs, unmatched_26as, unmatched_books, exceptions,
                                    suggested_matches=suggested_matches,
                                    variance_thresholds=var_thresholds,
                                    amount_control_totals_enabled=_ctrl_totals_s,
                                    match_type_distribution_enabled=_match_dist_s,
                                    variance_analysis_enabled=_var_analysis_s,
                                    watermark_text=_wm_text,
                                    redact_pan=_redact_pan)

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


# ── Compliance Report (Phase 4F) ─────────────────────────────────────────────

@router.get("/{run_id}/compliance-report")
async def download_compliance_report(
    run_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_reviewer),
):
    """Download audit-ready compliance report Excel."""
    _as_result = await db.execute(select(AdminSettings).where(AdminSettings.is_active == True))
    _as = _as_result.scalar_one_or_none()
    if _as and _as.compliance_report_enabled is False:
        raise HTTPException(status_code=400, detail="Compliance report export is disabled")

    run = await _get_run_or_404(run_id, db)
    if run.status not in ("APPROVED", "PENDING_REVIEW", "REJECTED"):
        raise HTTPException(status_code=400, detail=f"Run not yet complete (status: {run.status})")

    matched_result = await db.execute(select(MatchedPair).where(MatchedPair.run_id == run_id))
    unmatched_result = await db.execute(select(Unmatched26AS).where(Unmatched26AS.run_id == run_id))
    exc_result = await db.execute(select(ExceptionRecord).where(ExceptionRecord.run_id == run_id))
    suggested_result = await db.execute(select(SuggestedMatch).where(SuggestedMatch.run_id == run_id))

    from services.excel_v2 import generate_compliance_report
    buf = generate_compliance_report(
        run,
        list(matched_result.scalars().all()),
        list(unmatched_result.scalars().all()),
        list(exc_result.scalars().all()),
        list(suggested_result.scalars().all()),
    )

    await log_event(db, "COMPLIANCE_REPORT_DOWNLOADED",
                    f"Compliance report downloaded for RUN-{run.run_number:04d}",
                    run_id=run_id, user_id=current_user.id)

    filename = f"Compliance_Report_{run.deductor_name or 'run'}_{run.financial_year}_RUN{run.run_number:04d}.xlsx"
    return StreamingResponse(
        buf,
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


# ── Duplicate Detection ───────────────────────────────────────────────────────

@router.post("/batch/check-duplicates", status_code=200)
async def check_sap_duplicates(
    sap_files: List[UploadFile] = File(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Check if any uploaded SAP files have been processed before (by SHA-256 hash).
    Returns duplicate info per file. Only active when batch_duplicate_detection_enabled.
    """
    enabled = await _is_duplicate_detection_enabled(db)
    if not enabled:
        return {"enabled": False, "duplicates": []}

    results = []
    for f in sap_files:
        file_bytes = await f.read()
        file_hash = sha256_file(file_bytes)
        await f.seek(0)  # reset for potential re-read
        prior_runs = await _check_duplicate_sap_hash(db, file_hash)
        if prior_runs:
            results.append({
                "sap_filename": f.filename,
                "sap_file_hash": file_hash,
                "prior_runs": prior_runs,
            })
    return {"enabled": True, "duplicates": results}


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
        # 7I: Clean up batch failure counters and semaphores for expired sessions
        _batch_failure_counts.pop(k, None)
        _batch_semaphores.pop(k, None)


@router.post("/batch/init", status_code=200)
async def init_batch(
    as26_file: UploadFile = File(...),
    financial_year: str = Form(default=settings.DEFAULT_FINANCIAL_YEAR),
    run_config_json: Optional[str] = Form(default=None),
    db: AsyncSession = Depends(get_db),
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

    # Create batch semaphore for concurrency control
    concurrency_limit = await _get_batch_concurrency_limit(db)
    _get_or_create_batch_semaphore(batch_id, concurrency_limit)

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

    # Use batch semaphore for concurrency control
    batch_sem = _batch_semaphores.get(batch_id)

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
            semaphore=batch_sem,
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

    # Check for duplicates (non-blocking — informational only)
    duplicate_warning = None
    if await _is_duplicate_detection_enabled(db):
        sap_hash = sha256_file(sap_bytes)
        prior_runs = await _check_duplicate_sap_hash(db, sap_hash, current_batch_id=batch_id)
        if prior_runs:
            duplicate_warning = {
                "sap_filename": filename,
                "sap_file_hash": sap_hash,
                "prior_runs": prior_runs,
            }

    return {
        "batch_id": batch_id,
        "run": run_summary,
        "total_so_far": len(session["runs"]),
        "duplicate_warning": duplicate_warning,
    }


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

    # Create batch semaphore for concurrency control
    concurrency_limit = await _get_batch_concurrency_limit(db)
    batch_sem = _get_or_create_batch_semaphore(batch_id, concurrency_limit)

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
                semaphore=batch_sem,
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
        select(MatchedPair.as26_row_hash, MatchedPair.invoice_refs).where(MatchedPair.run_id == run_id)
    )
    existing_mp_hashes: set = set()
    consumed_refs: set = set()
    for row in existing_mp_result.all():
        if row[0]:
            existing_mp_hashes.add(row[0])
        if row[1]:
            try:
                for ref in (_json.loads(row[1]) if isinstance(row[1], str) else row[1]):
                    if ref:
                        consumed_refs.add(ref)
            except (TypeError, _json.JSONDecodeError):
                pass
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

        # Check invoice overlap for audit trail (promote regardless — user explicitly authorized)
        sm_refs = set()
        if sm.invoice_refs:
            try:
                parsed = _json.loads(sm.invoice_refs) if isinstance(sm.invoice_refs, str) else sm.invoice_refs
                sm_refs = {r for r in parsed if r}
            except (TypeError, _json.JSONDecodeError):
                pass
        overlap = sm_refs & consumed_refs
        has_invoice_reuse = bool(overlap)

        # Build remark for audit trail
        remark = None
        remark_parts = []
        if has_invoice_reuse:
            remark_parts.append(
                f"Invoice reuse: {', '.join(sorted(overlap))} also used in another match."
            )
        if sm.variance_pct > suggested_ceiling_pct:
            remark_parts.append(
                f"Variance ({sm.variance_pct:.2f}%) exceeds suggested ceiling ({suggested_ceiling_pct:.1f}%)."
            )
        if body.remarks:
            remark_parts.append(f"Reviewer remarks: {body.remarks}")
        if remark_parts:
            remark = f"Authorized by {current_user.full_name}. " + " ".join(remark_parts)

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
        if sm_refs:
            consumed_refs.update(sm_refs)

        # Soft-delete: mark Unmatched26AS as PROMOTED (preserves audit trail)
        if sm.as26_row_hash:
            u_result = await db.execute(
                select(Unmatched26AS).where(
                    Unmatched26AS.run_id == run_id,
                    Unmatched26AS.as26_row_hash == sm.as26_row_hash,
                )
            )
            u_entry = u_result.scalar_one_or_none()
            if u_entry:
                u_entry.status = "PROMOTED"
                u_entry.promoted_at = now
                u_entry.promoted_by_id = current_user.id

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
            select(func.count(Unmatched26AS.id)).where(Unmatched26AS.run_id == run_id, Unmatched26AS.status == "ACTIVE")
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

        # Recompute control_total_balanced from live amounts
        matched_amt_result = await db.execute(
            select(func.sum(MatchedPair.as26_amount)).where(MatchedPair.run_id == run_id)
        )
        live_matched_amt = matched_amt_result.scalar() or 0.0
        suggested_amt_result = await db.execute(
            select(func.sum(SuggestedMatch.as26_amount)).where(
                SuggestedMatch.run_id == run_id,
                SuggestedMatch.authorized == False,
                SuggestedMatch.rejected == False,
            )
        )
        live_suggested_amt = suggested_amt_result.scalar() or 0.0
        unmatched_amt_result = await db.execute(
            select(func.sum(Unmatched26AS.amount)).where(
                Unmatched26AS.run_id == run_id, Unmatched26AS.status == "ACTIVE"
            )
        )
        live_unmatched_amt = unmatched_amt_result.scalar() or 0.0
        run.matched_amount = round(live_matched_amt, 2)
        run.unmatched_26as_amount = round(live_unmatched_amt, 2)
        computed_sum = live_matched_amt + live_suggested_amt + live_unmatched_amt
        run.control_total_balanced = abs(run.total_26as_amount - computed_sum) < 0.02

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

async def _reset_run_for_rerun(db: AsyncSession, run: ReconciliationRun) -> dict:
    """
    Reset an existing run for in-place rerun.
    Deletes all result rows and resets stats to PROCESSING.
    Returns the old config_snapshot for audit logging.
    Raises HTTP 409 if the run is currently PROCESSING.
    """
    if run.status == "PROCESSING":
        raise HTTPException(
            status_code=409,
            detail="This run is already processing. Wait for it to complete before re-running.",
        )

    old_config = run.config_snapshot or {}

    # Bulk-delete all result rows for this run
    for model in [MatchedPair, SuggestedMatch, Unmatched26AS, UnmatchedBook, ExceptionRecord]:
        await db.execute(model.__table__.delete().where(model.__table__.c.run_id == run.id))

    # Reset run stats (use 0/0.0 for NOT NULL columns, None only for nullable)
    run.status = "PROCESSING"
    run.matched_count = 0
    run.suggested_count = 0
    run.unmatched_26as_count = 0
    run.unmatched_books_count = 0
    run.total_26as_entries = 0
    run.total_sap_entries = 0
    run.match_rate_pct = 0.0
    run.matched_amount = 0.0
    run.unmatched_26as_amount = 0.0
    run.total_26as_amount = 0.0
    run.total_sap_amount = 0.0
    run.high_confidence_count = 0
    run.medium_confidence_count = 0
    run.low_confidence_count = 0
    run.constraint_violations = 0
    run.control_total_balanced = False
    run.has_pan_issues = False
    run.has_rate_mismatches = False
    run.has_section_mismatches = False
    run.has_duplicate_26as = False
    run.validation_errors = None
    run.error_message = None
    run.completed_at = None
    run.reviewed_at = None
    run.reviewed_by_id = None
    run.review_notes = None
    run.started_at = datetime.now(timezone.utc)
    run.algorithm_version = settings.ALGORITHM_VERSION
    run.config_snapshot = {}

    return old_config


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
    parent_batch_id: Optional[str] = None,
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
        parent_batch_id=parent_batch_id,
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


async def _get_auto_retry_count(db: AsyncSession) -> int:
    """Read batch_auto_retry_count from active AdminSettings."""
    from db.models import AdminSettings
    result = await db.execute(
        select(AdminSettings).where(AdminSettings.is_active == True)
    )
    s = result.scalar_one_or_none()
    return (s.batch_auto_retry_count if s and s.batch_auto_retry_count else 0)


async def _get_batch_recovery_settings(db: AsyncSession) -> tuple[int, int, int]:
    """Read 7I batch recovery settings: (retry_backoff_seconds, stop_on_failure_count, auto_retry_count)."""
    from db.models import AdminSettings
    result = await db.execute(
        select(AdminSettings).where(AdminSettings.is_active == True)
    )
    s = result.scalar_one_or_none()
    backoff = (s.batch_retry_backoff_seconds if s and s.batch_retry_backoff_seconds is not None else 2)
    stop_count = (s.batch_stop_on_failure_count if s and s.batch_stop_on_failure_count is not None else 0)
    retries = (s.batch_auto_retry_count if s and s.batch_auto_retry_count else 0)
    # SQLite: ensure at least 1 auto-retry to handle transient "database is locked" errors
    from db.base import _is_sqlite
    if _is_sqlite and retries < 1:
        retries = 1
    return backoff, stop_count, retries


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
    semaphore: Optional[asyncio.Semaphore] = None,
):
    """Run reconciliation in a background task with its own DB session."""
    from db.base import AsyncSessionLocal
    from services.reconcile_service import run_reconciliation_on_existing_run
    import logging as _log
    import traceback

    logger = _log.getLogger(__name__)

    # Acquire batch semaphore if provided (concurrency control)
    if semaphore is not None:
        logger.info(f"Run {run_id} waiting for batch semaphore slot...")
        await semaphore.acquire()
        logger.info(f"Run {run_id} acquired semaphore slot")

    logger.info(f"Background task started for run {run_id}")

    # Determine auto-retry limit and recovery settings for batch runs
    max_retries = 0
    retry_backoff_base = 2  # seconds
    stop_on_failure_count = 0  # 0 = disabled
    if batch_id:
        try:
            async with AsyncSessionLocal() as settings_db:
                retry_backoff_base, stop_on_failure_count, max_retries = await _get_batch_recovery_settings(settings_db)
        except Exception:
            pass  # defaults above

    attempt = 0
    last_error = None

    try:
        # 7I: Check batch stop-on-failure before starting
        if batch_id and stop_on_failure_count > 0:
            failed_so_far = _batch_failure_counts.get(batch_id, 0)
            if failed_so_far >= stop_on_failure_count:
                stop_msg = f"Batch stopped: {failed_so_far} runs already failed (threshold={stop_on_failure_count})"
                logger.warning(f"Run {run_id} skipped — {stop_msg}")
                progress_store.mark_failed(run_id, stop_msg)
                try:
                    async with AsyncSessionLocal() as stop_db:
                        from sqlalchemy import text as sql_text
                        await stop_db.execute(
                            sql_text("UPDATE reconciliation_runs SET status='FAILED', error_message=:err WHERE id=:rid"),
                            {"rid": run_id, "err": stop_msg},
                        )
                        await stop_db.commit()
                except Exception:
                    pass
                return

        while attempt <= max_retries:
            if attempt > 0:
                logger.info(f"Auto-retry attempt {attempt}/{max_retries} for run {run_id}")
                progress_store.update(run_id, status="QUEUED", detail=f"Auto-retry {attempt}/{max_retries}")
                # 7I: Exponential backoff — base * 2^(attempt-1)
                backoff_delay = retry_backoff_base * (2 ** (attempt - 1))
                await asyncio.sleep(min(backoff_delay, 60))  # cap at 60s

            try:
                async with AsyncSessionLocal() as db:
                    try:
                        user_result = await db.execute(select(User).where(User.id == user_id))
                        user = user_result.scalar_one()

                        # Reset run status to PROCESSING for retries
                        if attempt > 0:
                            from sqlalchemy import text as sql_text
                            await db.execute(
                                sql_text("UPDATE reconciliation_runs SET status='PROCESSING', error_message=NULL WHERE id=:rid"),
                                {"rid": run_id},
                            )
                            await db.commit()

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
                        progress_store.mark_complete(run_id)
                        logger.info(f"Background task completed for run {run_id}" + (f" (attempt {attempt + 1})" if attempt > 0 else ""))

                        # Check batch completion and send notification if enabled
                        if batch_id:
                            try:
                                from services.notifications import check_and_notify_batch_complete
                                await check_and_notify_batch_complete(db, batch_id, run_id)
                            except Exception as notif_err:
                                logger.warning(f"Batch notification check failed: {notif_err}")

                        return  # success — exit the retry loop
                    except Exception as e:
                        last_error = e
                        logger.error(f"Background run {run_id} failed (attempt {attempt + 1}/{max_retries + 1}): {e}\n{traceback.format_exc()}")
                        await db.rollback()

                        # If no more retries, mark as failed
                        if attempt >= max_retries:
                            err_msg = str(e)[:2000]
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
                            # 7I: Increment batch failure counter for stop-on-failure
                            if batch_id:
                                _batch_failure_counts[batch_id] = _batch_failure_counts.get(batch_id, 0) + 1
            except Exception as outer:
                last_error = outer
                logger.error(f"Background task outer crash for run {run_id} (attempt {attempt + 1}): {outer}\n{traceback.format_exc()}")

                if attempt >= max_retries:
                    err_msg = str(outer)[:2000]
                    progress_store.mark_failed(run_id, err_msg)
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
                    # 7I: Increment batch failure counter for stop-on-failure
                    if batch_id:
                        _batch_failure_counts[batch_id] = _batch_failure_counts.get(batch_id, 0) + 1

            attempt += 1

        if last_error and attempt > max_retries:
            logger.error(f"Run {run_id} failed after {max_retries + 1} attempts")
    finally:
        # Release batch semaphore slot so queued tasks can proceed
        if semaphore is not None:
            semaphore.release()
            logger.info(f"Run {run_id} released semaphore slot")


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
        batch_name=r.batch_name,
        batch_tags=r.batch_tags,
        parent_batch_id=r.parent_batch_id,
        error_message=r.error_message,
        total_26as_amount=r.total_26as_amount or 0.0,
        total_sap_amount=r.total_sap_amount or 0.0,
        matched_amount=r.matched_amount or 0.0,
        unmatched_26as_amount=r.unmatched_26as_amount or 0.0,
        assigned_reviewer_id=r.assigned_reviewer_id,
        archived=r.archived if r.archived else False,
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
        "alert_message": p.alert_message,
        "alternative_matches": p.alternative_matches,
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


# ── Compliance Report Endpoint ────────────────────────────────────────────────

@router.get("/{run_id}/compliance-report")
async def get_compliance_report(
    run_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Generate a comprehensive compliance report for a reconciliation run.
    Covers: determinism proof, config snapshot, score distributions,
    constraint compliance, exception summary, and audit chain integrity.
    """
    run = await _get_run_or_404(run_id, db)

    # 1. Score distribution
    mp_result = await db.execute(
        select(MatchedPair).where(MatchedPair.run_id == run_id)
    )
    matched_pairs = list(mp_result.scalars().all())

    score_dist = {"HIGH": 0, "MEDIUM": 0, "LOW": 0}
    type_dist: dict = {}
    total_variance_amt = 0.0
    max_variance_pct = 0.0
    overclaim_violations = 0
    invoice_refs_seen: set = set()
    invoice_reuse_count = 0

    for mp in matched_pairs:
        conf = (mp.confidence or "LOW").upper()
        score_dist[conf] = score_dist.get(conf, 0) + 1
        mt = mp.match_type or "UNKNOWN"
        type_dist[mt] = type_dist.get(mt, 0) + 1
        total_variance_amt += abs(mp.variance_amt)
        max_variance_pct = max(max_variance_pct, mp.variance_pct)

        # Over-claim check: books_sum must not exceed as26_amount
        if mp.books_sum > mp.as26_amount + 0.01:
            overclaim_violations += 1

        # Invoice reuse check
        if mp.invoice_refs:
            for ref in mp.invoice_refs:
                if ref in invoice_refs_seen:
                    invoice_reuse_count += 1
                invoice_refs_seen.add(ref)

    # 2. Exception summary
    exc_result = await db.execute(
        select(ExceptionRecord).where(ExceptionRecord.run_id == run_id)
    )
    exceptions = list(exc_result.scalars().all())
    exc_summary = {}
    unreviewed_count = 0
    for exc in exceptions:
        exc_summary[exc.exception_type] = exc_summary.get(exc.exception_type, 0) + 1
        if not exc.reviewed:
            unreviewed_count += 1

    # 3. Reproducibility proof
    file_integrity = {
        "sap_file_hash": run.sap_file_hash,
        "as26_file_hash": run.as26_file_hash,
        "output_hash": run.output_hash,
        "sap_blob_stored": run.sap_file_blob is not None,
        "as26_blob_stored": run.as26_file_blob is not None,
        "admin_settings_id": run.admin_settings_id,
    }

    # Re-verify stored blobs match recorded hashes
    blob_verification = {"sap_verified": None, "as26_verified": None}
    if run.sap_file_blob:
        actual_hash = sha256_file(run.sap_file_blob)
        blob_verification["sap_verified"] = actual_hash == run.sap_file_hash
    if run.as26_file_blob:
        actual_hash = sha256_file(run.as26_file_blob)
        blob_verification["as26_verified"] = actual_hash == run.as26_file_hash

    # 4. Audit trail integrity
    from pathlib import Path
    audit_dir = Path(settings.AUDIT_LOG_DIR)
    audit_files = sorted(audit_dir.glob("audit_*.jsonl"))
    audit_chain_results = []
    for af in audit_files[-5:]:  # Check last 5 days
        result = verify_audit_chain(str(af))
        audit_chain_results.append({
            "file": af.name,
            "valid": result["valid"],
            "lines": result["total_lines"],
            "error": result.get("error"),
        })

    return {
        "run_id": run_id,
        "algorithm_version": run.algorithm_version,
        "config_snapshot": run.config_snapshot,
        "admin_settings_id": run.admin_settings_id,
        "compliance": {
            "overclaim_violations": overclaim_violations,
            "invoice_reuse_violations": invoice_reuse_count,
            "max_variance_pct": round(max_variance_pct, 4),
            "total_variance_amount": round(total_variance_amt, 2),
            "books_exceed_26as": overclaim_violations == 0,
            "no_invoice_reuse": invoice_reuse_count == 0,
            "constraint_violations": run.constraint_violations,
        },
        "statistics": {
            "total_26as_entries": run.total_26as_entries,
            "total_sap_entries": run.total_sap_entries,
            "matched_count": run.matched_count,
            "match_rate_pct": round(run.match_rate_pct, 2),
            "confidence_distribution": score_dist,
            "match_type_distribution": type_dist,
        },
        "control_totals": {
            "total_26as_amount": run.total_26as_amount,
            "matched_amount": run.matched_amount,
            "unmatched_26as_amount": run.unmatched_26as_amount,
            "balanced": run.control_total_balanced,
        },
        "exceptions": {
            "total": len(exceptions),
            "unreviewed": unreviewed_count,
            "by_type": exc_summary,
        },
        "file_integrity": file_integrity,
        "blob_verification": blob_verification,
        "audit_chain": audit_chain_results,
    }


# ── Comment Threads (Phase 4B) ──────────────────────────────────────────────

class CommentCreate(BaseModel):
    content: str
    parent_id: Optional[str] = None
    context_type: Optional[str] = None  # e.g. "matched_pair", "exception", "suggested"
    context_id: Optional[str] = None


class CommentUpdate(BaseModel):
    content: str


def _comment_to_dict(c: RunComment, user_map: dict) -> dict:
    u = user_map.get(c.user_id)
    return {
        "id": c.id,
        "run_id": c.run_id,
        "user_id": c.user_id,
        "user_name": u.full_name if u else "Unknown",
        "user_role": u.role if u else None,
        "content": c.content,
        "parent_id": c.parent_id,
        "context_type": c.context_type,
        "context_id": c.context_id,
        "created_at": c.created_at.isoformat() if c.created_at else None,
        "updated_at": c.updated_at.isoformat() if c.updated_at else None,
    }


async def _check_comments_enabled(db: AsyncSession):
    result = await db.execute(select(AdminSettings).where(AdminSettings.is_active == True))
    s = result.scalar_one_or_none()
    if s and s.comment_threads_enabled is False:
        raise HTTPException(status_code=400, detail="Comment threads are disabled")


@router.get("/{run_id}/comments")
async def list_comments(
    run_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all comments for a run, ordered by creation time."""
    await _check_comments_enabled(db)
    await _get_run_or_404(run_id, db)

    result = await db.execute(
        select(RunComment)
        .where(RunComment.run_id == run_id)
        .order_by(RunComment.created_at)
    )
    comments = list(result.scalars().all())

    # Build user map for display names
    user_ids = list({c.user_id for c in comments})
    user_map = {}
    if user_ids:
        users_result = await db.execute(select(User).where(User.id.in_(user_ids)))
        user_map = {u.id: u for u in users_result.scalars().all()}

    return [_comment_to_dict(c, user_map) for c in comments]


@router.post("/{run_id}/comments", status_code=201)
async def create_comment(
    run_id: str,
    body: CommentCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Add a comment to a run."""
    await _check_comments_enabled(db)
    await _get_run_or_404(run_id, db)

    if not body.content.strip():
        raise HTTPException(status_code=400, detail="Comment content cannot be empty")

    # Validate parent exists if replying
    if body.parent_id:
        parent = await db.execute(
            select(RunComment).where(RunComment.id == body.parent_id, RunComment.run_id == run_id)
        )
        if not parent.scalar_one_or_none():
            raise HTTPException(status_code=404, detail="Parent comment not found")

    comment = RunComment(
        run_id=run_id,
        user_id=current_user.id,
        content=body.content.strip(),
        parent_id=body.parent_id,
        context_type=body.context_type,
        context_id=body.context_id,
    )
    db.add(comment)
    await db.commit()
    await db.refresh(comment)

    await log_event(db, "COMMENT_ADDED", f"Comment by {current_user.full_name} on run {run_id}", run_id=run_id)

    user_map = {current_user.id: current_user}
    return _comment_to_dict(comment, user_map)


@router.put("/{run_id}/comments/{comment_id}")
async def update_comment(
    run_id: str,
    comment_id: str,
    body: CommentUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Edit own comment."""
    await _check_comments_enabled(db)
    result = await db.execute(
        select(RunComment).where(RunComment.id == comment_id, RunComment.run_id == run_id)
    )
    comment = result.scalar_one_or_none()
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")
    if comment.user_id != current_user.id and current_user.role != "ADMIN":
        raise HTTPException(status_code=403, detail="Can only edit your own comments")

    comment.content = body.content.strip()
    await db.commit()
    await db.refresh(comment)

    user_map = {current_user.id: current_user}
    return _comment_to_dict(comment, user_map)


@router.delete("/{run_id}/comments/{comment_id}", status_code=204)
async def delete_comment(
    run_id: str,
    comment_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete own comment (or any comment if ADMIN)."""
    await _check_comments_enabled(db)
    result = await db.execute(
        select(RunComment).where(RunComment.id == comment_id, RunComment.run_id == run_id)
    )
    comment = result.scalar_one_or_none()
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")
    if comment.user_id != current_user.id and current_user.role != "ADMIN":
        raise HTTPException(status_code=403, detail="Can only delete your own comments")

    await db.delete(comment)
    await db.commit()


# ── Bulk Operations (Phase 4D) ──────────────────────────────────────────────

class BulkReviewRequest(BaseModel):
    run_ids: List[str]
    action: str  # APPROVED | REJECTED
    notes: Optional[str] = None


@router.post("/bulk/review")
async def bulk_review_runs(
    body: BulkReviewRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_reviewer),
):
    """Bulk approve or reject multiple runs."""
    # Check feature toggle
    _as_result = await db.execute(select(AdminSettings).where(AdminSettings.is_active == True))
    _as = _as_result.scalar_one_or_none()
    if not _as or not _as.bulk_operations_enabled:
        raise HTTPException(status_code=400, detail="Bulk operations are disabled")
    if _as.approval_workflow_enabled is False:
        raise HTTPException(status_code=400, detail="Approval workflow is disabled")

    if body.action not in ("APPROVED", "REJECTED"):
        raise HTTPException(status_code=400, detail="Action must be APPROVED or REJECTED")

    results = {"success": 0, "failed": 0, "errors": []}

    for run_id in body.run_ids:
        try:
            run = await _get_run_or_404(run_id, db)
            if run.status != "PENDING_REVIEW":
                results["errors"].append({"run_id": run_id, "error": f"Status '{run.status}' cannot be reviewed"})
                results["failed"] += 1
                continue
            if run.created_by_id == current_user.id and not settings.ALLOW_SELF_REVIEW:
                results["errors"].append({"run_id": run_id, "error": "Cannot review own run"})
                results["failed"] += 1
                continue

            run.status = body.action
            run.reviewed_by_id = current_user.id
            run.reviewed_at = datetime.now(timezone.utc)
            run.review_notes = body.notes
            await log_event(db, f"REVIEW_{body.action}",
                            f"Bulk {body.action.lower()} by {current_user.full_name}",
                            run_id=run_id, user_id=current_user.id)
            results["success"] += 1
        except HTTPException:
            results["errors"].append({"run_id": run_id, "error": "Run not found"})
            results["failed"] += 1

    await db.commit()
    return results


class BulkArchiveRequest(BaseModel):
    run_ids: List[str]


@router.post("/bulk/archive")
async def bulk_archive_runs(
    body: BulkArchiveRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_reviewer),
):
    """Bulk archive multiple runs."""
    _as_result = await db.execute(select(AdminSettings).where(AdminSettings.is_active == True))
    _as = _as_result.scalar_one_or_none()
    if not _as or not _as.bulk_operations_enabled:
        raise HTTPException(status_code=400, detail="Bulk operations are disabled")
    if not _as.run_archival_enabled:
        raise HTTPException(status_code=400, detail="Run archival is disabled")

    archived_count = 0
    for run_id in body.run_ids:
        try:
            run = await _get_run_or_404(run_id, db)
            if not run.archived:
                run.archived = True
                run.archived_at = datetime.now(timezone.utc)
                archived_count += 1
        except HTTPException:
            pass

    await db.commit()
    await log_event(db, "BULK_ARCHIVE",
                    f"{archived_count} runs archived by {current_user.full_name}",
                    user_id=current_user.id)
    return {"archived": archived_count}


# ── Run Comparison (Phase 4I) ────────────────────────────────────────────────

@router.get("/compare/{run_id_a}/{run_id_b}")
async def compare_runs(
    run_id_a: str,
    run_id_b: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Compare two runs side-by-side."""
    _as_result = await db.execute(select(AdminSettings).where(AdminSettings.is_active == True))
    _as = _as_result.scalar_one_or_none()
    if _as and _as.run_comparison_enabled is False:
        raise HTTPException(status_code=400, detail="Run comparison is disabled")

    run_a = await _get_run_or_404(run_id_a, db)
    run_b = await _get_run_or_404(run_id_b, db)

    def _stats(r):
        return {
            "run_id": r.id,
            "run_number": r.run_number,
            "deductor_name": r.deductor_name,
            "financial_year": r.financial_year,
            "status": r.status,
            "match_rate_pct": r.match_rate_pct,
            "matched_count": r.matched_count or 0,
            "suggested_count": r.suggested_count or 0,
            "unmatched_26as_count": r.unmatched_26as_count or 0,
            "total_26as_entries": r.total_26as_entries or 0,
            "total_sap_entries": r.total_sap_entries or 0,
            "high_confidence_count": r.high_confidence_count or 0,
            "medium_confidence_count": r.medium_confidence_count or 0,
            "low_confidence_count": r.low_confidence_count or 0,
            "constraint_violations": r.constraint_violations or 0,
            "total_26as_amount": r.total_26as_amount or 0,
            "matched_amount": r.matched_amount or 0,
            "unmatched_26as_amount": r.unmatched_26as_amount or 0,
            "algorithm_version": r.algorithm_version,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }

    stats_a = _stats(run_a)
    stats_b = _stats(run_b)

    # Compute diffs for numeric fields
    diff_fields = [
        "match_rate_pct", "matched_count", "suggested_count", "unmatched_26as_count",
        "total_26as_entries", "total_sap_entries", "high_confidence_count",
        "medium_confidence_count", "low_confidence_count", "constraint_violations",
        "total_26as_amount", "matched_amount", "unmatched_26as_amount",
    ]
    diffs = []
    for f in diff_fields:
        va, vb = stats_a[f], stats_b[f]
        if va != vb:
            diffs.append({
                "field": f,
                "run_a_value": va,
                "run_b_value": vb,
                "delta": round(vb - va, 4) if isinstance(va, (int, float)) else None,
            })

    return {
        "run_a": stats_a,
        "run_b": stats_b,
        "diffs": diffs,
        "same_deductor": run_a.deductor_name == run_b.deductor_name,
        "same_fy": run_a.financial_year == run_b.financial_year,
    }


@router.post("/{run_id}/archive")
async def archive_run(
    run_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_reviewer),
):
    """Archive or unarchive a single run (toggle)."""
    _as_result = await db.execute(select(AdminSettings).where(AdminSettings.is_active == True))
    _as = _as_result.scalar_one_or_none()
    if not _as or not _as.run_archival_enabled:
        raise HTTPException(status_code=400, detail="Run archival is disabled")

    run = await _get_run_or_404(run_id, db)
    if run.archived:
        run.archived = False
        run.archived_at = None
        action = "unarchived"
    else:
        run.archived = True
        run.archived_at = datetime.now(timezone.utc)
        action = "archived"

    await db.commit()
    await log_event(db, f"RUN_{action.upper()}",
                    f"Run #{run.run_number} {action} by {current_user.full_name}",
                    run_id=run_id, user_id=current_user.id)
    return {"status": action, "archived": run.archived}
