"""
TDS Reconciliation API — Phase 1
FastAPI application with 5 endpoints.
All processing is synchronous and in-memory.
"""
from __future__ import annotations

import logging
import uuid
from typing import List, Optional

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
import io

from aligner import (
    align_deductor,
    confirm_alignment,
    get_excel,
    get_session,
    search_deductor,
    store_excel,
    store_session,
)
from cleaner import clean_sap_books
from config import DEFAULT_FINANCIAL_YEAR, fy_date_range, fy_label_from_date_range, sap_date_window
from excel_generator import generate_excel
from models import (
    CleaningReport,
    ConfirmAlignmentRequest,
    DeductorCandidate,
    ReconcileResponse,
    RecoResult,
)
from parser_26as import get_tanwise_candidates, parse_26as
from reco_engine import run_reco

logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(name)s | %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(
    title="TDS Reconciliation API",
    description="Phase 1 — Single file TDS Reco | HRA & Co. / Akurat Advisory",
    version="1.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── GET /api/health ────────────────────────────────────────────────────────────

@app.get("/api/health")
def health():
    return {"status": "ok", "version": "1.1.0"}


# ── GET /api/financial-years ───────────────────────────────────────────────────

@app.get("/api/financial-years")
def list_financial_years():
    """Return supported FY labels for the frontend dropdown."""
    from config import SUPPORTED_FINANCIAL_YEARS, DEFAULT_FINANCIAL_YEAR
    return {
        "years": SUPPORTED_FINANCIAL_YEARS,
        "default": DEFAULT_FINANCIAL_YEAR,
    }


# ── POST /api/reconcile ────────────────────────────────────────────────────────

@app.post("/api/reconcile", response_model=ReconcileResponse)
async def reconcile(
    sap_file:        UploadFile = File(..., description="SAP AR Ledger .xlsx"),
    as26_file:       UploadFile = File(..., description="26AS master .xlsx"),
    financial_year:  str        = Form(DEFAULT_FINANCIAL_YEAR,
                                       description="FY label e.g. FY2023-24"),
):
    # ── 1. Resolve FY date range ───────────────────────────────────────────
    try:
        fy_start, fy_end = fy_date_range(financial_year)
        sap_start, sap_end = sap_date_window(financial_year)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    fy_label = financial_year  # e.g. "FY2023-24"
    logger.info(
        "Reconcile request: FY=%s (%s → %s) | SAP window: %s → %s",
        fy_label, fy_start, fy_end, sap_start, sap_end,
    )

    # ── 2. Read files ──────────────────────────────────────────────────────
    sap_bytes  = await sap_file.read()
    as26_bytes = await as26_file.read()
    sap_filename = sap_file.filename or "upload.xlsx"

    # ── 3. Clean SAP books (P2: date window = current FY + 1 prior FY)
    # Includes prior-FY invoices (TDS on old invoices appears in current 26AS)
    # but EXCLUDES post-FY invoices (can't be paid before they exist).
    try:
        clean_df, cleaning_report = clean_sap_books(
            sap_bytes, fy_start=sap_start, fy_end=sap_end,
        )
    except Exception as e:
        logger.exception("SAP cleaning failed")
        raise HTTPException(status_code=422, detail=f"SAP file parsing error: {e}")

    if clean_df.empty:
        raise HTTPException(
            status_code=422,
            detail=(
                f"No valid RV/DC/DR invoice rows found in SAP date window "
                f"({sap_start.strftime('%d-%b-%Y')} – {sap_end.strftime('%d-%b-%Y')}). "
                "Check Document Type, amounts, and date columns."
            ),
        )

    # ── 4. Parse 26AS (FY date filter applied here — government side only) ─
    try:
        as26_df = parse_26as(as26_bytes, fy_start=fy_start, fy_end=fy_end)
        tanwise_extras = get_tanwise_candidates(as26_bytes)
    except Exception as e:
        logger.exception("26AS parsing failed")
        raise HTTPException(status_code=422, detail=f"26AS file parsing error: {e}")

    if as26_df.empty:
        raise HTTPException(
            status_code=422,
            detail=(
                f"No valid rows (Status=F) found in 26AS for {fy_label}. "
                "Check the Transaction Date column in your 26AS file."
            ),
        )

    # ── 5. Name alignment ──────────────────────────────────────────────────
    alignment = align_deductor(sap_filename, as26_df, tanwise_extras)
    alignment_id = str(uuid.uuid4())

    store_session(alignment_id, clean_df, as26_df, alignment, sap_filename, as26_bytes)
    sess = get_session(alignment_id)
    if sess:
        sess["cleaning_report"] = cleaning_report
        sess["fy_label"] = fy_label

    # ── 6a. AUTO_CONFIRMED → run reco immediately ──────────────────────────
    if alignment.status == "AUTO_CONFIRMED":
        return _run_and_respond(alignment_id, clean_df, as26_df, alignment,
                                cleaning_report, fy_label)

    # ── 6b. PENDING ────────────────────────────────────────────────────────
    if alignment.status == "PENDING":
        return ReconcileResponse(
            status="pending",
            alignment_id=alignment_id,
            identity_string=alignment.identity_string,
            top_candidates=alignment.top_candidates,
            cleaning_report=cleaning_report,
        )

    # ── 6c. NO_MATCH ───────────────────────────────────────────────────────
    return ReconcileResponse(
        status="no_match",
        alignment_id=alignment_id,
        identity_string=alignment.identity_string,
        top_candidates=alignment.top_candidates,
        cleaning_report=cleaning_report,
        error_message=(
            f"Could not find a suitable match for '{alignment.identity_string}' "
            f"in 26AS (best score: {alignment.top_candidates[0].score:.0f}%). "
            "Please search manually."
        ),
    )


# ── POST /api/confirm-alignment ────────────────────────────────────────────────

@app.post("/api/confirm-alignment", response_model=ReconcileResponse)
def confirm_alignment_endpoint(body: ConfirmAlignmentRequest):
    sess = get_session(body.alignment_id)
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found or expired.")

    as26_df         = sess["as26_df"]
    clean_df        = sess["clean_df"]
    cleaning_report = sess.get("cleaning_report")
    fy_label        = sess.get("fy_label", DEFAULT_FINANCIAL_YEAR)

    confirmed_alignment = confirm_alignment(
        body.alignment_id, body.deductor_name, body.tan, as26_df,
    )
    sess["alignment"] = confirmed_alignment

    return _run_and_respond(
        body.alignment_id, clean_df, as26_df, confirmed_alignment,
        cleaning_report, fy_label,
    )


# ── GET /api/search-deductor ───────────────────────────────────────────────────

@app.get("/api/search-deductor", response_model=List[DeductorCandidate])
def search_deductor_endpoint(
    q: str = Query(..., description="Search string"),
    alignment_id: str = Query(..., description="Session ID from /api/reconcile"),
):
    sess = get_session(alignment_id)
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found or expired.")

    as26_df = sess["as26_df"]
    tanwise_extras = get_tanwise_candidates(sess.get("as26_bytes", b""))
    return search_deductor(q, as26_df, tanwise_extras)


# ── GET /api/download/{session_id} ─────────────────────────────────────────────

@app.get("/api/download/{session_id}")
def download_excel(session_id: str):
    excel_bytes = get_excel(session_id)
    if not excel_bytes:
        raise HTTPException(status_code=404, detail="File not found or session expired.")

    sess = get_session(session_id)
    deductor = "UNKNOWN"
    fy_label = DEFAULT_FINANCIAL_YEAR
    if sess:
        if sess.get("alignment"):
            deductor = (sess["alignment"].confirmed_name or "UNKNOWN").replace(" ", "_")
        fy_label = sess.get("fy_label", DEFAULT_FINANCIAL_YEAR)

    filename = f"{deductor}_TDS_Reco_{fy_label}.xlsx"

    return StreamingResponse(
        io.BytesIO(excel_bytes),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── Internal helper ────────────────────────────────────────────────────────────

def _run_and_respond(
    session_id: str,
    clean_df,
    as26_df,
    alignment,
    cleaning_report: Optional[CleaningReport],
    fy_label: str = DEFAULT_FINANCIAL_YEAR,
) -> ReconcileResponse:
    """Filter 26AS to confirmed deductor, run reco, generate Excel, return response."""
    deductor_name = alignment.confirmed_name or ""
    tan           = alignment.confirmed_tan or ""

    as26_slice = as26_df[
        (as26_df["deductor_name"] == deductor_name) |
        (as26_df["tan"] == tan)
    ].copy().reset_index(drop=True)

    if as26_slice.empty:
        as26_slice = as26_df.copy()
        logger.warning("26AS slice empty after deductor filter — using full dataset")

    result = run_reco(
        clean_df=clean_df,
        as26_slice=as26_slice,
        deductor_name=deductor_name,
        tan=tan,
        fuzzy_score=alignment.fuzzy_score,
        session_id=session_id,
        target_fy=fy_label,
    )

    if cleaning_report is None:
        cleaning_report = CleaningReport(
            total_rows_input=0, rows_after_cleaning=len(clean_df),
            excluded_null=0, excluded_negative=0, excluded_noise=0,
            excluded_doc_type=0, excluded_sgl=0, excluded_date_fy=0,
            flagged_advance=0, flagged_ab=0, flagged_other_sgl=0,
            duplicates_removed=0, split_invoices_flagged=0,
            used_fallback_doc_types=False,
        )

    excel_bytes = generate_excel(result, cleaning_report, fy_label=fy_label)
    store_excel(session_id, excel_bytes)

    return ReconcileResponse(
        status="complete",
        reco_summary=result,
        download_url=f"/api/download/{session_id}",
        cleaning_report=cleaning_report,
    )
