"""
Configuration constants for TDS Reconciliation Engine — Phase 1
All tunable parameters live here. Never hardcode these in business logic.

Revised per Change Request Brief (March 2026) benchmarking FY2023-24 data.
"""
from __future__ import annotations
from datetime import date
from typing import Tuple

# ── Reconciliation Engine ─────────────────────────────────────────────────────
MAX_COMBO_SIZE: int = 5          # Hard cap: enforced in ALL phases (COMBO, FORCE_COMBO, CLR_GROUP)
                                 # Brief §3: MAX_COMBO_SIZE = 5. Groups > 5 are skipped/logged.
COMBO_LIMIT: int = 500           # Max combinations tried PER SIZE in Phase B (not shared global)
COMBO_ITERATION_BUDGET: int = 50_000  # Max iterations per (26AS entry × size) — prevents runaway loops
EXACT_TOLERANCE: float = 0.01   # ₹ difference threshold for EXACT classification

# ── Tier-specific variance ceilings (Brief §3/#4, March 2026) ─────────────────
# Each match type has its own ceiling. Entries that exceed it remain unmatched.
VARIANCE_CAP_SINGLE: float = 2.0       # SINGLE: TDS rate rounding + minor deductions
VARIANCE_CAP_COMBO: float = 3.0        # COMBO_3 to COMBO_5: slightly more tolerance
VARIANCE_CAP_CLR_GROUP: float = 3.0    # CLR_GROUP: clearing doc linkage adds confidence
VARIANCE_CAP_FORCE_SINGLE: float = 5.0 # FORCE_SINGLE: last resort, CA review required

# FORCE_COMBO is intentionally restricted (Brief §3/#3):
# Not eliminated but limited to 2–3 invoices with a tight 2% cap.
# Prevents statistical "any target can be approximated" abuse.
FORCE_COMBO_MAX_INVOICES: int = 3      # Max invoices in a FORCE_COMBO match
FORCE_COMBO_MAX_VARIANCE: float = 2.0  # FORCE_COMBO must be near-exact to be accepted

# ── Cross-FY matching control (Brief §3/#1, P0) ────────────────────────────────
# When False: Phases A/B/C use ONLY target-FY invoices.
# Unmatched entries are then tried against prior-FY books in Phase E and tagged
# PRIOR_YEAR_EXCEPTION with LOW confidence for explicit CA review.
# Set to True only when the CA explicitly authorises prior-FY matching.
ALLOW_CROSS_FY: bool = False

# ── Cleaning Pipeline ─────────────────────────────────────────────────────────
NOISE_THRESHOLD: float = 1.0    # Rows with amount < ₹1 are excluded (keep all meaningful amounts)

# SAP Date Window — include current FY + N prior FYs in the raw pool.
# With ALLOW_CROSS_FY=False, prior-FY entries are held separate (Phase E only).
# With ALLOW_CROSS_FY=True, all entries in the window are treated equally.
SAP_LOOKBACK_YEARS: int = 1     # How many prior FYs to load into the books pool

# ── Name Alignment ────────────────────────────────────────────────────────────
FUZZY_THRESHOLD: int = 80        # Min rapidfuzz score for a valid candidate
AUTO_CONFIRM_SCORE: int = 95     # Score at/above which alignment auto-confirms
TOP_N_CANDIDATES: int = 5        # How many candidates to surface to user

# ── Session Store ─────────────────────────────────────────────────────────────
SESSION_TTL_SECONDS: int = 1800  # 30 minutes

# ── Financial Years ───────────────────────────────────────────────────────────
SUPPORTED_FINANCIAL_YEARS: list[str] = [
    "FY2020-21",
    "FY2021-22",
    "FY2022-23",
    "FY2023-24",
    "FY2024-25",
    "FY2025-26",
]

DEFAULT_FINANCIAL_YEAR: str = "FY2023-24"


def fy_date_range(fy_label: str) -> Tuple[date, date]:
    """
    Return (fy_start, fy_end) for a label like 'FY2023-24'.
    FY2023-24  →  01-Apr-2023  to  31-Mar-2024
    """
    try:
        start_year = int(fy_label.replace("FY", "").split("-")[0])
    except (ValueError, IndexError):
        raise ValueError(f"Invalid FY label '{fy_label}'. Expected format: FY2023-24")
    return date(start_year, 4, 1), date(start_year + 1, 3, 31)


def sap_date_window(fy_label: str) -> Tuple[date, date]:
    """
    SAP date window — current FY + N prior FYs.
    For FY2023-24 with lookback=1: 01-Apr-2022 → 31-Mar-2024
    Excludes post-FY invoices (can't be paid before they exist).
    When ALLOW_CROSS_FY=False, prior-FY entries are loaded but held for Phase E only.
    """
    fy_start, fy_end = fy_date_range(fy_label)
    sap_start = date(fy_start.year - SAP_LOOKBACK_YEARS, 4, 1)
    return sap_start, fy_end


def fy_label_from_date_range(fy_start: date) -> str:
    """Inverse of fy_date_range — build label from start date."""
    sy = fy_start.year
    return f"FY{sy}-{str(sy + 1)[2:]}"


def date_to_fy_label(d: date) -> str:
    """Return the FY label for a given date. E.g. 15-Jun-2023 → FY2023-24."""
    if d.month >= 4:
        return f"FY{d.year}-{str(d.year + 1)[2:]}"
    else:
        return f"FY{d.year - 1}-{str(d.year)[2:]}"


# ── Runtime configuration dataclass ──────────────────────────────────────────

from dataclasses import dataclass, field as dc_field


@dataclass
class MatchConfig:
    """Runtime configuration for a single reconciliation run.
    Populated from AdminSettings (DB) + per-run overrides (batch config).
    """
    # Document Filters
    doc_types_include: list = dc_field(default_factory=lambda: ["RV", "DR"])
    doc_types_exclude: list = dc_field(default_factory=lambda: ["CC", "BR"])

    # Date Rules
    date_hard_cutoff_days: int = 90
    date_soft_preference_days: int = 180
    enforce_books_before_26as: bool = True
    filing_lag_days: int = 45  # Allow books up to N days AFTER 26AS date (filing lag tolerance)

    # Variance Thresholds
    variance_normal_ceiling_pct: float = 3.0
    variance_auto_confirm_ceiling_pct: float = 20.0  # Auto-confirm matches up to this variance (with audit flag)
    variance_suggested_ceiling_pct: float = 20.0

    # Advance Payment
    exclude_sgl_v: bool = True

    # Combo Settings
    max_combo_size: int = 0  # 0 = unlimited
    date_clustering_preference: bool = True

    # Cross-FY
    allow_cross_fy: bool = False
    cross_fy_lookback_years: int = 1

    # Force Match
    force_match_enabled: bool = True

    # Noise
    noise_threshold: float = 1.0

    # Internals (not user-configurable)
    exact_tolerance: float = 0.01
    combo_pool_cap: int = 50
    combo_iteration_budget: int = 50_000

    def to_dict(self) -> dict:
        from dataclasses import asdict
        return asdict(self)
