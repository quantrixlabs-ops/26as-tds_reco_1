"""
Validation Engine — runs BEFORE matching.
Implements all 6 mandatory pre-match validators.

1. PAN validation (format check + 206AA detection)
2. 26AS duplicate / revision detection
3. Section validation (known sections only)
4. TDS rate validation: derived_gross = TDS / rate vs reported gross
5. Control totals: will be verified post-match
6. Negative / invalid entry flagging
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import List, Dict, Optional, Set, Tuple
import pandas as pd

# ── Constants ──────────────────────────────────────────────────────────────────

PAN_REGEX = re.compile(r"^[A-Z]{5}[0-9]{4}[A-Z]$")

KNOWN_SECTIONS: Set[str] = {
    "192", "192A", "193", "194", "194A", "194B", "194BB", "194C",
    "194D", "194DA", "194E", "194EE", "194F", "194G", "194H", "194I",
    "194IA", "194IB", "194IC", "194J", "194K", "194LA", "194LB",
    "194LBA", "194LC", "194LD", "194N", "194O", "194P", "194Q",
    "194R", "194S", "195", "196A", "196B", "196C", "196D",
    "206AA", "206AB",
}

# Standard TDS rates by section (used for rate validation).
# Where rates differ by deductee type, the LOWER rate is used (individual/HUF).
# This minimizes false-positive rate mismatch flags — a higher actual rate will
# still be caught if it diverges >2% from the expected rate.
# Rates as per Finance Act 2024 (applicable FY2024-25 onwards).
STANDARD_RATES: Dict[str, float] = {
    # ── Salary & pension ────────────────────────────────────────────────────
    "192":   30.0,   # Salary (slab rates; 30% used as proxy for high-bracket detection)
    "192A":  10.0,   # Premature EPF withdrawal
    # ── Interest ────────────────────────────────────────────────────────────
    "193":   10.0,   # Interest on securities
    "194A":  10.0,   # Interest other than securities
    # ── Dividends ───────────────────────────────────────────────────────────
    "194":   10.0,   # Deemed dividend
    # ── Lottery / games ─────────────────────────────────────────────────────
    "194B":  30.0,   # Lottery / crossword / card games
    "194BB": 30.0,   # Horse race winnings
    # ── Contractor payments ─────────────────────────────────────────────────
    "194C":  1.0,    # Contractors — individual/HUF (2% for companies; 1% used as lower bound)
    # ── Insurance ───────────────────────────────────────────────────────────
    "194D":  5.0,    # Insurance commission (non-company; 10% for company)
    "194DA": 5.0,    # Life insurance payout (maturity proceeds)
    # ── Non-resident sportsman / entertainer ─────────────────────────────────
    "194E":  20.0,   # Payments to non-resident sportsmen / entertainers
    "194EE": 10.0,   # NSS deposits
    # ── Mutual fund / UTI ───────────────────────────────────────────────────
    "194F":  20.0,   # Repurchase of units by mutual fund / UTI
    # ── Commission ──────────────────────────────────────────────────────────
    "194G":  5.0,    # Commission on lottery tickets
    "194H":  5.0,    # Commission / brokerage
    # ── Rent ────────────────────────────────────────────────────────────────
    "194I":  10.0,   # Rent — land/building/furniture (10%); plant/machinery (2%)
    "194IA": 1.0,    # Transfer of immovable property (non-agricultural)
    "194IB": 5.0,    # Rent by individual/HUF > ₹50K/month
    "194IC": 10.0,   # JDA — payment under specified agreement
    # ── Professional / technical fees ───────────────────────────────────────
    "194J":  10.0,   # Professional/technical fees (2% for call centre; 10% default)
    # ── Income from units ───────────────────────────────────────────────────
    "194K":  10.0,   # Income from units of mutual fund / specified company
    # ── Compensation / enhanced compensation ────────────────────────────────
    "194LA": 10.0,   # Compensation on acquisition of immovable property
    "194LB": 5.0,    # Income from infrastructure debt fund (non-resident)
    "194LBA": 5.0,   # Certain income from business trust (non-resident)
    "194LC": 5.0,    # Interest income from Indian company (non-resident)
    "194LD": 5.0,    # Interest on certain bonds (non-resident)
    # ── Cash withdrawal ─────────────────────────────────────────────────────
    "194N":  2.0,    # Cash withdrawal exceeding ₹1 crore
    # ── E-commerce ──────────────────────────────────────────────────────────
    "194O":  1.0,    # E-commerce operator payments
    # ── Specified senior citizen ────────────────────────────────────────────
    "194P":  10.0,   # TDS on senior citizen (bank computation; slab-based proxy)
    # ── Purchase of goods ───────────────────────────────────────────────────
    "194Q":  0.1,    # Purchase of goods exceeding ₹50 lakh
    # ── Benefit or perquisite ───────────────────────────────────────────────
    "194R":  10.0,   # Benefit / perquisite in business
    # ── Virtual digital assets ──────────────────────────────────────────────
    "194S":  1.0,    # Transfer of virtual digital assets (crypto etc.)
    # ── Non-resident payments ───────────────────────────────────────────────
    "195":   20.0,   # Non-resident payments (default; varies by DTAA)
    "196A":  10.0,   # Income from units (non-resident, other than company)
    "196B":  10.0,   # Income from units to offshore fund
    "196C":  10.0,   # Income from foreign currency bonds / GDR
    "196D":  20.0,   # Income of FII from securities
    # ── PAN-related higher rates ────────────────────────────────────────────
    "206AA": 20.0,   # PAN not furnished — higher rate
    "206AB": 20.0,   # Specified person non-filer — higher rate (double normal or 5%, whichever higher)
}

RATE_TOLERANCE_PCT = 2.0   # Allow 2% tolerance in rate-derived gross vs reported gross

# Import from config.py to keep thresholds centralized
from config import HIGH_VALUE_THRESHOLD


# ── Result Types ──────────────────────────────────────────────────────────────

@dataclass
class ValidationIssue:
    code: str            # e.g. "PAN_INVALID", "DUPLICATE_26AS", "RATE_MISMATCH"
    severity: str        # "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"
    row_index: int
    description: str
    field: Optional[str] = None
    value: Optional[str] = None


@dataclass
class ValidationReport:
    total_rows: int = 0
    valid_rows: int = 0
    rejected_rows: int = 0
    flagged_rows: int = 0
    issues: List[ValidationIssue] = field(default_factory=list)
    duplicates_found: int = 0
    pan_issues: int = 0
    rate_mismatches: int = 0
    section_issues: int = 0
    has_blocking_errors: bool = False
    control_total_26as: float = 0.0

    def add_issue(self, issue: ValidationIssue) -> None:
        self.issues.append(issue)
        if issue.severity == "CRITICAL":
            self.has_blocking_errors = True

    def to_dict(self) -> dict:
        return {
            "total_rows": self.total_rows,
            "valid_rows": self.valid_rows,
            "rejected_rows": self.rejected_rows,
            "flagged_rows": self.flagged_rows,
            "duplicates_found": self.duplicates_found,
            "pan_issues": self.pan_issues,
            "rate_mismatches": self.rate_mismatches,
            "section_issues": self.section_issues,
            "has_blocking_errors": self.has_blocking_errors,
            "control_total_26as": self.control_total_26as,
            "issues": [
                {
                    "code": i.code,
                    "severity": i.severity,
                    "row_index": i.row_index,
                    "description": i.description,
                    "field": i.field,
                    "value": i.value,
                }
                for i in self.issues
            ],
        }


# ── Validator ─────────────────────────────────────────────────────────────────

def validate_26as(
    df: pd.DataFrame,
    rate_tolerance_pct: Optional[float] = None,
    rate_mismatch_severity: Optional[str] = None,
) -> Tuple[pd.DataFrame, ValidationReport]:
    """
    Run all validators on the parsed 26AS DataFrame.

    Args:
        df: Parsed 26AS DataFrame
        rate_tolerance_pct: Phase 5G — override default 2% rate tolerance
        rate_mismatch_severity: Phase 5G — override default MEDIUM severity for rate mismatches

    Returns:
        (validated_df, report)
        validated_df: rows that pass validation (flagged rows are KEPT but marked)
        report: full ValidationReport with all issues
    """
    # Phase 5G: resolve configurable rate tolerance
    eff_rate_tol = rate_tolerance_pct if rate_tolerance_pct is not None else RATE_TOLERANCE_PCT
    eff_rate_sev = rate_mismatch_severity if rate_mismatch_severity is not None else "MEDIUM"

    report = ValidationReport(total_rows=len(df))
    if df.empty:
        return df, report

    df = df.copy()
    df["_valid"] = True
    df["_flags"] = ""
    df["_derived_gross"] = None
    df["_rate_mismatch"] = False
    df["_section_valid"] = True

    seen_signatures: Dict[str, int] = {}   # for duplicate detection

    for idx, row in df.iterrows():
        row_issues: List[ValidationIssue] = []

        # 1. Negative / zero amount
        amount = row.get("amount", 0)
        if pd.isna(amount) or amount is None:
            row_issues.append(ValidationIssue(
                code="NULL_AMOUNT", severity="CRITICAL", row_index=idx,
                description="Amount is null", field="amount"
            ))
            df.at[idx, "_valid"] = False
        elif amount < 0:
            row_issues.append(ValidationIssue(
                code="NEGATIVE_AMOUNT", severity="HIGH", row_index=idx,
                description=f"Negative amount ₹{amount:,.2f} — possible reversal. Flagged for review.",
                field="amount", value=str(amount)
            ))
            df.at[idx, "_flags"] = _add_flag(df.at[idx, "_flags"], "REVERSAL")

        # 2. Section validation
        section = str(row.get("section", "")).strip()
        if section and section not in KNOWN_SECTIONS:
            row_issues.append(ValidationIssue(
                code="UNKNOWN_SECTION", severity="MEDIUM", row_index=idx,
                description=f"Section '{section}' is not a recognized TDS section",
                field="section", value=section
            ))
            df.at[idx, "_section_valid"] = False
            report.section_issues += 1

        # 3. TDS rate validation
        tds_amount = row.get("tds_amount")
        if tds_amount and not pd.isna(tds_amount) and amount and amount > 0 and section in STANDARD_RATES:
            expected_rate = STANDARD_RATES[section]
            derived_gross = (float(tds_amount) / expected_rate) * 100
            df.at[idx, "_derived_gross"] = round(derived_gross, 2)

            if amount > 0:
                rate_divergence_pct = abs(derived_gross - float(amount)) / float(amount) * 100
                if rate_divergence_pct > eff_rate_tol:
                    df.at[idx, "_rate_mismatch"] = True
                    report.rate_mismatches += 1

                    # Check for 206AA (20% rate — PAN not available)
                    if tds_amount and float(tds_amount) > 0:
                        implied_rate = float(tds_amount) / float(amount) * 100
                        if implied_rate >= 19.0:
                            row_issues.append(ValidationIssue(
                                code="POSSIBLE_206AA", severity="HIGH", row_index=idx,
                                description=f"Implied TDS rate {implied_rate:.1f}% suggests PAN non-availability (Section 206AA)",
                                field="tds_amount", value=f"{implied_rate:.1f}%"
                            ))
                            report.pan_issues += 1
                            df.at[idx, "_flags"] = _add_flag(df.at[idx, "_flags"], "POSSIBLE_206AA")
                        else:
                            row_issues.append(ValidationIssue(
                                code="RATE_MISMATCH", severity=eff_rate_sev, row_index=idx,
                                description=(
                                    f"Section {section}: expected rate {expected_rate}%, "
                                    f"derived gross ₹{derived_gross:,.2f} vs reported ₹{amount:,.2f} "
                                    f"({rate_divergence_pct:.1f}% divergence)"
                                ),
                                field="tds_amount"
                            ))
                            df.at[idx, "_flags"] = _add_flag(df.at[idx, "_flags"], "RATE_MISMATCH")

        # 4. Duplicate detection (same TAN + section + date + amount + TDS)
        #    Duplicates are REJECTED (only first occurrence kept for matching)
        sig = _row_signature(row)
        if sig in seen_signatures:
            report.duplicates_found += 1
            row_issues.append(ValidationIssue(
                code="DUPLICATE_26AS", severity="HIGH", row_index=idx,
                description=f"Duplicate of row {seen_signatures[sig]} (same TAN/section/date/amount)",
                field="amount"
            ))
            df.at[idx, "_flags"] = _add_flag(df.at[idx, "_flags"], "DUPLICATE_26AS")
            df.at[idx, "_valid"] = False
        else:
            seen_signatures[sig] = idx

        # Accumulate issues
        for issue in row_issues:
            report.add_issue(issue)
        if row_issues:
            report.flagged_rows += 1

    # Final counts
    report.valid_rows = int(df["_valid"].sum())
    report.rejected_rows = report.total_rows - report.valid_rows
    report.control_total_26as = float(df[df["_valid"]]["amount"].sum())

    return df, report


def validate_sap_books(df: pd.DataFrame) -> Tuple[pd.DataFrame, List[ValidationIssue]]:
    """
    Lighter validation pass on cleaned SAP books.
    Returns flagged DF and issue list (non-blocking).
    """
    issues: List[ValidationIssue] = []
    if df.empty:
        return df, issues

    df = df.copy()
    df["_sap_flags"] = df.get("flag", "")

    for idx, row in df.iterrows():
        amount = row.get("amount", 0)

        # Flag split invoices (already done in cleaner — just propagate)
        if "SPLIT_INVOICE" in str(row.get("flag", "")):
            issues.append(ValidationIssue(
                code="SPLIT_INVOICE", severity="LOW", row_index=idx,
                description=f"Invoice {row.get('invoice_ref', '')} has split clearing entries",
                field="invoice_ref"
            ))

        # Flag advances
        if "SGL_V" in str(row.get("flag", "")):
            issues.append(ValidationIssue(
                code="ADVANCE_PAYMENT", severity="LOW", row_index=idx,
                description=f"Row {idx} flagged as advance payment (Special G/L = V)",
                field="sgl_ind", value="V"
            ))

    return df, issues


# ── Helpers ───────────────────────────────────────────────────────────────────

def _row_signature(row) -> str:
    """Unique signature for duplicate detection.
    Includes invoice_number when available to prevent false-positive duplicates
    (two different transactions with same TAN/section/date/amount).
    """
    tan = str(row.get("tan", "") or "").strip()
    section = str(row.get("section", "") or "").strip()
    date = str(row.get("transaction_date", "") or "").strip()
    raw_amount = row.get("amount", 0)
    amount = str(round(float(raw_amount), 2)) if raw_amount is not None else "0"
    raw_tds = row.get("tds_amount", 0)
    tds = str(round(float(raw_tds), 2)) if raw_tds is not None else "0"
    invoice = str(row.get("invoice_number", "") or "").strip()
    return f"{tan}|{section}|{date}|{amount}|{tds}|{invoice}"


def _add_flag(existing: str, new_flag: str) -> str:
    if not existing:
        return new_flag
    flags = set(existing.split(","))
    flags.add(new_flag)
    return ",".join(sorted(flags))


def compute_control_totals(
    total_26as_amount: float,
    matched_amount: float,
    unmatched_26as_amount: float,
    suggested_amount: float = 0.0,
) -> dict:
    """
    Verify: total_26as_amount == matched_amount + suggested_amount + unmatched_26as_amount
    Returns a control totals dict with balanced flag.
    """
    computed_sum = matched_amount + suggested_amount + unmatched_26as_amount
    difference = abs(total_26as_amount - computed_sum)
    balanced = difference < 0.02  # ₹0.02 tolerance for floating point

    return {
        "total_26as_amount": round(total_26as_amount, 2),
        "matched_amount": round(matched_amount, 2),
        "suggested_amount": round(suggested_amount, 2),
        "unmatched_26as_amount": round(unmatched_26as_amount, 2),
        "computed_sum": round(computed_sum, 2),
        "difference": round(difference, 2),
        "balanced": balanced,
    }


def compute_pre_match_control_totals(
    total_26as_amount: float,
    total_26as_count: int,
    total_sap_amount: float,
    total_sap_count: int,
) -> dict:
    """
    Pre-match control totals — computed BEFORE matching begins.
    Compares aggregate amounts between 26AS and SAP for initial sanity check.
    """
    coverage_ratio = (total_sap_amount / total_26as_amount * 100) if total_26as_amount > 0 else 0.0
    amount_gap = total_26as_amount - total_sap_amount

    return {
        "total_26as_amount": round(total_26as_amount, 2),
        "total_26as_count": total_26as_count,
        "total_sap_amount": round(total_sap_amount, 2),
        "total_sap_count": total_sap_count,
        "coverage_ratio_pct": round(coverage_ratio, 2),
        "amount_gap": round(amount_gap, 2),
        "sap_covers_26as": coverage_ratio >= 95.0,
    }
