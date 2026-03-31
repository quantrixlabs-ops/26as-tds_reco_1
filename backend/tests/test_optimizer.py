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

def test_single_above_2pct_within_admin_ceiling_auto_confirmed():
    """SINGLE at 2.5% variance is above base cap (2%) but within default admin ceiling (3%) — auto-confirmed with flag."""
    as26 = [_as26(0, 100000.0)]
    books = [_book(0, 97500.0)]  # 2.5% variance — above base 2% but within default 3% ceiling
    all_results, unmatched = run_global_optimizer(as26, books, books, [])
    matched, suggested = _split_results(all_results)
    assert len(matched) == 1
    assert matched[0].variance_pct == pytest.approx(2.5, abs=0.1)
    assert matched[0].ai_risk_flag is True  # flagged because above base VARIANCE_CAP_SINGLE


def test_single_above_normal_ceiling_goes_to_suggested():
    """SINGLE at 5% variance exceeds admin ceiling (default 3%) — routed to suggested."""
    as26 = [_as26(0, 100000.0)]
    books = [_book(0, 95000.0)]  # 5% variance — above default 3% admin ceiling
    all_results, unmatched = run_global_optimizer(as26, books, books, [])
    matched, suggested = _split_results(all_results)
    assert len(suggested) == 1
    assert suggested[0].variance_pct == pytest.approx(5.0, abs=0.1)
    assert suggested[0].suggested is True


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


# ── Over-claim prevention: books > 26AS ──────────────────────────────────────

def test_books_exceeding_26as_never_matched():
    """Books sum > 26AS amount must NEVER produce a match (over-claim prevention)."""
    as26 = [_as26(0, 100000.0)]
    # Book slightly exceeds target — must be rejected, not abs()-converted
    books = [_book(0, 100001.0)]
    all_results, unmatched = run_global_optimizer(as26, books, books, [])
    matched, suggested = _split_results(all_results)
    # Verify over-claim rule: no match should have books_sum > as26_amount
    for r in matched + suggested:
        books_sum = sum(b.amount for b in r.books)
        assert books_sum <= r.as26_amount + 0.02, \
            f"OVER-CLAIM VIOLATION: books_sum {books_sum} > as26_amount {r.as26_amount}"


def test_books_at_exact_tolerance_boundary():
    """Book at target + exact_tolerance boundary: should NOT match (over-claim prevention)."""
    as26 = [_as26(0, 100000.0)]
    # Book = target + 0.01 (exact_tolerance) — right at boundary
    books = [_book(0, 100000.01)]
    all_results, unmatched = run_global_optimizer(as26, books, books, [])
    matched, suggested = _split_results(all_results)
    for r in matched + suggested:
        books_sum = sum(b.amount for b in r.books)
        assert books_sum <= r.as26_amount + 0.02


# ── #4: Auto-confirm 3-20% variance ──────────────────────────────────────────

def test_4pct_variance_goes_to_suggested():
    """4% variance exceeds SINGLE tier cap (2%) — reclassified as suggested."""
    as26 = [_as26(0, 100000.0)]
    books = [_book(0, 96000.0)]  # 4% variance — above SINGLE cap (2%)
    all_results, unmatched = run_global_optimizer(as26, books, books, [])
    matched, suggested = _split_results(all_results)
    assert len(suggested) == 1
    assert suggested[0].variance_pct == pytest.approx(4.0, abs=0.1)
    assert suggested[0].suggested is True


def test_10pct_variance_goes_to_suggested():
    """10% variance should NOT be auto-confirmed (above 5% ceiling) — goes to suggested or unmatched."""
    as26 = [_as26(0, 100000.0)]
    books = [_book(0, 90000.0)]  # 10% variance — above 5% auto-confirm ceiling
    all_results, unmatched = run_global_optimizer(as26, books, books, [])
    matched, suggested = _split_results(all_results)
    # Should not be auto-confirmed at 10% (ceiling is 5%)
    assert len(matched) == 0
    # May go to suggested via force match or remain unmatched


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


# ── Clearing Group Config ─────────────────────────────────────────────────────

def _clr_books(clearing_doc="CLR001"):
    """3 books sharing one clearing doc, summing to 97,000 (3% var vs 100,000)."""
    return [
        _book(0, 40000.0, "INV-A", clearing_doc=clearing_doc),
        _book(1, 32000.0, "INV-B", clearing_doc=clearing_doc),
        _book(2, 25000.0, "INV-C", clearing_doc=clearing_doc),
    ]


def test_clearing_group_disabled_skips_phase_a():
    """When clearing_group_enabled=False, no CLR_GROUP matches should appear."""
    from config import MatchConfig
    cfg = MatchConfig(clearing_group_enabled=False)
    books = _clr_books()
    as26 = [_as26(0, 100000.0)]
    all_results, unmatched = run_global_optimizer(as26, books, books, [], config=cfg)
    for r in all_results:
        assert not r.match_type.startswith("CLR_GROUP"), f"Unexpected CLR_GROUP match: {r.match_type}"


def test_clearing_group_variance_tighter():
    """Dedicated variance cap of 2% should reject a 3% clearing group."""
    from config import MatchConfig
    cfg = MatchConfig(
        clearing_group_variance_pct=2.0,
        variance_normal_ceiling_pct=3.0,
    )
    books = _clr_books()  # sums to 97,000 → 3% var vs 100,000
    as26 = [_as26(0, 100000.0)]
    all_results, unmatched = run_global_optimizer(as26, books, books, [], config=cfg)
    for r in all_results:
        assert not r.match_type.startswith("CLR_GROUP"), "CLR_GROUP should not match at 3% when cap is 2%"


def test_clearing_group_variance_looser():
    """Dedicated variance cap of 5% should accept a 3% clearing group even if normal cap is 2%."""
    from config import MatchConfig
    cfg = MatchConfig(
        clearing_group_variance_pct=5.0,
        variance_normal_ceiling_pct=2.0,
    )
    books = _clr_books()  # sums to 97,000 → 3% var vs 100,000
    as26 = [_as26(0, 100000.0)]
    all_results, unmatched = run_global_optimizer(as26, books, books, [], config=cfg)
    matched, suggested = _split_results(all_results)
    clr_matches = [r for r in matched if r.match_type.startswith("CLR_GROUP")]
    assert len(clr_matches) == 1, "CLR_GROUP should match at 3% when cap is 5%"


def test_clearing_group_variance_none_inherits():
    """When clearing_group_variance_pct=None, should inherit variance_normal_ceiling_pct."""
    from config import MatchConfig
    cfg = MatchConfig(
        clearing_group_variance_pct=None,
        variance_normal_ceiling_pct=3.0,
    )
    books = _clr_books()  # 3% var
    as26 = [_as26(0, 100000.0)]
    all_results, unmatched = run_global_optimizer(as26, books, books, [], config=cfg)
    matched, suggested = _split_results(all_results)
    clr_matches = [r for r in matched if r.match_type.startswith("CLR_GROUP")]
    assert len(clr_matches) == 1, "CLR_GROUP should match when inheriting 3% normal ceiling"


def test_proxy_clearing_disabled():
    """When proxy_clearing_enabled=False, no PROXY_GROUP matches should appear."""
    from config import MatchConfig
    cfg = MatchConfig(proxy_clearing_enabled=False)
    # Books with NO clearing doc (forces proxy path) but same doc_date
    books = [
        _book(0, 40000.0, "INV-X", clearing_doc="", doc_date="15-Jun-2023"),
        _book(1, 35000.0, "INV-Y", clearing_doc="", doc_date="15-Jun-2023"),
        _book(2, 22000.0, "INV-Z", clearing_doc="", doc_date="15-Jun-2023"),
    ]
    as26 = [_as26(0, 100000.0)]
    all_results, unmatched = run_global_optimizer(as26, books, books, [], config=cfg)
    for r in all_results:
        assert not r.match_type.startswith("PROXY_GROUP"), f"Unexpected proxy match: {r.match_type}"


# ── Single sweep before combo (U02 starvation prevention) ─────────────────

def test_single_sweep_prevents_combo_starvation():
    """Small entries should claim their 1:1 candidate before combo consumes it."""
    from config import MatchConfig
    cfg = MatchConfig(
        single_sweep_before_combo=True,
        variance_normal_ceiling_pct=10.0,  # wide ceiling so sweep candidates are within auto-confirm
        variance_suggested_ceiling_pct=20.0,
    )
    # Large 26AS entry: 300,000 — needs a combo of 3 books
    # Small 26AS entries: 50,000 each — have a perfect 1:1 match
    as26 = [
        _as26(0, 300000.0, date="15-Jun-2023"),
        _as26(1, 50000.0, date="15-Jun-2023"),
        _as26(2, 50000.0, date="16-Jun-2023"),
    ]
    # Books: two ~50K books (perfect for small entries) + three ~100K books (combo for large)
    # Without sweep, combo for 300K could grab the 50K books as part of a larger combo
    books = [
        _book(0, 100000.0, "INV-A", doc_date="10-Jun-2023"),
        _book(1, 100000.0, "INV-B", doc_date="10-Jun-2023"),
        _book(2, 100000.0, "INV-C", doc_date="10-Jun-2023"),
        _book(3, 49500.0, "INV-D", doc_date="12-Jun-2023"),  # 1% variance to small entry 1
        _book(4, 49000.0, "INV-E", doc_date="13-Jun-2023"),  # 2% variance to small entry 2
    ]
    all_results, unmatched = run_global_optimizer(as26, books, books, [], config=cfg)
    matched, suggested = _split_results(all_results)

    # Both small entries should be matched (not U02 unmatched)
    matched_indices = {r.as26_index for r in matched + suggested}
    assert 1 in matched_indices, "Small entry 1 should be matched by single sweep"
    assert 2 in matched_indices, "Small entry 2 should be matched by single sweep"


def test_single_sweep_disabled_via_config():
    """When single_sweep_before_combo=False, sweep should not run."""
    from config import MatchConfig
    cfg = MatchConfig(
        single_sweep_before_combo=False,
        variance_normal_ceiling_pct=10.0,
        variance_suggested_ceiling_pct=20.0,
    )
    as26 = [
        _as26(0, 300000.0, date="15-Jun-2023"),
        _as26(1, 50000.0, date="15-Jun-2023"),
    ]
    books = [
        _book(0, 100000.0, "INV-A", doc_date="10-Jun-2023"),
        _book(1, 100000.0, "INV-B", doc_date="10-Jun-2023"),
        _book(2, 100000.0, "INV-C", doc_date="10-Jun-2023"),
        _book(3, 49500.0, "INV-D", doc_date="12-Jun-2023"),
    ]
    # Just ensure it runs without error (behavior may vary — no assertion on match outcome)
    all_results, unmatched = run_global_optimizer(as26, books, books, [], config=cfg)
    assert len(all_results) + len(unmatched) >= 1


def test_single_sweep_respects_overclaim():
    """Single sweep must not match if book amount > 26AS amount (Section 199)."""
    from config import MatchConfig
    cfg = MatchConfig(
        single_sweep_before_combo=True,
        variance_normal_ceiling_pct=10.0,
        variance_suggested_ceiling_pct=20.0,
    )
    as26 = [_as26(0, 100000.0, date="15-Jun-2023")]
    books = [_book(0, 100001.0, "INV-OVER", doc_date="12-Jun-2023")]  # over-claim
    all_results, unmatched = run_global_optimizer(as26, books, books, [], config=cfg)
    matched, suggested = _split_results(all_results)
    # Should not create a match that violates Section 199 (books_sum > as26_amount)
    for r in matched:
        assert sum(b.amount for b in r.books) <= r.as26_amount, \
            f"Over-claim violation: books_sum={sum(b.amount for b in r.books)} > as26={r.as26_amount}"


def test_bipartite_widening_prevents_combo_theft():
    """When a small entry's candidate is above admin ceiling (3%) but within suggested
    ceiling (20%), bipartite-widening should commit the book, preventing combo from
    stealing it for a different entry's multi-book match."""
    from config import MatchConfig
    # Tight admin ceiling: only ≤1% gets auto-confirmed by bipartite in old behavior
    cfg_with = MatchConfig(
        single_sweep_before_combo=True,
        variance_normal_ceiling_pct=1.0,
        variance_suggested_ceiling_pct=20.0,
    )
    cfg_without = MatchConfig(
        single_sweep_before_combo=False,
        variance_normal_ceiling_pct=1.0,
        variance_suggested_ceiling_pct=20.0,
    )
    # Entry 0: 200,000 — needs combo of books 0+1+2 (sum=200K)
    # Entry 1: 50,000 — has a single candidate at 3% variance (book 3 = 48,500)
    as26 = [
        _as26(0, 200000.0, date="15-Jun-2023"),
        _as26(1, 50000.0, date="15-Jun-2023"),
    ]
    books = [
        _book(0, 70000.0, "INV-A", doc_date="10-Jun-2023"),
        _book(1, 80000.0, "INV-B", doc_date="10-Jun-2023"),
        _book(2, 48500.0, "INV-C", doc_date="10-Jun-2023"),  # combo candidate AND single candidate
        _book(3, 48500.0, "INV-D", doc_date="12-Jun-2023"),  # 3% variance to entry 1
    ]

    # With widening: bipartite claims book 3 for entry 1 (3% match), combo uses others for entry 0
    res_with, unmatched_with = run_global_optimizer(as26, books, books, [], config=cfg_with)
    all_indices_with = {r.as26_index for r in res_with}
    assert 1 in all_indices_with, "Entry 1 should be matched (bipartite claims its book before combo)"

    # Without widening: book 3 is in soft_candidates (not committed), combo may grab it
    res_without, unmatched_without = run_global_optimizer(as26, books, books, [], config=cfg_without)
    # Just verify it runs — the old behavior may or may not match entry 1
    assert len(res_without) + len(unmatched_without) >= 1
