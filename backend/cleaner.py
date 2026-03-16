"""
SAP AR Ledger Cleaning Pipeline — Phase 1
Pure function: clean_sap_books(file_bytes, config) → (clean_df, CleaningReport)

Column reference (0-based positional index — NEVER use header name detection):
  col[0]  Customer
  col[1]  Reference
  col[2]  Assignment
  col[3]  Document Number
  col[4]  Clearing Document
  col[5]  Document Type        ← GATE 1
  col[6]  Document Date        ← DATE field
  col[7]  Posting Date
  col[8]  Special G/L ind.     ← GATE 2
  col[9]  Clearing date
  col[10] Amount in local currency  ← AMOUNT
  col[11] Local Currency
  col[12] Profit Center
  col[13] Text
  col[14] Invoice reference    ← REF
"""
from __future__ import annotations

import io
import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import openpyxl
import pandas as pd

from config import NOISE_THRESHOLD
from models import CleaningReport

logger = logging.getLogger(__name__)

# ── Document Type Rules ───────────────────────────────────────────────────────
INCLUDE_DOC_TYPES = {"RV", "DC", "DR"}   # Include if amount > 0
EXCLUDE_DOC_TYPES = {"CC", "BR"}          # Always exclude
FLAG_DOC_TYPES    = {"AB"}                # Include positive + flag AB_FLAGGED

# ── Special G/L Indicator Rules ───────────────────────────────────────────────
EXCLUDE_SGL = {"L", "E", "U"}
FLAG_SGL = {
    "V": "SGL_V",   # advance
    "O": "SGL_O",   # other special posting
    "A": "SGL_A",   # down payment clearing
    "N": "SGL_N",   # net payment
}


@dataclass
class _ExclusionCounters:
    null: int = 0
    negative: int = 0
    noise: int = 0
    doc_type: int = 0
    sgl: int = 0
    dupe: int = 0
    flagged_advance: int = 0   # SGL = V
    flagged_ab: int = 0        # Doc Type = AB
    flagged_other_sgl: int = 0 # SGL = O, A, N
    split_invoices: int = 0


def _parse_date(val: Any) -> Optional[str]:
    """Convert openpyxl date cell to DD-MMM-YYYY string."""
    if val is None:
        return None
    if isinstance(val, datetime):
        return val.strftime("%d-%b-%Y")
    try:
        return pd.to_datetime(str(val)).strftime("%d-%b-%Y")
    except Exception:
        return str(val)


def clean_sap_books(
    file_bytes: bytes,
    noise_threshold: float = NOISE_THRESHOLD,
) -> Tuple[pd.DataFrame, CleaningReport]:
    """
    Parse and clean a raw SAP AR ledger Excel file.

    Returns
    -------
    clean_df : DataFrame with columns
        [doc_date, amount, invoice_ref, doc_type, sgl_ind, flag]
    cleaning_report : CleaningReport
    """
    wb = openpyxl.load_workbook(io.BytesIO(file_bytes), data_only=True, read_only=True)
    ws = wb.active

    c = _ExclusionCounters()
    clean_rows: List[Dict] = []
    total_input = 0

    for row in ws.iter_rows(min_row=2, values_only=True):  # skip header
        total_input += 1

        # ── Step 2: Null amount ────────────────────────────────────────────
        raw_amount = row[10]
        if raw_amount is None:
            c.null += 1
            continue

        try:
            amount = float(raw_amount)
        except (ValueError, TypeError):
            c.null += 1
            continue

        # ── Step 3: Non-positive ───────────────────────────────────────────
        if amount <= 0:
            c.negative += 1
            continue

        # ── Step 4: Noise filter ───────────────────────────────────────────
        if amount < noise_threshold:
            c.noise += 1
            continue

        # ── Step 5: Document Type gate ─────────────────────────────────────
        doc_type = str(row[5]).strip() if row[5] is not None else ""
        flag = ""

        if doc_type in EXCLUDE_DOC_TYPES:
            c.doc_type += 1
            continue
        elif doc_type in INCLUDE_DOC_TYPES:
            pass  # clean pass-through
        elif doc_type in FLAG_DOC_TYPES:
            flag = "AB_FLAGGED"
            c.flagged_ab += 1
        elif doc_type == "":
            pass  # blank = standard posting
        else:
            c.doc_type += 1
            continue  # unknown type — exclude conservatively

        # ── Step 6: Special G/L Indicator gate ────────────────────────────
        sgl = str(row[8]).strip() if row[8] is not None else ""

        if sgl in EXCLUDE_SGL:
            c.sgl += 1
            continue
        elif sgl in FLAG_SGL:
            sgl_flag = FLAG_SGL[sgl]
            flag = f"{flag},{sgl_flag}".strip(",") if flag else sgl_flag
            if sgl == "V":
                c.flagged_advance += 1
            else:
                c.flagged_other_sgl += 1

        # ── Collect clean row ──────────────────────────────────────────────
        invoice_ref = str(row[14]).strip() if row[14] is not None else ""
        clean_rows.append({
            "doc_date":    _parse_date(row[6]),
            "amount":      amount,
            "invoice_ref": invoice_ref,
            "doc_type":    doc_type,
            "sgl_ind":     sgl,
            "flag":        flag,
        })

    wb.close()

    # ── Step 7: Deduplication ──────────────────────────────────────────────
    df = pd.DataFrame(clean_rows)
    if df.empty:
        report = CleaningReport(
            total_rows_input=total_input,
            rows_after_cleaning=0,
            excluded_null=c.null,
            excluded_negative=c.negative,
            excluded_noise=c.noise,
            excluded_doc_type=c.doc_type,
            excluded_sgl=c.sgl,
            flagged_advance=c.flagged_advance,
            flagged_ab=c.flagged_ab,
            flagged_other_sgl=c.flagged_other_sgl,
            duplicates_removed=0,
            split_invoices_flagged=0,
        )
        return df, report

    final_rows: List[Dict] = []
    for ref, group in df.groupby("invoice_ref"):
        if ref == "":
            # No ref — keep all (can't deduplicate)
            for _, r in group.iterrows():
                final_rows.append(r.to_dict())
            continue

        unique_amounts = group["amount"].unique()
        if len(unique_amounts) == 1:
            # Same ref + same amount → keep one, discard rest
            c.dupe += len(group) - 1
            row_dict = group.iloc[0].to_dict()
            final_rows.append(row_dict)
        else:
            # Same ref + different amounts → keep all, flag SPLIT_INVOICE
            c.split_invoices += 1
            for _, r in group.iterrows():
                row_dict = r.to_dict()
                existing_flag = row_dict.get("flag", "")
                row_dict["flag"] = (
                    f"{existing_flag},SPLIT_INVOICE".strip(",")
                    if existing_flag else "SPLIT_INVOICE"
                )
                final_rows.append(row_dict)

    clean_df = pd.DataFrame(final_rows).reset_index(drop=True)

    report = CleaningReport(
        total_rows_input=total_input,
        rows_after_cleaning=len(clean_df),
        excluded_null=c.null,
        excluded_negative=c.negative,
        excluded_noise=c.noise,
        excluded_doc_type=c.doc_type,
        excluded_sgl=c.sgl,
        flagged_advance=c.flagged_advance,
        flagged_ab=c.flagged_ab,
        flagged_other_sgl=c.flagged_other_sgl,
        duplicates_removed=c.dupe,
        split_invoices_flagged=c.split_invoices,
    )

    logger.info(
        "SAP cleaning: %d raw → %d clean | excluded: null=%d neg=%d noise=%d "
        "doctype=%d sgl=%d dupes=%d",
        total_input, len(clean_df),
        c.null, c.negative, c.noise, c.doc_type, c.sgl, c.dupe,
    )
    return clean_df, report
