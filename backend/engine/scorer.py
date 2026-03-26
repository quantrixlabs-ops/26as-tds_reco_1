"""
Composite Scoring Engine — replaces single-dimension variance scoring.

score = 30% variance_accuracy
      + 20% date_proximity
      + 20% section_match
      + 20% clearing_doc_linkage
      + 10% historical_pattern (future: from DB)

Returns 0–100. Higher = better match.
Used by the optimizer to rank candidates before selecting the best global assignment.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from typing import Optional, List
import math


@dataclass
class BookCandidate:
    """A set of SAP book entries being evaluated as a match for one 26AS entry."""
    invoice_refs: List[str]
    amounts: List[float]
    dates: List[Optional[str]]          # doc_date strings (dd-Mon-YYYY)
    clearing_doc: Optional[str]
    sap_fy: Optional[str]

    @property
    def total(self) -> float:
        return sum(self.amounts)


@dataclass
class ScoreBreakdown:
    total: float                  # 0–100 composite score
    variance_score: float         # 0–30
    date_score: float             # 0–20
    section_score: float          # 0–20
    clearing_score: float         # 0–20
    historical_score: float       # 0–10

    def to_dict(self) -> dict:
        return {
            "composite_score": round(self.total, 2),
            "score_variance": round(self.variance_score, 2),
            "score_date_proximity": round(self.date_score, 2),
            "score_section_match": round(self.section_score, 2),
            "score_clearing_doc": round(self.clearing_score, 2),
            "score_historical": round(self.historical_score, 2),
        }


def score_candidate(
    as26_amount: float,
    as26_date: Optional[str],
    as26_section: str,
    candidate: BookCandidate,
    sap_section_map: Optional[dict] = None,   # future: invoice_ref → section
    historical_score: float = 5.0,            # default neutral
    enforce_before: bool = True,              # penalise books after 26AS date
) -> ScoreBreakdown:
    """
    Compute composite score for one candidate match.

    Args:
        as26_amount: The 26AS gross amount
        as26_date: The 26AS transaction date string
        as26_section: The 26AS TDS section
        candidate: The set of SAP book entries being evaluated
        sap_section_map: Optional dict mapping invoice_ref → expected section
        historical_score: 0–10 from historical pattern (default 5 = neutral)
        enforce_before: If True, heavily penalise books dated after 26AS date

    Returns:
        ScoreBreakdown with total and component scores
    """
    # ── 1. Variance Score (30%) ───────────────────────────────────────────────
    if as26_amount > 0:
        variance_pct = abs(as26_amount - candidate.total) / as26_amount * 100
    else:
        variance_pct = 100.0
    variance_score = _score_variance(variance_pct) * 0.30

    # ── 2. Date Proximity Score (20%) ─────────────────────────────────────────
    date_score = _score_date_proximity(as26_date, candidate.dates, enforce_before=enforce_before) * 0.20

    # ── 3. Section Match Score (20%) ──────────────────────────────────────────
    section_score = _score_section(as26_section, candidate.invoice_refs, sap_section_map) * 0.20

    # ── 4. Clearing Doc Linkage Score (20%) ──────────────────────────────────
    clearing_score = _score_clearing_doc(candidate.clearing_doc) * 0.20

    # ── 5. Historical Pattern Score (10%) ────────────────────────────────────
    hist_score = min(max(historical_score, 0.0), 10.0) * 0.10

    total = variance_score + date_score + section_score + clearing_score + hist_score

    return ScoreBreakdown(
        total=min(total, 100.0),
        variance_score=variance_score,
        date_score=date_score,
        section_score=section_score,
        clearing_score=clearing_score,
        historical_score=hist_score,
    )


# ── Component scorers ────────────────────────────────────────────────────────

def _score_variance(variance_pct: float) -> float:
    """
    0–100 score for variance accuracy.
    0%   → 100 (perfect)
    1%   → 90
    2%   → 75
    3%   → 55
    5%   → 20
    10%  → 10
    20%  → 2
    >20% → 1
    """
    if variance_pct <= 0.01:
        return 100.0
    if variance_pct <= 1.0:
        return 100.0 - (variance_pct / 1.0) * 10.0          # 100 → 90
    if variance_pct <= 2.0:
        return 90.0 - ((variance_pct - 1.0) / 1.0) * 15.0   # 90 → 75
    if variance_pct <= 3.0:
        return 75.0 - ((variance_pct - 2.0) / 1.0) * 20.0   # 75 → 55
    if variance_pct <= 5.0:
        return 55.0 - ((variance_pct - 3.0) / 2.0) * 35.0   # 55 → 20
    if variance_pct <= 10.0:
        return 20.0 - ((variance_pct - 5.0) / 5.0) * 10.0   # 20 → 10
    if variance_pct <= 20.0:
        return 10.0 - ((variance_pct - 10.0) / 10.0) * 8.0  # 10 → 2
    return 1.0


def _score_date_proximity(as26_date_str: Optional[str], book_dates: List[Optional[str]], enforce_before: bool = True) -> float:
    """
    0–100 score based on proximity between 26AS transaction date and invoice dates.
    Books BEFORE 26AS date (normal): standard proximity scoring
    Books AFTER 26AS date: heavily penalized (if enforce_before, return 5)
    Within 30 days → 100
    30–90 days → linear decay from 100 to 60
    90–180 days → linear decay from 60 to 20
    >180 days → 5 (still possible but unusual)
    No dates → 50 (neutral — don't penalise missing data)
    """
    as26_d = _parse_date(as26_date_str)
    if as26_d is None:
        return 50.0

    valid_diffs = []
    has_future_book = False
    for ds in book_dates:
        d = _parse_date(ds)
        if d:
            diff_days = (as26_d - d).days  # positive = book is before 26AS
            if diff_days < 0:
                has_future_book = True
            valid_diffs.append(abs(diff_days))

    if not valid_diffs:
        return 50.0

    # If any book is after 26AS and we enforce before-only, heavy penalty
    if enforce_before and has_future_book:
        return 5.0

    min_diff = min(valid_diffs)

    if min_diff <= 30:
        return 100.0
    if min_diff <= 90:
        return 100.0 - ((min_diff - 30) / 60) * 40.0      # 100 → 60
    if min_diff <= 180:
        return 60.0 - ((min_diff - 90) / 90) * 40.0       # 60 → 20
    return 5.0


def _score_section(
    as26_section: str,
    invoice_refs: List[str],
    sap_section_map: Optional[dict],
) -> float:
    """
    0–100 score for section alignment.
    With section map: score based on match ratio.
    Without section map but with section info: use section-based heuristics.
    No section at all: return 50 (neutral).
    """
    if not as26_section:
        return 50.0  # no 26AS section, can't evaluate

    if sap_section_map:
        matches = 0
        total = 0
        for ref in invoice_refs:
            sap_sec = sap_section_map.get(ref)
            if sap_sec:
                total += 1
                if sap_sec.strip() == as26_section.strip():
                    matches += 1
        if total > 0:
            return (matches / total) * 100.0

    # Without SAP section map: give slight boost for well-known high-volume sections
    # These sections (194C, 194J, 194H) have standard TDS rates, less ambiguity
    HIGH_CONFIDENCE_SECTIONS = {"194C", "194J", "194H", "194I", "194A"}
    if as26_section.strip() in HIGH_CONFIDENCE_SECTIONS:
        return 60.0  # slight positive bias for standard sections

    return 50.0  # neutral


def _score_clearing_doc(clearing_doc: Optional[str]) -> float:
    """
    0–100 score for clearing document linkage.
    Present and non-empty → 100 (strong business linkage evidence)
    Absent → 20 (possible but weaker)
    """
    if clearing_doc and str(clearing_doc).strip() not in ("", "0", "None"):
        return 100.0
    return 20.0


from functools import lru_cache

@lru_cache(maxsize=8192)
def _parse_date(date_str: Optional[str]) -> Optional[date]:
    """Parse dd-Mon-YYYY or YYYY-MM-DD date strings. LRU-cached for performance."""
    if not date_str:
        return None
    s = str(date_str).strip()
    for fmt in ("%d-%b-%Y", "%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None
