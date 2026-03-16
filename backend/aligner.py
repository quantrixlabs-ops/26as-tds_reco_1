"""
Deductor Name Alignment — Phase 1
Fuzzy-matches the SAP filename against 26AS deductor names.
Manages in-memory session store for pending alignments.
"""
from __future__ import annotations

import logging
import re
import time
import uuid
from typing import Any, Dict, List, Optional

import pandas as pd
from rapidfuzz import fuzz, process

from config import (
    AUTO_CONFIRM_SCORE,
    FUZZY_THRESHOLD,
    SESSION_TTL_SECONDS,
    TOP_N_CANDIDATES,
)
from models import AlignmentResult, DeductorCandidate

logger = logging.getLogger(__name__)

# ── Session Store ─────────────────────────────────────────────────────────────
# { alignment_id → { clean_df, as26_df, alignment, created_at, excel_bytes } }
_store: Dict[str, Dict[str, Any]] = {}


def _purge_expired() -> None:
    now = time.time()
    expired = [k for k, v in _store.items() if now - v["created_at"] > SESSION_TTL_SECONDS]
    for k in expired:
        del _store[k]


def store_session(
    alignment_id: str,
    clean_df: pd.DataFrame,
    as26_df: pd.DataFrame,
    alignment: AlignmentResult,
    sap_filename: str,
    as26_bytes: bytes,
) -> None:
    _purge_expired()
    _store[alignment_id] = {
        "clean_df":     clean_df,
        "as26_df":      as26_df,
        "alignment":    alignment,
        "sap_filename": sap_filename,
        "as26_bytes":   as26_bytes,
        "excel_bytes":  None,
        "cleaning_report": None,
        "created_at":   time.time(),
    }


def get_session(alignment_id: str) -> Optional[Dict[str, Any]]:
    _purge_expired()
    return _store.get(alignment_id)


def store_excel(session_id: str, excel_bytes: bytes) -> None:
    if session_id in _store:
        _store[session_id]["excel_bytes"] = excel_bytes


def get_excel(session_id: str) -> Optional[bytes]:
    sess = _store.get(session_id)
    if sess:
        return sess.get("excel_bytes")
    return None


# ── Name Extraction ───────────────────────────────────────────────────────────

def extract_identity_string(filename: str) -> str:
    """
    Strip extension, replace underscores/hyphens with spaces, normalise.
    e.g. 'BHUSHAN_POWER_&_STEEL_LIMITED.XLSX' → 'BHUSHAN POWER & STEEL LIMITED'
    """
    name = re.sub(r"\.[a-zA-Z]{2,5}$", "", filename)  # remove extension
    name = name.replace("_", " ").replace("-", " ")
    name = re.sub(r"\s+", " ", name).strip().upper()
    return name


# ── Candidate Scoring ─────────────────────────────────────────────────────────

def _score_candidates(
    identity: str,
    as26_df: pd.DataFrame,
    tanwise_extras: List[dict],
) -> List[DeductorCandidate]:
    """
    Build ranked candidate list using rapidfuzz token_sort_ratio.
    Merges unique names from 26AS data rows + TANWISE SUMMARY sheet.
    """
    # Build pool: name → {tan, entry_count}
    pool: Dict[str, Dict] = {}

    if not as26_df.empty:
        for name, grp in as26_df.groupby("deductor_name"):
            tan = grp["tan"].iloc[0] if "tan" in grp.columns else ""
            pool[name] = {"tan": tan, "entry_count": len(grp)}

    for extra in tanwise_extras:
        ename = extra["deductor_name"]
        if ename not in pool:
            pool[ename] = {"tan": extra["tan"], "entry_count": 0}

    if not pool:
        return []

    # Score all candidates
    scored: List[DeductorCandidate] = []
    for name, meta in pool.items():
        score = fuzz.token_sort_ratio(identity, name)
        scored.append(DeductorCandidate(
            rank=0,
            deductor_name=name,
            tan=meta["tan"],
            score=float(score),
            entry_count=meta["entry_count"],
        ))

    scored.sort(key=lambda x: x.score, reverse=True)
    for i, c in enumerate(scored[:TOP_N_CANDIDATES]):
        c.rank = i + 1

    return scored[:TOP_N_CANDIDATES]


# ── Main Alignment Function ───────────────────────────────────────────────────

def align_deductor(
    sap_filename: str,
    as26_df: pd.DataFrame,
    tanwise_extras: Optional[List[dict]] = None,
) -> AlignmentResult:
    """
    Fuzzy-match SAP filename against 26AS deductor names.
    Returns AlignmentResult with status: AUTO_CONFIRMED | PENDING | NO_MATCH
    """
    identity = extract_identity_string(sap_filename)
    candidates = _score_candidates(identity, as26_df, tanwise_extras or [])

    if not candidates:
        return AlignmentResult(
            status="NO_MATCH",
            identity_string=identity,
            top_candidates=[],
        )

    top = candidates[0]
    second_score = candidates[1].score if len(candidates) > 1 else 0.0

    # AUTO_CONFIRM: top ≥ 95 AND (only one candidate OR second < 80)
    if top.score >= AUTO_CONFIRM_SCORE and second_score < 80:
        logger.info(
            "Auto-confirmed deductor: '%s' (score=%.1f)", top.deductor_name, top.score
        )
        return AlignmentResult(
            status="AUTO_CONFIRMED",
            identity_string=identity,
            top_candidates=candidates,
            confirmed_name=top.deductor_name,
            confirmed_tan=top.tan,
            fuzzy_score=top.score,
        )

    # PENDING: score 80–94 or two close candidates
    if top.score >= FUZZY_THRESHOLD:
        logger.info(
            "Alignment pending: top='%s' score=%.1f second=%.1f",
            top.deductor_name, top.score, second_score,
        )
        return AlignmentResult(
            status="PENDING",
            identity_string=identity,
            top_candidates=candidates,
        )

    # NO_MATCH
    logger.warning(
        "No match found for '%s' — top score=%.1f", identity, top.score
    )
    return AlignmentResult(
        status="NO_MATCH",
        identity_string=identity,
        top_candidates=candidates,
    )


def confirm_alignment(
    alignment_id: str,
    deductor_name: str,
    tan: str,
    as26_df: pd.DataFrame,
) -> AlignmentResult:
    """
    Stores user-confirmed deductor. Returns updated AlignmentResult.
    """
    # Recompute score for transparency
    sess = get_session(alignment_id)
    identity = sess["alignment"].identity_string if sess else deductor_name
    score = fuzz.token_sort_ratio(identity, deductor_name)

    return AlignmentResult(
        status="USER_CONFIRMED",
        identity_string=identity,
        top_candidates=sess["alignment"].top_candidates if sess else [],
        confirmed_name=deductor_name,
        confirmed_tan=tan.upper(),
        fuzzy_score=float(score),
    )


def search_deductor(
    query: str,
    as26_df: pd.DataFrame,
    tanwise_extras: Optional[List[dict]] = None,
) -> List[DeductorCandidate]:
    """
    Manual search — returns top 5 fuzzy matches for a user-typed query.
    Used when status = NO_MATCH.
    """
    return _score_candidates(query.upper(), as26_df, tanwise_extras or [])
