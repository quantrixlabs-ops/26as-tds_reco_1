"""
Reconciliation run routes — upload, status, results, review, download, replay.
"""
from __future__ import annotations

import io
import json as _json
import uuid
from typing import List, Optional
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from core.audit import log_event
from core.deps import get_current_user, require_reviewer
from core.settings import settings
from db.base import get_db
from db.models import ReconciliationRun, MatchedPair, Unmatched26AS, UnmatchedBook, ExceptionRecord, User
from services.reconcile_service import run_reconciliation

router = APIRouter(prefix="/api/runs", tags=["runs"])


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


class ReviewRequest(BaseModel):
    action: str       # APPROVED | REJECTED
    notes: Optional[str] = None


class ExceptionReviewRequest(BaseModel):
    exception_id: str
    action: str       # ACCEPTED | REJECTED | ESCALATED
    notes: Optional[str] = None


# ── Upload & Run ──────────────────────────────────────────────────────────────

@router.post("", status_code=202)
async def create_run(
    request: Request,
    sap_file: UploadFile = File(...),
    as26_file: UploadFile = File(...),
    financial_year: str = Form(default=settings.DEFAULT_FINANCIAL_YEAR),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Upload files and start a reconciliation run."""
    # Size guard
    max_bytes = settings.MAX_UPLOAD_MB * 1024 * 1024
    sap_bytes = await sap_file.read()
    as26_bytes = await as26_file.read()

    if len(sap_bytes) > max_bytes or len(as26_bytes) > max_bytes:
        raise HTTPException(status_code=413, detail=f"File exceeds {settings.MAX_UPLOAD_MB}MB limit")

    try:
        run = await run_reconciliation(
            db=db,
            current_user=current_user,
            sap_bytes=sap_bytes,
            as26_bytes=as26_bytes,
            sap_filename=sap_file.filename or "sap.xlsx",
            as26_filename=as26_file.filename or "26as.xlsx",
            financial_year=financial_year,
        )
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))

    return {"run_id": run.id, "run_number": run.run_number, "status": run.status}


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
    runs = result.scalars().all()
    return [_run_to_summary(r) for r in runs]


@router.get("/{run_id}", response_model=RunSummary)
async def get_run(
    run_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    run = await _get_run_or_404(run_id, db)
    return _run_to_summary(run)


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
    return [
        {
            "id": u.id, "deductor_name": u.deductor_name, "tan": u.tan,
            "transaction_date": u.transaction_date, "amount": u.amount,
            "section": u.section, "reason_code": u.reason_code,
            "reason_detail": u.reason_detail,
        }
        for u in result.scalars().all()
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

    from datetime import datetime, timezone
    run.status = body.action
    run.reviewed_by_id = current_user.id
    run.reviewed_at = datetime.now(timezone.utc)
    run.review_notes = body.notes

    await log_event(db, f"RUN_{body.action}",
                    f"Run RUN-{run.run_number:04d} {body.action.lower()} by {current_user.full_name}",
                    run_id=run_id, user_id=current_user.id,
                    metadata={"action": body.action, "notes": body.notes})

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

    from datetime import datetime, timezone
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


# ── Download ──────────────────────────────────────────────────────────────────

@router.get("/{run_id}/download")
async def download_excel(
    run_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Generate and download the Excel output for a completed run."""
    run = await _get_run_or_404(run_id, db)

    if run.status not in ("APPROVED", "PENDING_REVIEW"):
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
    from db.models import AuditLog
    result = await db.execute(
        select(AuditLog).where(AuditLog.run_id == run_id)
        .order_by(AuditLog.created_at)
    )
    return [
        {
            "event_type": l.event_type,
            "description": l.description,
            "user_id": l.user_id,
            "created_at": l.created_at.isoformat(),
            "metadata": l.event_metadata,
        }
        for l in result.scalars().all()
    ]


# ── Batch: Preview Mappings ───────────────────────────────────────────────────

@router.post("/batch/preview", status_code=200)
async def preview_batch_mappings(
    as26_file: UploadFile = File(...),
    sap_files: List[UploadFile] = File(...),
    current_user: User = Depends(get_current_user),
):
    """
    Dry-run only — no DB writes.
    Parse 26AS and fuzzy-match each SAP filename to a deductor.
    Returns proposed mappings + full party list for manual override.
    """
    from aligner import align_deductor
    from parser_26as import parse_26as

    as26_bytes = await as26_file.read()
    as26_df = parse_26as(as26_bytes)

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
    for sap_file in sap_files:
        filename = sap_file.filename or "unknown.xlsx"
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

    return {"mappings": mappings, "all_parties": all_parties}


# ── Batch: Run All ─────────────────────────────────────────────────────────────

@router.post("/batch", status_code=202)
async def create_batch_run(
    request: Request,
    as26_file: UploadFile = File(...),
    sap_files: List[UploadFile] = File(...),
    financial_year: str = Form(default=settings.DEFAULT_FINANCIAL_YEAR),
    mappings_json: str = Form(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Run reconciliation for each SAP file against the shared 26AS.
    Each SAP file → one ReconciliationRun, all linked by a shared batch_id.
    mappings_json: JSON object keyed by sap_filename →
        { "deductor_name": str, "tan": str }
    """
    try:
        mappings: dict = _json.loads(mappings_json)
    except Exception:
        raise HTTPException(status_code=422, detail="mappings_json must be valid JSON")

    max_bytes = settings.MAX_UPLOAD_MB * 1024 * 1024
    as26_bytes = await as26_file.read()
    if len(as26_bytes) > max_bytes:
        raise HTTPException(status_code=413, detail=f"26AS file exceeds {settings.MAX_UPLOAD_MB}MB limit")

    batch_id = str(uuid.uuid4())
    runs_summary = []

    for sap_file in sap_files:
        sap_bytes = await sap_file.read()
        if len(sap_bytes) > max_bytes:
            raise HTTPException(status_code=413, detail=f"{sap_file.filename} exceeds {settings.MAX_UPLOAD_MB}MB limit")

        filename = sap_file.filename or "sap.xlsx"
        # mappings_json value is a list of {deductor_name, tan} dicts
        parties: list = mappings.get(filename, [])
        if isinstance(parties, dict):
            parties = [parties]  # backward-compat: accept single dict too

        try:
            run = await run_reconciliation(
                db=db,
                current_user=current_user,
                sap_bytes=sap_bytes,
                as26_bytes=as26_bytes,
                sap_filename=filename,
                as26_filename=as26_file.filename or "26as.xlsx",
                financial_year=financial_year,
                batch_id=batch_id,
                deductor_filter_parties=parties if parties else None,
            )
            runs_summary.append({
                "run_id": run.id,
                "run_number": run.run_number,
                "sap_filename": filename,
                "deductor_name": run.deductor_name,
                "match_rate_pct": run.match_rate_pct,
                "status": run.status,
            })
        except Exception as e:
            runs_summary.append({
                "run_id": None,
                "sap_filename": filename,
                "deductor_name": deductor_name,
                "status": "FAILED",
                "error": str(e),
            })

    return {"batch_id": batch_id, "runs": runs_summary, "total": len(runs_summary)}


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
    )


def _mp_to_dict(p: MatchedPair) -> dict:
    return {
        "id": p.id, "as26_amount": p.as26_amount, "as26_date": p.as26_date,
        "section": p.section, "books_sum": p.books_sum,
        "variance_pct": p.variance_pct, "variance_amt": p.variance_amt,
        "match_type": p.match_type, "confidence": p.confidence,
        "composite_score": p.composite_score,
        "score_breakdown": {
            "variance": p.score_variance, "date_proximity": p.score_date_proximity,
            "section": p.score_section_match, "clearing_doc": p.score_clearing_doc,
            "historical": p.score_historical,
        },
        "invoice_refs": p.invoice_refs, "invoice_amounts": p.invoice_amounts,
        "invoice_dates": p.invoice_dates, "clearing_doc": p.clearing_doc,
        "cross_fy": p.cross_fy, "is_prior_year": p.is_prior_year,
        "ai_risk_flag": p.ai_risk_flag, "ai_risk_reason": p.ai_risk_reason,
    }


def _exc_to_dict(e: ExceptionRecord) -> dict:
    return {
        "id": e.id, "exception_type": e.exception_type, "severity": e.severity,
        "description": e.description, "amount": e.amount, "section": e.section,
        "reviewed": e.reviewed, "review_action": e.review_action,
        "review_notes": e.review_notes, "reviewed_at": e.reviewed_at.isoformat() if e.reviewed_at else None,
        "created_at": e.created_at.isoformat(),
    }
