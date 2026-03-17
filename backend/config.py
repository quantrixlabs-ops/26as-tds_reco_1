"""
Configuration constants for TDS Reconciliation Engine — Phase 1
All tunable parameters live here. Never hardcode these in business logic.
"""
from __future__ import annotations
from datetime import date
from typing import Tuple

# ── Reconciliation Engine ─────────────────────────────────────────────────────
MAX_COMBO_SIZE: int = 8          # Max invoices in a single combination match
COMBO_LIMIT: int = 200           # Max combinations tried per 26AS entry
EXACT_TOLERANCE: float = 0.01   # ₹ difference threshold for EXACT classification
VARIANCE_CAP_PCT: float = 5.0   # P0: Hard cap — reject matches with variance > 5%

# ── Cleaning Pipeline ─────────────────────────────────────────────────────────
NOISE_THRESHOLD: float = 100.0  # Rows with amount < ₹100 are excluded as noise

# P2: SAP Date Window — include current FY + one prior FY only.
# For FY2023-24 reco: SAP invoices from Apr 2022 – Mar 2024 are eligible.
# Invoices AFTER the FY end are excluded (can't be paid before they exist).
SAP_LOOKBACK_YEARS: int = 1     # How many prior FYs to include in SAP pool

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
    P2: SAP date window — current FY + N prior FYs.
    For FY2023-24 with lookback=1: 01-Apr-2022 → 31-Mar-2024
    Excludes post-FY invoices (can't be paid before they exist).
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
