"""
Configuration constants for TDS Reconciliation Engine — Phase 1
All tunable parameters live here. Never hardcode these in business logic.
"""

# ── Reconciliation Engine ─────────────────────────────────────────────────────
MAX_COMBO_SIZE: int = 8          # Max invoices in a single combination match
COMBO_LIMIT: int = 200           # Max combinations tried per 26AS entry
EXACT_TOLERANCE: float = 0.01   # ₹ difference threshold for EXACT classification

# ── Cleaning Pipeline ─────────────────────────────────────────────────────────
NOISE_THRESHOLD: float = 100.0  # Rows with amount < ₹100 are excluded as noise

# ── Name Alignment ────────────────────────────────────────────────────────────
FUZZY_THRESHOLD: int = 80        # Min rapidfuzz score for a valid candidate
AUTO_CONFIRM_SCORE: int = 95     # Score at/above which alignment auto-confirms
TOP_N_CANDIDATES: int = 5        # How many candidates to surface to user

# ── Session Store ─────────────────────────────────────────────────────────────
SESSION_TTL_SECONDS: int = 1800  # 30 minutes

# ── Output ────────────────────────────────────────────────────────────────────
FINANCIAL_YEAR: str = "FY2023-24"
