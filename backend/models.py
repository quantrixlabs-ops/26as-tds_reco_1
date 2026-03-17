"""
Pydantic models for TDS Reconciliation — Phase 1
"""
from __future__ import annotations
from typing import List, Optional
from pydantic import BaseModel


# ── Cleaning ──────────────────────────────────────────────────────────────────

class CleaningReport(BaseModel):
    total_rows_input: int
    rows_after_cleaning: int
    excluded_null: int
    excluded_negative: int
    excluded_noise: int
    excluded_doc_type: int
    excluded_sgl: int
    excluded_date_fy: int = 0               # Rows outside SAP date window
    flagged_advance: int                    # SGL = V
    flagged_ab: int                         # AB doc type (legacy)
    flagged_other_sgl: int                  # SGL = O, A, N
    duplicates_removed: int
    split_invoices_flagged: int
    used_fallback_doc_types: bool = False


# ── Alignment ─────────────────────────────────────────────────────────────────

class DeductorCandidate(BaseModel):
    rank: int
    deductor_name: str
    tan: str
    score: float
    entry_count: int


class AlignmentResult(BaseModel):
    status: str                 # AUTO_CONFIRMED | PENDING | NO_MATCH
    identity_string: str
    top_candidates: List[DeductorCandidate]
    confirmed_name: Optional[str] = None
    confirmed_tan: Optional[str] = None
    fuzzy_score: Optional[float] = None


# ── Reconciliation ────────────────────────────────────────────────────────────

class BookEntry(BaseModel):
    index: int
    doc_date: Optional[str]
    amount: float
    invoice_ref: str            # PRIMARY identifier — col[14]
    doc_type: str
    sgl_ind: str
    flag: str
    clearing_doc: str = ""      # P1: SAP Clearing Document — col[4]
    sap_fy: str = ""            # P4: Which FY the invoice belongs to


class As26Entry(BaseModel):
    index: int
    transaction_date: Optional[str]
    amount: float
    section: str
    tan: str
    deductor_name: str


class MatchedPair(BaseModel):
    as26_index: int
    as26_date: Optional[str]
    as26_amount: float
    section: str
    books_sum: float
    variance_amt: float
    variance_pct: float
    match_type: str             # EXACT | SINGLE | COMBO_N | CLR_GROUP
    confidence: str = ""        # P3: HIGH | MEDIUM
    invoice_count: int
    invoice_refs: List[str]     # PRIMARY identifier column
    invoice_dates: List[Optional[str]]
    invoice_amounts: List[float]
    sgl_flags: List[str]
    clearing_docs: List[str] = []   # P4: Clearing doc(s) for this match
    sap_fys: List[str] = []         # P4: FY of each SAP invoice
    cross_fy: bool = False          # P4: True if any invoice is from a different FY


class UnmatchedAs26Entry(BaseModel):
    """26AS entry that could not be matched within the variance cap."""
    index: int
    transaction_date: Optional[str]
    amount: float
    section: str
    tan: str
    deductor_name: str
    # P0 enhancement: show what the algorithm *would have* matched
    best_candidate_ref: Optional[str] = None
    best_candidate_amount: Optional[float] = None
    best_candidate_variance_pct: Optional[float] = None
    rejection_reason: str = ""


class RecoResult(BaseModel):
    deductor_name: str
    tan: str
    fuzzy_score: Optional[float]
    total_26as_entries: int
    matched_count: int
    match_rate_pct: float
    unmatched_26as_count: int
    unmatched_books_count: int
    avg_variance_pct: float
    constraint_violations: int
    # P3: Confidence tier counts
    high_confidence_count: int = 0
    medium_confidence_count: int = 0
    # P4: Cross-FY stats
    cross_fy_match_count: int = 0
    matched_pairs: List[MatchedPair]
    unmatched_26as: List[UnmatchedAs26Entry]
    unmatched_books: List[BookEntry]
    session_id: str


# ── API Request / Response ────────────────────────────────────────────────────

class ConfirmAlignmentRequest(BaseModel):
    alignment_id: str
    deductor_name: str
    tan: str


class ReconcileResponse(BaseModel):
    status: str
    alignment_id: Optional[str] = None
    top_candidates: Optional[List[DeductorCandidate]] = None
    identity_string: Optional[str] = None
    reco_summary: Optional[RecoResult] = None
    download_url: Optional[str] = None
    error_message: Optional[str] = None
    cleaning_report: Optional[CleaningReport] = None
