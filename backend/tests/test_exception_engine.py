"""
Exception Engine tests — ensures exceptions are generated for FORCE, HIGH_VARIANCE,
CROSS_FY, and UNMATCHED_HIGH_VALUE scenarios.
"""
import pytest
from dataclasses import dataclass, field
from engine.exception_engine import generate_exceptions
from engine.optimizer import AssignmentResult, BookEntry, As26Entry
from engine.scorer import ScoreBreakdown


def _score():
    return ScoreBreakdown(
        total=60.0, variance_score=24.0, date_score=10.0,
        section_score=20.0, clearing_score=0.0, historical_score=0.0,
    )


def _book(idx=0, amount=100000.0, inv_ref="INV-001"):
    return BookEntry(
        index=idx, invoice_ref=inv_ref, amount=amount,
        doc_date="15-Jun-2023", doc_type="RV",
        clearing_doc="", sap_fy="FY2023-24",
    )


def _as26(idx=0, amount=100000.0):
    return As26Entry(
        index=idx, amount=amount, transaction_date="20-Jun-2023",
        section="194C", tan="BLRM12345A", deductor_name="TEST CO",
    )


def _result(match_type="EXACT", variance_pct=0.0, is_prior_year=False, cross_fy=False,
            as26_amount=100000.0, books=None, suggested=False):
    return AssignmentResult(
        as26_index=0, as26_amount=as26_amount, as26_date="20-Jun-2023",
        as26_section="194C", books=books or [_book()],
        match_type=match_type, variance_pct=variance_pct,
        variance_amt=as26_amount * variance_pct / 100,
        confidence="LOW" if "FORCE" in match_type or is_prior_year else "HIGH",
        score=_score(), cross_fy=cross_fy, is_prior_year=is_prior_year,
        suggested=suggested,
    )


def _empty_val_report():
    from engine.validator import ValidationReport
    return ValidationReport()


# ── FORCE matches generate exceptions ────────────────────────────────────────

def test_force_single_generates_exception():
    matched = [_result(match_type="FORCE_SINGLE", variance_pct=4.0, suggested=True)]
    exc = generate_exceptions(matched, [], _empty_val_report(), "run-1")
    assert len(exc) >= 1
    force_exc = [e for e in exc if e["exception_type"] == "FORCE_MATCH"]
    assert len(force_exc) == 1
    assert force_exc[0]["severity"] == "HIGH"


def test_force_combo_generates_exception():
    books = [_book(0, 50000.0, "INV-001"), _book(1, 49000.0, "INV-002")]
    matched = [_result(match_type="FORCE_COMBO", variance_pct=1.0, books=books, suggested=True)]
    exc = generate_exceptions(matched, [], _empty_val_report(), "run-1")
    force_exc = [e for e in exc if e["exception_type"] == "FORCE_MATCH"]
    assert len(force_exc) == 1


# ── HIGH_VARIANCE generates exception ────────────────────────────────────────

def test_high_variance_generates_exception():
    matched = [_result(match_type="COMBO_3", variance_pct=3.5)]
    exc = generate_exceptions(matched, [], _empty_val_report(), "run-1")
    hv_exc = [e for e in exc if e["exception_type"] == "HIGH_VARIANCE"]
    assert len(hv_exc) == 1
    # Non-suggested matches get INFO severity (auto-confirmed audit trail)
    assert hv_exc[0]["severity"] == "INFO"


def test_high_variance_suggested_gets_medium():
    """Suggested matches with high variance should still get MEDIUM severity."""
    matched = [_result(match_type="COMBO_3", variance_pct=3.5, suggested=True)]
    exc = generate_exceptions(matched, [], _empty_val_report(), "run-1")
    hv_exc = [e for e in exc if e["exception_type"] == "HIGH_VARIANCE"]
    assert len(hv_exc) == 1
    assert hv_exc[0]["severity"] == "MEDIUM"


# ── CROSS_FY generates exception ─────────────────────────────────────────────

def test_cross_fy_generates_exception():
    matched = [_result(match_type="PRIOR_SINGLE", variance_pct=1.0, is_prior_year=True)]
    exc = generate_exceptions(matched, [], _empty_val_report(), "run-1")
    fy_exc = [e for e in exc if e["exception_type"] == "CROSS_FY"]
    assert len(fy_exc) == 1
    assert fy_exc[0]["severity"] == "HIGH"


# ── UNMATCHED_HIGH_VALUE generates exception ──────────────────────────────────

def test_unmatched_high_value_generates_exception():
    unmatched = [_as26(0, 15_00_000.0)]  # 15 lakh > 10 lakh threshold
    exc = generate_exceptions([], unmatched, _empty_val_report(), "run-1")
    uhv_exc = [e for e in exc if e["exception_type"] == "UNMATCHED_HIGH_VALUE"]
    assert len(uhv_exc) == 1
    assert uhv_exc[0]["severity"] == "CRITICAL"


# ── No exceptions for clean matches ──────────────────────────────────────────

def test_exact_match_no_exceptions():
    matched = [_result(match_type="EXACT", variance_pct=0.0)]
    exc = generate_exceptions(matched, [], _empty_val_report(), "run-1")
    assert len(exc) == 0
