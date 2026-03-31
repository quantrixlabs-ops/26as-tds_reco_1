"""
Reconciliation Service — orchestrates the full pipeline:
1. File hashing + intake
2. Cleaning (SAP + 26AS)
3. Validation
4. Global optimization (matching)
5. Exception generation
6. DB persistence
7. Audit logging
8. Excel output generation
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, List, Tuple

import pandas as pd
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func

from core.settings import settings
from core.security import sha256_file
from core.audit import log_event, log_sync
from db.models import (
    ReconciliationRun, MatchedPair, Unmatched26AS, UnmatchedBook,
    ExceptionRecord, RunCounter, User, SuggestedMatch, AdminSettings
)
from engine.validator import validate_26as, validate_sap_books, compute_control_totals
from engine.exception_engine import generate_exceptions, detect_pan_risk
from engine.optimizer import (
    run_global_optimizer, BookEntry, As26Entry, AssignmentResult,
    _compute_days_gap, _is_date_eligible,
)
from config import (
    MatchConfig,
    ALLOW_CROSS_FY, DEFAULT_FINANCIAL_YEAR,
    fy_date_range, sap_date_window, date_to_fy_label,
    MAX_COMBO_SIZE, VARIANCE_CAP_SINGLE, VARIANCE_CAP_COMBO,
    VARIANCE_CAP_FORCE_SINGLE, FORCE_COMBO_MAX_INVOICES,
    AUTO_APPROVAL_MIN_MATCH_RATE,
)

# Import existing v1.0 parsers (reused)
import sys
sys.path.insert(0, str(Path(__file__).parent.parent))
from cleaner import clean_sap_books
from parser_26as import parse_26as

from services import progress_store

logger = logging.getLogger(__name__)

UPLOAD_DIR = Path(settings.UPLOAD_DIR)
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# ── Parse-Once Cache ─────────────────────────────────────────────────────────
# Caches parsed 26AS DataFrames by SHA-256 hash to avoid re-parsing the same
# file N times in an N-party batch. Thread-safe: asyncio is single-threaded.
import time as _time

_parse_cache: dict[str, tuple[pd.DataFrame, float]] = {}  # hash → (df, timestamp)
_PARSE_CACHE_TTL = 600  # 10 minutes


def _purge_parse_cache() -> None:
    now = _time.time()
    expired = [k for k, (_, ts) in _parse_cache.items() if now - ts > _PARSE_CACHE_TTL]
    for k in expired:
        del _parse_cache[k]


def _get_cached_26as(as26_hash: str) -> Optional[pd.DataFrame]:
    """Return a copy of the cached 26AS DataFrame, or None if not cached."""
    entry = _parse_cache.get(as26_hash)
    if entry is None:
        return None
    df, ts = entry
    if _time.time() - ts > _PARSE_CACHE_TTL:
        del _parse_cache[as26_hash]
        return None
    return df.copy()


def _set_cached_26as(as26_hash: str, df: pd.DataFrame) -> None:
    """Store a copy of the parsed 26AS DataFrame in cache."""
    _purge_parse_cache()
    _parse_cache[as26_hash] = (df.copy(), _time.time())


# ── Cross-Run Invoice Uniqueness Registry ─────────────────────────────────────
# In batch mode, prevents the same invoice_ref from being matched across
# different parties. batch_id → set of consumed invoice_ref strings.
_batch_invoice_registry: dict[str, set[str]] = {}
_INVOICE_REGISTRY_TTL = 3600  # 1 hour


def _get_batch_consumed_invoices(batch_id: str) -> set[str]:
    """Get the set of invoice_refs already consumed by other runs in this batch."""
    return _batch_invoice_registry.get(batch_id, set()).copy()


def _register_batch_invoices(batch_id: str, invoice_refs: set[str]) -> None:
    """Register invoice_refs as consumed by a run in this batch."""
    if batch_id not in _batch_invoice_registry:
        _batch_invoice_registry[batch_id] = set()
    _batch_invoice_registry[batch_id].update(invoice_refs)


def _purge_invoice_registry() -> None:
    """Purge stale batch registries (called opportunistically)."""
    # Simple: limit total entries. In production, could use timestamps.
    if len(_batch_invoice_registry) > 100:
        # Keep only the 50 most recent (arbitrary, but prevents unbounded growth)
        keys = list(_batch_invoice_registry.keys())
        for k in keys[:len(keys) - 50]:
            del _batch_invoice_registry[k]


# ── Batch Control Total Registry ──────────────────────────────────────────────
# Tracks per-party 26AS amounts and the full-file total for control total assertion.
# batch_id → {"full_total": float | None, "party_totals": {run_id: float}}
_batch_control_totals: dict[str, dict] = {}


def _init_batch_control_total(batch_id: str, full_26as_total: float) -> None:
    """Set the full 26AS total for a batch (called once at batch creation)."""
    if batch_id not in _batch_control_totals:
        _batch_control_totals[batch_id] = {"full_total": full_26as_total, "party_totals": {}}
    else:
        _batch_control_totals[batch_id]["full_total"] = full_26as_total


def _register_party_control_total(batch_id: str, run_id: str, party_26as_total: float) -> None:
    """Register one party's 26AS slice total."""
    if batch_id not in _batch_control_totals:
        _batch_control_totals[batch_id] = {"full_total": None, "party_totals": {}}
    _batch_control_totals[batch_id]["party_totals"][run_id] = party_26as_total


def _check_batch_control_total(batch_id: str) -> tuple[bool, float, float]:
    """Check if the sum of party slices equals the full 26AS total.
    Returns (balanced, sum_of_parties, full_total)."""
    entry = _batch_control_totals.get(batch_id)
    if not entry or entry["full_total"] is None:
        return True, 0.0, 0.0
    full = entry["full_total"]
    parties_sum = sum(entry["party_totals"].values())
    # Allow 0.01 tolerance for floating point
    balanced = abs(parties_sum - full) < 0.01
    return balanced, parties_sum, full


async def _is_control_total_enabled(db: AsyncSession) -> bool:
    """Check if batch control total assertion is enabled."""
    result = await db.execute(
        select(AdminSettings).where(AdminSettings.is_active == True)
    )
    s = result.scalar_one_or_none()
    return s.batch_control_total_enabled if s and s.batch_control_total_enabled is not None else False


async def _is_batch_invoice_dedup_enabled(db: AsyncSession) -> bool:
    """Check if cross-run invoice uniqueness is enabled in admin settings."""
    result = await db.execute(
        select(AdminSettings).where(AdminSettings.is_active == True)
    )
    s = result.scalar_one_or_none()
    return s.batch_invoice_dedup_enabled if s and s.batch_invoice_dedup_enabled is not None else False


async def _is_parse_cache_enabled(db: AsyncSession) -> bool:
    """Check if parse-once cache is enabled in admin settings."""
    result = await db.execute(
        select(AdminSettings).where(AdminSettings.is_active == True)
    )
    s = result.scalar_one_or_none()
    return s.batch_parse_cache_enabled if s and s.batch_parse_cache_enabled is not None else True


async def _is_approval_workflow_enabled(db: AsyncSession) -> bool:
    """Check if run approval workflow is enabled in admin settings."""
    result = await db.execute(
        select(AdminSettings).where(AdminSettings.is_active == True)
    )
    s = result.scalar_one_or_none()
    return s.approval_workflow_enabled if s and s.approval_workflow_enabled is not None else True


def _parse_26as_with_cache(
    as26_bytes: bytes,
    as26_hash: str,
    use_cache: bool,
    lenient_mode: bool = True,
) -> pd.DataFrame:
    """Parse 26AS with optional cache lookup/store.

    Phase 5H: When lenient_mode=True (default), always parse in lenient mode.
    When False, try strict first and fall back to lenient on error.
    """
    if use_cache:
        cached = _get_cached_26as(as26_hash)
        if cached is not None:
            logger.info(f"26AS parse cache HIT for hash {as26_hash[:12]}...")
            return cached

    if lenient_mode:
        df = parse_26as(as26_bytes, lenient=True)
    else:
        try:
            df = parse_26as(as26_bytes)
        except (ValueError, StopIteration, KeyError):
            df = parse_26as(as26_bytes, lenient=True)

    if use_cache:
        _set_cached_26as(as26_hash, df)
        logger.info(f"26AS parse cache STORE for hash {as26_hash[:12]}... ({len(df)} rows)")

    return df


async def _next_run_number(db: AsyncSession) -> int:
    """Atomic monotonic run counter."""
    result = await db.execute(select(RunCounter).where(RunCounter.id == 1))
    counter = result.scalar_one_or_none()
    if not counter:
        counter = RunCounter(id=1, current_value=0)
        db.add(counter)
    counter.current_value += 1
    await db.flush()
    return counter.current_value


# ── MatchConfig Loading ───────────────────────────────────────────────────────

async def _load_match_config(
    db: AsyncSession,
    run_config_overrides: Optional[dict] = None,
) -> Tuple[MatchConfig, Optional[str]]:
    """Load admin settings from DB, apply any per-run overrides, return (MatchConfig, admin_settings_id).

    Returns the admin_settings_id so callers can link the exact settings version to the run.
    """
    result = await db.execute(
        select(AdminSettings).where(AdminSettings.is_active == True)
    )
    admin_settings = result.scalar_one_or_none()
    admin_settings_id = admin_settings.id if admin_settings else None

    if admin_settings:
        match_cfg = MatchConfig(
            doc_types_include=admin_settings.doc_types_include or ["RV", "DR"],
            doc_types_exclude=admin_settings.doc_types_exclude or ["CC", "BR"],
            date_hard_cutoff_days=admin_settings.date_hard_cutoff_days if admin_settings.date_hard_cutoff_days is not None else 90,
            date_soft_preference_days=admin_settings.date_soft_preference_days if admin_settings.date_soft_preference_days is not None else 180,
            enforce_books_before_26as=admin_settings.enforce_books_before_26as if admin_settings.enforce_books_before_26as is not None else True,
            variance_normal_ceiling_pct=admin_settings.variance_normal_ceiling_pct if admin_settings.variance_normal_ceiling_pct is not None else 3.0,
            variance_suggested_ceiling_pct=admin_settings.variance_suggested_ceiling_pct if admin_settings.variance_suggested_ceiling_pct is not None else 20.0,
            exclude_sgl_v=admin_settings.exclude_sgl_v if admin_settings.exclude_sgl_v is not None else True,
            max_combo_size=admin_settings.max_combo_size if admin_settings.max_combo_size is not None else 0,
            date_clustering_preference=admin_settings.date_clustering_preference if admin_settings.date_clustering_preference is not None else True,
            allow_cross_fy=admin_settings.allow_cross_fy if admin_settings.allow_cross_fy is not None else False,
            cross_fy_lookback_years=admin_settings.cross_fy_lookback_years if admin_settings.cross_fy_lookback_years is not None else 1,
            force_match_enabled=admin_settings.force_match_enabled if admin_settings.force_match_enabled is not None else True,
            noise_threshold=admin_settings.noise_threshold if admin_settings.noise_threshold is not None else 1.0,
            clearing_group_enabled=admin_settings.clearing_group_enabled if admin_settings.clearing_group_enabled is not None else True,
            clearing_group_variance_pct=admin_settings.clearing_group_variance_pct,
            proxy_clearing_enabled=admin_settings.proxy_clearing_enabled if admin_settings.proxy_clearing_enabled is not None else True,
            # Phase 3
            section_filter_enabled=admin_settings.section_filter_enabled if admin_settings.section_filter_enabled is not None else False,
            invoice_date_proximity_enabled=admin_settings.invoice_date_proximity_enabled if admin_settings.invoice_date_proximity_enabled is not None else False,
            max_date_gap_days=admin_settings.max_date_gap_days if admin_settings.max_date_gap_days is not None else 90,
            bipartite_matching_enabled=admin_settings.bipartite_matching_enabled if admin_settings.bipartite_matching_enabled is not None else False,
            enumerate_alternatives_enabled=admin_settings.enumerate_alternatives_enabled if admin_settings.enumerate_alternatives_enabled is not None else False,
            # Phase 5A: Exception severity
            high_value_threshold=admin_settings.high_value_threshold if admin_settings.high_value_threshold is not None else 1_000_000.0,
            auto_escalate_high_value=admin_settings.auto_escalate_high_value if admin_settings.auto_escalate_high_value is not None else True,
            force_match_exception_severity=admin_settings.force_match_exception_severity if admin_settings.force_match_exception_severity is not None else "HIGH",
            # Phase 5B: Scoring weights
            score_weight_variance=admin_settings.score_weight_variance if admin_settings.score_weight_variance is not None else 30.0,
            score_weight_date=admin_settings.score_weight_date if admin_settings.score_weight_date is not None else 20.0,
            score_weight_section=admin_settings.score_weight_section if admin_settings.score_weight_section is not None else 20.0,
            score_weight_clearing=admin_settings.score_weight_clearing if admin_settings.score_weight_clearing is not None else 20.0,
            score_weight_historical=admin_settings.score_weight_historical if admin_settings.score_weight_historical is not None else 10.0,
            custom_scoring_enabled=admin_settings.custom_scoring_enabled if admin_settings.custom_scoring_enabled is not None else False,
            # Phase 5C: Variance ceilings
            variance_ceiling_single_pct=admin_settings.variance_ceiling_single_pct if admin_settings.variance_ceiling_single_pct is not None else 2.0,
            variance_ceiling_combo_pct=admin_settings.variance_ceiling_combo_pct if admin_settings.variance_ceiling_combo_pct is not None else 3.0,
            variance_ceiling_force_single_pct=admin_settings.variance_ceiling_force_single_pct if admin_settings.variance_ceiling_force_single_pct is not None else 5.0,
            variance_ceiling_force_combo_pct=admin_settings.variance_ceiling_force_combo_pct if admin_settings.variance_ceiling_force_combo_pct is not None else 2.0,
            custom_variance_ceilings_enabled=admin_settings.custom_variance_ceilings_enabled if admin_settings.custom_variance_ceilings_enabled is not None else False,
            # Phase 5D: Combo heuristics
            combo_pool_cap=admin_settings.combo_pool_cap if admin_settings.combo_pool_cap is not None else 5000,
            combo_iteration_budget=admin_settings.combo_iteration_budget if admin_settings.combo_iteration_budget is not None else 50_000,
            combo_date_window_days=admin_settings.combo_date_window_days if admin_settings.combo_date_window_days is not None else 30,
            # Phase 5E: Date proximity
            date_proximity_profile=admin_settings.date_proximity_profile if admin_settings.date_proximity_profile is not None else "STANDARD",
            filing_lag_days_tolerance=admin_settings.filing_lag_days_tolerance if admin_settings.filing_lag_days_tolerance is not None else 45,
            # Phase 5F: Clearing document
            clearing_doc_bonus_score=admin_settings.clearing_doc_bonus_score if admin_settings.clearing_doc_bonus_score is not None else 20.0,
            proxy_clearing_date_window_days=admin_settings.proxy_clearing_date_window_days if admin_settings.proxy_clearing_date_window_days is not None else 30,
            # Phase 5G: Rate & section validation
            rate_tolerance_pct=admin_settings.rate_tolerance_pct if admin_settings.rate_tolerance_pct is not None else 2.0,
            rate_mismatch_severity=admin_settings.rate_mismatch_severity if admin_settings.rate_mismatch_severity is not None else "MEDIUM",
            # Phase 5H: Parser & cleaner
            parser_lenient_mode=admin_settings.parser_lenient_mode if admin_settings.parser_lenient_mode is not None else True,
            cleaner_duplicate_strategy=admin_settings.cleaner_duplicate_strategy if admin_settings.cleaner_duplicate_strategy is not None else "FIRST_OCCURRENCE",
            # Phase 6A: Confidence tiers
            confidence_high_variance_threshold=admin_settings.confidence_high_variance_threshold if admin_settings.confidence_high_variance_threshold is not None else 1.0,
            confidence_medium_variance_threshold=admin_settings.confidence_medium_variance_threshold if admin_settings.confidence_medium_variance_threshold is not None else 5.0,
            confidence_score_boost_threshold=admin_settings.confidence_score_boost_threshold if admin_settings.confidence_score_boost_threshold is not None else 70.0,
            # Phase 6B: Exact tolerance
            exact_tolerance=admin_settings.exact_tolerance_rupees if admin_settings.exact_tolerance_rupees is not None else 0.01,
            # Phase 6C: Auto-approval
            auto_approval_enabled=admin_settings.auto_approval_enabled if admin_settings.auto_approval_enabled is not None else False,
            auto_approval_min_match_rate=admin_settings.auto_approval_min_match_rate if admin_settings.auto_approval_min_match_rate is not None else 75.0,
            auto_approval_max_exceptions=admin_settings.auto_approval_max_exceptions if admin_settings.auto_approval_max_exceptions is not None else 10,
            # Phase 6D: Section confidence
            high_confidence_sections=admin_settings.high_confidence_sections if admin_settings.high_confidence_sections is not None else "194C,194J,194H,194I,194A",
            section_confidence_boost_pct=admin_settings.section_confidence_boost_pct if admin_settings.section_confidence_boost_pct is not None else 60.0,
            # Phase 6E: Unmatched alerting
            unmatched_alerting_enabled=admin_settings.unmatched_alerting_enabled if admin_settings.unmatched_alerting_enabled is not None else True,
            unmatched_critical_amount_threshold=admin_settings.unmatched_critical_amount_threshold if admin_settings.unmatched_critical_amount_threshold is not None else 500_000.0,
            unmatched_critical_count_threshold=admin_settings.unmatched_critical_count_threshold if admin_settings.unmatched_critical_count_threshold is not None else 50,
            # Phase 6F: Force match alert
            force_match_alert_enabled=admin_settings.force_match_alert_enabled if admin_settings.force_match_alert_enabled is not None else True,
            force_match_alert_pct_threshold=admin_settings.force_match_alert_pct_threshold if admin_settings.force_match_alert_pct_threshold is not None else 10.0,
            # Phase 7H: Anomaly detection
            anomaly_detection_enabled=admin_settings.anomaly_detection_enabled if admin_settings.anomaly_detection_enabled is not None else False,
            amount_outlier_stddev=admin_settings.amount_outlier_stddev if admin_settings.amount_outlier_stddev is not None else 3.0,
            match_rate_drop_alert_pct=admin_settings.match_rate_drop_alert_pct if admin_settings.match_rate_drop_alert_pct is not None else 20.0,
            # Phase 7J: System health alerts
            system_alerts_enabled=admin_settings.system_alerts_enabled if admin_settings.system_alerts_enabled is not None else False,
            slow_run_threshold_seconds=admin_settings.slow_run_threshold_seconds if admin_settings.slow_run_threshold_seconds is not None else 300,
            high_exception_rate_pct=admin_settings.high_exception_rate_pct if admin_settings.high_exception_rate_pct is not None else 50.0,
        )
    else:
        match_cfg = MatchConfig()

    # Apply per-run overrides (e.g. from batch config)
    if run_config_overrides:
        for key, value in run_config_overrides.items():
            if hasattr(match_cfg, key) and value is not None:
                setattr(match_cfg, key, value)

    return match_cfg, admin_settings_id


def _match_config_from_snapshot(run_config: dict) -> MatchConfig:
    """Reconstruct MatchConfig from a stored run_config snapshot (for reproducible reruns)."""
    cfg = MatchConfig()
    for key, value in run_config.items():
        if hasattr(cfg, key) and value is not None:
            setattr(cfg, key, value)
    return cfg


def _config_snapshot(match_cfg: Optional[MatchConfig] = None) -> dict:
    """Capture current config state for reproducibility."""
    snapshot = {
        "algorithm_version": settings.ALGORITHM_VERSION,
        "ALLOW_CROSS_FY": ALLOW_CROSS_FY,
        "MAX_COMBO_SIZE": MAX_COMBO_SIZE,
        "VARIANCE_CAP_SINGLE": VARIANCE_CAP_SINGLE,
        "VARIANCE_CAP_COMBO": VARIANCE_CAP_COMBO,
        "VARIANCE_CAP_FORCE_SINGLE": VARIANCE_CAP_FORCE_SINGLE,
        "FORCE_COMBO_MAX_INVOICES": FORCE_COMBO_MAX_INVOICES,
        "captured_at": datetime.now(timezone.utc).isoformat(),
    }
    if match_cfg is not None:
        snapshot["match_config"] = match_cfg.to_dict()
    return snapshot


# ── Unmatched Reason Code Helper ──────────────────────────────────────────────

def _determine_unmatched_reason(
    entry: As26Entry,
    remaining_books: List[BookEntry],
    noise_threshold: float = 1.0,
    all_books: Optional[List[BookEntry]] = None,
    consumed_book_indices: Optional[set] = None,
    match_cfg: Optional[MatchConfig] = None,
) -> Tuple[str, str]:
    """Determine a specific reason code for an unmatched 26AS entry.

    Checks both remaining (unconsumed) books AND the full book pool to give
    accurate diagnostics — e.g. "best candidate was already matched elsewhere"
    or "date outside eligibility window".

    Returns (reason_code, reason_detail).
    """
    # U04: Amount too small or negative
    if entry.amount <= 0:
        return "U04", "Amount is zero or negative"
    if noise_threshold > 0 and entry.amount < noise_threshold:
        return "U04", f"Amount below noise threshold (₹{noise_threshold})"

    # Use full book pool if provided, else fall back to remaining
    pool_for_search = all_books if all_books else remaining_books
    consumed = consumed_book_indices or set()

    # U01: No candidate invoices found at all
    if not pool_for_search:
        return "U01", "No SAP invoice candidates available for matching"

    # Find best candidate across ALL books (including consumed ones)
    best = None  # (variance_pct, signed_var, invoice_ref, doc_date, book_index, is_consumed)

    for b in pool_for_search:
        if b.amount <= 0:
            continue
        variance_pct = abs(entry.amount - b.amount) / entry.amount * 100
        signed_var = (entry.amount - b.amount) / entry.amount * 100  # positive = book < 26AS
        is_consumed = b.index in consumed
        if best is None or variance_pct < best[0]:
            best = (variance_pct, signed_var, b.invoice_ref, b.doc_date, b.index, is_consumed)

    if best is None:
        return "U01", "No SAP invoice candidates with positive amounts"

    var_pct, signed_var, inv_ref, inv_date, b_idx, was_consumed = best
    date_str = f", dated {inv_date}" if inv_date else ""

    # Diagnose WHY the best candidate wasn't matched

    # Case 1: Best candidate was consumed by another match
    if was_consumed:
        return "U02", (
            f"Best candidate '{inv_ref}' ({var_pct:.1f}% variance{date_str}) "
            f"was already matched to another 26AS entry"
        )

    # Case 2: Over-claim prevention — book amount > 26AS amount
    if signed_var < 0:
        return "U01", (
            f"Best candidate '{inv_ref}' exceeds 26AS amount by {abs(signed_var):.1f}%{date_str} "
            f"(books cannot exceed 26AS — over-claim prevention rule)"
        )

    # Case 3: Variance genuinely exceeds threshold — no viable candidate
    threshold_desc = "5%" if match_cfg and match_cfg.force_match_enabled else "2%"
    max_threshold = VARIANCE_CAP_FORCE_SINGLE if match_cfg and match_cfg.force_match_enabled else VARIANCE_CAP_SINGLE
    if var_pct > max_threshold:
        # High variance = no viable match found (U01), not "consumed by another" (U02)
        return "U01", (
            f"Best candidate '{inv_ref}' has {var_pct:.1f}% variance{date_str}, "
            f"exceeding maximum threshold ({threshold_desc})"
        )

    # Case 4: Date ineligible but variance is within threshold
    if match_cfg is not None:
        days_gap = _compute_days_gap(entry.transaction_date, inv_date)
        eligible, _ = _is_date_eligible(days_gap, match_cfg)
        if not eligible:
            gap_desc = f"{abs(days_gap)} days" if days_gap is not None else "unknown gap"
            direction = "after" if (days_gap is not None and days_gap < 0) else "before"
            return "U01", (
                f"Best candidate '{inv_ref}' ({var_pct:.1f}% variance{date_str}) "
                f"is {gap_desc} {direction} 26AS date — outside eligibility window"
            )

    # Case 5: Candidate looks viable but wasn't matched — optimizer assigned it elsewhere
    return "U02", (
        f"Best candidate '{inv_ref}' ({var_pct:.1f}% variance{date_str}) "
        f"was assigned to a closer 26AS entry by the global optimizer"
    )


async def run_reconciliation(
    db: AsyncSession,
    current_user: User,
    sap_bytes: bytes,
    as26_bytes: bytes,
    sap_filename: str,
    as26_filename: str,
    financial_year: str = DEFAULT_FINANCIAL_YEAR,
    batch_id: Optional[str] = None,
    deductor_filter_parties: Optional[List[dict]] = None,
    run_config: Optional[dict] = None,
) -> ReconciliationRun:
    """
    deductor_filter_parties: list of {deductor_name, tan} dicts.
    When provided (batch mode), 26AS is filtered to only those parties
    before matching — supporting multi-TAN / same-PAN scenarios.

    run_config: optional dict of per-run config overrides (e.g. from batch config).
    """
    """
    Full reconciliation pipeline. Returns the persisted ReconciliationRun.
    """
    started_at = datetime.now(timezone.utc)

    # ── 0. Load MatchConfig from DB + overrides ──────────────────────────────
    match_cfg, admin_settings_id = await _load_match_config(db, run_config)

    # ── 1. File integrity hashing ─────────────────────────────────────────────
    sap_hash = sha256_file(sap_bytes)
    as26_hash = sha256_file(as26_bytes)
    run_num = await _next_run_number(db)

    # ── 2. Create run record ──────────────────────────────────────────────────
    run = ReconciliationRun(
        run_number=run_num,
        financial_year=financial_year,
        sap_filename=sap_filename,
        as26_filename=as26_filename,
        sap_file_hash=sap_hash,
        as26_file_hash=as26_hash,
        algorithm_version=settings.ALGORITHM_VERSION,
        config_snapshot=_config_snapshot(match_cfg),
        run_config=match_cfg.to_dict(),
        admin_settings_id=admin_settings_id,
        status="PROCESSING",
        mode="BATCH" if batch_id else "SINGLE",
        batch_id=batch_id,
        created_by_id=current_user.id,
        started_at=started_at,
    )
    db.add(run)
    await db.flush()  # Get run.id

    # ── Initialize progress tracking ────────────────────────────────────────
    progress_store.create(run.id)

    await log_event(db, "RUN_STARTED",
                    f"Run RUN-{run_num:04d} started for FY {financial_year}",
                    run_id=run.id, user_id=current_user.id,
                    metadata={"sap_hash": sap_hash, "as26_hash": as26_hash})

    try:
        fy_start, fy_end = fy_date_range(financial_year)
        sap_start, sap_end = sap_date_window(financial_year)

        # ── 3. Parse and clean SAP ────────────────────────────────────────────
        progress_store.update(run.id, status="PARSING", detail="Parsing SAP AR Ledger...")

        # Load Phase 3 flags from admin settings
        _p3_result = await db.execute(
            select(AdminSettings.credit_note_handling_enabled).where(AdminSettings.is_active == True)
        )
        _credit_note_enabled = _p3_result.scalar_one_or_none() or False

        clean_df, sgl_v_df, cleaning_report = clean_sap_books(
            sap_bytes,
            fy_start=sap_start,
            fy_end=sap_end,
            doc_types_include=set(match_cfg.doc_types_include) if match_cfg.doc_types_include else None,
            doc_types_exclude=set(match_cfg.doc_types_exclude) if match_cfg.doc_types_exclude else None,
            exclude_sgl_v=match_cfg.exclude_sgl_v,
            noise_threshold=match_cfg.noise_threshold,
            credit_note_handling_enabled=_credit_note_enabled,
        )

        # If exclude_sgl_v is False (user enabled advance payments), SGL_V entries
        # are already in clean_df. If True but we want them available as suggested,
        # they remain in sgl_v_df — we'll build BookEntry objects for them separately.
        sgl_v_book_entries = []  # type: List[BookEntry]
        if not match_cfg.exclude_sgl_v and not sgl_v_df.empty:
            # SGL_V already merged into clean_df by cleaner (exclude_sgl_v=False),
            # sgl_v_df will be empty in this case. Nothing extra to do.
            pass
        elif match_cfg.exclude_sgl_v and not sgl_v_df.empty:
            # Build separate BookEntry objects for SGL_V entries (for suggested matching)
            sgl_v_book_entries = _df_to_book_entries(sgl_v_df, flag_override="SGL_V")

        progress_store.update(run.id, detail=f"SAP parsed: {len(clean_df)} rows. Parsing 26AS...", phase_pct=50)

        # ── 4. Parse and validate 26AS ────────────────────────────────────────
        as26_hash = sha256_file(as26_bytes)
        as26_df = _parse_26as_with_cache(as26_bytes, as26_hash, use_cache=False, lenient_mode=match_cfg.parser_lenient_mode)
        progress_store.update(run.id, detail=f"26AS parsed: {len(as26_df)} rows", phase_pct=80)

        # Filter 26AS to relevant deductor(s)
        if deductor_filter_parties and not as26_df.empty:
            # Batch mode: explicit party filter
            mask = pd.Series([False] * len(as26_df), index=as26_df.index)
            for party in deductor_filter_parties:
                name = party.get("deductor_name", "")
                tan = party.get("tan", "")
                if name:
                    mask = mask | (as26_df["deductor_name"] == name)
                elif tan:
                    mask = mask | (as26_df["tan"] == tan)
            as26_df = as26_df[mask].copy()
        elif not as26_df.empty and as26_df["deductor_name"].nunique() > 1:
            # Single mode with multi-deductor 26AS: auto-map by SAP filename
            progress_store.update(run.id, detail="Multi-deductor 26AS detected. Running name alignment...", phase_pct=85)
            from aligner import align_deductor
            alignment = align_deductor(sap_filename, as26_df)
            if alignment.status in ("AUTO_CONFIRMED", "PENDING") and alignment.confirmed_name:
                # Filter to the aligned deductor
                mask = as26_df["deductor_name"] == alignment.confirmed_name
                if alignment.confirmed_tan:
                    mask = mask | (as26_df["tan"] == alignment.confirmed_tan)
                as26_df = as26_df[mask].copy()
                run.deductor_name = alignment.confirmed_name
                run.tan = alignment.confirmed_tan or ""
                progress_store.update(run.id,
                    detail=f"Aligned to '{alignment.confirmed_name}' (score={alignment.fuzzy_score}). {len(as26_df)} 26AS entries.",
                    phase_pct=90)
            else:
                # No good match — use ALL 26AS entries (total reco against full SAP)
                progress_store.update(run.id,
                    detail=f"No name match found. Using all {len(as26_df)} 26AS entries.",
                    phase_pct=90)
        progress_store.update(run.id, detail=f"26AS filtered: {len(as26_df)} entries", phase_pct=100)

        progress_store.update(run.id, status="VALIDATING", detail="Validating 26AS entries...")
        validated_df, val_report = validate_26as(
            as26_df,
            rate_tolerance_pct=match_cfg.rate_tolerance_pct,
            rate_mismatch_severity=match_cfg.rate_mismatch_severity,
        )
        progress_store.update(run.id, detail="Validating SAP books...", phase_pct=50)

        # SAP book validation (light)
        clean_df, sap_issues = validate_sap_books(clean_df)
        progress_store.update(run.id, detail="Validation complete. Building entry objects...", phase_pct=100)

        # ── 4.5. Data quality pre-check (Phase 4G) ────────────────────────────
        dq_result = await db.execute(
            select(AdminSettings.data_quality_precheck_enabled).where(AdminSettings.is_active == True)
        )
        dq_row = dq_result.one_or_none()
        if dq_row and dq_row[0]:
            dq_warnings = _data_quality_precheck(validated_df, clean_df, run.id)
            for w in dq_warnings:
                db.add(ExceptionRecord(**w))

        # ── 5. Build entry objects ────────────────────────────────────────────
        book_entries = _df_to_book_entries(clean_df)

        # Large batch performance mode (Phase 3J): cap SAP rows per run
        _lbm_result = await db.execute(
            select(AdminSettings.large_batch_mode_enabled, AdminSettings.max_sap_rows_per_run).where(AdminSettings.is_active == True)
        )
        _lbm_row = _lbm_result.one_or_none()
        if _lbm_row and _lbm_row[0] and _lbm_row[1]:
            max_rows = _lbm_row[1]
            if len(book_entries) > max_rows:
                logger.warning(
                    "Large batch mode: capping SAP entries from %d to %d",
                    len(book_entries), max_rows
                )
                book_entries = book_entries[:max_rows]

        as26_entries = _df_to_as26_entries(validated_df[validated_df["_valid"] == True])

        # ── 5a. 26AS duplicate/revision detection (Phase 3C) ───────────────────
        as26_duplicate_warnings: List[dict] = []
        _as26_dup_setting = await db.execute(
            select(AdminSettings.as26_duplicate_check_enabled).where(AdminSettings.is_active == True)
        )
        _as26_dup_enabled = _as26_dup_setting.scalar_one_or_none()
        if _as26_dup_enabled:
            as26_duplicate_warnings = _detect_26as_duplicates(as26_entries)
            if as26_duplicate_warnings:
                logger.warning(
                    "26AS duplicate entries detected: %d groups (%d total rows)",
                    len(as26_duplicate_warnings),
                    sum(d["count"] for d in as26_duplicate_warnings),
                )

        # FY segregation
        target_fy = financial_year
        current_books = [b for b in book_entries if b.sap_fy == target_fy or not b.sap_fy]
        prior_books = [b for b in book_entries if b.sap_fy and b.sap_fy != target_fy]

        total_26as_amount = float(validated_df[validated_df["_valid"] == True]["amount"].sum())
        total_sap_amount = float(sum(b.amount for b in book_entries))

        progress_store.update(run.id,
                              total_26as=len(as26_entries),
                              total_sap=len(book_entries),
                              detail=f"{len(as26_entries)} 26AS entries, {len(book_entries)} SAP entries ready")

        # ── 6. Run global optimizer ───────────────────────────────────────────
        # Bridge callback: optimizer -> progress_store
        def _optimizer_progress(phase: str, done: int, total: int, matched_n: int, detail: str):
            pct = (done / total * 100) if total > 0 else 0
            progress_store.update(
                run.id,
                status=phase,
                phase_pct=pct,
                matched_so_far=matched_n,
                detail=detail,
            )

        def _cancel_check():
            return progress_store.is_cancelled(run.id)

        all_results, unmatched_entries = await asyncio.to_thread(
            run_global_optimizer,
            as26_entries=as26_entries,
            book_pool=book_entries,
            current_books=current_books,
            prior_books=prior_books,
            allow_cross_fy=match_cfg.allow_cross_fy,
            config=match_cfg,
            sgl_v_books=sgl_v_book_entries if sgl_v_book_entries else None,
            progress_cb=_optimizer_progress,
            cancel_check=_cancel_check,
        )
        matched_results = [r for r in all_results if not r.suggested]
        suggested_results = [r for r in all_results if r.suggested]

        # ── 7. Compute metrics ────────────────────────────────────────────────
        matched_amount = sum(r.as26_amount for r in matched_results)
        suggested_amount = sum(r.as26_amount for r in suggested_results)
        unmatched_amount = sum(e.amount for e in unmatched_entries)
        control_totals = compute_control_totals(total_26as_amount, matched_amount, unmatched_amount, suggested_amount)

        match_rate = (len(matched_results) / len(as26_entries) * 100) if as26_entries else 0.0
        high_conf = sum(1 for r in matched_results if r.confidence == "HIGH")
        med_conf = sum(1 for r in matched_results if r.confidence == "MEDIUM")
        low_conf = sum(1 for r in matched_results if r.confidence == "LOW")

        # ── 8. Persist matched pairs ──────────────────────────────────────────
        progress_store.update(run.id, status="PERSISTING",
                              matched_so_far=len(matched_results),
                              detail=f"Saving {len(matched_results)} matched pairs...", phase_pct=0)
        deductor_name = ""
        tan = ""
        if deductor_filter_parties:
            # Pick the most frequent name variant (canonical) instead of concatenating all
            from collections import Counter
            names = [p["deductor_name"] for p in deductor_filter_parties if p.get("deductor_name")]
            if names:
                deductor_name = Counter(names).most_common(1)[0][0]
            tan = deductor_filter_parties[0].get("tan", "")
        elif as26_entries:
            # Fallback: pick most frequent name from 26AS entries for this TAN
            from collections import Counter
            name_counts = Counter(e.deductor_name for e in as26_entries if e.deductor_name)
            deductor_name = name_counts.most_common(1)[0][0] if name_counts else as26_entries[0].deductor_name
            tan = as26_entries[0].tan

        for result in matched_results:
            score_d = result.score.to_dict()
            # Auto-confirmed high-variance matches get audit remark
            remark = None
            if result.ai_risk_flag and result.alert_message:
                remark = result.alert_message
            mp = MatchedPair(
                run_id=run.id,
                as26_row_hash=_hash_as26_entry(result),
                as26_index=result.as26_index,
                as26_amount=result.as26_amount,
                as26_date=result.as26_date,
                section=result.as26_section,
                tan=tan,
                deductor_name=deductor_name,
                invoice_refs=[b.invoice_ref for b in result.books],
                invoice_amounts=[b.amount for b in result.books],
                invoice_dates=[b.doc_date for b in result.books],
                clearing_doc=result.books[0].clearing_doc if result.books else None,
                books_sum=sum(b.amount for b in result.books),
                match_type=result.match_type,
                variance_amt=result.variance_amt,
                variance_pct=result.variance_pct,
                confidence=result.confidence,
                composite_score=score_d["composite_score"],
                score_variance=score_d["score_variance"],
                score_date_proximity=score_d["score_date_proximity"],
                score_section_match=score_d["score_section_match"],
                score_clearing_doc=score_d["score_clearing_doc"],
                score_historical=score_d["score_historical"],
                cross_fy=result.cross_fy,
                is_prior_year=result.is_prior_year,
                ai_risk_flag=result.ai_risk_flag,
                ai_risk_reason=result.ai_risk_reason,
                remark=remark,
            )
            db.add(mp)

        # ── 8b. Persist suggested matches ─────────────────────────────────────
        if suggested_results:
            progress_store.update(run.id,
                                  detail=f"Saving {len(suggested_results)} suggested matches...",
                                  phase_pct=40)
        for result in suggested_results:
            score_d = result.score.to_dict()
            sm = SuggestedMatch(
                run_id=run.id,
                as26_row_hash=_hash_as26_entry(result),
                as26_index=result.as26_index,
                as26_amount=result.as26_amount,
                as26_date=result.as26_date,
                section=result.as26_section,
                tan=tan,
                deductor_name=deductor_name,
                invoice_refs=[b.invoice_ref for b in result.books],
                invoice_amounts=[b.amount for b in result.books],
                invoice_dates=[b.doc_date for b in result.books],
                clearing_doc=result.books[0].clearing_doc if result.books else None,
                books_sum=sum(b.amount for b in result.books),
                match_type=result.match_type,
                variance_amt=result.variance_amt,
                variance_pct=result.variance_pct,
                confidence=result.confidence,
                composite_score=score_d["composite_score"],
                score_variance=score_d["score_variance"],
                score_date_proximity=score_d["score_date_proximity"],
                score_section_match=score_d["score_section_match"],
                score_clearing_doc=score_d["score_clearing_doc"],
                score_historical=score_d["score_historical"],
                cross_fy=result.cross_fy,
                is_prior_year=result.is_prior_year,
                category=result.suggested_category or "GENERAL",
                requires_remarks=result.requires_remarks,
                alert_message=result.alert_message or None,
            )
            db.add(sm)

        # ── 9. Persist unmatched ──────────────────────────────────────────────
        progress_store.update(run.id, detail=f"Saving {len(unmatched_entries)} unmatched 26AS entries...", phase_pct=60)
        # Build a set of book indices consumed by both matched and suggested results
        # so that unmatched reason code logic uses the remaining books
        effective_noise = match_cfg.noise_threshold if match_cfg else 1.0
        consumed_book_indices = set()  # type: set
        for r in matched_results:
            for b in r.books:
                consumed_book_indices.add(b.index)
        for r in suggested_results:
            for b in r.books:
                consumed_book_indices.add(b.index)
        remaining_books = [b for b in book_entries if b.index not in consumed_book_indices]

        seen_unmatched_idx: set = set()
        for entry in unmatched_entries:
            if entry.index in seen_unmatched_idx:
                continue
            seen_unmatched_idx.add(entry.index)
            reason_code, reason_detail = _determine_unmatched_reason(
                entry, remaining_books,
                noise_threshold=effective_noise,
                all_books=book_entries,
                consumed_book_indices=consumed_book_indices,
                match_cfg=match_cfg,
            )
            db.add(Unmatched26AS(
                run_id=run.id,
                as26_row_hash=_hash_as26_idx(entry.index, entry.amount, entry.section, entry.tan),
                deductor_name=entry.deductor_name,
                tan=entry.tan,
                transaction_date=entry.transaction_date,
                amount=entry.amount,
                section=entry.section,
                reason_code=reason_code,
                reason_detail=reason_detail,
            ))

        for b in book_entries:
            if not _book_was_matched(b.index, matched_results, suggested_results):
                db.add(UnmatchedBook(
                    run_id=run.id,
                    invoice_ref=b.invoice_ref,
                    amount=b.amount,
                    doc_date=b.doc_date,
                    doc_type=b.doc_type,
                    clearing_doc=b.clearing_doc,
                    flag=b.flag,
                    sap_fy=b.sap_fy,
                ))

        # ── 10. Generate exceptions ───────────────────────────────────────────
        progress_store.update(run.id, status="EXCEPTIONS", detail="Generating exception flags...", phase_pct=0)
        exc_dicts = generate_exceptions(matched_results + suggested_results, unmatched_entries, val_report, run.id, cfg=match_cfg)
        for exc in exc_dicts:
            db.add(ExceptionRecord(**exc))

        # Add 26AS duplicate warnings as exceptions (Phase 3C)
        for dup in as26_duplicate_warnings:
            db.add(ExceptionRecord(
                run_id=run.id,
                exception_type="26AS_DUPLICATE",
                severity="HIGH",
                amount=dup["amount"],
                section=dup.get("section"),
                description=(
                    f"Duplicate 26AS entry (index {dup['indices'][0]}): {dup['count']} identical rows for "
                    f"{dup['deductor_name']} / {dup['section']} / Rs.{dup['amount']:,.2f} "
                    f"on {dup['transaction_date']}. May indicate revision or data error."
                ),
            ))

        # PAN & 206AA risk detection (Phase 3I)
        _pan_result = await db.execute(
            select(AdminSettings.pan_detection_enabled).where(AdminSettings.is_active == True)
        )
        _pan_enabled = _pan_result.scalar_one_or_none() or False
        pan_exceptions = []
        if _pan_enabled:
            pan_exceptions = detect_pan_risk(as26_entries, run.id)
            for pe in pan_exceptions:
                db.add(ExceptionRecord(**pe))

        # Custom exception rules (Phase 4H)
        custom_exc_count = 0
        _cer_result = await db.execute(
            select(AdminSettings.custom_exception_rules_enabled).where(AdminSettings.is_active == True)
        )
        _cer_enabled = _cer_result.scalar_one_or_none() or False
        if _cer_enabled:
            from db.models import CustomExceptionRule
            rules_result = await db.execute(
                select(CustomExceptionRule).where(CustomExceptionRule.is_active == True)
            )
            custom_rules = list(rules_result.scalars().all())
            custom_exc_count = _evaluate_custom_rules(custom_rules, matched_results, run.id, db)

        total_exc = len(exc_dicts) + len(as26_duplicate_warnings) + len(pan_exceptions) + custom_exc_count
        progress_store.update(run.id, detail=f"{total_exc} exceptions generated", phase_pct=100)

        # ── 11. Update run summary ────────────────────────────────────────────
        progress_store.update(run.id, status="FINALIZING", detail="Updating run summary...", phase_pct=0)
        run.deductor_name = deductor_name
        run.tan = tan
        # Auto-approve if: no blocking exceptions (INFO-only is OK) AND match rate >= threshold AND at least 1 match
        approval_workflow = await _is_approval_workflow_enabled(db)
        blocking_exceptions = [e for e in exc_dicts if e.get("severity") not in ("INFO",)]
        min_rate = match_cfg.auto_approval_min_match_rate if match_cfg.auto_approval_enabled else AUTO_APPROVAL_MIN_MATCH_RATE
        max_exc = match_cfg.auto_approval_max_exceptions
        needs_review = (
            approval_workflow
            and (
                len(blocking_exceptions) > max_exc
                or match_rate < min_rate
                or len(matched_results) == 0
            )
        )
        run.status = "PENDING_REVIEW" if needs_review else "APPROVED"
        run.total_26as_entries = len(as26_entries)
        run.total_sap_entries = len(book_entries)
        run.matched_count = len(matched_results)
        run.suggested_count = len(suggested_results)
        run.unmatched_26as_count = len(unmatched_entries)
        run.unmatched_books_count = len(book_entries) - sum(
            1 for r in matched_results for b in r.books
        ) - sum(
            1 for r in suggested_results for b in r.books
        )
        run.match_rate_pct = round(match_rate, 2)
        run.high_confidence_count = high_conf
        run.medium_confidence_count = med_conf
        run.low_confidence_count = low_conf
        run.total_26as_amount = total_26as_amount
        run.total_sap_amount = round(total_sap_amount, 2)
        run.matched_amount = matched_amount
        run.unmatched_26as_amount = unmatched_amount
        run.control_total_balanced = control_totals["balanced"]
        # Always store validation summary (raw/valid/rejected counts) even if no issues
        run.validation_errors = val_report.to_dict()
        run.has_pan_issues = val_report.pan_issues > 0
        run.has_rate_mismatches = val_report.rate_mismatches > 0
        run.has_duplicate_26as = val_report.duplicates_found > 0
        run.completed_at = datetime.now(timezone.utc)

        # ── Recount suggested_count from DB for accuracy ─────────────────
        await db.flush()
        run.suggested_count = await db.scalar(
            select(func.count(SuggestedMatch.id)).where(SuggestedMatch.run_id == run.id)
        ) or 0

        # ── Count invariant check ──────────────────────────────────────────
        _check_count_invariant(
            matched_results, suggested_results, unmatched_entries,
            len(as26_entries), run.id,
            raw_26as_total=val_report.total_rows,
            rejected_26as=val_report.rejected_rows,
        )

        await log_event(db, "RUN_COMPLETED",
                        f"Run RUN-{run_num:04d} completed. "
                        f"Match rate: {match_rate:.1f}%. Exceptions: {len(exc_dicts)}",
                        run_id=run.id, user_id=current_user.id,
                        metadata={
                            "match_rate": match_rate,
                            "matched": len(matched_results),
                            "suggested": len(suggested_results),
                            "unmatched": len(unmatched_entries),
                            "exceptions": len(exc_dicts),
                            "control_balanced": control_totals["balanced"],
                        })

        # Send single-run webhook (Phase 4J)
        try:
            from services.notifications import send_run_webhook
            await send_run_webhook(db, run, event="run_complete")
        except Exception:
            pass  # Never block run completion for webhook issues

        # mark_complete is called by the background task AFTER db.commit()
        return run

    except Exception as e:
        run.status = "FAILED"
        progress_store.mark_failed(run.id, str(e))
        await log_event(db, "RUN_FAILED", f"Run failed: {str(e)}",
                        run_id=run.id, user_id=current_user.id,
                        metadata={"error": str(e)})
        raise


async def run_reconciliation_on_existing_run(
    db: AsyncSession,
    current_user: User,
    run_id: str,
    sap_bytes: bytes,
    as26_bytes: bytes,
    sap_filename: str,
    as26_filename: str,
    financial_year: str = DEFAULT_FINANCIAL_YEAR,
    batch_id: Optional[str] = None,
    deductor_filter_parties: Optional[List[dict]] = None,
    run_config: Optional[dict] = None,
) -> ReconciliationRun:
    """
    Run reconciliation on an already-created run record (for background execution).
    The run record must already exist with status=PROCESSING.

    run_config: optional dict of per-run config overrides (e.g. from batch config).
    """
    from sqlalchemy import select as _sel

    result = await db.execute(_sel(ReconciliationRun).where(ReconciliationRun.id == run_id))
    run = result.scalar_one()

    # Note: result cleanup is handled by _reset_run_for_rerun() in the API layer
    # before background tasks start. No safety-net DELETE here — it causes
    # "database is locked" errors when multiple batch runs execute concurrently.

    # ── 0. Load MatchConfig from DB + overrides ──────────────────────────────
    match_cfg, _admin_id = await _load_match_config(db, run_config)

    progress_store.create(run.id)

    try:
        fy_start, fy_end = fy_date_range(financial_year)
        sap_start, sap_end = sap_date_window(financial_year)

        progress_store.update(run.id, status="PARSING", detail="Parsing SAP AR Ledger...")

        _p3b_result = await db.execute(
            select(AdminSettings.credit_note_handling_enabled).where(AdminSettings.is_active == True)
        )
        _credit_note_enabled_b = _p3b_result.scalar_one_or_none() or False

        clean_df, sgl_v_df, cleaning_report = clean_sap_books(
            sap_bytes,
            fy_start=sap_start,
            fy_end=sap_end,
            doc_types_include=set(match_cfg.doc_types_include) if match_cfg.doc_types_include else None,
            doc_types_exclude=set(match_cfg.doc_types_exclude) if match_cfg.doc_types_exclude else None,
            exclude_sgl_v=match_cfg.exclude_sgl_v,
            noise_threshold=match_cfg.noise_threshold,
            credit_note_handling_enabled=_credit_note_enabled_b,
        )

        # Handle SGL_V entries — same logic as run_reconciliation
        sgl_v_book_entries = []  # type: List[BookEntry]
        if match_cfg.exclude_sgl_v and not sgl_v_df.empty:
            sgl_v_book_entries = _df_to_book_entries(sgl_v_df, flag_override="SGL_V")

        progress_store.update(run.id, detail=f"SAP parsed: {len(clean_df)} rows. Parsing 26AS...", phase_pct=50)

        # Use parse-once cache for batch mode (same 26AS parsed N times)
        use_cache = batch_id is not None and await _is_parse_cache_enabled(db)
        as26_hash = sha256_file(as26_bytes)
        as26_df = _parse_26as_with_cache(as26_bytes, as26_hash, use_cache, lenient_mode=match_cfg.parser_lenient_mode)
        progress_store.update(run.id, detail=f"26AS parsed: {len(as26_df)} rows", phase_pct=100)

        # ── Batch control total: register full 26AS total (first run sets it) ──
        _control_total_enabled = batch_id is not None and await _is_control_total_enabled(db)
        if _control_total_enabled and batch_id not in _batch_control_totals:
            full_26as_total = float(as26_df["amount"].sum()) if not as26_df.empty else 0.0
            _init_batch_control_total(batch_id, full_26as_total)

        if deductor_filter_parties and not as26_df.empty:
            import numpy as np
            mask = pd.Series([False] * len(as26_df), index=as26_df.index)
            for party in deductor_filter_parties:
                name = party.get("deductor_name", "")
                tan = party.get("tan", "")
                if name:
                    mask = mask | (as26_df["deductor_name"] == name)
                elif tan:
                    mask = mask | (as26_df["tan"] == tan)
            as26_df = as26_df[mask].copy()
        elif not deductor_filter_parties and not as26_df.empty and as26_df["deductor_name"].nunique() > 1:
            # Single-mode: smart name mapping when 26AS has multiple deductors
            try:
                from aligner import align_deductor
                alignment = align_deductor(sap_filename, as26_df)
                if alignment.status in ("AUTO_CONFIRMED", "PENDING") and alignment.confirmed_name:
                    mask = as26_df["deductor_name"] == alignment.confirmed_name
                    if alignment.confirmed_tan:
                        mask = mask | (as26_df["tan"] == alignment.confirmed_tan)
                    as26_df = as26_df[mask].copy()
                    run.deductor_name = alignment.confirmed_name
                    run.tan = alignment.confirmed_tan or ""
            except Exception:
                pass  # Fall through — use all 26AS entries

        progress_store.update(run.id, status="VALIDATING", detail="Validating entries...")
        validated_df, val_report = validate_26as(
            as26_df,
            rate_tolerance_pct=match_cfg.rate_tolerance_pct,
            rate_mismatch_severity=match_cfg.rate_mismatch_severity,
        )
        clean_df, sap_issues = validate_sap_books(clean_df)
        progress_store.update(run.id, phase_pct=100)

        # Data quality pre-check (Phase 4G) — batch pipeline
        dq_result = await db.execute(
            select(AdminSettings.data_quality_precheck_enabled).where(AdminSettings.is_active == True)
        )
        dq_row = dq_result.one_or_none()
        if dq_row and dq_row[0]:
            dq_warnings = _data_quality_precheck(validated_df, clean_df, run.id)
            for w in dq_warnings:
                db.add(ExceptionRecord(**w))

        book_entries = _df_to_book_entries(clean_df)
        as26_entries = _df_to_as26_entries(validated_df[validated_df["_valid"] == True])

        # ── Cross-run invoice dedup (batch mode only) ──────────────────────
        cross_run_excluded = 0
        if batch_id and await _is_batch_invoice_dedup_enabled(db):
            already_consumed = _get_batch_consumed_invoices(batch_id)
            if already_consumed:
                before_count = len(book_entries)
                book_entries = [b for b in book_entries if b.invoice_ref not in already_consumed]
                cross_run_excluded = before_count - len(book_entries)
                if cross_run_excluded > 0:
                    logger.info(
                        f"Cross-run dedup: excluded {cross_run_excluded} books "
                        f"(already consumed in batch {batch_id[:8]}...)"
                    )
                # Also filter SGL_V book entries
                if sgl_v_book_entries:
                    sgl_v_book_entries = [b for b in sgl_v_book_entries if b.invoice_ref not in already_consumed]

        target_fy = financial_year
        current_books = [b for b in book_entries if b.sap_fy == target_fy or not b.sap_fy]
        prior_books = [b for b in book_entries if b.sap_fy and b.sap_fy != target_fy]

        total_26as_amount = float(validated_df[validated_df["_valid"] == True]["amount"].sum())
        total_sap_amount = float(sum(b.amount for b in book_entries))

        # Register party's 26AS slice for batch control total assertion
        if _control_total_enabled:
            _register_party_control_total(batch_id, run.id, total_26as_amount)

        progress_store.update(run.id, total_26as=len(as26_entries), total_sap=len(book_entries))

        def _optimizer_progress(phase, done, total, matched_n, detail):
            pct = (done / total * 100) if total > 0 else 0
            progress_store.update(run.id, status=phase, phase_pct=pct,
                                  matched_so_far=matched_n, detail=detail)

        def _cancel_check():
            return progress_store.is_cancelled(run.id)

        all_results, unmatched_entries = await asyncio.to_thread(
            run_global_optimizer,
            as26_entries=as26_entries,
            book_pool=book_entries,
            current_books=current_books,
            prior_books=prior_books,
            allow_cross_fy=match_cfg.allow_cross_fy,
            config=match_cfg,
            sgl_v_books=sgl_v_book_entries if sgl_v_book_entries else None,
            progress_cb=_optimizer_progress,
            cancel_check=_cancel_check,
        )
        matched_results = [r for r in all_results if not r.suggested]
        suggested_results = [r for r in all_results if r.suggested]

        # Register matched invoice refs in batch registry (for subsequent runs)
        if batch_id and await _is_batch_invoice_dedup_enabled(db):
            matched_invoice_refs: set[str] = set()
            for r in matched_results:
                matched_invoice_refs.update(r.invoice_refs)
            for r in suggested_results:
                matched_invoice_refs.update(r.invoice_refs)
            if matched_invoice_refs:
                _register_batch_invoices(batch_id, matched_invoice_refs)
                logger.info(
                    f"Cross-run dedup: registered {len(matched_invoice_refs)} invoice refs "
                    f"for batch {batch_id[:8]}..."
                )

        matched_amount = sum(r.as26_amount for r in matched_results)
        suggested_amount = sum(r.as26_amount for r in suggested_results)
        unmatched_amount = sum(e.amount for e in unmatched_entries)
        control_totals = compute_control_totals(total_26as_amount, matched_amount, unmatched_amount, suggested_amount)
        match_rate = (len(matched_results) / len(as26_entries) * 100) if as26_entries else 0.0
        high_conf = sum(1 for r in matched_results if r.confidence == "HIGH")
        med_conf = sum(1 for r in matched_results if r.confidence == "MEDIUM")
        low_conf = sum(1 for r in matched_results if r.confidence == "LOW")

        progress_store.update(run.id, status="PERSISTING",
                              matched_so_far=len(matched_results),
                              detail=f"Saving {len(matched_results)} matched pairs...")

        deductor_name = ""
        tan = ""
        if deductor_filter_parties:
            # Pick the most frequent name variant (canonical) instead of concatenating all
            from collections import Counter
            names = [p["deductor_name"] for p in deductor_filter_parties if p.get("deductor_name")]
            if names:
                deductor_name = Counter(names).most_common(1)[0][0]
            tan = deductor_filter_parties[0].get("tan", "")
        elif as26_entries:
            # Fallback: pick most frequent name from 26AS entries for this TAN
            from collections import Counter
            name_counts = Counter(e.deductor_name for e in as26_entries if e.deductor_name)
            deductor_name = name_counts.most_common(1)[0][0] if name_counts else as26_entries[0].deductor_name
            tan = as26_entries[0].tan

        for result in matched_results:
            score_d = result.score.to_dict()
            remark = None
            if result.ai_risk_flag and result.alert_message:
                remark = result.alert_message
            mp = MatchedPair(
                run_id=run.id,
                as26_row_hash=_hash_as26_entry(result),
                as26_index=result.as26_index,
                as26_amount=result.as26_amount,
                as26_date=result.as26_date,
                section=result.as26_section,
                tan=tan,
                deductor_name=deductor_name,
                invoice_refs=[b.invoice_ref for b in result.books],
                invoice_amounts=[b.amount for b in result.books],
                invoice_dates=[b.doc_date for b in result.books],
                clearing_doc=result.books[0].clearing_doc if result.books else None,
                books_sum=sum(b.amount for b in result.books),
                match_type=result.match_type,
                variance_amt=result.variance_amt,
                variance_pct=result.variance_pct,
                confidence=result.confidence,
                composite_score=score_d["composite_score"],
                score_variance=score_d["score_variance"],
                score_date_proximity=score_d["score_date_proximity"],
                score_section_match=score_d["score_section_match"],
                score_clearing_doc=score_d["score_clearing_doc"],
                score_historical=score_d["score_historical"],
                cross_fy=result.cross_fy,
                is_prior_year=result.is_prior_year,
                ai_risk_flag=result.ai_risk_flag,
                ai_risk_reason=result.ai_risk_reason,
                remark=remark,
            )
            db.add(mp)

        # ── Persist suggested matches ─────────────────────────────────────────
        if suggested_results:
            progress_store.update(run.id,
                                  detail=f"Saving {len(suggested_results)} suggested matches...",
                                  phase_pct=40)
        for result in suggested_results:
            score_d = result.score.to_dict()
            sm = SuggestedMatch(
                run_id=run.id,
                as26_row_hash=_hash_as26_entry(result),
                as26_index=result.as26_index,
                as26_amount=result.as26_amount,
                as26_date=result.as26_date,
                section=result.as26_section,
                tan=tan,
                deductor_name=deductor_name,
                invoice_refs=[b.invoice_ref for b in result.books],
                invoice_amounts=[b.amount for b in result.books],
                invoice_dates=[b.doc_date for b in result.books],
                clearing_doc=result.books[0].clearing_doc if result.books else None,
                books_sum=sum(b.amount for b in result.books),
                match_type=result.match_type,
                variance_amt=result.variance_amt,
                variance_pct=result.variance_pct,
                confidence=result.confidence,
                composite_score=score_d["composite_score"],
                score_variance=score_d["score_variance"],
                score_date_proximity=score_d["score_date_proximity"],
                score_section_match=score_d["score_section_match"],
                score_clearing_doc=score_d["score_clearing_doc"],
                score_historical=score_d["score_historical"],
                cross_fy=result.cross_fy,
                is_prior_year=result.is_prior_year,
                category=result.suggested_category or "GENERAL",
                requires_remarks=result.requires_remarks,
                alert_message=result.alert_message or None,
            )
            db.add(sm)

        # ── Persist unmatched entries ─────────────────────────────────────────
        progress_store.update(run.id, detail="Saving unmatched entries...", phase_pct=60)
        # Build remaining books for reason code determination
        effective_noise = match_cfg.noise_threshold if match_cfg else 1.0
        consumed_book_indices = set()  # type: set
        for r in matched_results:
            for b in r.books:
                consumed_book_indices.add(b.index)
        for r in suggested_results:
            for b in r.books:
                consumed_book_indices.add(b.index)
        remaining_books = [b for b in book_entries if b.index not in consumed_book_indices]

        seen_unmatched_idx: set = set()
        for entry in unmatched_entries:
            if entry.index in seen_unmatched_idx:
                continue
            seen_unmatched_idx.add(entry.index)
            reason_code, reason_detail = _determine_unmatched_reason(
                entry, remaining_books,
                noise_threshold=effective_noise,
                all_books=book_entries,
                consumed_book_indices=consumed_book_indices,
                match_cfg=match_cfg,
            )
            db.add(Unmatched26AS(
                run_id=run.id,
                as26_row_hash=_hash_as26_idx(entry.index, entry.amount, entry.section, entry.tan),
                deductor_name=entry.deductor_name,
                tan=entry.tan,
                transaction_date=entry.transaction_date,
                amount=entry.amount,
                section=entry.section,
                reason_code=reason_code,
                reason_detail=reason_detail,
            ))

        for b in book_entries:
            if not _book_was_matched(b.index, matched_results, suggested_results):
                db.add(UnmatchedBook(
                    run_id=run.id,
                    invoice_ref=b.invoice_ref,
                    amount=b.amount,
                    doc_date=b.doc_date,
                    doc_type=b.doc_type,
                    clearing_doc=b.clearing_doc,
                    flag=b.flag,
                    sap_fy=b.sap_fy,
                ))

        progress_store.update(run.id, status="EXCEPTIONS", detail="Generating exceptions...")
        exc_dicts = generate_exceptions(matched_results + suggested_results, unmatched_entries, val_report, run.id, cfg=match_cfg)
        for exc in exc_dicts:
            db.add(ExceptionRecord(**exc))

        progress_store.update(run.id, status="FINALIZING", detail="Updating run summary...")

        run.deductor_name = deductor_name
        run.tan = tan
        approval_workflow = await _is_approval_workflow_enabled(db)
        blocking_exceptions = [e for e in exc_dicts if e.get("severity") not in ("INFO",)]
        min_rate = match_cfg.auto_approval_min_match_rate if match_cfg.auto_approval_enabled else AUTO_APPROVAL_MIN_MATCH_RATE
        max_exc = match_cfg.auto_approval_max_exceptions
        needs_review = (
            approval_workflow
            and (
                len(blocking_exceptions) > max_exc
                or match_rate < min_rate
                or len(matched_results) == 0
            )
        )
        run.status = "PENDING_REVIEW" if needs_review else "APPROVED"
        run.total_26as_entries = len(as26_entries)
        run.total_sap_entries = len(book_entries)
        run.matched_count = len(matched_results)
        run.suggested_count = len(suggested_results)
        run.unmatched_26as_count = len(unmatched_entries)
        run.unmatched_books_count = len(book_entries) - sum(
            1 for r in matched_results for b in r.books
        ) - sum(
            1 for r in suggested_results for b in r.books
        )
        run.match_rate_pct = round(match_rate, 2)
        run.high_confidence_count = high_conf
        run.medium_confidence_count = med_conf
        run.low_confidence_count = low_conf
        run.total_26as_amount = total_26as_amount
        run.total_sap_amount = round(total_sap_amount, 2)
        run.matched_amount = matched_amount
        run.unmatched_26as_amount = unmatched_amount
        run.control_total_balanced = control_totals["balanced"]

        # Batch-level control total assertion (if enabled)
        if _control_total_enabled:
            balanced, parties_sum, full_total = _check_batch_control_total(batch_id)
            if not balanced:
                logger.warning(
                    f"Batch control total MISMATCH for {batch_id[:8]}: "
                    f"parties_sum={parties_sum:.2f} vs full_total={full_total:.2f} "
                    f"(diff={abs(parties_sum - full_total):.2f})"
                )
                run.control_total_balanced = False

        # Always store validation summary (raw/valid/rejected counts) even if no issues
        run.validation_errors = val_report.to_dict()
        run.has_pan_issues = val_report.pan_issues > 0
        run.has_rate_mismatches = val_report.rate_mismatches > 0
        run.has_duplicate_26as = val_report.duplicates_found > 0
        run.completed_at = datetime.now(timezone.utc)
        run.config_snapshot = _config_snapshot(match_cfg)
        run.run_config = match_cfg.to_dict()

        # ── Recount suggested_count from DB for accuracy ─────────────────
        await db.flush()
        run.suggested_count = await db.scalar(
            select(func.count(SuggestedMatch.id)).where(SuggestedMatch.run_id == run.id)
        ) or 0

        # ── Count invariant check ──────────────────────────────────────────
        _check_count_invariant(
            matched_results, suggested_results, unmatched_entries,
            len(as26_entries), run.id,
            raw_26as_total=val_report.total_rows,
            rejected_26as=val_report.rejected_rows,
        )

        await log_event(db, "RUN_COMPLETED",
                        f"Run RUN-{run.run_number:04d} completed. "
                        f"Match rate: {match_rate:.1f}%. Exceptions: {len(exc_dicts)}",
                        run_id=run.id, user_id=current_user.id,
                        metadata={
                            "match_rate": match_rate,
                            "matched": len(matched_results),
                            "suggested": len(suggested_results),
                            "unmatched": len(unmatched_entries),
                            "exceptions": len(exc_dicts),
                        })

        # mark_complete is called by the background task AFTER db.commit()
        return run

    except Exception as e:
        run.status = "FAILED"
        progress_store.mark_failed(run.id, str(e))
        await log_event(db, "RUN_FAILED", f"Run failed: {str(e)}",
                        run_id=run.id, user_id=current_user.id,
                        metadata={"error": str(e)})
        raise


# ── Helpers ───────────────────────────────────────────────────────────────────

def _check_count_invariant(
    matched_results: list,
    suggested_results: list,
    unmatched_entries: list,
    total_26as: int,
    run_id: str,
    raw_26as_total: int = 0,
    rejected_26as: int = 0,
) -> None:
    """
    Assert: unique matched + unique suggested + unique unmatched == total 26AS entries.
    Suggested entries are a sub-bucket of "not yet confirmed" — they don't overlap with
    matched or unmatched.
    If violated, raise ValueError so the run is marked FAILED rather than persisting
    inconsistent data.

    raw_26as_total and rejected_26as are informational — logged for audit trail but
    not part of the invariant (rejected entries are correctly excluded pre-algorithm).
    """
    matched_indices = {r.as26_index for r in matched_results}
    suggested_indices = {r.as26_index for r in suggested_results}
    unmatched_indices = {e.index for e in unmatched_entries}

    # Check for duplicate as26 indices within each bucket (should never happen)
    if len(matched_indices) != len(matched_results):
        dupes = len(matched_results) - len(matched_indices)
        raise ValueError(
            f"Invariant violation in run {run_id}: "
            f"{dupes} duplicate as26_index values in matched results"
        )
    if len(suggested_indices) != len(suggested_results):
        dupes = len(suggested_results) - len(suggested_indices)
        raise ValueError(
            f"Invariant violation in run {run_id}: "
            f"{dupes} duplicate as26_index values in suggested results"
        )

    # Suggested should not overlap with matched
    overlap_ms = matched_indices & suggested_indices
    if overlap_ms:
        raise ValueError(
            f"Invariant violation in run {run_id}: "
            f"{len(overlap_ms)} 26AS entries appear in BOTH matched and suggested"
        )

    # Unmatched should not overlap with matched or suggested
    overlap_mu = matched_indices & unmatched_indices
    overlap_su = suggested_indices & unmatched_indices
    if overlap_mu or overlap_su:
        raise ValueError(
            f"Invariant violation in run {run_id}: "
            f"{len(overlap_mu)} matched/unmatched overlap, "
            f"{len(overlap_su)} suggested/unmatched overlap"
        )

    accounted = len(matched_indices) + len(suggested_indices) + len(unmatched_indices)
    if accounted != total_26as:
        raise ValueError(
            f"Count invariant violation in run {run_id}: "
            f"matched({len(matched_indices)}) + suggested({len(suggested_indices)}) "
            f"+ unmatched({len(unmatched_indices)}) = {accounted} ≠ total_26as({total_26as})"
        )

    # Log the effective counts for the new model:
    # confirmed = matched, pending_review = suggested, truly_unmatched = unmatched
    logger.info(
        f"Count invariant OK for {run_id}: "
        f"confirmed={len(matched_indices)}, pending_review={len(suggested_indices)}, "
        f"truly_unmatched={len(unmatched_indices)}, total={total_26as}"
        + (f" | raw_26as={raw_26as_total}, rejected_by_validation={rejected_26as}"
           if raw_26as_total else "")
    )


def _df_to_book_entries(
    df: pd.DataFrame,
    flag_override: Optional[str] = None,
) -> List[BookEntry]:
    entries = []
    for i, (_, row) in enumerate(df.iterrows()):
        flag = str(row.get("flag", "") or "")
        if flag_override:
            flag = f"{flag},{flag_override}".strip(",") if flag else flag_override
        entries.append(BookEntry(
            index=i,
            invoice_ref=str(row.get("invoice_ref", "") or ""),
            amount=float(row.get("amount", 0)),
            doc_date=str(row.get("doc_date", "") or ""),
            doc_type=str(row.get("doc_type", "") or ""),
            clearing_doc=str(row.get("clearing_doc", "") or ""),
            sap_fy=str(row.get("sap_fy", "") or ""),
            flag=flag,
        ))
    return entries


def _df_to_as26_entries(df: pd.DataFrame) -> List[As26Entry]:
    entries = []
    for i, (_, row) in enumerate(df.iterrows()):
        entries.append(As26Entry(
            index=i,
            amount=float(row.get("amount", 0)),
            transaction_date=str(row.get("transaction_date", "") or ""),
            section=str(row.get("section", "") or ""),
            tan=str(row.get("tan", "") or ""),
            deductor_name=str(row.get("deductor_name", "") or ""),
            tds_amount=float(row["tds_amount"]) if "tds_amount" in row and row["tds_amount"] else None,
        ))
    return entries


def _evaluate_custom_rules(rules, matched_results, run_id: str, db) -> int:
    """Evaluate custom exception rules against matched results (Phase 4H)."""
    count = 0
    for result in matched_results:
        attrs = {
            "variance_pct": abs(result.variance_pct) if result.variance_pct else 0,
            "as26_amount": result.as26_amount or 0,
            "match_type": result.match_type or "",
            "section": result.as26_section or "",
            "confidence": result.confidence or "",
            "books_sum": sum(b.amount for b in result.books) if result.books else 0,
        }
        for rule in rules:
            field_val = attrs.get(rule.field)
            if field_val is None:
                continue
            triggered = False
            try:
                rule_val = float(rule.value) if rule.operator in ("gt", "lt", "gte", "lte") else rule.value
                if rule.operator == "gt" and float(field_val) > rule_val:
                    triggered = True
                elif rule.operator == "lt" and float(field_val) < rule_val:
                    triggered = True
                elif rule.operator == "gte" and float(field_val) >= rule_val:
                    triggered = True
                elif rule.operator == "lte" and float(field_val) <= rule_val:
                    triggered = True
                elif rule.operator == "eq" and str(field_val) == str(rule.value):
                    triggered = True
                elif rule.operator == "ne" and str(field_val) != str(rule.value):
                    triggered = True
                elif rule.operator == "contains" and str(rule.value).lower() in str(field_val).lower():
                    triggered = True
            except (ValueError, TypeError):
                continue

            if triggered:
                desc = f"Custom rule '{rule.name}' triggered: {rule.field} {rule.operator} {rule.value}"
                if rule.description:
                    desc += f". {rule.description}"
                db.add(ExceptionRecord(
                    run_id=run_id,
                    exception_type="CUSTOM_RULE",
                    severity=rule.severity,
                    amount=result.as26_amount,
                    section=result.as26_section,
                    description=desc,
                ))
                count += 1
    return count


def _data_quality_precheck(as26_df, sap_df, run_id: str) -> List[dict]:
    """
    Profile input data and generate quality warnings (Phase 4G).
    Returns list of ExceptionRecord dicts with type=DATA_QUALITY.
    """
    import numpy as np
    warnings = []

    # Check 1: Empty or very small datasets
    if len(as26_df) == 0:
        warnings.append({
            "run_id": run_id, "exception_type": "DATA_QUALITY", "severity": "CRITICAL",
            "description": "26AS file contains no valid entries after filtering",
        })
    if len(sap_df) == 0:
        warnings.append({
            "run_id": run_id, "exception_type": "DATA_QUALITY", "severity": "CRITICAL",
            "description": "SAP file contains no valid entries after cleaning",
        })

    # Check 2: Large amount outliers in 26AS
    if len(as26_df) > 5 and "amount" in as26_df.columns:
        amounts = as26_df["amount"].dropna()
        if len(amounts) > 0:
            q99 = amounts.quantile(0.99)
            median = amounts.median()
            if median > 0 and q99 > median * 50:
                outlier_count = int((amounts > q99).sum())
                warnings.append({
                    "run_id": run_id, "exception_type": "DATA_QUALITY", "severity": "MEDIUM",
                    "description": f"26AS has {outlier_count} extreme amount outlier(s) (>50x median). Verify data integrity.",
                    "amount": float(q99),
                })

    # Check 3: Missing dates in SAP
    if "doc_date" in sap_df.columns:
        missing_dates = int(sap_df["doc_date"].isna().sum())
        if missing_dates > 0:
            warnings.append({
                "run_id": run_id, "exception_type": "DATA_QUALITY", "severity": "LOW",
                "description": f"SAP file has {missing_dates} row(s) with missing document dates",
            })

    # Check 4: Duplicate invoice refs in SAP
    if "invoice_ref" in sap_df.columns:
        dups = sap_df["invoice_ref"].dropna()
        dup_count = int(dups.duplicated().sum())
        if dup_count > len(sap_df) * 0.1:  # >10% duplicates
            warnings.append({
                "run_id": run_id, "exception_type": "DATA_QUALITY", "severity": "HIGH",
                "description": f"SAP file has {dup_count} duplicate invoice references ({dup_count/len(sap_df)*100:.0f}%). May cause false matches.",
            })

    # Check 5: SAP-to-26AS ratio imbalance
    if len(as26_df) > 0 and len(sap_df) > 0:
        ratio = len(sap_df) / len(as26_df)
        if ratio > 20:
            warnings.append({
                "run_id": run_id, "exception_type": "DATA_QUALITY", "severity": "MEDIUM",
                "description": f"SAP/26AS ratio is {ratio:.0f}:1 (very high). Many SAP entries will remain unmatched.",
            })
        elif ratio < 0.1:
            warnings.append({
                "run_id": run_id, "exception_type": "DATA_QUALITY", "severity": "MEDIUM",
                "description": f"SAP/26AS ratio is {ratio:.2f}:1 (very low). Many 26AS entries will remain unmatched.",
            })

    return warnings


def _detect_26as_duplicates(entries: List[As26Entry]) -> List[dict]:
    """
    Detect duplicate 26AS entries (same deductor, TAN, amount, date, section).
    Returns a list of dicts describing each duplicate group found.
    """
    from collections import defaultdict
    sig_map: dict[str, list[int]] = defaultdict(list)
    for e in entries:
        sig = f"{e.deductor_name}|{e.tan}|{e.amount}|{e.transaction_date}|{e.section}"
        sig_map[sig].append(e.index)
    duplicates = []
    for sig, indices in sig_map.items():
        if len(indices) > 1:
            parts = sig.split("|")
            duplicates.append({
                "deductor_name": parts[0],
                "tan": parts[1],
                "amount": float(parts[2]) if parts[2] else 0,
                "transaction_date": parts[3],
                "section": parts[4],
                "indices": indices,
                "count": len(indices),
            })
    return duplicates


def _hash_as26_entry(result: AssignmentResult) -> str:
    """Full SHA-256 hash of all identifying 26AS fields (no truncation for collision safety)."""
    sig = (
        f"{result.as26_index}|{result.as26_amount}|{result.as26_date}|"
        f"{result.as26_section}|{getattr(result, 'as26_tan', '')}|"
        f"{getattr(result, 'as26_deductor', '')}"
    )
    return hashlib.sha256(sig.encode()).hexdigest()


def _hash_as26_idx(idx: int, amount: float = 0.0, section: str = "", tan: str = "") -> str:
    """Full SHA-256 hash for unmatched 26AS entries (no truncation)."""
    sig = f"{idx}|{amount}|{section}|{tan}"
    return hashlib.sha256(sig.encode()).hexdigest()


def _book_was_matched(
    book_index: int,
    matched_results: List[AssignmentResult],
    suggested_results: Optional[List[AssignmentResult]] = None,
) -> bool:
    if any(b.index == book_index for r in matched_results for b in r.books):
        return True
    if suggested_results and any(b.index == book_index for r in suggested_results for b in r.books):
        return True
    return False
