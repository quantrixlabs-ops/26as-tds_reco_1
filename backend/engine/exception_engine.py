"""
Exception Engine — automatically generates REQUIRES REVIEW records.

Produces ExceptionRecord entries for:
1. FORCE matches (FORCE_SINGLE, FORCE_COMBO)
2. HIGH_VARIANCE (variance > 3%)
3. CROSS_FY / PRIOR_YEAR matches
4. SECTION_MISMATCH (if section data available)
5. RATE_MISMATCH (from validation report)
6. PAN_ISSUE (206AA indicators)
7. DUPLICATE_26AS (from validation report)
8. AI_RISK_FLAG (from AI assist layer)
9. UNMATCHED_HIGH_VALUE (unmatched entries > ₹10L)
"""
from __future__ import annotations

from typing import List, Optional
from engine.optimizer import AssignmentResult, As26Entry
from engine.validator import ValidationReport, HIGH_VALUE_THRESHOLD
from config import MatchConfig


def generate_exceptions(
    matched: List[AssignmentResult],
    unmatched_26as: List[As26Entry],
    validation_report: ValidationReport,
    run_id: str,
    cfg: Optional[MatchConfig] = None,
) -> List[dict]:
    """
    Generate exception records for database insertion.
    Returns list of dicts matching ExceptionRecord fields.

    Phase 5A: cfg controls severity thresholds:
    - cfg.force_match_exception_severity: severity for FORCE matches
    - cfg.high_value_threshold: amount threshold for UNMATCHED_HIGH_VALUE
    - cfg.auto_escalate_high_value: auto-escalate exceptions above threshold
    """
    exceptions: List[dict] = []
    # Phase 5A: resolve configurable thresholds
    force_severity = cfg.force_match_exception_severity if cfg else "HIGH"
    hv_threshold = cfg.high_value_threshold if cfg else HIGH_VALUE_THRESHOLD
    auto_escalate = cfg.auto_escalate_high_value if cfg else True

    # ── Section cross-reference map (for mismatch detection) ─────────────────
    # Known sections that are commonly confused with each other
    SECTION_CONFLICT_PAIRS = {
        ("194C", "194J"), ("194J", "194C"),  # Contractor vs Professional fees
        ("194I", "194IB"), ("194IB", "194I"),  # Rent categories
        ("194A", "193"), ("193", "194A"),  # Interest categories
    }

    # ── From matched pairs ────────────────────────────────────────────────────
    for result in matched:
        # 1. FORCE matches
        if "FORCE" in result.match_type:
            exceptions.append(_exc(
                run_id=run_id,
                exception_type="FORCE_MATCH",
                severity=force_severity,
                description=(
                    f"{result.match_type}: {len(result.books)} invoice(s), "
                    f"variance {result.variance_pct:.2f}%. "
                    f"Score: {result.score.total:.1f}/100. "
                    f"Section: {result.as26_section}. "
                    f"Amount: ₹{result.as26_amount:,.2f}"
                ),
                amount=result.as26_amount,
                section=result.as26_section,
            ))

        # 2. HIGH_VARIANCE (>3% but not FORCE)
        elif result.variance_pct > 3.0 and "FORCE" not in result.match_type:
            # Auto-confirmed high-variance matches get LOW severity (blocks auto-approval)
            # Suggested high-variance matches get MEDIUM severity
            sev = "LOW" if not result.suggested else "MEDIUM"
            exceptions.append(_exc(
                run_id=run_id,
                exception_type="HIGH_VARIANCE",
                severity=sev,
                description=(
                    f"Variance {result.variance_pct:.2f}% on {result.match_type} match. "
                    f"26AS amount ₹{result.as26_amount:,.2f}, "
                    f"books sum ₹{sum(b.amount for b in result.books):,.2f}"
                    + (" [Auto-confirmed]" if not result.suggested else "")
                ),
                amount=result.as26_amount,
                section=result.as26_section,
            ))

        # 3. PRIOR_YEAR / CROSS_FY
        if result.is_prior_year or result.cross_fy:
            exceptions.append(_exc(
                run_id=run_id,
                exception_type="CROSS_FY",
                severity="HIGH",
                description=(
                    f"Prior-year match ({result.match_type}): "
                    f"26AS amount ₹{result.as26_amount:,.2f}. "
                    f"Invoice date(s): {[b.doc_date for b in result.books]}. "
                    f"Invoice FY: {result.books[0].sap_fy if result.books else 'unknown'}"
                ),
                amount=result.as26_amount,
                section=result.as26_section,
            ))

        # 4. AI risk flag
        if result.ai_risk_flag:
            exceptions.append(_exc(
                run_id=run_id,
                exception_type="AI_RISK_FLAG",
                severity="MEDIUM",
                description=f"AI flagged: {result.ai_risk_reason or 'Anomaly detected'}",
                amount=result.as26_amount,
                section=result.as26_section,
            ))

        # 5. TIMING_MISMATCH — flag when book dates are significantly after 26AS date
        if result.days_gap is not None and result.days_gap < -45:
            exceptions.append(_exc(
                run_id=run_id,
                exception_type="AI_RISK_FLAG",
                severity="MEDIUM",
                description=(
                    f"Timing mismatch: invoice date is {abs(result.days_gap)} days AFTER 26AS date. "
                    f"Section: {result.as26_section}. "
                    f"Amount: ₹{result.as26_amount:,.2f}. "
                    f"Possible backdated or late-filed entry."
                ),
                amount=result.as26_amount,
                section=result.as26_section,
            ))

        # 6. TAN validation — flag if 26AS TAN looks invalid
        if hasattr(result, 'as26_section') and result.as26_section:
            import re
            tan_pattern = re.compile(r'^[A-Z]{4}[0-9]{5}[A-Z]$')
            # Check TAN from the 26AS entry (if available through books context)
            # TAN validation is primarily handled in the validator, but flag here
            # for matched pairs where the section suggests 206AA higher-rate deduction
            if result.as26_section in ("206AA", "206AB"):
                exceptions.append(_exc(
                    run_id=run_id,
                    exception_type="TAN_VALIDATION",
                    severity="HIGH",
                    description=(
                        f"Match under section {result.as26_section} — "
                        f"higher rate deduction (PAN non-availability). "
                        f"Amount: ₹{result.as26_amount:,.2f}"
                    ),
                    amount=result.as26_amount,
                    section=result.as26_section,
                ))

    # ── From unmatched 26AS ───────────────────────────────────────────────────
    for entry in unmatched_26as:
        if entry.amount >= hv_threshold:
            exceptions.append(_exc(
                run_id=run_id,
                exception_type="UNMATCHED_HIGH_VALUE",
                severity="CRITICAL",
                description=(
                    f"High-value 26AS entry unmatched: ₹{entry.amount:,.2f}. "
                    f"Section: {entry.section}. TAN: {entry.tan}. "
                    f"Date: {entry.transaction_date}"
                ),
                amount=entry.amount,
                section=entry.section,
            ))

    # ── Section mismatch detection across matched pairs ──────────────────────
    # Group matched entries by section and flag ambiguous section assignments
    section_amounts: dict[str, float] = {}
    for result in matched:
        sec = (result.as26_section or "").strip()
        if sec:
            section_amounts[sec] = section_amounts.get(sec, 0) + result.as26_amount

    # Check for known conflicting section pairs in the same run
    seen_sections = set(section_amounts.keys())
    flagged_pairs: set[tuple] = set()
    for s1 in seen_sections:
        for s2 in seen_sections:
            pair = tuple(sorted([s1, s2]))
            if (s1, s2) in SECTION_CONFLICT_PAIRS and pair not in flagged_pairs:
                flagged_pairs.add(pair)
                exceptions.append(_exc(
                    run_id=run_id,
                    exception_type="SECTION_MISMATCH",
                    severity="MEDIUM",
                    description=(
                        f"Both sections {pair[0]} (₹{section_amounts.get(pair[0], 0):,.2f}) and "
                        f"{pair[1]} (₹{section_amounts.get(pair[1], 0):,.2f}) appear in the same run. "
                        f"These sections are commonly confused — verify correct classification."
                    ),
                    amount=None,
                    section=f"{pair[0]}/{pair[1]}",
                ))

    # ── From validation report ─────────────────────────────────────────────────
    for issue in validation_report.issues:
        if issue.code == "RATE_MISMATCH":
            exceptions.append(_exc(
                run_id=run_id,
                exception_type="RATE_MISMATCH",
                severity="MEDIUM",
                description=issue.description,
                amount=None,
                section=None,
            ))
        elif issue.code == "POSSIBLE_206AA":
            exceptions.append(_exc(
                run_id=run_id,
                exception_type="PAN_ISSUE",
                severity="HIGH",
                description=issue.description,
                amount=None,
                section=None,
            ))
        elif issue.code == "DUPLICATE_26AS":
            exceptions.append(_exc(
                run_id=run_id,
                exception_type="DUPLICATE_26AS",
                severity="HIGH",
                description=issue.description,
                amount=None,
                section=None,
            ))

    # Phase 6F: Force match distribution alert
    fm_alert = getattr(cfg, 'force_match_alert_enabled', True) if cfg else True
    if fm_alert and matched:
        fm_pct_threshold = getattr(cfg, 'force_match_alert_pct_threshold', 10.0) if cfg else 10.0
        force_count = sum(1 for r in matched if "FORCE" in r.match_type)
        total_count = len(matched)
        fm_pct = (force_count / total_count * 100) if total_count > 0 else 0
        if fm_pct >= fm_pct_threshold:
            exceptions.append(_exc(
                run_id=run_id,
                exception_type="FORCE_MATCH_DISTRIBUTION",
                severity="HIGH",
                description=(
                    f"Force matches constitute {fm_pct:.1f}% of all matches "
                    f"({force_count}/{total_count}), exceeding {fm_pct_threshold:.0f}% threshold. "
                    f"Review force-match quality."
                ),
                amount=None,
                section=None,
            ))

    # Phase 6E: Unmatched amount alerting — aggregate-level exceptions
    alerting_enabled = getattr(cfg, 'unmatched_alerting_enabled', True) if cfg else True
    if alerting_enabled and unmatched_26as:
        crit_amt = getattr(cfg, 'unmatched_critical_amount_threshold', 500_000.0) if cfg else 500_000.0
        crit_count = getattr(cfg, 'unmatched_critical_count_threshold', 50) if cfg else 50
        total_unmatched_amt = sum(e.amount for e in unmatched_26as)
        total_unmatched_count = len(unmatched_26as)
        if total_unmatched_amt >= crit_amt:
            exceptions.append(_exc(
                run_id=run_id,
                exception_type="UNMATCHED_EXPOSURE",
                severity="CRITICAL",
                description=(
                    f"Total unmatched 26AS exposure ₹{total_unmatched_amt:,.2f} "
                    f"exceeds threshold ₹{crit_amt:,.0f} "
                    f"({total_unmatched_count} entries)"
                ),
                amount=total_unmatched_amt,
                section=None,
            ))
        if total_unmatched_count >= crit_count:
            exceptions.append(_exc(
                run_id=run_id,
                exception_type="UNMATCHED_COUNT_ALERT",
                severity="HIGH",
                description=(
                    f"{total_unmatched_count} unmatched 26AS entries "
                    f"exceeds threshold of {crit_count}. "
                    f"Total exposure: ₹{total_unmatched_amt:,.2f}"
                ),
                amount=total_unmatched_amt,
                section=None,
            ))

    # Phase 7H: Anomaly detection — amount outliers
    anomaly_enabled = getattr(cfg, 'anomaly_detection_enabled', False) if cfg else False
    if anomaly_enabled and matched:
        import statistics
        amounts = [r.as26_amount for r in matched if r.as26_amount > 0]
        if len(amounts) >= 5:  # Need enough data for meaningful stats
            mean_amt = statistics.mean(amounts)
            stdev_amt = statistics.stdev(amounts)
            outlier_threshold = getattr(cfg, 'amount_outlier_stddev', 3.0) if cfg else 3.0
            if stdev_amt > 0:
                for r in matched:
                    z_score = abs(r.as26_amount - mean_amt) / stdev_amt
                    if z_score >= outlier_threshold:
                        exceptions.append(_exc(
                            run_id=run_id,
                            exception_type="AMOUNT_OUTLIER",
                            severity="MEDIUM",
                            description=(
                                f"Amount ₹{r.as26_amount:,.2f} is {z_score:.1f} stddev from mean "
                                f"(₹{mean_amt:,.0f} ± ₹{stdev_amt:,.0f}). "
                                f"Match type: {r.match_type}, section: {r.as26_section}"
                            ),
                            amount=r.as26_amount,
                            section=r.as26_section,
                        ))

    # Phase 7J: System health — high exception rate alert
    sys_alerts = getattr(cfg, 'system_alerts_enabled', False) if cfg else False
    if sys_alerts:
        exc_rate_threshold = getattr(cfg, 'high_exception_rate_pct', 50.0) if cfg else 50.0
        total_entries = len(matched) + len(unmatched_26as)
        if total_entries > 0:
            exc_rate = len(exceptions) / total_entries * 100
            if exc_rate >= exc_rate_threshold:
                exceptions.append(_exc(
                    run_id=run_id,
                    exception_type="HIGH_EXCEPTION_RATE",
                    severity="HIGH",
                    description=(
                        f"Exception rate {exc_rate:.1f}% ({len(exceptions)} exceptions / "
                        f"{total_entries} entries) exceeds {exc_rate_threshold:.0f}% threshold"
                    ),
                    amount=None,
                    section=None,
                ))

    # Phase 5A: Auto-escalate high-value matched exceptions
    if auto_escalate:
        _SEVERITY_ORDER = {"INFO": 0, "LOW": 1, "MEDIUM": 2, "HIGH": 3, "CRITICAL": 4}
        _SEVERITY_NAMES = {v: k for k, v in _SEVERITY_ORDER.items()}
        for exc in exceptions:
            amt = exc.get("amount")
            if amt is not None and amt >= hv_threshold:
                current = _SEVERITY_ORDER.get(exc["severity"], 0)
                if current < _SEVERITY_ORDER["HIGH"]:
                    exc["severity"] = "HIGH"
                    exc["description"] += f" [Auto-escalated: amount ≥ ₹{hv_threshold:,.0f}]"

    return exceptions


# ── Phase 3I: PAN & 206AA Risk Detection ────────────────────────────────────

# Standard TDS rates by section (approximate, for risk detection only)
_STANDARD_TDS_RATES = {
    "194C": 0.02,   # 2% for contractors (>30K)
    "194J": 0.10,   # 10% for professional fees
    "194H": 0.05,   # 5% for commission
    "194I": 0.10,   # 10% for rent
    "194A": 0.10,   # 10% for interest
    "194B": 0.30,   # 30% for lottery
    "193":  0.10,   # 10% for interest on securities
    "194D": 0.05,   # 5% for insurance commission
    "194IA": 0.01,  # 1% for immovable property
}

# 206AA rate: 20% (or twice the normal rate, whichever is higher)
_206AA_RATE = 0.20


def detect_pan_risk(
    as26_entries: List[As26Entry],
    run_id: str,
) -> List[dict]:
    """Detect potential PAN non-furnishing (Section 206AA) issues.

    If the effective TDS rate for an entry significantly exceeds the standard
    section rate, it may indicate PAN non-availability (higher deduction).
    """
    exceptions = []
    for entry in as26_entries:
        if not entry.tds_amount or not entry.amount or entry.amount <= 0:
            continue
        effective_rate = entry.tds_amount / entry.amount
        section = entry.section.strip() if entry.section else ""
        standard_rate = _STANDARD_TDS_RATES.get(section)

        if standard_rate and effective_rate >= _206AA_RATE and effective_rate > standard_rate * 1.5:
            exceptions.append(_exc(
                run_id=run_id,
                exception_type="PAN_206AA_RISK",
                severity="HIGH",
                description=(
                    f"Potential 206AA risk: {entry.deductor_name} section {section} "
                    f"TDS rate {effective_rate:.1%} vs standard {standard_rate:.1%}. "
                    f"Amount: Rs.{entry.amount:,.2f}, TDS: Rs.{entry.tds_amount:,.2f}. "
                    f"May indicate PAN non-furnishing."
                ),
                amount=entry.amount,
                section=section,
            ))
    return exceptions


def _exc(
    run_id: str,
    exception_type: str,
    severity: str,
    description: str,
    amount: Optional[float],
    section: Optional[str],
) -> dict:
    return {
        "run_id": run_id,
        "exception_type": exception_type,
        "severity": severity,
        "description": description,
        "amount": amount,
        "section": section,
        "reviewed": False,
    }
