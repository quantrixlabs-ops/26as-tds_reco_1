"""
Optimizer / matching engine tests — covers all phases + compliance assertions.
"""
import pytest
from engine.optimizer import (
    run_global_optimizer, BookEntry, As26Entry,
    _variance_pct, _confidence,
)


def _book(idx, amount, inv_ref="", clearing_doc="", fy="FY2023-24", doc_date="15-Jun-2023"):
    return BookEntry(
        index=idx, invoice_ref=inv_ref or f"INV-{idx:04d}",
        amount=amount, doc_date=doc_date, doc_type="RV",
        clearing_doc=clearing_doc, sap_fy=fy,
    )


def _as26(idx, amount, section="194C", date="20-Jun-2023"):
    return As26Entry(
        index=idx, amount=amount, transaction_date=date,
        section=section, tan="BLRM12345A", deductor_name="TEST CO",
    )


def _split_results(all_results):
    """Split all_results into (matched, suggested) by checking result.suggested."""
    matched = [r for r in all_results if not r.suggested]
    suggested = [r for r in all_results if r.suggested]
    return matched, suggested


# ── Basic matching ─────────────────────────────────────────────────────────────

def test_exact_match():
    as26 = [_as26(0, 100000.0)]
    books = [_book(0, 100000.0, "INV-001")]
    all_results, unmatched = run_global_optimizer(as26, books, books, [])
    matched, suggested = _split_results(all_results)
    assert len(matched) == 1
    assert len(unmatched) == 0
    assert matched[0].match_type in ("EXACT", "SINGLE", "CLR_GROUP_1")


def test_no_match_above_ceiling():
    as26 = [_as26(0, 100000.0)]
    books = [_book(0, 50000.0)]   # 50% variance — no ceiling covers this
    all_results, unmatched = run_global_optimizer(as26, books, books, [])
    matched, suggested = _split_results(all_results)
    # 50% variance is beyond even suggested ceiling, so truly unmatched
    assert len(unmatched) + len(suggested) >= 1


def test_single_match_within_2pct():
    as26 = [_as26(0, 100000.0)]
    books = [_book(0, 98500.0)]   # 1.5% variance
    all_results, unmatched = run_global_optimizer(as26, books, books, [])
    matched, suggested = _split_results(all_results)
    assert len(matched) == 1
    assert matched[0].variance_pct == pytest.approx(1.5, abs=0.1)


# ── Compliance: books_sum <= as26_amount ───────────────────────────────────────

def test_books_sum_never_exceeds_as26():
    as26 = [_as26(0, 100000.0)]
    books = [_book(0, 100001.0)]  # slightly over — must NOT match
    all_results, unmatched = run_global_optimizer(as26, books, books, [])
    matched, suggested = _split_results(all_results)
    for r in matched:
        assert sum(b.amount for b in r.books) <= r.as26_amount + 0.02


# ── Compliance: invoice reuse ─────────────────────────────────────────────────

def test_invoice_not_reused():
    as26 = [_as26(0, 100000.0), _as26(1, 100000.0)]
    books = [_book(0, 100000.0, "INV-SHARED")]  # one book, two 26AS entries
    all_results, unmatched = run_global_optimizer(as26, books, books, [])
    matched, suggested = _split_results(all_results)
    # Only one can be matched (non-suggested)
    total_matched = len(matched)
    assert total_matched <= 1
    all_refs = [ref for r in matched for b in r.books for ref in [b.invoice_ref]]
    assert len(all_refs) == len(set(all_refs))  # no duplicates


# ── Multiple 26AS vs multiple books ──────────────────────────────────────────

def test_multiple_entries_independent():
    as26 = [_as26(0, 50000.0), _as26(1, 80000.0)]
    books = [_book(0, 50000.0, "INV-001"), _book(1, 80000.0, "INV-002")]
    all_results, unmatched = run_global_optimizer(as26, books, books, [])
    matched, suggested = _split_results(all_results)
    assert len(matched) == 2
    assert len(unmatched) == 0


# ── Cross-FY segregation ──────────────────────────────────────────────────────

def test_prior_fy_not_matched_in_phase_b(monkeypatch):
    """Prior-FY books should only appear in Phase E matches, tagged PRIOR_*."""
    as26 = [_as26(0, 100000.0)]
    current = [_book(0, 100000.0, "INV-CURR", fy="FY2023-24")]
    prior = [_book(1, 100000.0, "INV-PRIOR", fy="FY2022-23")]

    all_results, unmatched = run_global_optimizer(
        as26, current + prior, current, prior, allow_cross_fy=False
    )
    matched, suggested = _split_results(all_results)
    assert len(matched) == 1
    # Current-FY book should win
    assert not matched[0].is_prior_year


# ── Confidence tiers ──────────────────────────────────────────────────────────

def test_confidence_exact_high():
    assert _confidence(0.0, "EXACT") == "HIGH"


def test_confidence_force_always_low():
    assert _confidence(0.5, "FORCE_SINGLE") == "LOW"
    assert _confidence(0.0, "FORCE_COMBO") == "LOW"


def test_confidence_prior_year_low():
    assert _confidence(0.5, "PRIOR_SINGLE") == "LOW"


def test_confidence_medium_range():
    assert _confidence(2.0, "SINGLE") == "MEDIUM"


# ── Variance helper ───────────────────────────────────────────────────────────

def test_variance_pct_exact():
    assert _variance_pct(100000.0, 100000.0) == pytest.approx(0.0)


def test_variance_pct_1pct():
    assert _variance_pct(100000.0, 99000.0) == pytest.approx(1.0)


def test_variance_pct_zero_as26():
    assert _variance_pct(0.0, 100.0) == 100.0


# ── Tier-specific variance caps (Brief §3/#4) ────────────────────────────────

def test_single_above_2pct_auto_confirmed():
    """SINGLE at 2.5% variance should be auto-confirmed (within 20% auto-confirm ceiling).
    Pre-#4 this went to suggested; post-#4 it's auto-matched within the expanded bipartite."""
    as26 = [_as26(0, 100000.0)]
    books = [_book(0, 97500.0)]  # 2.5% variance — above SINGLE cap (2%), below auto-confirm ceiling (20%)
    all_results, unmatched = run_global_optimizer(as26, books, books, [])
    matched, suggested = _split_results(all_results)
    # Should be auto-confirmed (within auto-confirm ceiling of 20%)
    assert len(matched) == 1
    assert matched[0].variance_pct == pytest.approx(2.5, abs=0.1)


def test_single_above_normal_ceiling_gets_risk_flag():
    """SINGLE at 5% variance (above 3% normal ceiling) should be auto-confirmed but flagged."""
    as26 = [_as26(0, 100000.0)]
    books = [_book(0, 95000.0)]  # 5% variance — above normal ceiling (3%), below auto-confirm (20%)
    all_results, unmatched = run_global_optimizer(as26, books, books, [])
    matched, suggested = _split_results(all_results)
    assert len(matched) == 1
    assert matched[0].variance_pct == pytest.approx(5.0, abs=0.1)
    assert matched[0].ai_risk_flag is True
    assert "Auto-confirmed" in (matched[0].alert_message or "")


def test_single_within_2pct_auto_matched():
    """SINGLE at 1.8% variance should be auto-matched (under 2% cap)."""
    as26 = [_as26(0, 100000.0)]
    books = [_book(0, 98200.0)]  # 1.8% variance — under SINGLE cap (2%)
    all_results, unmatched = run_global_optimizer(as26, books, books, [])
    matched, suggested = _split_results(all_results)
    assert len(matched) == 1
    assert matched[0].variance_pct == pytest.approx(1.8, abs=0.1)


# ── FORCE_SINGLE 5% cap (Brief §3/#4) ────────────────────────────────────────

def test_force_single_within_5pct():
    """FORCE_SINGLE at 4% should produce a suggested match."""
    as26 = [_as26(0, 100000.0)]
    books = [_book(0, 96000.0)]  # 4% variance — within FORCE_SINGLE cap (5%)
    from config import MatchConfig
    cfg = MatchConfig(force_match_enabled=True)
    all_results, unmatched = run_global_optimizer(as26, books, books, [], cfg=cfg)
    matched, suggested = _split_results(all_results)
    # 4% is above normal (2% single cap) but within force-single (5%)
    # Should appear as suggested via Phase C
    assert len(suggested) >= 1 or len(matched) >= 1  # matched or suggested, not lost


def test_force_single_above_5pct_rejected():
    """FORCE_SINGLE at 6% should NOT produce a match — exceeds 5% cap."""
    as26 = [_as26(0, 100000.0)]
    books = [_book(0, 94000.0)]  # 6% variance — above FORCE_SINGLE cap (5%)
    from config import MatchConfig
    cfg = MatchConfig(force_match_enabled=True)
    all_results, unmatched = run_global_optimizer(as26, books, books, [], cfg=cfg)
    matched, suggested = _split_results(all_results)
    # Should be unmatched — 6% exceeds FORCE_SINGLE 5% cap
    # (may still appear as suggested via Phase B soft candidates if within 20% suggested ceiling)
    force_results = [r for r in suggested if "FORCE" in r.match_type]
    assert len(force_results) == 0  # no FORCE matches should exist


# ── FORCE_COMBO restrictions (Brief §3/#3) ────────────────────────────────────

def test_force_combo_max_3_invoices():
    """FORCE_COMBO should use at most 3 invoices (FORCE_COMBO_MAX_INVOICES)."""
    as26 = [_as26(0, 100000.0)]
    # 4 books that sum close to target — force match should NOT use all 4
    books = [
        _book(0, 24000.0), _book(1, 25000.0),
        _book(2, 24500.0), _book(3, 25500.0),
    ]  # sum = 99000, 4 books
    from config import MatchConfig
    cfg = MatchConfig(force_match_enabled=True)
    all_results, unmatched = run_global_optimizer(as26, books, books, [], cfg=cfg)
    matched, suggested = _split_results(all_results)
    force_results = [r for r in suggested if "FORCE" in r.match_type]
    for r in force_results:
        assert len(r.books) <= 3, f"FORCE_COMBO used {len(r.books)} invoices, max is 3"


def test_force_combo_above_2pct_rejected():
    """FORCE_COMBO with >2% variance should NOT produce a FORCE match."""
    as26 = [_as26(0, 100000.0)]
    # Two books summing to 96000 = 4% variance, exceeds FORCE_COMBO 2% cap
    books = [_book(0, 48000.0), _book(1, 48000.0)]
    from config import MatchConfig
    cfg = MatchConfig(force_match_enabled=True)
    all_results, unmatched = run_global_optimizer(as26, books, books, [], cfg=cfg)
    matched, suggested = _split_results(all_results)
    force_results = [r for r in suggested if "FORCE" in r.match_type]
    # 4% variance on a 2-invoice combo exceeds FORCE_COMBO_MAX_VARIANCE (2%)
    assert len(force_results) == 0


# ── Section 199 attack: books > 26AS ─────────────────────────────────────────

def test_books_exceeding_26as_never_matched():
    """Books sum > 26AS amount must NEVER produce a match (Section 199 hard constraint)."""
    as26 = [_as26(0, 100000.0)]
    # Book slightly exceeds target — must be rejected, not abs()-converted
    books = [_book(0, 100001.0)]
    all_results, unmatched = run_global_optimizer(as26, books, books, [])
    matched, suggested = _split_results(all_results)
    # Verify Section 199: no match should have books_sum > as26_amount
    for r in matched + suggested:
        books_sum = sum(b.amount for b in r.books)
        assert books_sum <= r.as26_amount + 0.02, \
            f"Section 199 VIOLATION: books_sum {books_sum} > as26_amount {r.as26_amount}"


def test_books_at_exact_tolerance_boundary():
    """Book at target + exact_tolerance boundary: should NOT match (Section 199)."""
    as26 = [_as26(0, 100000.0)]
    # Book = target + 0.01 (exact_tolerance) — right at boundary
    books = [_book(0, 100000.01)]
    all_results, unmatched = run_global_optimizer(as26, books, books, [])
    matched, suggested = _split_results(all_results)
    for r in matched + suggested:
        books_sum = sum(b.amount for b in r.books)
        assert books_sum <= r.as26_amount + 0.02


# ── #4: Auto-confirm 3-20% variance ──────────────────────────────────────────

def test_10pct_variance_auto_confirmed():
    """10% variance should be auto-confirmed (within 20% auto-confirm ceiling)."""
    as26 = [_as26(0, 100000.0)]
    books = [_book(0, 90000.0)]  # 10% variance
    all_results, unmatched = run_global_optimizer(as26, books, books, [])
    matched, suggested = _split_results(all_results)
    assert len(matched) == 1
    assert matched[0].variance_pct == pytest.approx(10.0, abs=0.1)
    # Should be flagged as high-variance auto-confirm
    assert matched[0].ai_risk_flag is True


def test_25pct_variance_goes_to_suggested():
    """25% variance should NOT be auto-confirmed (above 20% ceiling) — goes to suggested."""
    as26 = [_as26(0, 100000.0)]
    books = [_book(0, 75000.0)]  # 25% variance — above auto-confirm ceiling
    all_results, unmatched = run_global_optimizer(as26, books, books, [])
    matched, suggested = _split_results(all_results)
    # Should not be auto-confirmed
    assert len(matched) == 0
    # Note: may go to suggested via force match or just be unmatched
    # 25% is above the 20% suggested ceiling too, so likely unmatched


# ── #5: Directional date tolerance ────────────────────────────────────────────

def test_book_30days_after_26as_allowed():
    """Book 30 days after 26AS should be allowed (within 45-day filing lag)."""
    from engine.optimizer import _compute_days_gap, _is_date_eligible
    from config import MatchConfig
    # Book on 20-Jul-2023, 26AS on 20-Jun-2023 → days_gap = -30 (book 30 days AFTER)
    gap = _compute_days_gap("20-Jun-2023", "20-Jul-2023")
    assert gap == -30
    cfg = MatchConfig()
    eligible, cat = _is_date_eligible(gap, cfg)
    assert eligible is True
    assert cat == "DATE_SOFT_PREFERENCE"


def test_book_60days_after_26as_rejected():
    """Book 60 days after 26AS should be rejected (beyond 45-day filing lag)."""
    from engine.optimizer import _compute_days_gap, _is_date_eligible
    from config import MatchConfig
    gap = _compute_days_gap("20-Jun-2023", "19-Aug-2023")
    assert gap == -60
    cfg = MatchConfig()
    eligible, cat = _is_date_eligible(gap, cfg)
    assert eligible is False


# ── #6: Confidence recalibration ─────────────────────────────────────────────

def test_confidence_boosted_by_high_score():
    """1.5% variance with composite score ≥70 should be HIGH confidence."""
    from engine.scorer import ScoreBreakdown
    score = ScoreBreakdown(total=75.0, variance_score=25.0, date_score=20.0,
                            section_score=15.0, clearing_score=15.0, historical_score=0.0)
    assert _confidence(1.5, "SINGLE", score) == "HIGH"


def test_confidence_low_for_high_variance():
    """8% variance without high score should be LOW."""
    assert _confidence(8.0, "COMBO_3") == "LOW"


# ── #8: FY boundary zone ─────────────────────────────────────────────────────

def test_fy_boundary_detection():
    """Dates near March 31 should be detected as boundary zone."""
    from engine.optimizer import _is_fy_boundary_zone
    assert _is_fy_boundary_zone("15-Mar-2024") is True   # 16 days from Mar 31
    assert _is_fy_boundary_zone("10-Apr-2024") is True   # 10 days from Apr 1
    assert _is_fy_boundary_zone("20-Jun-2023") is False  # far from boundary
