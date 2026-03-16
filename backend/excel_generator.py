"""
Excel Output Generator — Phase 1
generate_excel(reco_result, cleaning_report) → bytes

5-sheet workbook:
  Sheet 1 — Summary
  Sheet 2 — Matched Pairs
  Sheet 3 — Unmatched 26AS
  Sheet 4 — Unmatched Books
  Sheet 5 — Variance Analysis
"""
from __future__ import annotations

import io
from datetime import datetime
from typing import List, Optional

import openpyxl
from openpyxl import Workbook
from openpyxl.styles import (
    Alignment, Border, Font, GradientFill, PatternFill, Side, numbers
)
from openpyxl.utils import get_column_letter

from config import FINANCIAL_YEAR
from models import CleaningReport, MatchedPair, RecoResult

# ── Colour constants ──────────────────────────────────────────────────────────
NAVY        = "1F3864"
WHITE       = "FFFFFF"
LIGHT_BLUE  = "EBF3FB"
LIGHT_GRAY  = "F5F5F5"

VAR_GREEN   = "C6EFCE"   # variance < 5%
VAR_YELLOW  = "FFEB9C"   # variance 5–20%
VAR_RED     = "FFC7CE"   # variance > 20%

VIOLATION_RED = "FF0000"
GOOD_GREEN    = "00B050"

INR_FMT     = '#,##0.00'          # openpyxl handles Indian locale display
DATE_FMT    = "DD-MMM-YYYY"


# ── Style helpers ─────────────────────────────────────────────────────────────

def _fill(hex_color: str) -> PatternFill:
    return PatternFill("solid", fgColor=hex_color)


def _font(bold=False, color=WHITE, size=10, name="Arial") -> Font:
    return Font(bold=bold, color=color, size=size, name=name)


def _border() -> Border:
    thin = Side(style="thin", color="CCCCCC")
    return Border(left=thin, right=thin, top=thin, bottom=thin)


def _align(h="left", v="center", wrap=False) -> Alignment:
    return Alignment(horizontal=h, vertical=v, wrap_text=wrap)


def _header_style(ws, row: int, start_col: int, end_col: int, value: str) -> None:
    """Merge cells across a header title row."""
    ws.merge_cells(
        start_row=row, start_column=start_col,
        end_row=row,   end_column=end_col
    )
    cell = ws.cell(row=row, column=start_col, value=value)
    cell.fill    = _fill(NAVY)
    cell.font    = _font(bold=True, color=WHITE, size=11)
    cell.alignment = _align(h="center")


def _col_header(ws, row: int, col: int, value: str) -> None:
    cell = ws.cell(row=row, column=col, value=value)
    cell.fill      = _fill(NAVY)
    cell.font      = _font(bold=True, color=WHITE, size=10)
    cell.alignment = _align(h="center")
    cell.border    = _border()


def _data_cell(
    ws, row: int, col: int, value,
    fmt: Optional[str] = None,
    bg: Optional[str] = None,
    bold=False,
    align_h="left",
) -> None:
    cell = ws.cell(row=row, column=col, value=value)
    cell.border    = _border()
    cell.alignment = _align(h=align_h)
    if fmt:
        cell.number_format = fmt
    bg_color = bg if bg else (LIGHT_BLUE if row % 2 == 0 else WHITE)
    cell.fill = _fill(bg_color)
    cell.font = Font(bold=bold, size=10, name="Arial", color="000000")


def _autofit(ws, min_w=10, max_w=55) -> None:
    for col_cells in ws.columns:
        width = min_w
        for cell in col_cells:
            if cell.value:
                width = max(width, min(len(str(cell.value)) + 2, max_w))
        ws.column_dimensions[get_column_letter(col_cells[0].column)].width = width


def _var_color(pct: float) -> str:
    if abs(pct) < 5:
        return VAR_GREEN
    elif abs(pct) <= 20:
        return VAR_YELLOW
    else:
        return VAR_RED


# ── Sheet 1: Summary ──────────────────────────────────────────────────────────

def _build_summary(ws, result: RecoResult, report: CleaningReport) -> None:
    ws.sheet_view.showGridLines = False
    ws.freeze_panes = "A2"

    now_str = datetime.now().strftime("%d-%b-%Y %H:%M")
    title = (
        f"{result.deductor_name} | TDS Reconciliation | "
        f"{FINANCIAL_YEAR} | Generated: {now_str}"
    )
    _header_style(ws, 1, 1, 4, title)

    row = 3
    # ── Cleaning Stats ──────────────────────────────────────────────────────
    ws.cell(row=row, column=1, value="CLEANING STATISTICS").font = _font(bold=True, color="000000", size=10)
    row += 1

    cleaning_rows = [
        ("Total raw rows (input)",       report.total_rows_input),
        ("Rows after cleaning",          report.rows_after_cleaning),
        ("  Excluded — null amount",     report.excluded_null),
        ("  Excluded — negative/zero",   report.excluded_negative),
        ("  Excluded — noise (<₹100)",   report.excluded_noise),
        ("  Excluded — doc type (CC/BR)", report.excluded_doc_type),
        ("  Excluded — Special G/L (L/E/U)", report.excluded_sgl),
        ("  Flagged — advance (SGL=V)",  report.flagged_advance),
        ("  Flagged — AB doc type",      report.flagged_ab),
        ("  Flagged — other SGL (O/A/N)", report.flagged_other_sgl),
        ("  Duplicates removed",         report.duplicates_removed),
        ("  Split invoices flagged",     report.split_invoices_flagged),
    ]

    for label, value in cleaning_rows:
        _data_cell(ws, row, 1, label)
        _data_cell(ws, row, 2, value, align_h="right")
        row += 1

    row += 1
    # ── Reco Stats ──────────────────────────────────────────────────────────
    ws.cell(row=row, column=1, value="RECONCILIATION STATISTICS").font = _font(bold=True, color="000000", size=10)
    row += 1

    match_color = (
        VAR_GREEN  if result.match_rate_pct == 100 else
        VAR_YELLOW if result.match_rate_pct >= 80  else
        VAR_RED
    )

    reco_rows = [
        ("Deductor Name",          result.deductor_name,                   None),
        ("TAN",                    result.tan,                             None),
        ("Name Match Score",
            f"{result.fuzzy_score:.1f}%" if result.fuzzy_score else "Manual override",
            None),
        ("Total 26AS entries (Status=F)", result.total_26as_entries,      None),
        ("Matched entries",        result.matched_count,                   None),
        ("Match rate",             f"{result.match_rate_pct:.2f}%",       match_color),
        ("Unmatched 26AS entries", result.unmatched_26as_count,            None),
        ("Unmatched book invoices", result.unmatched_books_count,          None),
        ("Average variance %",     f"{result.avg_variance_pct:.2f}%",     None),
        ("Constraint violations",  result.constraint_violations,
            VIOLATION_RED if result.constraint_violations > 0 else VAR_GREEN),
    ]

    for label, value, bg in reco_rows:
        _data_cell(ws, row, 1, label)
        _data_cell(ws, row, 2, value, align_h="right", bg=bg)
        row += 1

    ws.column_dimensions["A"].width = 40
    ws.column_dimensions["B"].width = 30


# ── Sheet 2: Matched Pairs ────────────────────────────────────────────────────

def _build_matched(ws, pairs: List[MatchedPair]) -> None:
    ws.sheet_view.showGridLines = False
    ws.freeze_panes = "A2"

    headers = [
        "#", "26AS Date", "26AS Amount (₹)", "Section",
        "Books Sum (₹)", "Variance (₹)", "Variance %",
        "Match Type", "Invoice Count",
        "Invoice Ref(s)", "Invoice Date(s)", "Invoice Amounts",
        "SGL Flags",
    ]
    for c, h in enumerate(headers, 1):
        _col_header(ws, 1, c, h)

    # Sort by 26AS amount descending
    sorted_pairs = sorted(pairs, key=lambda p: p.as26_amount, reverse=True)

    for r, pair in enumerate(sorted_pairs, 2):
        var_bg = _var_color(pair.variance_pct)
        _data_cell(ws, r, 1,  r - 1,                                  align_h="center")
        _data_cell(ws, r, 2,  pair.as26_date or "",                   align_h="center")
        _data_cell(ws, r, 3,  pair.as26_amount,  fmt=INR_FMT,         align_h="right")
        _data_cell(ws, r, 4,  pair.section,                           align_h="center")
        _data_cell(ws, r, 5,  pair.books_sum,    fmt=INR_FMT,         align_h="right")
        _data_cell(ws, r, 6,  pair.variance_amt, fmt=INR_FMT, bg=var_bg, align_h="right")
        _data_cell(ws, r, 7,  f"{pair.variance_pct:.2f}%", bg=var_bg, align_h="right")
        _data_cell(ws, r, 8,  pair.match_type,                        align_h="center")
        _data_cell(ws, r, 9,  pair.invoice_count,                     align_h="center")
        _data_cell(ws, r, 10, ", ".join(pair.invoice_refs))
        _data_cell(ws, r, 11, ", ".join(d or "" for d in pair.invoice_dates))
        _data_cell(ws, r, 12, ", ".join(f"{a:,.2f}" for a in pair.invoice_amounts))
        _data_cell(ws, r, 13, ", ".join(f for f in pair.sgl_flags if f))

    _autofit(ws)


# ── Sheet 3: Unmatched 26AS ───────────────────────────────────────────────────

def _build_unmatched_26as(ws, entries) -> None:
    ws.sheet_view.showGridLines = False
    ws.freeze_panes = "A2"

    headers = ["#", "26AS Date", "Amount (₹)", "Section", "TAN", "Possible Reason"]
    for c, h in enumerate(headers, 1):
        _col_header(ws, 1, c, h)

    if not entries:
        ws.merge_cells("A2:F2")
        cell = ws.cell(row=2, column=1, value="✓ All 26AS entries matched")
        cell.fill      = _fill(VAR_GREEN)
        cell.font      = Font(bold=True, color="375623", size=11, name="Arial")
        cell.alignment = _align(h="center")
        _autofit(ws)
        return

    for r, entry in enumerate(entries, 2):
        _data_cell(ws, r, 1, r - 1,               align_h="center")
        _data_cell(ws, r, 2, entry.transaction_date or "", align_h="center")
        _data_cell(ws, r, 3, entry.amount, fmt=INR_FMT, align_h="right")
        _data_cell(ws, r, 4, entry.section,        align_h="center")
        _data_cell(ws, r, 5, entry.tan,             align_h="center")
        _data_cell(ws, r, 6, "Investigate with deductor — no matching book invoice found")

    _autofit(ws)


# ── Sheet 4: Unmatched Books ──────────────────────────────────────────────────

def _possible_reason_books(entry) -> str:
    if "SGL_V" in (entry.flag or ""):
        return "Advance payment — TDS may be on advance"
    if entry.amount > 1_000_000:
        return "Large milestone / different financial year"
    return "Timing difference — may appear in 26AS next period"


def _build_unmatched_books(ws, entries) -> None:
    ws.sheet_view.showGridLines = False
    ws.freeze_panes = "A2"

    headers = [
        "#", "Invoice Date", "Amount (₹)", "Invoice Ref",
        "Doc Type", "SGL Flag", "Possible Reason",
    ]
    for c, h in enumerate(headers, 1):
        _col_header(ws, 1, c, h)

    if not entries:
        ws.merge_cells("A2:G2")
        cell = ws.cell(row=2, column=1, value="✓ All book invoices matched")
        cell.fill      = _fill(VAR_GREEN)
        cell.font      = Font(bold=True, color="375623", size=11, name="Arial")
        cell.alignment = _align(h="center")
        _autofit(ws)
        return

    sorted_entries = sorted(entries, key=lambda e: e.amount, reverse=True)
    for r, entry in enumerate(sorted_entries, 2):
        _data_cell(ws, r, 1, r - 1,                 align_h="center")
        _data_cell(ws, r, 2, entry.doc_date or "",  align_h="center")
        _data_cell(ws, r, 3, entry.amount, fmt=INR_FMT, align_h="right")
        _data_cell(ws, r, 4, entry.invoice_ref)
        _data_cell(ws, r, 5, entry.doc_type,         align_h="center")
        _data_cell(ws, r, 6, entry.flag or "",       align_h="center")
        _data_cell(ws, r, 7, _possible_reason_books(entry))

    _autofit(ws)


# ── Sheet 5: Variance Analysis ────────────────────────────────────────────────

def _build_variance(ws, pairs: List[MatchedPair]) -> None:
    ws.sheet_view.showGridLines = False
    ws.freeze_panes = "A2"

    headers = ["Bucket", "Count", "% of Matched", "Interpretation"]
    for c, h in enumerate(headers, 1):
        _col_header(ws, 1, c, h)

    buckets = [
        ("0% Exact",    lambda p: abs(p.variance_pct) < 0.01,      VAR_GREEN,  "Perfect match"),
        ("0–5%",        lambda p: 0.01 <= abs(p.variance_pct) < 5,  VAR_GREEN,  "Acceptable variance"),
        ("5–10%",       lambda p: 5 <= abs(p.variance_pct) < 10,    VAR_YELLOW, "Minor variance — review"),
        ("10–20%",      lambda p: 10 <= abs(p.variance_pct) < 20,   VAR_YELLOW, "Moderate variance — investigate"),
        ("20–50%",      lambda p: 20 <= abs(p.variance_pct) < 50,   VAR_RED,    "High variance — investigate"),
        (">50%",        lambda p: abs(p.variance_pct) >= 50,         VAR_RED,    "Very high variance — urgent review"),
    ]

    total = len(pairs)
    for r, (label, pred, color, interp) in enumerate(buckets, 2):
        count = sum(1 for p in pairs if pred(p))
        pct   = (count / total * 100) if total > 0 else 0.0
        _data_cell(ws, r, 1, label,          bg=color)
        _data_cell(ws, r, 2, count,          bg=color, align_h="center")
        _data_cell(ws, r, 3, f"{pct:.1f}%", bg=color, align_h="center")
        _data_cell(ws, r, 4, interp,        bg=color)

    # Summary stats
    if pairs:
        variances = [p.variance_pct for p in pairs]
        import statistics
        stats_row = len(buckets) + 3
        ws.cell(row=stats_row, column=1, value="SUMMARY STATISTICS").font = (
            _font(bold=True, color="000000", size=10)
        )
        stats_row += 1
        for label, value in [
            ("Min variance %",    f"{min(variances):.2f}%"),
            ("Max variance %",    f"{max(variances):.2f}%"),
            ("Average variance %", f"{sum(variances)/len(variances):.2f}%"),
            ("Median variance %", f"{statistics.median(variances):.2f}%"),
            ("Std Dev %",         f"{statistics.stdev(variances):.2f}%" if len(variances) > 1 else "N/A"),
        ]:
            _data_cell(ws, stats_row, 1, label)
            _data_cell(ws, stats_row, 2, value, align_h="right")
            stats_row += 1

    _autofit(ws)


# ── Main generator ────────────────────────────────────────────────────────────

def generate_excel(
    result: RecoResult,
    report: CleaningReport,
) -> bytes:
    """
    Build the 5-sheet Excel workbook and return as bytes.
    """
    wb = Workbook()

    # Sheet 1 — Summary
    ws1 = wb.active
    ws1.title = "Summary"
    _build_summary(ws1, result, report)

    # Sheet 2 — Matched Pairs
    ws2 = wb.create_sheet("Matched Pairs")
    _build_matched(ws2, result.matched_pairs)

    # Sheet 3 — Unmatched 26AS
    ws3 = wb.create_sheet("Unmatched 26AS")
    _build_unmatched_26as(ws3, result.unmatched_26as)

    # Sheet 4 — Unmatched Books
    ws4 = wb.create_sheet("Unmatched Books")
    _build_unmatched_books(ws4, result.unmatched_books)

    # Sheet 5 — Variance Analysis
    ws5 = wb.create_sheet("Variance Analysis")
    _build_variance(ws5, result.matched_pairs)

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf.read()
