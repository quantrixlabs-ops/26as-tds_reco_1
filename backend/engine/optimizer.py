"""
Global Optimization Engine — replaces greedy sequential matching.

Strategy (three-tier):
  Tier 1 — Bipartite matching (scipy.optimize.linear_sum_assignment):
    Applied to EXACT and SINGLE candidates within normal variance ceiling.
    Guarantees a globally optimal 1:1 assignment when one invoice matches one 26AS entry.
    Polynomial time complexity O(n^3).

  Tier 2 — Smart combo matching (date-clustered greedy accumulation + subset-sum DP):
    Applied to COMBO candidates (multiple invoices -> one 26AS entry).
    Prefers date-proximate books, respects over-claim prevention constraint (books ≤ 26AS).

  Tier 3 — Force matching (unified):
    All results go to suggested matches for CA review.

Results are routed into two buckets inside one list:
  - result.suggested == False: within normal variance ceiling + date rules -> auto-accepted
  - result.suggested == True:  outside normal but within suggested ceiling -> needs review
  Caller separates by checking result.suggested.
  Unmatched entries returned as a separate list.

Both tiers use composite scores from scorer.py -- NOT just variance.
Final selection is deterministic and reproducible (same input -> same output every time).
All dictionary iterations are explicitly sorted, and tie-breaking uses stable
secondary keys (as26_index, book_index) to guarantee identical output across runs.

If scipy unavailable, falls back to enhanced greedy (descending score, deterministic tie-break).
"""
from __future__ import annotations

import bisect
import logging
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple

import numpy as np

try:
    from scipy.optimize import linear_sum_assignment
    SCIPY_AVAILABLE = True
except ImportError:
    SCIPY_AVAILABLE = False

from engine.scorer import score_candidate, BookCandidate, ScoreBreakdown, _parse_date
from config import (
    MAX_COMBO_SIZE,
    VARIANCE_CAP_SINGLE,
    VARIANCE_CAP_COMBO,
    VARIANCE_CAP_FORCE_SINGLE,
    FORCE_COMBO_MAX_INVOICES,
    FORCE_COMBO_MAX_VARIANCE,
    MatchConfig,
)

logger = logging.getLogger(__name__)


@dataclass
class BookEntry:
    index: int
    invoice_ref: str
    amount: float
    doc_date: Optional[str]
    doc_type: str
    clearing_doc: str
    sap_fy: str
    flag: str = ""


@dataclass
class As26Entry:
    index: int
    amount: float
    transaction_date: Optional[str]
    section: str
    tan: str
    deductor_name: str
    tds_amount: Optional[float] = None
    row_hash: str = ""


@dataclass
class AssignmentResult:
    as26_index: int
    as26_amount: float
    as26_date: Optional[str]
    as26_section: str
    books: List[BookEntry]
    match_type: str         # EXACT / SINGLE / COMBO_N / CLR_GROUP / FORCE_N / PRIOR_*
    variance_pct: float
    variance_amt: float
    confidence: str         # HIGH / MEDIUM / LOW
    score: ScoreBreakdown
    cross_fy: bool = False
    is_prior_year: bool = False
    alternative_matches: List[dict] = field(default_factory=list)
    ai_risk_flag: bool = False
    ai_risk_reason: Optional[str] = None
    # Suggested-match routing fields
    suggested: bool = False
    suggested_category: str = ""  # HIGH_VARIANCE_3_20, HIGH_VARIANCE_20_PLUS, DATE_SOFT_PREFERENCE, ADVANCE_PAYMENT, FORCE, CROSS_FY
    requires_remarks: bool = False
    alert_message: str = ""
    days_gap: Optional[int] = None  # Days between book date and 26AS date


# ── Date constraint helpers ──────────────────────────────────────────────────

def _compute_days_gap(as26_date_str: Optional[str], book_date_str: Optional[str]) -> Optional[int]:
    """Return days gap (positive = book before 26AS). None if either date missing."""
    as26_d = _parse_date(as26_date_str)
    book_d = _parse_date(book_date_str)
    if as26_d is None or book_d is None:
        return None
    return (as26_d - book_d).days


def _is_date_eligible(days_gap: Optional[int], cfg: MatchConfig) -> Tuple[bool, str]:
    """Check if date gap is within hard/soft cutoff. Returns (eligible, category).

    - Within hard cutoff (default 90 days): eligible, category=""
    - Between hard and soft (default 90-180): eligible, category="DATE_SOFT_PREFERENCE"
    - Books AFTER 26AS date (negative gap):
        * Within filing_lag_days (default 45): eligible, category="DATE_SOFT_PREFERENCE"
        * Beyond filing_lag_days: ineligible
    - Beyond soft cutoff (>180): ineligible
    """
    if days_gap is None:
        return True, ""  # no date info, don't exclude
    if days_gap < 0:
        # Book is AFTER 26AS — allow within filing lag tolerance
        filing_lag = getattr(cfg, 'filing_lag_days', 45)
        if abs(days_gap) <= filing_lag:
            return True, "DATE_SOFT_PREFERENCE"
        if cfg.enforce_books_before_26as:
            return False, ""
    abs_gap = abs(days_gap)
    if abs_gap <= cfg.date_hard_cutoff_days:
        return True, ""
    if abs_gap <= cfg.date_soft_preference_days:
        return True, "DATE_SOFT_PREFERENCE"
    return False, ""


# ── Categorisation helper ────────────────────────────────────────────────────

def _categorize_suggested(var_pct: float, date_category: str, cfg: MatchConfig) -> Tuple[str, bool]:
    """Determine suggested category and whether remarks are required.

    Returns (category, requires_remarks).
    """
    if date_category == "DATE_SOFT_PREFERENCE":
        return "DATE_SOFT_PREFERENCE", False
    if var_pct > cfg.variance_suggested_ceiling_pct:
        return "HIGH_VARIANCE_20_PLUS", True  # mandatory remarks
    if var_pct > cfg.variance_normal_ceiling_pct:
        return "HIGH_VARIANCE_3_20", False
    # Within normal ceiling but above tier-specific cap (e.g. SINGLE 2%)
    return "TIER_CAP_EXCEEDED", False


# ── Main entry point ──────────────────────────────────────────────────────────

class CancelledException(Exception):
    """Raised when a run is cancelled by the user."""
    pass


def run_global_optimizer(
    as26_entries: List[As26Entry],
    book_pool: List[BookEntry],
    current_books: List[BookEntry],
    prior_books: List[BookEntry],
    allow_cross_fy: bool = False,
    cfg: Optional[MatchConfig] = None,
    config: Optional[MatchConfig] = None,
    sgl_v_books: Optional[List[BookEntry]] = None,
    progress_cb: Optional[callable] = None,
    cancel_check: Optional[callable] = None,
) -> Tuple[List[AssignmentResult], List[As26Entry]]:
    """
    Run the full global optimization pipeline.

    Parameters:
        cfg: MatchConfig instance. If None, falls back to `config` param or default.
        config: Alias for cfg (backward compatibility). `cfg` takes precedence.
        progress_cb: optional callable(phase, entries_done, entries_total, matched_so_far, detail)
        cancel_check: optional callable() -> bool, returns True if run should be cancelled.

    Returns:
        (all_results, unmatched_as26_entries)

        all_results contains both normal matches (suggested=False) and suggested
        matches (suggested=True). The caller separates them by checking result.suggested.
    """
    # Resolve config: cfg takes precedence, then config param, then default
    if cfg is None:
        cfg = config if config is not None else MatchConfig()

    def _progress(phase: str, done: int = 0, total: int = 0, matched_n: int = 0, detail: str = ""):
        if progress_cb:
            progress_cb(phase, done, total, matched_n, detail)
        if cancel_check and cancel_check():
            raise CancelledException("Run cancelled by user")

    used_book_indices: Set[int] = set()
    consumed_invoice_refs: Set[int] = set()  # book index -- uniquely identifies each book entry
    all_results: List[AssignmentResult] = []

    effective_allow_cross_fy = cfg.allow_cross_fy or allow_cross_fy
    active_books = current_books if not effective_allow_cross_fy else book_pool

    # ── Phase A: Clearing Group Matching ─────────────────────────────────────
    if cfg.clearing_group_enabled:
        logger.info("optimizer.phase_a_start")
        _progress("PHASE_A", 0, len(as26_entries), 0, "Building clearing groups...")
        phase_a_matched, phase_a_unmatched = _phase_a_clearing_groups(
            as26_entries, active_books, used_book_indices, consumed_invoice_refs, cfg
        )
        all_results.extend(phase_a_matched)
        _progress("PHASE_A", len(as26_entries), len(as26_entries), len(all_results),
                  f"Clearing groups done: {len(phase_a_matched)} matched")
    else:
        logger.info("optimizer.phase_a_skipped (clearing_group_enabled=False)")
        _progress("PHASE_A", len(as26_entries), len(as26_entries), 0, "Phase A skipped")
        phase_a_matched = []
        phase_a_unmatched = as26_entries

    # ── Phase B: Bipartite single + smart combo ──────────────────────────────
    logger.info("optimizer.phase_b_start")
    _progress("PHASE_B_SINGLE", 0, len(phase_a_unmatched),
              _count_normal(all_results),
              f"Building single candidates for {len(phase_a_unmatched)} entries...")
    phase_b_results, phase_b_unmatched = _phase_b_global(
        phase_a_unmatched, active_books, used_book_indices, consumed_invoice_refs, cfg,
        progress_cb=progress_cb, matched_so_far=_count_normal(all_results),
    )
    all_results.extend(phase_b_results)

    # ── Phase B.2: Relaxed Individual Matching ────────────────────────────────
    # Retry unmatched entries with relaxed parameters: wider date window (180 days),
    # and slightly relaxed variance. Catches near-misses that Phase B's strict criteria missed.
    if phase_b_unmatched:
        logger.info("optimizer.phase_b2_start")
        _progress("PHASE_B2", 0, len(phase_b_unmatched), _count_normal(all_results),
                  f"Relaxed matching {len(phase_b_unmatched)} entries...")

        # Build a relaxed config: wider date hard cutoff, same auto-confirm ceiling
        relaxed_cfg = MatchConfig(
            date_hard_cutoff_days=cfg.date_soft_preference_days,  # promote soft to hard (180 days)
            date_soft_preference_days=365,  # allow up to 1 year as soft
            enforce_books_before_26as=False,  # allow books after 26AS in relaxed pass
            filing_lag_days=getattr(cfg, 'filing_lag_days', 45),
            variance_normal_ceiling_pct=cfg.variance_normal_ceiling_pct,
            variance_auto_confirm_ceiling_pct=getattr(cfg, 'variance_auto_confirm_ceiling_pct', cfg.variance_suggested_ceiling_pct),
            variance_suggested_ceiling_pct=cfg.variance_suggested_ceiling_pct,
            max_combo_size=cfg.max_combo_size,
            combo_pool_cap=cfg.combo_pool_cap,
            combo_iteration_budget=cfg.combo_iteration_budget,
            exact_tolerance=cfg.exact_tolerance,
            date_clustering_preference=cfg.date_clustering_preference,
        )
        phase_b2_results, phase_b2_unmatched = _phase_b_global(
            phase_b_unmatched, active_books, used_book_indices, consumed_invoice_refs, relaxed_cfg
        )
        # Tag relaxed matches for audit trail
        for r in phase_b2_results:
            if not r.suggested:
                r.alert_message = f"Matched in relaxed pass (Phase B.2): {r.match_type}"
                if r.variance_pct > cfg.variance_normal_ceiling_pct:
                    r.ai_risk_flag = True
                    r.ai_risk_reason = f"Relaxed match at {r.variance_pct:.1f}% variance"
        all_results.extend(phase_b2_results)
        _progress("PHASE_B2", len(phase_b_unmatched), len(phase_b_unmatched),
                  _count_normal(all_results),
                  f"Relaxed done: {_count_normal(phase_b2_results)} matched, "
                  f"{_count_suggested(phase_b2_results)} suggested")
        phase_b_unmatched = phase_b2_unmatched

    # ── Phase C: Force match (all -> suggested) ──────────────────────────────
    if cfg.force_match_enabled:
        logger.info("optimizer.phase_c_start")
        _progress("PHASE_C", 0, len(phase_b_unmatched),
                  _count_normal(all_results),
                  f"Force-matching {len(phase_b_unmatched)} remaining entries...")
        phase_c_suggested, phase_c_unmatched = _phase_c_force_unified(
            phase_b_unmatched, active_books, used_book_indices, consumed_invoice_refs, cfg,
            progress_cb=progress_cb, matched_so_far=_count_normal(all_results),
        )
        all_results.extend(phase_c_suggested)
    else:
        phase_c_unmatched = phase_b_unmatched

    # ── Phase E: Prior-Year Exception (all -> suggested with CROSS_FY category) ─
    if not effective_allow_cross_fy and prior_books:
        logger.info("optimizer.phase_e_start")
        _progress("PHASE_E", 0, len(phase_c_unmatched),
                  _count_normal(all_results),
                  f"Prior-year matching {len(phase_c_unmatched)} entries...")
        phase_e_results, phase_e_unmatched = _phase_b_global(
            phase_c_unmatched, prior_books, used_book_indices, consumed_invoice_refs, cfg
        )
        for r in phase_e_results:
            r.is_prior_year = True
            r.cross_fy = True
            r.match_type = f"PRIOR_{r.match_type}"
            r.suggested = True
            r.suggested_category = "CROSS_FY"
            # All PRIOR_* matches are LOW confidence per spec — CA must review
            r.confidence = "LOW"
            is_boundary = _is_fy_boundary_zone(r.as26_date, days=60)
            if is_boundary:
                r.alert_message = (
                    f"Cross-FY match in boundary zone (within 60 days of FY boundary). "
                    f"{r.alert_message or ''}"
                ).strip()
        all_results.extend(phase_e_results)
        unmatched = phase_e_unmatched
        _progress("PHASE_E", len(phase_c_unmatched), len(phase_c_unmatched),
                  _count_normal(all_results),
                  f"Prior-year done: {len(phase_e_results)} suggested")
    else:
        unmatched = phase_c_unmatched

    # ── Phase B.3: SGL_V advance payment books -> suggested ─────────────────
    # Always try SGL_V books as last resort for unmatched entries (all go to suggested)
    if sgl_v_books and unmatched:
        logger.info("optimizer.phase_b3_start")
        _progress("PHASE_B3", 0, len(unmatched), _count_normal(all_results),
                  f"Advance TDS matching {len(unmatched)} entries against {len(sgl_v_books)} SGL_V books...")
        adv_results, adv_unmatched = _phase_b_global(
            unmatched, sgl_v_books, used_book_indices, consumed_invoice_refs, cfg
        )
        for r in adv_results:
            r.suggested = True
            r.suggested_category = "ADVANCE_PAYMENT"
            r.alert_message = "Matched against advance payment (SGL_V) — CA review required"
            r.confidence = "LOW"
        all_results.extend(adv_results)
        unmatched = adv_unmatched
        _progress("PHASE_B3", len(unmatched), len(unmatched), _count_normal(all_results),
                  f"Advance TDS done: {len(adv_results)} suggested")

    # ── Post-run compliance validation ────────────────────────────────────────
    _progress("POST_VALIDATE", 0, 1, _count_normal(all_results), "Running compliance checks...")
    normal_results = [r for r in all_results if not r.suggested]
    _validate_compliance(normal_results, effective_allow_cross_fy, cfg)
    _progress("POST_VALIDATE", 1, 1, _count_normal(all_results), "Compliance checks passed")

    logger.info("optimizer.complete",
                matched=_count_normal(all_results),
                suggested=_count_suggested(all_results),
                unmatched=len(unmatched))
    return all_results, unmatched


def _count_normal(results: List[AssignmentResult]) -> int:
    """Count non-suggested results."""
    return sum(1 for r in results if not r.suggested)


def _count_suggested(results: List[AssignmentResult]) -> int:
    """Count suggested results."""
    return sum(1 for r in results if r.suggested)


# ── Phase A: Clearing Groups ──────────────────────────────────────────────────

def _phase_a_clearing_groups(
    as26_entries: List[As26Entry],
    book_pool: List[BookEntry],
    used_book_indices: Set[int],
    consumed_invoice_refs: Set[int],
    cfg: MatchConfig,
) -> Tuple[List[AssignmentResult], List[As26Entry]]:
    """Group SAP books by clearing_doc, then match 26AS entries to whole groups."""
    # Build groups
    from collections import defaultdict
    groups: Dict[str, List[BookEntry]] = defaultdict(list)
    for b in book_pool:
        if b.clearing_doc and b.clearing_doc not in ("", "0"):
            groups[b.clearing_doc].append(b)

    # Filter: groups of 2-max_combo_size only
    max_grp = cfg.max_combo_size if cfg.max_combo_size > 0 else MAX_COMBO_SIZE
    valid_groups = {k: v for k, v in groups.items() if 2 <= len(v) <= max_grp}

    # Pre-compute group sums and check availability once
    excluded = used_book_indices | consumed_invoice_refs
    clr_cap = cfg.clearing_group_variance_pct if cfg.clearing_group_variance_pct is not None else cfg.variance_normal_ceiling_pct

    matched: List[AssignmentResult] = []
    unmatched_26as: List[As26Entry] = []

    for as26 in as26_entries:
        best_result = None
        best_score = -1.0
        target = as26.amount

        for clr_doc, group in sorted(valid_groups.items()):  # deterministic iteration
            # All entries available?
            if any(b.index in excluded for b in group):
                continue

            group_sum = sum(b.amount for b in group)
            if group_sum > target + cfg.exact_tolerance:
                continue

            var_pct = (target - group_sum) / target * 100 if target > 0 else 100.0
            if var_pct > clr_cap:
                continue

            # Date eligibility: check at least one book passes
            any_eligible = False
            for b in group:
                days_gap = _compute_days_gap(as26.transaction_date, b.doc_date)
                eligible, _ = _is_date_eligible(days_gap, cfg)
                if eligible:
                    any_eligible = True
                    break
            if not any_eligible:
                continue

            candidate = BookCandidate(
                invoice_refs=[b.invoice_ref for b in group],
                amounts=[b.amount for b in group],
                dates=[b.doc_date for b in group],
                clearing_doc=clr_doc,
                sap_fy=group[0].sap_fy,
            )
            score = score_candidate(target, as26.transaction_date, as26.section, candidate,
                                     enforce_before=cfg.enforce_books_before_26as)

            # Deterministic tie-breaking: higher score wins; on tie, lower clr_doc wins
            if score.total > best_score or (score.total == best_score and best_result and clr_doc < best_result[3]):
                best_score = score.total
                best_result = (group, score, var_pct, clr_doc)

        if best_result:
            books, score, var_pct, clr_doc = best_result
            _commit(books, used_book_indices, consumed_invoice_refs)
            for b in books:
                excluded.add(b.index)
            matched.append(AssignmentResult(
                as26_index=as26.index,
                as26_amount=target,
                as26_date=as26.transaction_date,
                as26_section=as26.section,
                books=books,
                match_type=f"CLR_GROUP_{len(books)}",
                variance_pct=round(var_pct, 4),
                variance_amt=round(target - sum(b.amount for b in books), 2),
                confidence=_confidence(var_pct, "CLR_GROUP", score),
                score=score,
            ))
        else:
            unmatched_26as.append(as26)

    # ── Proxy clearing groups (fallback when clearing_doc is sparse) ────────
    # If Phase A matched very few entries, try date+amount clustering as proxy groups
    clr_coverage = len(matched) / len(as26_entries) if as26_entries else 1.0
    if clr_coverage < 0.1 and len(unmatched_26as) >= 2 and cfg.proxy_clearing_enabled:
        proxy_matched, proxy_unmatched = _proxy_clearing_groups(
            unmatched_26as, book_pool, used_book_indices, consumed_invoice_refs, cfg
        )
        matched.extend(proxy_matched)
        unmatched_26as = proxy_unmatched

    return matched, unmatched_26as


def _proxy_clearing_groups(
    as26_entries: List[As26Entry],
    book_pool: List[BookEntry],
    used_book_indices: Set[int],
    consumed_invoice_refs: Set[int],
    cfg: MatchConfig,
) -> Tuple[List[AssignmentResult], List[As26Entry]]:
    """Fallback: cluster books by date proximity to form proxy clearing groups.
    When clearing_doc is missing/sparse, books with same doc_date and amounts
    that sum close to a 26AS entry form a pseudo-group."""
    from collections import defaultdict

    excluded = used_book_indices | consumed_invoice_refs
    max_grp = cfg.max_combo_size if cfg.max_combo_size > 0 else MAX_COMBO_SIZE
    clr_cap = cfg.clearing_group_variance_pct if cfg.clearing_group_variance_pct is not None else cfg.variance_normal_ceiling_pct

    # Cluster available books by doc_date
    date_groups: Dict[str, List[BookEntry]] = defaultdict(list)
    for b in book_pool:
        if b.index in excluded or not b.doc_date:
            continue
        date_groups[b.doc_date].append(b)

    # Only consider date clusters with 2-max_grp entries
    valid_date_groups = {d: books for d, books in date_groups.items()
                         if 2 <= len(books) <= max_grp}

    matched: List[AssignmentResult] = []
    unmatched: List[As26Entry] = []

    for as26 in as26_entries:
        target = as26.amount
        best_result = None
        best_score = -1.0

        for doc_date, group in sorted(valid_date_groups.items()):  # deterministic iteration
            avail = [b for b in group if b.index not in excluded]
            if len(avail) < 2:
                continue

            group_sum = sum(b.amount for b in avail)
            if group_sum > target + cfg.exact_tolerance:
                # Try subset of the date group
                avail_sorted = sorted(avail, key=lambda b: b.amount, reverse=True)
                subset = []
                sub_sum = 0.0
                for b in avail_sorted:
                    if sub_sum + b.amount <= target + cfg.exact_tolerance:
                        subset.append(b)
                        sub_sum += b.amount
                    if len(subset) >= max_grp:
                        break
                if len(subset) < 2:
                    continue
                avail = subset
                group_sum = sub_sum

            if group_sum > target + cfg.exact_tolerance:
                continue

            var_pct = (target - group_sum) / target * 100 if target > 0 else 100.0
            if var_pct > clr_cap:
                continue

            candidate = BookCandidate(
                invoice_refs=[b.invoice_ref for b in avail],
                amounts=[b.amount for b in avail],
                dates=[b.doc_date for b in avail],
                clearing_doc=None,
                sap_fy=avail[0].sap_fy,
            )
            score = score_candidate(target, as26.transaction_date, as26.section, candidate,
                                     enforce_before=cfg.enforce_books_before_26as)
            if score.total > best_score:
                best_score = score.total
                best_result = (avail, score, var_pct)

        if best_result:
            books, score, var_pct = best_result
            _commit(books, used_book_indices, consumed_invoice_refs)
            for b in books:
                excluded.add(b.index)
            matched.append(AssignmentResult(
                as26_index=as26.index,
                as26_amount=target,
                as26_date=as26.transaction_date,
                as26_section=as26.section,
                books=books,
                match_type=f"PROXY_GROUP_{len(books)}",
                variance_pct=round(var_pct, 4),
                variance_amt=round(target - sum(b.amount for b in books), 2),
                confidence=_confidence(var_pct, "PROXY_GROUP", score),
                score=score,
                alert_message="Matched via date-clustered proxy group (no clearing doc)",
            ))
        else:
            unmatched.append(as26)

    return matched, unmatched


# ── Phase B: Bipartite + Smart Combo ─────────────────────────────────────────

def _phase_b_global(
    as26_entries: List[As26Entry],
    book_pool: List[BookEntry],
    used_book_indices: Set[int],
    consumed_invoice_refs: Set[int],
    cfg: MatchConfig,
    progress_cb: Optional[callable] = None,
    matched_so_far: int = 0,
) -> Tuple[List[AssignmentResult], List[As26Entry]]:
    """
    Phase B: widened candidate search with variance routing.
    Returns (results, unmatched) where results include both normal and suggested.
    """
    if not as26_entries:
        return [], []

    def _progress(phase: str, done: int, total: int, m: int, detail: str):
        if progress_cb:
            progress_cb(phase, done, total, m, detail)

    # Build ALL single candidates (up to suggested ceiling)
    _progress("PHASE_B_SINGLE", 0, len(as26_entries), matched_so_far,
              f"Scoring single candidates across {len(as26_entries)} x {len(book_pool)} pairs...")
    all_candidates = _build_single_candidates(
        as26_entries, book_pool, used_book_indices, consumed_invoice_refs, cfg
    )
    _progress("PHASE_B_SINGLE", 30, 100, matched_so_far,
              f"Built {len(all_candidates)} single candidates. Running bipartite...")

    # Split: normal candidates (for bipartite) vs suggested candidates
    # Auto-confirm ceiling: matches within admin's variance_normal_ceiling are auto-confirmed.
    # Only entries above this ceiling become suggested for CA review.
    auto_confirm_cap = cfg.variance_normal_ceiling_pct
    normal_candidates: Dict[Tuple[int, int], Tuple] = {}
    soft_candidates: Dict[Tuple[int, int], Tuple] = {}

    for key in sorted(all_candidates.keys()):  # deterministic iteration by (as26_idx, book_idx)
        val = all_candidates[key]
        score_val, var_pct, match_type, score_obj, book, date_cat, alert, days_gap = val
        # Route to bipartite if within auto-confirm ceiling
        # Categories: "" (normal), "HIGH_VARIANCE_3_20", "DATE_SOFT_PREFERENCE" all go to bipartite
        # Only "HIGH_VARIANCE_20_PLUS" or above ceiling goes to suggested
        if var_pct <= auto_confirm_cap:
            normal_candidates[key] = val
        else:
            soft_candidates[key] = val

    # Bipartite on normal candidates
    if SCIPY_AVAILABLE and normal_candidates:
        bip_matched, bip_unmatched, bip_used = _bipartite_match(
            as26_entries, normal_candidates, used_book_indices, consumed_invoice_refs, cfg
        )
    elif normal_candidates:
        logger.warning("scipy unavailable -- using greedy fallback for single matches")
        bip_matched, bip_unmatched, bip_used = _greedy_single(
            as26_entries, normal_candidates, used_book_indices, consumed_invoice_refs, cfg
        )
    else:
        bip_matched, bip_unmatched, bip_used = [], list(as26_entries), set()

    # Enforce admin-configured variance ceiling — matches within cfg.variance_normal_ceiling_pct
    # are auto-confirmed. Above the ceiling → reclassified to suggested for CA review.
    # VARIANCE_CAP_SINGLE (2%) is the "clean" threshold — below it, no flag. Above it but
    # within the admin ceiling → auto-confirmed WITH a high-variance flag/exception.
    confirmed_bip: List[AssignmentResult] = []
    reclassified_bip: List[AssignmentResult] = []
    effective_ceiling = cfg.variance_normal_ceiling_pct  # admin-configured ceiling
    for r in bip_matched:
        if r.variance_pct > effective_ceiling:
            # Above admin ceiling — reclassify to suggested for CA review
            cat, req = _categorize_suggested(r.variance_pct, "", cfg)
            r.suggested = True
            r.suggested_category = cat
            r.requires_remarks = req
            r.confidence = "LOW"
            r.ai_risk_flag = True
            r.ai_risk_reason = f"Above admin ceiling: {r.variance_pct:.1f}% > {effective_ceiling}%"
            if not r.alert_message:
                r.alert_message = f"Variance {r.variance_pct:.1f}% exceeds ceiling ({effective_ceiling}%)"
            reclassified_bip.append(r)
        else:
            # Within admin ceiling — auto-confirmed
            if r.variance_pct > VARIANCE_CAP_SINGLE:
                # Above base tier cap but within admin ceiling — flag for awareness
                r.alert_message = (
                    f"Auto-confirmed at {r.variance_pct:.1f}% variance "
                    f"(above base {VARIANCE_CAP_SINGLE}% cap, within admin ceiling {effective_ceiling}%)"
                )
                r.ai_risk_flag = True
                r.ai_risk_reason = f"High variance auto-confirmed: {r.variance_pct:.1f}%"
            confirmed_bip.append(r)

    results: List[AssignmentResult] = confirmed_bip
    # All bipartite-assigned books remain consumed (assignment is globally optimal)
    used_book_indices.update(bip_used)
    consumed_invoice_refs.update(bip_used)

    _progress("PHASE_B_SINGLE", 100, 100, matched_so_far + len(results),
              f"Bipartite done: {len(bip_matched)} single matches. {len(bip_unmatched)} remaining.")

    # Build suggested from soft candidates (only for as26 entries that weren't matched)
    matched_as26_ids = {r.as26_index for r in results}
    suggested: List[AssignmentResult] = []
    for (a_idx, b_idx) in sorted(soft_candidates.keys()):  # deterministic iteration
        val = soft_candidates[(a_idx, b_idx)]
        if a_idx in matched_as26_ids:
            continue  # already matched normally
        score_val, var_pct, match_type, score_obj, book, date_cat, alert, days_gap = val
        if book.index in used_book_indices:
            continue
        as26 = next((e for e in as26_entries if e.index == a_idx), None)
        if not as26:
            continue
        cat, req = _categorize_suggested(var_pct, date_cat, cfg)
        suggested.append(AssignmentResult(
            as26_index=as26.index, as26_amount=as26.amount,
            as26_date=as26.transaction_date, as26_section=as26.section,
            books=[book], match_type=match_type,
            variance_pct=round(var_pct, 4),
            variance_amt=round(as26.amount - book.amount, 2),
            confidence="LOW", score=score_obj,
            suggested=True, suggested_category=cat,
            requires_remarks=req, alert_message=alert,
            days_gap=days_gap,
        ))

    # Merge reclassified bipartite results into suggestions
    for r in reclassified_bip:
        suggested.append(r)

    # Deduplicate suggested: keep only the best suggestion per as26 entry
    best_suggested: Dict[int, AssignmentResult] = {}
    for s in suggested:
        existing = best_suggested.get(s.as26_index)
        if existing is None or s.score.total > existing.score.total or (
            s.score.total == existing.score.total and s.books[0].index < existing.books[0].index
        ):
            best_suggested[s.as26_index] = s
    suggested = [best_suggested[k] for k in sorted(best_suggested.keys())]  # deterministic order

    # Combo matching for ALL unmatched — don't exclude entries with single suggestions,
    # because a combo at 1% may be far better than a single suggestion at 15%
    combo_unmatched = list(bip_unmatched)
    if combo_unmatched:
        _progress("PHASE_B_COMBO", 0, len(combo_unmatched),
                  matched_so_far + len(results),
                  f"Smart combo matching {len(combo_unmatched)} entries...")
        combo_results, final_unmatched = _smart_combo_match(
            combo_unmatched, book_pool, used_book_indices, consumed_invoice_refs, cfg
        )
        results.extend(combo_results)
        _progress("PHASE_B_COMBO", len(combo_unmatched), len(combo_unmatched),
                  matched_so_far + len(results),
                  f"Combo done: {_count_normal(combo_results)} matched, "
                  f"{_count_suggested(combo_results)} suggested.")

        # If an entry got both a single suggestion AND a combo result, always prefer
        # the combo (its books are already committed; keeping both causes invariant violation)
        combo_as26_ids = {r.as26_index for r in combo_results}
        suggested = [s for s in suggested if s.as26_index not in combo_as26_ids]
    else:
        final_unmatched = []

    # Merge suggested into results
    results.extend(suggested)

    # Collect truly unmatched (entries not in any result — matched, suggested, or combo)
    all_handled = {r.as26_index for r in results}
    truly_unmatched = [e for e in as26_entries if e.index not in all_handled]

    return results, truly_unmatched


def _build_single_candidates(
    as26_entries: List[As26Entry],
    book_pool: List[BookEntry],
    used_book_indices: Set[int],
    consumed_invoice_refs: Set[int],
    cfg: MatchConfig,
) -> Dict[Tuple[int, int], Tuple[float, float, str, ScoreBreakdown, BookEntry, str, str, Optional[int]]]:
    """
    Build single-book candidate matches for all 26AS entries.

    Widens the amount range to include candidates up to cfg.variance_suggested_ceiling_pct.
    Applies date eligibility filtering via _is_date_eligible.

    Returns {(as26_idx, book_idx): (score, variance_pct, match_type, score_obj,
              book, date_category, alert, days_gap)}

    date_category: "" for normal, "DATE_SOFT_PREFERENCE" for soft range,
                   "HIGH_VARIANCE_3_20" for 3-20%, "HIGH_VARIANCE_20_PLUS" for >20%.
    """
    excluded = used_book_indices | consumed_invoice_refs
    available = [b for b in book_pool if b.index not in excluded]
    if not available:
        return {}

    available.sort(key=lambda b: b.amount)
    avail_amounts = [b.amount for b in available]
    candidates: Dict[Tuple[int, int], Tuple] = {}

    # Widen to suggested ceiling (e.g., 20%) instead of just SINGLE cap
    max_var = max(cfg.variance_suggested_ceiling_pct, 20.0)
    var_cap_factor = 1.0 - max_var / 100.0

    for as26 in as26_entries:
        target = as26.amount
        if target <= 0:
            continue

        min_book_amt = target * var_cap_factor - cfg.exact_tolerance
        max_book_amt = target + cfg.exact_tolerance

        lo = bisect.bisect_left(avail_amounts, min_book_amt)
        hi = bisect.bisect_right(avail_amounts, max_book_amt)

        a_date = as26.transaction_date
        a_section = as26.section
        a_idx = as26.index
        exact_threshold = cfg.exact_tolerance / target * 100

        for idx in range(lo, hi):
            b = available[idx]

            # Date eligibility check
            days_gap = _compute_days_gap(a_date, b.doc_date)
            eligible, date_cat = _is_date_eligible(days_gap, cfg)
            if not eligible:
                continue

            var_pct = (target - b.amount) / target * 100
            if var_pct < 0:
                continue  # books > target = over-claim prevention, skip

            match_type = "EXACT" if var_pct <= exact_threshold else "SINGLE"

            candidate = BookCandidate(
                invoice_refs=[b.invoice_ref],
                amounts=[b.amount],
                dates=[b.doc_date],
                clearing_doc=b.clearing_doc,
                sap_fy=b.sap_fy,
            )
            score = score_candidate(target, a_date, a_section, candidate,
                                     enforce_before=cfg.enforce_books_before_26as)

            # Determine the overall category for this candidate
            # Date soft preference takes priority, then variance tier
            alert = ""
            if date_cat == "DATE_SOFT_PREFERENCE" and days_gap is not None:
                alert = f"Invoice date {abs(days_gap)} days from 26AS date"
            elif var_pct > cfg.variance_suggested_ceiling_pct:
                date_cat = "HIGH_VARIANCE_20_PLUS" if not date_cat else date_cat
                alert = f"High variance: {var_pct:.1f}% (above {cfg.variance_suggested_ceiling_pct}% ceiling)"
            elif var_pct > cfg.variance_normal_ceiling_pct:
                if not date_cat:
                    date_cat = "HIGH_VARIANCE_3_20"
                alert = f"Variance {var_pct:.1f}% exceeds normal ceiling ({cfg.variance_normal_ceiling_pct}%)"

            candidates[(a_idx, b.index)] = (score.total, var_pct, match_type, score, b,
                                             date_cat, alert, days_gap)

    return candidates


def _bipartite_match(
    as26_entries: List[As26Entry],
    candidates: dict,
    used_book_indices: Set[int],
    consumed_invoice_refs: Set[int],
    cfg: MatchConfig,
) -> Tuple[List[AssignmentResult], List[As26Entry], Set[int]]:
    """
    scipy linear_sum_assignment on the candidate score matrix.
    Maximizes total composite score across all 1:1 assignments globally.
    """
    as26_idx_map = {e.index: i for i, e in enumerate(as26_entries)}
    book_indices = sorted({k[1] for k in candidates})
    book_idx_map = {bi: i for i, bi in enumerate(book_indices)}

    n_a = len(as26_entries)
    n_b = len(book_indices)

    if n_a == 0 or n_b == 0:
        return [], as26_entries, set()

    # Cost matrix: negate score (scipy minimizes)
    cost = np.full((n_a, n_b), 1000.0)

    entry_map: Dict[Tuple[int, int], Tuple] = {}
    for (a_idx, b_idx), val in candidates.items():
        score_val, var_pct, match_type, score_obj, book = val[0], val[1], val[2], val[3], val[4]
        row = as26_idx_map.get(a_idx)
        col = book_idx_map.get(b_idx)
        if row is not None and col is not None:
            cost[row][col] = 100.0 - score_val
            days_gap = val[7] if len(val) > 7 else None
            entry_map[(row, col)] = (var_pct, match_type, score_obj, book, days_gap)

    row_ind, col_ind = linear_sum_assignment(cost)

    matched: List[AssignmentResult] = []
    matched_as26_indices: Set[int] = set()
    used_books: Set[int] = set()

    for row, col in zip(row_ind, col_ind):
        if cost[row][col] >= 999.0:
            continue  # no valid candidate assigned
        as26 = as26_entries[row]
        var_pct, match_type, score_obj, book, days_gap = entry_map[(row, col)]

        matched.append(AssignmentResult(
            as26_index=as26.index,
            as26_amount=as26.amount,
            as26_date=as26.transaction_date,
            as26_section=as26.section,
            books=[book],
            match_type=match_type,
            variance_pct=round(var_pct, 4),
            variance_amt=round(as26.amount - book.amount, 2),
            confidence=_confidence(var_pct, match_type, score_obj),
            score=score_obj,
            days_gap=days_gap,
        ))
        matched_as26_indices.add(as26.index)
        used_books.add(book.index)

    unmatched = [e for e in as26_entries if e.index not in matched_as26_indices]
    return matched, unmatched, used_books


def _greedy_single(
    as26_entries: List[As26Entry],
    candidates: dict,
    used_book_indices: Set[int],
    consumed_invoice_refs: Set[int],
    cfg: MatchConfig,
) -> Tuple[List[AssignmentResult], List[As26Entry], Set[int]]:
    """Score-descending greedy single assignment (deterministic tie-breaking by index pair)."""
    sorted_cands = sorted(candidates.items(), key=lambda x: (-x[1][0], x[0][0], x[0][1]))
    as26_by_idx = {e.index: e for e in as26_entries}
    matched_a26: Set[int] = set()
    matched_books: Set[int] = set()
    matched: List[AssignmentResult] = []
    used_new: Set[int] = set()

    for (a_idx, b_idx), val in sorted_cands:
        if a_idx in matched_a26 or b_idx in matched_books:
            continue
        as26 = as26_by_idx.get(a_idx)
        if not as26:
            continue
        score_val, var_pct, match_type, score_obj, book = val[0], val[1], val[2], val[3], val[4]
        days_gap = val[7] if len(val) > 7 else None
        matched_a26.add(a_idx)
        matched_books.add(b_idx)
        used_new.add(b_idx)
        matched.append(AssignmentResult(
            as26_index=as26.index, as26_amount=as26.amount,
            as26_date=as26.transaction_date, as26_section=as26.section,
            books=[book], match_type=match_type,
            variance_pct=round(var_pct, 4),
            variance_amt=round(as26.amount - book.amount, 2),
            confidence=_confidence(var_pct, match_type, score_obj), score=score_obj,
            days_gap=days_gap,
        ))

    unmatched = [e for e in as26_entries if e.index not in matched_a26]
    return matched, unmatched, used_new


# ── Smart combo matching ─────────────────────────────────────────────────────

def _smart_combo_match(
    as26_entries: List[As26Entry],
    book_pool: List[BookEntry],
    used_book_indices: Set[int],
    consumed_invoice_refs: Set[int],
    cfg: MatchConfig,
) -> Tuple[List[AssignmentResult], List[As26Entry]]:
    """
    Date-clustered combo matching using greedy accumulation + subset-sum DP.
    Returns (results, unmatched) where results may include both normal and suggested.
    Hard timeout guard: if combo matching takes too long, bail out gracefully.
    """
    import time
    from config import COMBO_TIMEOUT_SECONDS

    results: List[AssignmentResult] = []
    unmatched: List[As26Entry] = []

    excluded = set(used_book_indices) | set(consumed_invoice_refs)
    combo_start_time = time.monotonic()

    # Pre-sort book pool by amount once for bisect lookups
    sorted_books = sorted(book_pool, key=lambda b: b.amount)
    sorted_amounts = [b.amount for b in sorted_books]

    for as26 in as26_entries:
        # Timeout guard: if combo matching exceeded time budget, route remaining to unmatched
        if time.monotonic() - combo_start_time > COMBO_TIMEOUT_SECONDS:
            logger.warning(f"Combo timeout after {COMBO_TIMEOUT_SECONDS}s — "
                           f"{len(as26_entries) - len(results) - len(unmatched)} entries skipped")
            unmatched.extend(e for e in as26_entries
                             if e.index not in {r.as26_index for r in results}
                             and e not in unmatched)
            break

        target = as26.amount
        tol = target + cfg.exact_tolerance
        a_date = as26.transaction_date

        # Use bisect to narrow to books with amount <= tol
        hi = bisect.bisect_right(sorted_amounts, tol)

        eligible: List[Tuple[BookEntry, Optional[int], str]] = []
        for idx in range(hi):
            b = sorted_books[idx]
            if b.index in excluded:
                continue
            days_gap = _compute_days_gap(a_date, b.doc_date)
            date_eligible, date_cat = _is_date_eligible(days_gap, cfg)
            if not date_eligible:
                continue
            eligible.append((b, days_gap if days_gap is not None else 999, date_cat))

        if len(eligible) < 2:
            unmatched.append(as26)
            continue

        # Sort by date proximity (closest first) — date clustering preference
        if cfg.date_clustering_preference:
            eligible.sort(key=lambda x: abs(x[1]))

        # Cap the pool
        eligible = eligible[:cfg.combo_pool_cap]

        max_size = cfg.max_combo_size if cfg.max_combo_size > 0 else len(eligible)

        # Try greedy accumulation first — use admin ceiling for combo acceptance
        combo_ceiling = cfg.variance_normal_ceiling_pct
        best_result = _greedy_accumulate(target, eligible, cfg.exact_tolerance, max_size, variance_ceiling=combo_ceiling)

        if best_result is None:
            # Try subset-sum DP on the pool
            amounts = [b.amount for b, _, _ in eligible]
            dp_indices = _subset_sum_dp(target, amounts, cfg.exact_tolerance, max_size, variance_ceiling=combo_ceiling)
            if dp_indices is not None:
                best_result = [eligible[i] for i in dp_indices]

        if best_result is not None:
            # best_result is a list of (book, days_gap, date_cat) tuples
            books = [b for b, _, _ in best_result]
            books_sum = sum(b.amount for b in books)
            var_pct = (target - books_sum) / target * 100 if target > 0 else 100.0

            if var_pct < 0:
                # books_sum > target: over-claim prevention, skip
                unmatched.append(as26)
                continue

            worst_date_cat = ""
            for _, _, dc in best_result:
                if dc == "DATE_SOFT_PREFERENCE":
                    worst_date_cat = "DATE_SOFT_PREFERENCE"
                    break

            combo_size = len(books)
            match_type = f"COMBO_{combo_size}"

            # Score the combo
            clr_docs = set(b.clearing_doc for b in books)
            clr_doc = books[0].clearing_doc if len(clr_docs) == 1 else None
            candidate = BookCandidate(
                invoice_refs=[b.invoice_ref for b in books],
                amounts=[b.amount for b in books],
                dates=[b.doc_date for b in books],
                clearing_doc=clr_doc,
                sap_fy=books[0].sap_fy,
            )
            score_obj = score_candidate(target, a_date, as26.section, candidate,
                                         enforce_before=cfg.enforce_books_before_26as)

            alert = ""
            if worst_date_cat == "DATE_SOFT_PREFERENCE":
                alert = "Contains invoices 90-180 days from 26AS date"

            # Route based on admin ceiling — matches within admin ceiling auto-confirmed
            is_suggested = var_pct > cfg.variance_normal_ceiling_pct

            if is_suggested:
                cat, req_remarks = _categorize_suggested(var_pct, worst_date_cat, cfg)
                if not alert and var_pct > cfg.variance_normal_ceiling_pct:
                    alert = f"Combo variance {var_pct:.1f}% exceeds normal ceiling"
                result = AssignmentResult(
                    as26_index=as26.index, as26_amount=target,
                    as26_date=a_date, as26_section=as26.section,
                    books=books, match_type=match_type,
                    variance_pct=round(var_pct, 4),
                    variance_amt=round(target - books_sum, 2),
                    confidence="LOW",
                    score=score_obj,
                    suggested=True, suggested_category=cat,
                    requires_remarks=req_remarks, alert_message=alert,
                )
                results.append(result)
            else:
                result = AssignmentResult(
                    as26_index=as26.index, as26_amount=target,
                    as26_date=a_date, as26_section=as26.section,
                    books=books, match_type=match_type,
                    variance_pct=round(var_pct, 4),
                    variance_amt=round(target - books_sum, 2),
                    confidence=_confidence(var_pct, match_type, score_obj),
                    score=score_obj,
                )
                # Flag auto-confirmed high-variance combos
                if var_pct > cfg.variance_normal_ceiling_pct:
                    result.alert_message = (
                        f"Auto-confirmed combo at {var_pct:.1f}% variance "
                        f"(above {cfg.variance_normal_ceiling_pct}% normal ceiling)"
                    )
                    result.ai_risk_flag = True
                    result.ai_risk_reason = f"High variance auto-confirmed: {var_pct:.1f}%"
                _commit(books, used_book_indices, consumed_invoice_refs)
                for b in books:
                    excluded.add(b.index)
                results.append(result)
        else:
            unmatched.append(as26)

    return results, unmatched


def _greedy_accumulate(
    target: float,
    eligible: List[Tuple[BookEntry, Optional[int], str]],
    tolerance: float,
    max_size: int,
    variance_ceiling: float = 20.0,
) -> Optional[List[Tuple[BookEntry, Optional[int], str]]]:
    """Greedy: add closest-date books, tracking the tightest accumulation.

    Does NOT return early at the first viable result — continues accumulating
    to find the tightest possible combo (lowest variance).

    Returns list of (book, days_gap, date_cat) tuples or None if no valid
    accumulation found within variance_ceiling.
    """
    accumulated: List[Tuple[BookEntry, Optional[int], str]] = []
    running_sum = 0.0
    best_result: Optional[List[Tuple[BookEntry, Optional[int], str]]] = None
    best_var_pct = float('inf')

    for item in eligible:
        b, days_gap, date_cat = item
        if running_sum + b.amount > target + tolerance:
            continue  # skip this book, it would overshoot
        accumulated.append(item)
        running_sum += b.amount

        var_pct = (target - running_sum) / target * 100 if target > 0 else 100.0
        if 0 <= var_pct < best_var_pct:
            best_var_pct = var_pct
            best_result = list(accumulated)

        # Apply max combo size
        if len(accumulated) >= max_size:
            break

    # Return the tightest accumulation found, if within variance ceiling
    if best_result is not None and best_var_pct <= variance_ceiling:
        return best_result

    return None


def _subset_sum_dp(
    target: float,
    amounts: List[float],
    tolerance: float,
    max_size: int,
    variance_ceiling: float = 20.0,
) -> Optional[List[int]]:
    """DP approach: find subset of amounts closest to target without exceeding it.
    Returns indices of selected items, or None if no valid subset found.

    Uses scaled integer DP for performance. Scales amounts to integer cents.
    The DP table tracks the maximum achievable sum for each (count, capacity) pair.
    """
    n = len(amounts)
    if n == 0:
        return None

    # Scale to integer cents for DP (multiply by 100 and round)
    scale = 100
    int_target = int(round((target + tolerance) * scale))
    int_amounts = [int(round(a * scale)) for a in amounts]

    # Cap DP table size to prevent memory/time explosion
    # If target is too large, use a coarser scale
    max_dp_size = 500_000  # maximum cells in DP table
    if int_target * min(max_size, n) > max_dp_size:
        # Use coarser scaling
        coarse_scale = max(1, int_target * min(max_size, n) // max_dp_size)
        int_target = int_target // coarse_scale
        int_amounts = [a // coarse_scale for a in int_amounts]
        if int_target <= 0:
            return None

    # DP: dp[j] = (best_sum, items_used_count, last_added_index, parent_capacity)
    # We track the best sum achievable with capacity j
    # Using 1D DP with item count tracking

    effective_max_size = min(max_size, n)

    # dp[j] = (sum_value, count, traceback_info)
    # Simple approach: for each number of items k (1..max_size),
    # find the best subset sum <= int_target

    # Use a bitset-like approach: dp[j] = True if sum j is achievable
    # Then find the largest j <= int_target

    # For tractability with item count constraint, iterate items and track counts
    # dp_table[j] = minimum count of items to achieve sum j, or -1 if impossible
    INF = effective_max_size + 1
    dp_count = [INF] * (int_target + 1)
    dp_count[0] = 0
    # Track which items were used: dp_parent[j] = (previous_capacity, item_index)
    dp_parent: List[Optional[Tuple[int, int]]] = [None] * (int_target + 1)

    for i in range(n):
        a = int_amounts[i]
        if a <= 0:
            continue
        # Iterate in reverse to avoid using same item twice
        for j in range(int_target, a - 1, -1):
            prev = j - a
            new_count = dp_count[prev] + 1
            if new_count < dp_count[j] and new_count <= effective_max_size:
                dp_count[j] = new_count
                dp_parent[j] = (prev, i)

    # Find the best (largest) achievable sum that is also <= target (not just target+tolerance)
    # Actually we want sum <= target + tolerance but also as close to target as possible
    int_target_exact = int(round(target * scale))
    if int_target != int(round((target + tolerance) * scale)):
        # We used coarse scaling, recalculate
        pass  # int_target already includes tolerance

    best_j = -1
    best_distance = float('inf')
    for j in range(int_target + 1):
        if dp_count[j] < INF:
            # Distance from target (prefer closest to target, not just largest sum)
            distance = abs(int_target_exact - j) if int_target_exact <= int_target else abs(j - int_target)
            if distance < best_distance:
                best_distance = distance
                best_j = j

    if best_j < 0 or dp_count[best_j] < 2:
        # Need at least 2 items for a combo
        # Try to find any sum with >= 2 items
        best_j_multi = -1
        best_dist_multi = float('inf')
        for j in range(int_target + 1):
            if 2 <= dp_count[j] <= effective_max_size:
                distance = abs(int_target_exact - j) if int_target_exact <= int_target else abs(j - int_target)
                if distance < best_dist_multi:
                    best_dist_multi = distance
                    best_j_multi = j
        if best_j_multi < 0:
            return None
        best_j = best_j_multi

    # Check variance is within ceiling
    approx_sum = best_j / scale if scale == 100 else best_j  # approximate
    approx_var = (target - approx_sum) / target * 100 if target > 0 else 100.0
    if approx_var > variance_ceiling or approx_var < -0.1:
        return None

    # Traceback to find which items were selected
    selected_indices: List[int] = []
    j = best_j
    while j > 0 and dp_parent[j] is not None:
        prev, item_idx = dp_parent[j]
        selected_indices.append(item_idx)
        j = prev

    if len(selected_indices) < 2:
        return None

    return selected_indices


# ── Phase C: Unified Force Match ──────────────────────────────────────────────

def _force_match_one(
    as26: As26Entry,
    available: List[BookEntry],
    avail_amounts: List[float],
    cfg: MatchConfig,
) -> Tuple[Optional[AssignmentResult], bool]:
    """Force-match a single 26AS entry. Returns (result_or_None, is_unmatched).

    Pure function — no shared mutable state, safe for parallel execution.
    """
    target = as26.amount
    a_date = as26.transaction_date

    # Use bisect to narrow to books with amount <= target + tolerance
    hi = bisect.bisect_right(avail_amounts, target + cfg.exact_tolerance)
    if hi == 0:
        return None, True

    eligible: List[Tuple[BookEntry, Optional[int], str]] = []
    for idx in range(hi):
        b = available[idx]
        days_gap = _compute_days_gap(a_date, b.doc_date)
        gap = days_gap if days_gap is not None else 999
        # Force matches beyond 365 days are unreliable — skip
        if abs(gap) > 365:
            continue
        eligible.append((b, gap, ""))

    if not eligible:
        return None, True

    # Sort by date proximity
    if cfg.date_clustering_preference:
        eligible.sort(key=lambda x: abs(x[1]))
    eligible = eligible[:cfg.combo_pool_cap]

    # Force combos limited to FORCE_COMBO_MAX_INVOICES (3) per Brief §3/#3
    max_size_combo = min(
        cfg.max_combo_size if cfg.max_combo_size > 0 else MAX_COMBO_SIZE,
        FORCE_COMBO_MAX_INVOICES,
    )

    # Try greedy accumulation first (allows single + combo, capped at max_size_combo)
    best_result = _greedy_accumulate(target, eligible, cfg.exact_tolerance, max_size_combo, variance_ceiling=FORCE_COMBO_MAX_VARIANCE)
    if best_result is None:
        amounts = [b.amount for b, _, _ in eligible]
        dp_indices = _subset_sum_dp(target, amounts, cfg.exact_tolerance, max_size_combo, variance_ceiling=FORCE_COMBO_MAX_VARIANCE)
        if dp_indices is not None:
            best_result = [eligible[idx] for idx in dp_indices]

    # Also try single best match (greedy may have skipped it)
    # Enforce FORCE_SINGLE 5% variance cap here (Brief §3/#4)
    if best_result is None and eligible:
        best_single = None
        best_single_var = VARIANCE_CAP_FORCE_SINGLE  # Cap at 5%, not 100%
        for b, dg, dc in eligible:
            if b.amount <= target + cfg.exact_tolerance:
                var = (target - b.amount) / target * 100 if target > 0 else 100.0
                if 0 <= var < best_single_var:
                    best_single_var = var
                    best_single = (b, dg, dc)
        if best_single is not None:
            best_result = [best_single]

    if not best_result:
        return None, True

    # Deduplicate books by index (same SAP row cannot appear twice in one match)
    seen_indices: Set[int] = set()
    deduped: List[Tuple] = []
    for item in best_result:
        b = item[0]
        if b.index not in seen_indices:
            seen_indices.add(b.index)
            deduped.append(item)
    best_result = deduped

    books = [b for b, _, _ in best_result]
    books_sum = sum(b.amount for b in books)
    var_pct = (target - books_sum) / target * 100 if target > 0 else 100.0

    if var_pct < 0:
        return None, True  # over-claim prevention: books exceed 26AS amount

    combo_size = len(books)

    # ── Enforce tier-specific force-match caps (Brief §3/#3 and §3/#4) ────
    if combo_size == 1:
        # FORCE_SINGLE: reject if variance exceeds 5% cap
        if var_pct > VARIANCE_CAP_FORCE_SINGLE:
            return None, True
    else:
        # FORCE_COMBO: reject if >3 invoices or >2% variance
        if combo_size > FORCE_COMBO_MAX_INVOICES:
            return None, True
        if var_pct > FORCE_COMBO_MAX_VARIANCE:
            return None, True

    clr_docs = set(b.clearing_doc for b in books)
    clr_doc = books[0].clearing_doc if len(clr_docs) == 1 else None
    candidate = BookCandidate(
        invoice_refs=[b.invoice_ref for b in books],
        amounts=[b.amount for b in books],
        dates=[b.doc_date for b in books],
        clearing_doc=clr_doc,
        sap_fy=books[0].sap_fy,
    )
    score_obj = score_candidate(target, a_date, as26.section, candidate,
                                 enforce_before=cfg.enforce_books_before_26as)

    if var_pct > cfg.variance_suggested_ceiling_pct:
        cat, req_remarks = "HIGH_VARIANCE_20_PLUS", True
    else:
        cat, req_remarks = "FORCE", False

    alert = "Force match -- CA review required"
    if var_pct > cfg.variance_suggested_ceiling_pct:
        alert = f"Force match with {var_pct:.1f}% variance -- mandatory remarks required"

    result = AssignmentResult(
        as26_index=as26.index, as26_amount=target,
        as26_date=a_date, as26_section=as26.section,
        books=books, match_type=f"FORCE_{combo_size}",
        variance_pct=round(var_pct, 4),
        variance_amt=round(target - books_sum, 2),
        confidence="LOW", score=score_obj,
        suggested=True, suggested_category=cat,
        requires_remarks=req_remarks, alert_message=alert,
    )
    return result, False


def _force_match_chunk(
    chunk: List[As26Entry],
    available: List[BookEntry],
    avail_amounts: List[float],
    cfg: MatchConfig,
) -> Tuple[List[AssignmentResult], List[As26Entry]]:
    """Process a chunk of 26AS entries for force matching. Used by parallel executor."""
    suggested: List[AssignmentResult] = []
    unmatched: List[As26Entry] = []
    for as26 in chunk:
        result, is_unmatched = _force_match_one(as26, available, avail_amounts, cfg)
        if is_unmatched:
            unmatched.append(as26)
        elif result:
            suggested.append(result)
        else:
            unmatched.append(as26)
    return suggested, unmatched


def _phase_c_force_unified(
    as26_entries: List[As26Entry],
    book_pool: List[BookEntry],
    used_book_indices: Set[int],
    consumed_invoice_refs: Set[int],
    cfg: MatchConfig,
    progress_cb: Optional[callable] = None,
    matched_so_far: int = 0,
) -> Tuple[List[AssignmentResult], List[As26Entry]]:
    """
    Unified force matching -- all results go to suggested matches (suggested=True).
    Pre-indexes books by amount and parallelizes across CPU cores when beneficial.
    """
    if not as26_entries:
        return [], []

    excluded = set(used_book_indices) | set(consumed_invoice_refs)

    # Pre-filter and sort available books once (excluded never changes in Phase C)
    available = sorted(
        [b for b in book_pool if b.index not in excluded],
        key=lambda b: b.amount,
    )
    avail_amounts = [b.amount for b in available]

    if not available:
        return [], list(as26_entries)

    total = len(as26_entries)
    _progress = lambda done, detail: progress_cb("PHASE_C", done, total, matched_so_far, detail) if progress_cb else None

    # ── Sequential only — parallel was reusing same books across workers ──
    # Invoice reuse prevention requires sequential processing: after each
    # FORCE match, the consumed books must be removed from the pool before
    # the next 26AS entry is attempted.
    suggested: List[AssignmentResult] = []
    unmatched: List[As26Entry] = []
    consumed_indices: Set[int] = set()
    progress_interval = max(1, total // 20)

    for i, as26 in enumerate(as26_entries):
        if progress_cb and i % progress_interval == 0:
            _progress(i, f"Force-matching entry {i + 1}/{total}...")

        result, is_unmatched = _force_match_one(as26, available, avail_amounts, cfg)
        if is_unmatched:
            unmatched.append(as26)
        elif result:
            # ── Remove consumed books from pool to prevent reuse ──
            matched_indices = {b.index for b in result.books}
            consumed_indices.update(matched_indices)
            available = [b for b in available if b.index not in consumed_indices]
            avail_amounts = [b.amount for b in available]
            suggested.append(result)
        else:
            # Defensive: result is None but not flagged as unmatched — treat as unmatched
            unmatched.append(as26)

    # Propagate consumed books back to caller so Phase E and later phases
    # don't reuse books that were force-matched in Phase C
    used_book_indices.update(consumed_indices)
    consumed_invoice_refs.update(consumed_indices)

    _progress(total, f"Force matching done: {len(suggested)} suggested")
    return suggested, unmatched


# ── Helpers ───────────────────────────────────────────────────────────────────

def _commit(books: List[BookEntry], used: Set[int], consumed: Set[int]) -> None:
    """Mark books as consumed. Uses index (globally unique) as the key."""
    for b in books:
        used.add(b.index)
        consumed.add(b.index)


def _variance_pct(as26_amt: float, books_sum: float) -> float:
    if as26_amt <= 0:
        return 100.0
    return (as26_amt - books_sum) / as26_amt * 100


def _is_fy_boundary_zone(date_str: Optional[str], days: int = 60) -> bool:
    """Check if a date falls within N days of the FY boundary (March 31 / April 1)."""
    d = _parse_date(date_str)
    if d is None:
        return False
    # Distance to nearest March 31
    year = d.year
    from datetime import date as _date
    boundaries = [_date(year, 3, 31), _date(year, 4, 1),
                  _date(year - 1, 3, 31), _date(year + 1, 3, 31)]
    return any(abs((d - b).days) <= days for b in boundaries)


def _confidence(variance_pct: float, match_type: str, score: Optional[ScoreBreakdown] = None) -> str:
    """Determine confidence tier from variance, match type, and composite score.

    Tiers:
        HIGH:   exact/near-exact (≤1%), non-force, OR high composite score (≥70) with ≤2%
        MEDIUM: 1–5% variance non-force, OR composite score ≥50
        LOW:    FORCE, PRIOR, PROXY, or high variance (>5%)
    """
    if "FORCE" in match_type or "PRIOR" in match_type:
        return "LOW"
    if "PROXY" in match_type:
        return "MEDIUM" if variance_pct <= 1.0 else "LOW"
    # Use composite score to boost confidence when available
    composite = score.total if score else 0.0
    if variance_pct <= 1.0:
        return "HIGH"
    if variance_pct <= 2.0 and composite >= 70.0:
        return "HIGH"
    if variance_pct <= 5.0:
        return "MEDIUM"
    if composite >= 50.0:
        return "MEDIUM"
    return "LOW"


def _validate_compliance(
    results: List[AssignmentResult],
    allow_cross_fy: bool,
    cfg: Optional[MatchConfig] = None,
) -> None:
    """Post-run compliance assertions -- raises RuntimeError on violation.

    Accepts cfg for configurable combo cap and tolerance. Falls back to
    global constants if cfg is not provided.
    """
    if cfg is None:
        cfg = MatchConfig()

    # 1. Book uniqueness -- no single book entry should appear in two different matches.
    from collections import Counter
    all_book_indices: List[int] = []
    for r in results:
        for b in r.books:
            all_book_indices.append(b.index)
    counts = Counter(all_book_indices)
    duplicates = {k: v for k, v in counts.items() if v > 1}
    if duplicates:
        raise RuntimeError(f"COMPLIANCE VIOLATION: Book entry reuse detected (indices): {duplicates}")

    # 2. books_sum <= as26_amount
    for r in results:
        books_sum = sum(b.amount for b in r.books)
        if books_sum > r.as26_amount + cfg.exact_tolerance:
            raise RuntimeError(
                f"COMPLIANCE VIOLATION: books_sum {books_sum} > as26_amount {r.as26_amount} "
                f"for as26 index {r.as26_index}"
            )

    # 3. Combo cap (only enforce when max_combo_size > 0; 0 = unlimited)
    effective_max = cfg.max_combo_size if cfg.max_combo_size > 0 else 0
    if effective_max > 0:
        for r in results:
            if len(r.books) > effective_max:
                raise RuntimeError(
                    f"COMPLIANCE VIOLATION: Match has {len(r.books)} invoices > "
                    f"max_combo_size={effective_max}"
                )

    # 4. FY boundary
    if not allow_cross_fy:
        for r in results:
            if not r.is_prior_year:
                for b in r.books:
                    if b.sap_fy and r.as26_section:  # only validate when FY data present
                        pass  # FY boundary check requires FY label comparison -- done in service layer
