# 26AS Matcher — Complete Technical & User Documentation

**TDS Reconciliation Platform for Chartered Accountants**
Version 2.3.0 | Algorithm v5.3 | Backend v2.0.0

---

## Table of Contents

**Part I — User Guide**

1. [What This App Does](#1-what-this-app-does)
2. [Getting Started](#2-getting-started)
3. [Dashboard](#3-dashboard)
4. [Running a Reconciliation](#4-running-a-reconciliation)
5. [Understanding Results](#5-understanding-results)
6. [Review & Approval Workflow](#6-review--approval-workflow)
7. [Downloading the Excel Report](#7-downloading-the-excel-report)
8. [Run History & Batch History](#8-run-history--batch-history)
9. [Administration](#9-administration)

**Part II — Algorithm & Logic**

10. [Algorithm Overview — The 7 Phases](#10-algorithm-overview--the-7-phases)
11. [Composite Scoring Engine](#11-composite-scoring-engine)
12. [Pre-Match Validation Engine](#12-pre-match-validation-engine)
13. [Exception Engine](#13-exception-engine)
14. [Data Parsing & Cleaning Pipeline](#14-data-parsing--cleaning-pipeline)
15. [Deductor Name Alignment](#15-deductor-name-alignment)

**Part III — Architecture & Design**

16. [System Architecture](#16-system-architecture)
17. [Backend Architecture](#17-backend-architecture)
18. [Frontend Architecture](#18-frontend-architecture)
19. [Database Schema](#19-database-schema)
20. [API Reference](#20-api-reference)
21. [Security Architecture](#21-security-architecture)

**Part IV — Audit, Compliance & Verification**

22. [Audit Trail System](#22-audit-trail-system)
23. [Compliance Rules & Hard Constraints](#23-compliance-rules--hard-constraints)
24. [Data Integrity Guarantees](#24-data-integrity-guarantees)
25. [Verification Checklist for Auditors](#25-verification-checklist-for-auditors)

**Part V — Reference**

26. [Match Types](#26-match-types)
27. [Confidence Levels](#27-confidence-levels)
28. [Variance Thresholds](#28-variance-thresholds)
29. [Reason Codes](#29-reason-codes)
30. [Exception Types](#30-exception-types)
31. [Glossary](#31-glossary)
32. [Troubleshooting](#32-troubleshooting)

---

# Part I — User Guide

---

## 1. What This App Does

This app automates the reconciliation of **Form 26AS** (government TDS credit statement) against a company's **SAP AR Ledger** (books of account). It verifies that every TDS credit claimed under **Section 199 of the Income Tax Act** has a corresponding invoice in the company's records.

**In plain English**: The government says "Company X deducted tax of Rs.1,50,000 on your behalf." Your books say "We invoiced Company X for Rs.1,49,775." This app matches those two numbers, flags the Rs.225 variance, and produces an audit-ready Excel report.

### Key Guarantees

| Guarantee | Implementation |
|-----------|---------------|
| **Section 199 compliance** | Books sum **never exceeds** 26AS amount — enforced as hard assert in code |
| **Invoice uniqueness** | Same invoice **never used twice** — tracked via `consumed_invoice_refs` set across all phases |
| **Count integrity** | Matched + Suggested + Unmatched = Total 26AS entries (post-validation) |
| **Full audit trail** | Every action logged to DB + disk JSONL with actor, timestamp, and metadata |
| **Reproducibility** | SHA-256 file hashes + config snapshot stored per run; same inputs → same outputs |
| **Maker-checker** | Run creator cannot approve their own run |

### What It Does NOT Do

- Does not file TDS returns — this is a reconciliation/verification tool only
- Does not connect to the Income Tax portal — requires manually downloaded 26AS Excel files
- Does not modify your SAP data — read-only processing

---

## 2. Getting Started

### 2.1 First-Time Setup

When the app is first installed, no users exist. The first person to access the app sees a **Setup** page.

1. Open `http://localhost:3000` in your browser
2. You'll be redirected to the **Setup** page
3. Fill in: Full Name, Email, Password (min 8 chars), Confirm Password
4. Click **Create Admin Account**
5. You'll be logged in automatically as an **ADMIN**

> This page only works once. After the first admin is created, new users must be added from the Admin page.

### 2.2 Logging In

1. Go to `http://localhost:3000`
2. Enter your Email and Password
3. Click **Sign In**

Session lasts 60 minutes. The app auto-refreshes your session in the background. On 401 (token expiry), the Axios interceptor queues pending requests, refreshes the token, and replays them transparently.

### 2.3 User Roles

| Role | Permissions |
|------|------------|
| **PREPARER** | Upload files, start runs, view results, download Excel reports |
| **REVIEWER** | Everything above + approve/reject runs, authorize suggested matches, review exceptions |
| **ADMIN** | Everything above + manage users, change algorithm settings, view settings history |

**Maker-Checker Rule**: A Reviewer/Admin **cannot approve their own run**. The creator must have a different person review it. This is enforced server-side.

---

## 3. Dashboard

The Dashboard is your home screen after logging in.

- **Greeting** — Personalized time-of-day message with your first name
- **Summary Cards**: Total Runs, Avg Match Rate, Pending Review, Failed
- **Recent Runs Table** — 8 most recent runs with status, match rate, deductor name (click any row to open detail)
- **Match Rate Trend** — Area chart showing match rates over last 10 finished runs
- **Quick Actions** — Buttons to start a new run, view all runs, or jump to pending reviews

---

## 4. Running a Reconciliation

Click **New Run** (Dashboard or sidebar). Two modes are available:

### 4.1 Single-Party Mode

**Step 1 — Upload Files**:
1. SAP AR Ledger (drag & drop or browse)
2. Form 26AS (drag & drop or browse)
3. Financial Year (dropdown, defaults to FY2023-24)
4. Click **Continue**

**Step 2 — Confirm Party Mapping**: The app extracts the deductor name from your SAP filename and fuzzy-matches it against 26AS deductor names using rapidfuzz `token_sort_ratio`:

| Status | Score | Meaning |
|--------|-------|---------|
| AUTO_CONFIRMED (green) | ≥95% AND 2nd candidate <80% | Correct deductor pre-selected |
| PENDING (amber) | 80–94% | Review and confirm |
| NO_MATCH (red) | <80% | Select manually from dropdown |

Click **Start Reconciliation**. Processing runs asynchronously — you see a real-time progress bar with 11 stages (Parse → Validate → Phase A → B → B.2 → C → E → B.3 → Post-Validate → Persist → Finalize). Typically 5–30 seconds.

### 4.2 Batch Mode (Multiple Parties)

Use when reconciling **multiple SAP files** (one per deductor) against a **shared 26AS file**.

**Step 1** — Upload 26AS + multiple SAP files + select FY → **Preview Mappings**

**Step 2** — (Optional) Toggle **Use Admin Defaults** or customize algorithm settings for this batch

**Step 3** — Review per-file mappings. For each SAP file:
- Review auto-detected deductor
- Click **+ Select parties** to change or add deductors
- Search by name or TAN; each deductor shows entry count

Click **Run All** to start. The frontend uses a **chunked upload pattern**:
1. `POST /api/runs/batch/init` — uploads 26AS once, gets `batch_id`
2. For each SAP file: `POST /api/runs/batch/{batch_id}/add` — uploads one SAP file + mappings
3. Progress bar shows current file, succeeded/failed counts, per-file errors

Each party runs as a separate reconciliation linked by batch ID.

> **Deductor name display**: When a party has multiple name variants in the 26AS, the app picks the **most frequent variant** as the canonical name.

### 4.3 File Requirements

**SAP AR Ledger File** — Excel (.xlsx/.xls), columns positional (headers ignored):

| Position | What It Contains | Required |
|----------|-----------------|----------|
| Column 1 (A) | Company Code | No |
| Column 2 (B) | Customer Number | No |
| Column 3 (C) | Customer Name | No |
| Column 4 (D) | Account | No |
| **Column 5 (E)** | **Clearing Document** | **Yes** |
| **Column 6 (F)** | **Document Type** (RV, DC, DR) | **Yes** |
| **Column 7 (G)** | **Document Date** | **Yes** |
| Column 8 (H) | Posting Date | No |
| **Column 9 (I)** | **Special G/L Indicator** | **Yes** |
| Column 10 (J) | Currency | No |
| **Column 11 (K)** | **Amount in Local Currency** | **Yes** |
| Column 12 (L) | Tax Amount | No |
| Column 13 (M) | Document Number | No |
| Column 14 (N) | Reference | No |
| **Column 15 (O)** | **Invoice Reference** | **Yes** |

**Important**: Use the raw SAP AR Ledger export, not a pre-processed workings file.

**Form 26AS File** — Excel (.xlsx/.xls), headers auto-detected (first 5 rows):

| Column | Accepted Header Names |
|--------|----------------------|
| Deductor Name | "Name of Deductor", "Particulars", "Deductor Name" |
| TAN | "TAN of Deductor", "TAN" |
| Amount | "Amount Paid/Credited", "Amount Credited" |
| Status | "Status of Booking" |
| Section | "Section" |
| Transaction Date | "Transaction Date", "Date of Payment/Credit" |

- Only **Status = F** (Final) rows are processed
- The **"Amount Paid/Credited"** column is used (NOT "Tax Deducted" or "TDS Deposited")
- Sheets named "tanwise" or "summary" are skipped

---

## 5. Understanding Results

After a run completes, the Run Detail page shows results across 9 tabs.

### 5.1 Summary Cards

| Card | What It Shows | Color Logic |
|------|--------------|-------------|
| **Match Rate** | % of 26AS entries auto-matched | Green ≥95%, Amber 80–94%, Red <80% |
| **Matched** | Count vs total (e.g., "15 / 20") | Navy |
| **Suggested** | Pending CA review items | Amber if pending, Green if all resolved |
| **Unmatched 26AS** | No match found at all | Red if >0, Green if 0 |
| **Violations** | Compliance constraint violations | Should always be 0 |
| **Control Total** | Balanced / Unbalanced / N/A | Green / Red / Grey |

**Key relationship**: Matched + Suggested + Unmatched = Total 26AS Entries. A red warning banner appears if this doesn't hold.

**Confidence Breakdown** bar below cards shows HIGH / MEDIUM / LOW proportional bars.

### 5.2 Matched Pairs Tab

Displays every auto-matched 26AS entry with:
- **Global search bar** — searches across all columns (26AS #, date, section, amounts, type, confidence, invoice refs)
- **Excel-style dropdown filters** — Month, Section, Type, Confidence (each with search bar + checkboxes + select all/clear)
- **Variance range slider** — dual-handle min/max slider for filtering by variance %
- **Sortable columns** — click any column header to sort asc/desc/reset (all 9 columns: 26AS #, Date, Section, 26AS Amount, Books Sum, Variance, Type, Confidence, Invoices)

Each row shows: 26AS #, Date, Section, 26AS Amount, Books Sum, Variance (color-coded), Type, Confidence badge, Invoice count.

**Expand any row** to see:
- Individual invoice details (reference, date, amount)
- Clearing document number
- **Score breakdown** — 5 factors shown as progress bars (Variance, Date Proximity, Section Match, Clearing Doc, Historical)
- Match metadata (type, confidence, cross-FY flag, prior-year flag, AI risk flag with reason)

### 5.3 Suggested Matches Tab

Matches the algorithm found but couldn't auto-approve. Categories:
- **Variance 20%+** — Requires mandatory remarks to authorize
- **Date Preference** — Invoice outside preferred date window
- **Advance Payment** — SGL_V indicator match
- **Force Match** — Last-resort match at relaxed thresholds
- **Cross-FY** — Invoice from a different financial year

Actions: Filter by category, select items, **Authorize Selected** (with remarks modal if required), **Reject Selected** (with reason). Authorized items are promoted to Matched Pairs and the match rate updates automatically.

### 5.4 Unmatched 26AS Tab

26AS entries with no match. Each row shows deductor, TAN, section, date, amount, and **reason code** (U01/U02/U04). Expandable for full detail.

### 5.5 Unmatched Books Tab

SAP invoices not consumed by any match. Shows invoice reference, clearing doc, date, type, amount, SGL flag.

### 5.6 Section Summary Tab

Aggregated by TDS section (194C, 194J, etc.) — count, total 26AS/books amounts, avg variance, confidence distribution per section, with grand totals.

### 5.7 Resolution Tracker Tab

Prioritized issue list:

| Severity | Issues |
|----------|--------|
| **Critical** (red) | Unmatched 26AS entries (potential lost TDS credit) |
| **Warning** (amber) | High variance, low confidence, force matches |
| **Info** (blue) | Top unmatched SAP books by value |

Shows total financial impact and counts by severity.

### 5.8 Methodology Tab

Explains the algorithm configuration for this specific run — 5 collapsible sections (Phase A–E + Phase D), showing match types, variance caps, phase rules, and actual statistics with volume bars showing % of matches from each phase.

### 5.9 Exceptions Tab

Auto-generated exception records requiring CA review. Each exception has severity (CRITICAL/HIGH/MEDIUM/LOW/INFO), category, description, amount, and review status. Reviewers can **Acknowledge**, **Waive**, or **Escalate** with notes.

### 5.10 Audit Trail Tab

Timeline of every action: run started/completed/failed, files uploaded (with SHA-256 hashes), review decisions, suggested match authorizations, exception reviews, Excel downloads. Each entry shows actor, role, timestamp, and notes.

---

## 6. Review & Approval Workflow

### 6.1 Run Status Flow

```
PENDING → PROCESSING → PENDING_REVIEW or APPROVED
                      ↓                    ↓
                    FAILED              REJECTED
```

Auto-approval if: no blocking exceptions AND match_rate ≥50% AND ≥1 match. INFO-severity exceptions do NOT block auto-approval.

### 6.2 Approving / Rejecting a Run

A **Reviewer/Admin** (who is NOT the run creator) can:
1. Review matched pairs, exceptions, unmatched entries
2. Click **Approve** (green) or **Reject** (red, requires notes)

> **Minimum match rate gate**: Approval blocked below **75%** match rate. Authorize suggested matches first to raise the rate.

**Other actions**: Refresh data (not a re-run), Delete (permanent, with confirmation modal), Re-run (creates new run with same files), Download Excel.

### 6.3 Authorizing Suggested Matches

1. Go to **Suggested Matches** tab
2. Select items (or "Select All Pending")
3. **Authorize Selected** — remarks required for >20% variance items
4. Or **Reject Selected** with optional reason

Authorized items are promoted to Matched Pairs. Confidence counts are recounted from all matched pairs in the database.

**From Batch History**: Click **Authorize All Suggested** to bulk-authorize across all runs in a batch.

### 6.4 Reviewing Exceptions

1. Go to **Exceptions** tab
2. Click **Review** on any unreviewed exception
3. Select: **Acknowledged** / **Waived** / **Escalated** + notes
4. Click **Submit**

---

## 7. Downloading the Excel Report

Click **Download** (top-right of run detail page). The 6-sheet Excel workbook contains:

| Sheet | Contents |
|-------|----------|
| **Summary** | Run metadata, file hashes (SHA-256), control totals, match rate, confidence breakdown, algorithm version |
| **Requires Review** | All exceptions requiring CA attention with severity, category, description |
| **Matched Pairs** | Full match detail: 26AS entry, all invoices, variance, confidence, composite score breakdown |
| **Unmatched 26AS** | Unmatched government entries with reason codes (U01/U02/U04) and best candidate info |
| **Unmatched SAP Books** | Unconsumed company invoices |
| **Variance Analysis** | Variance distribution by match type and statistical breakdown |

Filename: `TDS_Reco_[Deductor]_[FY]_RUN[Number].xlsx`

Styling: Navy headers (#1B3A5C), variance coloring (green 0–2%, yellow 2–3%, red >3%), confidence coloring (green HIGH, yellow MEDIUM, orange LOW), frozen headers, auto-column width.

For batch: **Download Combined Excel** from Batch History.

---

## 8. Run History & Batch History

### Run History

Filterable table of all runs:
- **Search** — by deductor name, TAN, or run number
- **Mode** — All / Single / Batch
- **Status** — All / Processing / Pending Review / Approved / Rejected / Failed
- **Financial Year** — filter by specific FY

### Batch History

Groups runs by batch. Each batch card shows party count, FY, status summary, aggregate match rate. Expandable for per-party breakdown, **Rerun Batch**, **Authorize All Suggested**, **Download Combined Excel**.

---

## 9. Administration

Only **ADMIN** users can access the Admin page.

### 9.1 Algorithm Settings

| Setting | Default | What It Controls |
|---------|---------|-----------------|
| Document Types Include | RV, DR | SAP doc types to include |
| Document Types Exclude | CC, BR | SAP doc types to always exclude |
| Date Hard Cutoff (days) | 90 | Maximum age difference between invoice and 26AS entry |
| Date Soft Preference (days) | 180 | Preferred date range (outside = flagged) |
| Filing Lag Tolerance (days) | 45 | Allow invoices up to N days **after** 26AS date |
| Enforce Books Before 26AS | Yes | Penalize invoices dated after 26AS date |
| Normal Variance Ceiling (%) | 3.0 | Maximum variance for standard auto-matching |
| Auto-Confirm Ceiling (%) | 20.0 | Up to this variance = auto-confirmed with audit flag |
| Suggested Variance Ceiling (%) | 20.0 | Maximum variance for suggested matches |
| Max Combo Size | 5 | Maximum invoices per combo match |
| Noise Threshold (Rs.) | 1.0 | Ignore SAP entries below this amount |
| Force Match Enabled | Yes | Whether Phase C runs |
| Date Clustering | Yes | Prefer date-proximate invoices in combos |
| Exclude Advances (SGL_V) | Yes | Exclude advance payments from main matching |
| Allow Cross-FY | No | Allow matching across financial years |
| Cross-FY Lookback (years) | 1 | Prior years to include |

**Validation**: Non-negative numbers, percentages ≤100%, lookback ≤5 years. Validated in browser + server.

**History pattern**: Each change creates a new version. Previous versions are retained for audit.

### 9.2 User Management

Admins can create users with Full Name, Email, Password, and Role (PREPARER/REVIEWER/ADMIN). Users table shows all registered users with roles.

---

# Part II — Algorithm & Logic

---

## 10. Algorithm Overview — The 7 Phases

The algorithm processes every 26AS entry through sequential phases. Once matched in any phase, an entry doesn't proceed to later phases.

### Phase A — Clearing Group Matching

**Logic**: Groups SAP invoices by clearing document number. If a group of 2–5 invoices sums within 3% of a 26AS amount, it's a CLR_GROUP match.

**Proxy Groups Fallback**: When clearing documents are sparse (<10% of entries matched), the algorithm falls back to **date-clustered proxy groups** — books with the same `doc_date` that sum close to a 26AS amount form a pseudo-group.

**Constraints**:
- Group size: 2–5 invoices (enforced by MAX_COMBO_SIZE)
- Variance: ≤3% (VARIANCE_CAP_CLR_GROUP)
- Groups >5 invoices: excluded entirely

**Example**: 26AS = Rs.5,00,000. Books have 3 invoices (Rs.2,00,000 + Rs.1,50,000 + Rs.1,45,000 = Rs.4,95,000) under the same clearing document → CLR_GROUP_3, 1% variance.

### Phase B — Bipartite Single + Smart Combo

**Logic**: Mathematical optimization using scipy `linear_sum_assignment` (polynomial O(n^3)) to find the globally best set of 1:1 matches, then smart combo enumeration for multi-invoice matches.

**Tier 1 — Single matches**:
1. Build cost matrix: EXACT (within Rs.0.01) and SINGLE candidates (≤2% variance)
2. Run scipy bipartite matching for global optimum
3. Fallback to score-descending greedy if scipy unavailable

**Tier 2 — Combo matches** (for unmatched entries from Tier 1):
1. Date-clustered greedy accumulation (prefers date-proximate books)
2. Subset-sum DP for exact matching
3. Per-size combo budget: 50 iterations max per size level
4. Combo pool cap: max 50 books per candidate
5. Total iteration budget: 50,000 per entry
6. 30-second hard timeout

**Variance caps**: SINGLE ≤2%, COMBO_2 ≤2%, COMBO_3–5 ≤3%

**Auto-confirm ceiling**: Matches up to 20% variance are auto-confirmed with an audit flag (moved to Matched Pairs, not Suggested).

### Phase B.2 — Relaxed Individual Matching

**Logic**: Retries unmatched entries from Phase B with relaxed parameters.

| Parameter | Phase B | Phase B.2 |
|-----------|---------|-----------|
| Date hard cutoff | 90 days | 180 days |
| Date soft preference | 180 days | 365 days |
| Enforce books before 26AS | Yes | No |

Catches near-misses that Phase B's strict date criteria missed. All matches tagged with `alert_message` for audit trail.

### Phase C — Force Matching

**Logic**: Last-resort matching for entries that failed Phases A, B, and B.2. All results go to **Suggested** (require CA review).

| Variant | Max Invoices | Max Variance | Confidence |
|---------|-------------|-------------|------------|
| FORCE_SINGLE | 1 | 5% (hard cap) | LOW |
| FORCE_COMBO | 3 | 2% (hard cap) | LOW |

**Invoice reuse prevention**: Phase C processes entries **sequentially**. After each match, consumed books are removed from the pool before the next entry. Same invoice can never back two force matches.

**Duplicate guard**: If the same SAP row appears twice in a match result (greedy/DP overlap), it's deduplicated before creation.

### Phase E — Prior-Year Exception

**Logic**: Only runs when `ALLOW_CROSS_FY=False` (default). Tries remaining unmatched entries against invoices from the previous financial year using Phase B logic.

All results: `.suggested=True`, `category=CROSS_FY`, `confidence=LOW`.

**FY Boundary Zone**: If the 26AS date is within 60 days of the FY boundary (March 31 / April 1), confidence upgrades to **MEDIUM** — transactions near FY boundaries often legitimately cross years.

### Phase B.3 — Advance TDS Matching

**Logic**: Tries remaining unmatched entries against **advance payment books** (SGL_V indicator). Only runs when `exclude_sgl_v=True` AND unmatched entries remain AND advance books exist.

All results: `.suggested=True`, `category=ADVANCE_PAYMENT`, `confidence=LOW`.

### Phase D — Truly Unmatched

Any 26AS entry not matched in Phases A–B.3. Assigned reason codes:

| Code | Meaning |
|------|---------|
| U01 | No candidate found at any threshold |
| U02 | Candidates exist but all consumed by other matches |
| U04 | Below noise threshold (< Rs.1) |

### Cancellation Support

Users can cancel a running reconciliation. The `cancel_check()` callable is tested at each phase boundary. Raises `CancelledException` to stop processing cleanly.

---

## 11. Composite Scoring Engine

**File**: `backend/engine/scorer.py`

Every match candidate is ranked by a 5-factor composite score (0–100):

```
Total = 30% × Variance Score
      + 20% × Date Proximity Score
      + 20% × Section Match Score
      + 20% × Clearing Doc Score
      + 10% × Historical Score
```

### Factor 1: Variance Score (0–30 points)

| Variance | Raw Score | Weighted |
|----------|-----------|----------|
| 0% | 100 | 30.0 |
| 1% | 90 | 27.0 |
| 2% | 75 | 22.5 |
| 3% | 55 | 16.5 |
| 5% | 20 | 6.0 |
| 10% | 10 | 3.0 |
| 20% | 2 | 0.6 |
| >20% | 1 | 0.3 |

### Factor 2: Date Proximity Score (0–20 points)

| Date Gap | Raw Score | Weighted |
|----------|-----------|----------|
| ≤30 days | 100 | 20.0 |
| 30–90 days | Linear decay to 60 | 12.0 |
| 90–180 days | Decay to 20 | 4.0 |
| >180 days | 5 | 1.0 |
| Books after 26AS (enforce=True) | 5 | 1.0 |
| No date info | 50 (neutral) | 10.0 |

### Factor 3: Section Match Score (0–20 points)

| Condition | Raw Score | Weighted |
|-----------|-----------|----------|
| All invoices match 26AS section | 100 | 20.0 |
| Partial match | Proportional | Variable |
| High-confidence section (194C, 194J, 194H, 194I, 194A) | 60 | 12.0 |
| No section info | 50 (neutral) | 10.0 |

### Factor 4: Clearing Doc Score (0–20 points)

| Condition | Raw Score | Weighted |
|-----------|-----------|----------|
| Clearing doc present + non-empty | 100 | 20.0 |
| No clearing doc | 20 | 4.0 |

### Factor 5: Historical Score (0–10 points)

Fixed neutral default: 50 → 5.0 points. Can be enhanced with historical pattern data from prior runs.

---

## 12. Pre-Match Validation Engine

**File**: `backend/engine/validator.py`

Six validators run before matching begins:

### Validator 1: PAN Validation

- Format check: `[A-Z]{5}[0-9]{4}[A-Z]`
- Detects Section 206AA (PAN non-available, implied 20% rate)
- Flags: `PAN_ISSUE` (HIGH severity)

### Validator 2: 26AS Duplicate Detection

- Signature: `(tan, section, date, amount, tds_amount)`
- First occurrence: kept
- Duplicates: flagged as `DUPLICATE_26AS`, marked invalid (excluded from algorithm)
- Severity: HIGH

### Validator 3: Section Validation

- Checks against known TDS sections: 192, 192A, 193, 194, 194A, 194B, 194C, 194D, 194DA, 194H, 194I, 194IA, 194J, 194K, 194N, 194O, 194Q, 194R, 194S, 195, 196A, 196B, 196C, 196D, 206AA, 206AB
- Unknown sections: flagged MEDIUM severity

### Validator 4: TDS Rate Validation

- Computes `derived_gross = TDS / expected_rate × 100`
- Compares against reported gross amount
- Tolerance: 2%
- If deviation >2%: flags `RATE_MISMATCH`
- If implied rate ≥19%: detects 206AA scenario

### Validator 5: Control Totals Verification

- Post-match check: `total_26as_amount ≈ matched_amount + unmatched_26as_amount`
- Tolerance: Rs.0.02 (floating-point safety margin)

### Validator 6: Negative / Invalid Entry Flagging

- Negative amounts → REVERSAL flag
- Zero amounts → rejected
- Null amounts → rejected (CRITICAL)

**Output**: `ValidationReport` containing issue list, counts (total_rows, valid_rows, rejected_rows), control total status, and blocking-error flag.

---

## 13. Exception Engine

**File**: `backend/engine/exception_engine.py`

Automatically generates exception records after matching completes:

| Exception Type | Trigger | Severity | Blocks Auto-Approval? |
|---------------|---------|----------|----------------------|
| FORCE_MATCH | FORCE_SINGLE or FORCE_COMBO match | HIGH | Yes |
| HIGH_VARIANCE | Variance 3–20%, auto-confirmed | INFO | **No** (audit trail only) |
| HIGH_VARIANCE | Variance >20%, suggested | MEDIUM | Yes |
| CROSS_FY | Prior-year or cross-FY match | HIGH | Yes |
| AI_RISK_FLAG | Auto-confirmed with risk indicators | MEDIUM | Yes |
| RATE_MISMATCH | From validation report | MEDIUM | Yes |
| PAN_ISSUE | Section 206AA indicator | HIGH | Yes |
| DUPLICATE_26AS | From validation report | HIGH | Yes |
| UNMATCHED_HIGH_VALUE | Unmatched 26AS entry > Rs.10 lakh | CRITICAL | Yes |

**Auto-approval logic**: A run is auto-approved if:
1. No exceptions with severity ≥ MEDIUM
2. Match rate ≥ 50%
3. At least 1 matched pair

Otherwise → PENDING_REVIEW.

---

## 14. Data Parsing & Cleaning Pipeline

### 14.1 SAP AR Ledger Cleaning

**File**: `backend/services/reconcile_service.py` (clean_sap_books function)

Columns are **positional** (0-indexed): col[4]=ClearingDoc, col[5]=DocType, col[6]=DocDate, col[8]=SGL, col[10]=Amount, col[14]=InvoiceRef.

**Pipeline**:

1. **Null/Negative Filter** — Exclude null or ≤0 amounts
2. **Noise Filter** — Exclude amounts < Rs.1 (configurable via `NOISE_THRESHOLD`)
3. **Document Type Gate**:
   - Include: RV, DR (configurable)
   - Exclude: CC, BR (configurable)
   - Fallback: if no primary doc types found in data, use all (with flag)
4. **Special G/L Gate**:
   - Exclude: L (loan), E (liability), U (unbilled)
   - Flag: V=SGL_V (advance), O/A/N=other (kept but flagged)
5. **Date Window Filter** — Exclude if doc_date outside FY range (current FY + SAP_LOOKBACK_YEARS prior)
6. **Deduplication**:
   - Group by (invoice_ref, clearing_doc, amount)
   - Same invoice + same clearing_doc + same amount = true duplicate → remove
   - Same invoice + different clearing_doc = separate payment event → keep both
7. **SAP FY Tagging** — Computes FY label from doc_date for each entry

**Output**: `clean_df` (main pool) + `sgl_v_df` (advance payments, separate pool for Phase B.3)

### 14.2 Form 26AS Parsing

**File**: `backend/parser_26as.py`

- Searches first 5 rows for header row
- Header matching via regex (flexible naming):
  - "Amount Paid/Credited" → `amount` (NOT "Tax Deducted")
  - "Name of Deductor" → `deductor_name`
  - "TAN of Deductor" → `tan`
  - "Status of Booking" → `status`
- Filters: Status=F (Final) only
- Skips sheets named "tanwise" or "summary"
- Date parsing: handles dd-Mon-YYYY, YYYY-MM-DD, dd/mm/yyyy formats
- Output: normalized pandas DataFrame

---

## 15. Deductor Name Alignment

**Logic**: Fuzzy-match SAP filename against 26AS deductor names using rapidfuzz.

1. **Extract identity** from SAP filename:
   - Strip extension → replace underscores/hyphens with spaces → normalize (uppercase, trim)
   - Example: `BHUSHAN_POWER_&_STEEL_LIMITED.XLSX` → `BHUSHAN POWER & STEEL LIMITED`

2. **Score candidates** via `token_sort_ratio`:
   - Build candidates from unique (deductor_name, TAN) pairs in 26AS
   - Score each candidate against identity string

3. **Classify**:
   - ≥95% AND 2nd candidate <80% → AUTO_CONFIRMED
   - 80–94% → PENDING (user confirms)
   - <80% → NO_MATCH (user searches manually)

---

# Part III — Architecture & Design

---

## 16. System Architecture

```
┌─────────────────────┐     HTTP/JSON     ┌──────────────────────┐
│     React SPA       │ ◄──────────────── │   FastAPI Backend    │
│  (Vite, port 3000)  │ ────────────────► │   (port 8000)        │
│                     │     /api proxy    │                      │
│  React 19           │                   │  SQLAlchemy 2.0      │
│  TypeScript         │                   │  (async)             │
│  Tailwind CSS 4     │                   │                      │
│  TanStack Query     │                   │  ┌────────────────┐  │
│  React Router       │                   │  │  SQLite (dev)   │  │
│  Radix UI           │                   │  │  PostgreSQL     │  │
└─────────────────────┘                   │  │  (prod)         │  │
                                          │  └────────────────┘  │
                                          │                      │
                                          │  ┌────────────────┐  │
                                          │  │  Audit JSONL    │  │
                                          │  │  (disk)         │  │
                                          │  └────────────────┘  │
                                          └──────────────────────┘
```

**Key design decisions**:
- **Async-only**: FastAPI with async/await, AsyncSessionLocal, no sync DB calls in routes
- **Background processing**: `asyncio.create_task` for long-running reconciliations (returns 202 immediately)
- **Polling for progress**: Frontend polls `/api/runs/{id}/progress` every 800ms (in-memory progress store)
- **Dual-sink audit**: Every event logged to DB (queryable) AND disk JSONL (tamper-evident)
- **File hashing**: SHA-256 for reproducibility (same input → same output)
- **Positional column extraction**: SAP columns indexed (not header-based) for robustness across different SAP export formats

---

## 17. Backend Architecture

```
backend/
├── main_v2.py              # FastAPI app entry + lifespan + middleware
├── config.py               # Algorithm constants (single source of truth)
├── parser_26as.py           # 26AS Excel parser (auto-header detection)
├── core/
│   ├── settings.py          # Env-based config via pydantic-settings (.env)
│   ├── security.py          # JWT + bcrypt + API keys + SHA-256
│   ├── audit.py             # Dual-sink audit (DB + JSONL)
│   └── deps.py              # FastAPI dependency injection (auth guards)
├── db/
│   ├── base.py              # Async engine, session factory, auto-migration
│   └── models.py            # SQLAlchemy models (11 tables)
├── engine/
│   ├── optimizer.py         # Core algorithm: scipy bipartite + combo matching
│   ├── validator.py         # 6 pre-match validators
│   ├── scorer.py            # 5-factor composite scoring
│   └── exception_engine.py  # Auto-exception generation
├── services/
│   ├── reconcile_service.py # Full pipeline orchestrator (8 stages)
│   ├── excel_v2.py          # 6-sheet Excel output with audit metadata
│   └── progress_store.py    # In-memory real-time progress tracking
├── api/routes/
│   ├── auth.py              # Login, register, token refresh, API keys
│   ├── runs.py              # CRUD + async processing + review workflow
│   └── settings.py          # Admin algorithm configuration
└── tests/
    ├── test_optimizer.py
    ├── test_validator.py
    ├── test_scorer.py
    └── test_exception_engine.py
```

### Startup Sequence (main_v2.py lifespan)

1. Validate `SECRET_KEY` (blocks non-dev environments from using default)
2. Create all database tables via SQLAlchemy
3. Run `auto_migrate()` — adds missing columns without destructive changes
4. Enable WAL mode for SQLite (improves concurrency)
5. Clean orphaned PROCESSING runs from previous crashes → mark FAILED
6. One-time recount of matched_count / match_rate_pct (data healing)

### Middleware Stack

- CORS (origins: localhost:3000, localhost:5173)
- Structured logging via structlog (JSON in prod, colored console in dev)
- Trusted host middleware

### Pipeline Orchestrator (reconcile_service.py) — 8 Stages

| Stage | What It Does |
|-------|-------------|
| 1. File Intake | SHA-256 hashing, atomic run counter increment, create run record |
| 2. SAP Cleaning | Positional column extraction, filtering, dedup, SGL_V separation |
| 3. 26AS Parsing | Auto-header detection, Status=F filter, deductor alignment |
| 4. Validation | 6 validators: PAN, duplicates, section, rate, control totals, negatives |
| 5. FY Segregation | Split books into current_books vs prior_books by FY |
| 6. Optimizer | Run 7-phase matching algorithm |
| 7. Persistence | Save matched pairs, suggested matches, unmatched entries to DB |
| 8. Exceptions | Generate exception records, compute summary, set final status |

### Progress Store

In-memory dict (thread-safe) tracking real-time progress with 11 weighted stages:

| Stage | Weight |
|-------|--------|
| PARSING | 5% |
| VALIDATING | 5% |
| PHASE_A | 10% |
| PHASE_B_SINGLE | 25% |
| PHASE_B_COMBO | 15% |
| PHASE_C | 15% |
| PHASE_E | 5% |
| POST_VALIDATE | 2% |
| PERSISTING | 8% |
| EXCEPTIONS | 3% |
| FINALIZING | 7% |

Supports cancellation: `request_cancel(run_id)` → checked at each phase boundary.

---

## 18. Frontend Architecture

```
frontend/src/
├── App.tsx              # Routes + guards (PrivateRoute, AdminRoute, GuestRoute)
├── index.css            # Tailwind CSS 4 + custom scrollbar + Radix animations
├── main.tsx             # Vite entry point
├── lib/
│   ├── api.ts           # Axios client, 70+ API endpoints, type definitions
│   ├── auth.tsx         # AuthContext, JWT storage (localStorage), hooks
│   └── utils.ts         # cn(), formatDate/Currency/Pct, badge color helpers
├── components/
│   ├── layout/AppLayout.tsx  # Responsive sidebar + header
│   ├── ui/                   # Card, Badge, Spinner, Toast, Table
│   ├── RunProgressPanel.tsx  # Real-time 11-stage pipeline visualization
│   ├── SectionSummaryTab.tsx
│   ├── MismatchTrackerTab.tsx
│   ├── MatchingMethodologyPanel.tsx
│   └── SuggestedMatchesTab.tsx
└── pages/
    ├── LoginPage.tsx / SetupPage.tsx
    ├── DashboardPage.tsx     # Stats, chart, recent runs
    ├── NewRunPage.tsx        # Single/Batch upload with chunked flow
    ├── RunDetailPage.tsx     # 9-tab result viewer with filters/sort
    ├── RunHistoryPage.tsx    # Filterable run list with batch grouping
    └── AdminPage.tsx         # Settings + user management
```

### State Management

| Concern | Solution |
|---------|----------|
| Auth | React Context (AuthContext) → localStorage JWT tokens |
| Data fetching | TanStack Query (useQuery/useMutation) with 30s staleTime, 1 retry |
| Local UI state | useState for modals, filters, selections, form inputs |
| Side effects | useEffect for polling (RunProgressPanel at 800ms), query invalidation on mutation success |

### API Client (lib/api.ts)

- Axios instance with 300s timeout
- Request interceptor: attaches JWT Bearer token
- Response interceptor: on 401, queues pending requests, refreshes token via `/api/auth/refresh`, replays queue
- All endpoints organized under `runsApi`, `authApi`, `settingsApi`, `miscApi`

### Key Type Definitions

```typescript
RunStatus = 'PROCESSING' | 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'FAILED'
ConfidenceTier = 'HIGH' | 'MEDIUM' | 'LOW'
Role = 'ADMIN' | 'REVIEWER' | 'PREPARER'
```

### Design System

- **Color**: Primary navy (#1B3A5C), sidebar (#152E4D), status colors (emerald/amber/red)
- **Layout**: Tailwind CSS 4, max-w-7xl container, responsive 4→2→1 column grids
- **Components**: Radix UI primitives (Tabs, Dialog), Recharts for charts
- **Responsive**: Sidebar hidden <1024px (hamburger overlay), touch-friendly 44px min heights

### Vite Configuration

- Dev server: port 3000
- API proxy: `/api` → `http://localhost:8000` (avoids CORS in dev)
- Plugins: React, Tailwind CSS

---

## 19. Database Schema

11 tables in a normalized relational schema. SQLite (dev) with WAL mode / PostgreSQL (prod).

### 19.1 Core Tables

**users** — User accounts
| Column | Type | Notes |
|--------|------|-------|
| id | UUID (PK) | |
| email | String (unique) | Login identifier |
| hashed_password | String | bcrypt hash |
| full_name | String | Display name |
| role | Enum | ADMIN / REVIEWER / PREPARER |
| is_active | Boolean | Soft delete |
| last_login | DateTime | |
| created_at | DateTime | Auto |

**api_keys** — API key authentication
| Column | Type | Notes |
|--------|------|-------|
| id | UUID (PK) | |
| user_id | FK → users | |
| key_hash | String | SHA-256 of raw key |
| label | String | User-defined name |
| expires_at | DateTime | Optional TTL |
| is_active | Boolean | Revocable |

**run_counter** — Atomic monotonic run number (single row, id=1)

### 19.2 Run Tables

**reconciliation_runs** — Master record for each reconciliation

| Category | Columns |
|----------|---------|
| Identity | id (UUID), run_number (sequential), financial_year, deductor_name, tan |
| Files | sap_filename, as26_filename, sap_file_hash, as26_file_hash, sap_file_blob, as26_file_blob, output_hash |
| Versioning | algorithm_version, config_snapshot (JSON), run_config (JSON) |
| Status | status (PENDING→PROCESSING→PENDING_REVIEW/APPROVED/REJECTED/FAILED), mode (SINGLE/BATCH), batch_id |
| Results | total_26as_entries, total_sap_entries, matched_count, unmatched_26as_count, unmatched_books_count, suggested_count |
| Metrics | match_rate_pct, high/medium/low_confidence_count, constraint_violations |
| Financials | total_26as_amount, matched_amount, unmatched_26as_amount, control_total_balanced |
| Flags | has_pan_issues, has_rate_mismatches, has_section_mismatches, has_duplicate_26as |
| Validation | validation_errors (JSON) |
| Review | reviewed_by_id (FK), reviewed_at, review_notes |
| Timestamps | created_by_id (FK), started_at, completed_at, created_at, error_message |

**matched_pairs** — Successful 26AS ↔ SAP matches

| Category | Columns |
|----------|---------|
| 26AS side | as26_row_hash (SHA-256), as26_index, as26_amount, as26_tds_amount, as26_date, section, tan, deductor_name |
| Books side | invoice_refs (JSON array), invoice_amounts (JSON array), invoice_dates (JSON array), clearing_doc, books_sum |
| Quality | match_type, variance_amt, variance_pct, confidence, composite_score |
| Score breakdown | score_variance, score_date_proximity, score_section_match, score_clearing_doc, score_historical |
| Flags | cross_fy, is_prior_year, ai_risk_flag, ai_risk_reason, remark, alert_message |
| Extras | alternative_matches (JSON: top 3 candidates), derived_gross, rate_mismatch |
| **Unique** | **(run_id, as26_row_hash)** |

**suggested_matches** — High-variance / force matches pending CA authorization

Same fields as matched_pairs plus:
| Column | Purpose |
|--------|---------|
| category | HIGH_VARIANCE_3_20, HIGH_VARIANCE_20_PLUS, DATE_SOFT_PREFERENCE, ADVANCE_PAYMENT, FORCE, CROSS_FY |
| requires_remarks | Boolean (mandatory for >20% variance) |
| authorized / rejected | Boolean |
| authorized_by_id / rejected_by_id | FK → users |
| remarks / rejection_reason | Text |

**unmatched_26as** — Unmatched government entries
| Column | Notes |
|--------|-------|
| as26_row_hash | SHA-256, unique per run |
| deductor_name, tan, transaction_date, amount, tds_amount, section | Source data |
| reason_code | U01 / U02 / U04 |
| reason_detail | Descriptive text |
| best_candidate_invoice, best_candidate_variance_pct | Closest miss info |

**unmatched_books** — Unconsumed SAP entries
| Column | Notes |
|--------|-------|
| invoice_ref, amount, doc_date, doc_type, clearing_doc, flag, sap_fy | Source data |

**exception_records** — Flagged items requiring CA review
| Column | Notes |
|--------|-------|
| exception_type | FORCE_MATCH, HIGH_VARIANCE, CROSS_FY, etc. |
| severity | CRITICAL / HIGH / MEDIUM / LOW / INFO |
| description, amount, section | Context |
| matched_pair_id / unmatched_26as_id | FK (optional) |
| reviewed, reviewed_by_id, reviewed_at | Review workflow |
| review_action | ACCEPTED / REJECTED / ESCALATED |
| review_notes | Free text |

**audit_logs** — Immutable event trail (never updated, only inserted)
| Column | Notes |
|--------|-------|
| run_id, user_id | FK (optional) |
| event_type | RUN_STARTED, REVIEW_APPROVED, etc. |
| description | Human-readable |
| event_metadata | JSON (arbitrary context) |
| ip_address, user_agent | HTTP context |
| created_at | Timestamp |

**admin_settings** — Singleton-with-history (only one row has is_active=True)
| Column | Notes |
|--------|-------|
| All algorithm parameters | See Section 9.1 |
| is_active | True for current, False for historical |
| updated_by_id | FK → users |
| created_at, updated_at | Timestamps |

### 19.3 Auto-Migration

On every startup, `auto_migrate()` compares SQLAlchemy models vs live DB schema:
- Adds missing columns (safe, non-destructive)
- Creates missing unique indices
- Cleans duplicate rows before creating unique constraints
- Never drops columns or tables

---

## 20. API Reference

### 20.1 Authentication (`/api/auth`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/register` | ADMIN | Create new user (name, email, password, role) |
| POST | `/login` | None | Email + password → JWT access + refresh tokens |
| POST | `/refresh` | None | Refresh token → new access token |
| GET | `/me` | Bearer | Current user profile |
| POST | `/api-keys` | Bearer | Create API key (returns raw key once) |
| GET | `/api-keys` | Bearer | List user's API keys (hashed only) |
| DELETE | `/api-keys/{id}` | Bearer | Revoke API key |

### 20.2 Runs (`/api/runs`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/` | Preparer+ | Upload SAP + 26AS, start async reconciliation (202) |
| GET | `/` | Preparer+ | List all runs (filter by status, FY, deductor) |
| GET | `/{id}` | Preparer+ | Run detail with result summary |
| GET | `/{id}/progress` | Preparer+ | Real-time progress (poll every 800ms) |
| GET | `/{id}/matched` | Preparer+ | Matched pairs with score breakdown |
| GET | `/{id}/unmatched-26as` | Preparer+ | Unmatched government entries |
| GET | `/{id}/unmatched-books` | Preparer+ | Unmatched SAP invoices |
| GET | `/{id}/exceptions` | Preparer+ | Exception records |
| GET | `/{id}/audit` | Preparer+ | Audit trail events |
| GET | `/{id}/suggested` | Preparer+ | Suggested matches |
| GET | `/{id}/suggested/summary` | Preparer+ | Category counts |
| GET | `/{id}/excel` | Preparer+ | Download 6-sheet Excel workbook |
| POST | `/{id}/review` | Reviewer+ | Approve/reject run (maker-checker enforced) |
| POST | `/{id}/cancel` | Preparer+ | Request cancellation |
| POST | `/{id}/replay` | Preparer+ | Re-run with stored files |
| DELETE | `/{id}` | Preparer+ | Delete run + all related data |
| POST | `/{id}/exceptions/{exc_id}/review` | Reviewer+ | Review exception (ACK/WAIVE/ESCALATE) |
| POST | `/{id}/suggested/authorize` | Reviewer+ | Bulk-authorize suggested matches |
| POST | `/{id}/suggested/reject` | Reviewer+ | Bulk-reject suggested matches |

### 20.3 Batch (`/api/runs/batch`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/init` | Preparer+ | Upload 26AS, get batch_id |
| POST | `/{batch_id}/add` | Preparer+ | Upload one SAP file + mappings |
| POST | `/{batch_id}/rerun` | Preparer+ | Re-run all parties in batch |
| POST | `/{batch_id}/authorize-all` | Reviewer+ | Bulk-authorize all suggested |
| GET | `/{batch_id}/combined-excel` | Preparer+ | Combined workbook |

### 20.4 Settings (`/api/settings`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/` | Preparer+ | Get active algorithm settings |
| PUT | `/` | ADMIN | Update settings (creates new version) |
| GET | `/history` | ADMIN | Last 20 settings revisions |

### 20.5 Misc

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/health` | None | App version, algorithm version, environment |
| GET | `/api/financial-years` | Preparer+ | Supported FY list + default |

---

## 21. Security Architecture

### 21.1 Authentication

| Mechanism | Implementation |
|-----------|---------------|
| Password hashing | bcrypt (auto-salted) |
| JWT access token | HS256, 60-minute expiry, contains `sub` (user_id), `role`, `type: "access"` |
| JWT refresh token | HS256, 7-day expiry, `type: "refresh"` |
| API keys | Format: `reco_<48 alphanumeric>`, stored as SHA-256 hash, raw key shown once |
| Secret key | `SECRET_KEY` env var; startup blocks non-dev environments from using default |

### 21.2 Authorization (RBAC)

| Guard | Allows |
|-------|--------|
| `get_current_user()` | Any authenticated user (JWT or API key) |
| `require_preparer()` | PREPARER, REVIEWER, ADMIN |
| `require_reviewer()` | REVIEWER, ADMIN |
| `require_admin()` | ADMIN only |

Auth chain: Bearer token → API key header (`X-API-Key`) → 401.

### 21.3 Data Security

| Measure | Implementation |
|---------|---------------|
| File integrity | SHA-256 hash computed on upload, stored per run, verified on replay |
| Password storage | bcrypt (never plain text) |
| Token storage | Frontend: localStorage (client-side); Backend: stateless JWT |
| CORS | Restricted to configured origins (localhost:3000, localhost:5173) |
| Input validation | Pydantic models on all API endpoints; admin settings validated client + server |
| SQL injection | SQLAlchemy ORM parameterized queries (no raw SQL with user input) |

---

# Part IV — Audit, Compliance & Verification

---

## 22. Audit Trail System

### 22.1 Dual-Sink Architecture

Every auditable event is written to **two independent sinks**:

| Sink | Location | Format | Tamper Resistance |
|------|----------|--------|-------------------|
| **Database** | `audit_logs` table | Structured rows (queryable) | Insert-only (no UPDATE/DELETE in application) |
| **Disk** | `backend/audit_logs/{date}.jsonl` | Append-only JSON lines | One file per day, append-only |

Both sinks are written atomically per event. If one fails, the other still records.

### 22.2 Audited Events

| Event Type | When | What's Recorded |
|------------|------|-----------------|
| RUN_STARTED | Run begins processing | Run ID, user, files, FY |
| RUN_COMPLETED | Run finishes successfully | Match rate, counts, duration |
| RUN_FAILED | Run encounters error | Error message, stack trace |
| FILE_UPLOADED | Files uploaded | Filename, SHA-256 hash, size |
| ALIGNMENT_CONFIRMED | Deductor mapping confirmed | Mapping details, fuzzy score |
| REVIEW_APPROVED | Run approved by reviewer | Reviewer ID, notes |
| REVIEW_REJECTED | Run rejected by reviewer | Reviewer ID, rejection reason |
| EXCEPTION_REVIEWED | Exception reviewed | Action (ACK/WAIVE/ESCALATE), notes |
| SUGGESTED_AUTHORIZED | Suggested match authorized | Match IDs, remarks |
| SUGGESTED_REJECTED | Suggested match rejected | Match IDs, reason |
| EXPORT_DOWNLOADED | Excel downloaded | User, timestamp |
| SETTINGS_UPDATED | Admin changes algorithm settings | Old values, new values, changed_by |
| USER_LOGIN | User logs in | Email, IP address |
| USER_CREATED | New user created | Creator, new user role |

### 22.3 Audit Metadata Per Run

Each run stores:
- **sap_file_hash** / **as26_file_hash** — SHA-256 of uploaded files (proves which files were used)
- **config_snapshot** — JSON dump of all algorithm constants at run time (proves which parameters were used)
- **algorithm_version** — Engine version string (e.g., "v5.1")
- **output_hash** — SHA-256 of generated Excel (proves report integrity)
- **created_by_id** / **reviewed_by_id** — Maker and checker identification

---

## 23. Compliance Rules & Hard Constraints

These rules are enforced in code and **cannot be bypassed** through the UI or API:

### Rule 1: Section 199 — Books Sum ≤ 26AS Amount

**Where enforced**: `optimizer.py` (match creation) + `reconcile_service.py` (DB insert) + post-run validation

**How verified**: Every matched pair is checked: `books_sum ≤ as26_amount`. If violated, the match is rejected and the entry goes to Phase D (unmatched).

### Rule 2: Invoice Uniqueness

**Where enforced**: `optimizer.py` via `consumed_invoice_refs` set (global across all phases)

**How it works**: Before any match is finalized, each invoice reference is checked against the consumed set. If already consumed, the match is rejected. Phase C processes sequentially (not parallel) to prevent race conditions.

### Rule 3: Combo Size Cap

**Where enforced**: `config.py` (MAX_COMBO_SIZE=5), checked in Phase A (CLR_GROUP), Phase B (COMBO), Phase C (FORCE_COMBO limited to 3)

### Rule 4: FY Boundary Control

**Where enforced**: `config.py` (ALLOW_CROSS_FY=False default), `optimizer.py` (Phase E separation)

When ALLOW_CROSS_FY=False, prior-FY books are held in a separate pool and only tried in Phase E (tagged PRIOR_YEAR_EXCEPTION).

### Rule 5: Count Integrity

**Where enforced**: Post-run validation in `reconcile_service.py`

Check: `matched_count + suggested_count + unmatched_26as_count = total_26as_entries` (post-validation, excluding rejected entries)

### Rule 6: Variance Caps

| Phase | Match Type | Hard Cap |
|-------|-----------|----------|
| A | CLR_GROUP | 3% |
| B | SINGLE | 2% |
| B | COMBO_2 | 2% |
| B | COMBO_3–5 | 3% |
| C | FORCE_SINGLE | 5% |
| C | FORCE_COMBO | 2% |

### Rule 7: Maker-Checker

**Where enforced**: `runs.py` review endpoint — `run.created_by_id != current_user.id` check

### Rule 8: Minimum Approval Gate

**Where enforced**: `runs.py` review endpoint — `match_rate_pct >= 75` check

---

## 24. Data Integrity Guarantees

### 24.1 File Integrity

| Guarantee | Mechanism |
|-----------|-----------|
| Files are not tampered with after upload | SHA-256 hash computed immediately on upload, stored in `sap_file_hash` / `as26_file_hash` |
| Same files produce same results | Config snapshot stored per run; deterministic algorithm (no random elements) |
| Files can be replayed | `sap_file_blob` / `as26_file_blob` store original file bytes for re-run |
| Excel output is verifiable | `output_hash` stores SHA-256 of generated Excel |

### 24.2 Database Integrity

| Guarantee | Mechanism |
|-----------|-----------|
| No duplicate matches per run | UNIQUE constraint on `(run_id, as26_row_hash)` |
| No orphaned records | Foreign keys with cascading deletes on run deletion |
| Audit trail is immutable | `audit_logs` table: insert-only (application never issues UPDATE/DELETE) |
| Settings history preserved | Singleton-with-history pattern: each change creates new row |
| Run counter is atomic | Single-row `run_counter` table with atomic increment |

### 24.3 Hash Computation

The `as26_row_hash` for each matched pair uses:
```
SHA-256(f"{as26_index}|{as26_amount}|{as26_date}|{as26_section}")[:16]
```

The `as26_index` makes each hash unique even when two 26AS entries have identical amount+date+section.

### 24.4 Auto-Migration Safety

On startup, `auto_migrate()`:
- **Only adds** columns — never drops or renames
- Cleans duplicate rows before creating unique constraints
- Creates missing indices
- All operations are idempotent (safe to run multiple times)

---

## 25. Verification Checklist for Auditors

### 25.1 Verify Algorithm Compliance

| Check | How to Verify |
|-------|---------------|
| Section 199 (books ≤ 26AS) | Download Excel → Matched Pairs sheet → verify every row: Books Sum ≤ 26AS Amount |
| Invoice uniqueness | Download Excel → Matched Pairs sheet → collect all Invoice Refs → check for duplicates across rows |
| Combo size cap | Download Excel → verify no match has >5 invoices (check INVOICES column) |
| Variance caps | Download Excel → verify variance column respects caps per match type |
| Count integrity | Run Detail → verify Matched + Suggested + Unmatched = Total 26AS |

### 25.2 Verify Audit Trail

| Check | How to Verify |
|-------|---------------|
| Who uploaded files | Audit Trail tab → FILE_UPLOADED events with actor name and timestamp |
| Which files were used | Run Detail → Metadata card → SAP/26AS file hashes (SHA-256) |
| Who approved/rejected | Audit Trail tab → REVIEW_APPROVED/REVIEW_REJECTED events |
| Maker ≠ Checker | Compare created_by (Run metadata) vs reviewed_by (Audit Trail) — must be different |
| Exception review trail | Exceptions tab → each reviewed exception shows action, reviewer, notes, timestamp |
| Settings at run time | Run metadata → config_snapshot (JSON) — exact parameters used |

### 25.3 Verify Data Integrity

| Check | How to Verify |
|-------|---------------|
| File not tampered | Re-compute SHA-256 of original file → compare with stored hash in Run metadata |
| Reproducibility | Re-run with same files → verify same match rate and matched pairs |
| Excel integrity | Compare output_hash in DB with SHA-256 of downloaded Excel |

### 25.4 Verify Security Controls

| Check | How to Verify |
|-------|---------------|
| Password hashing | DB `users` table → `hashed_password` column shows bcrypt hash (starts with `$2b$`) |
| JWT expiry | Token payload → `exp` claim = issued_at + 60 minutes |
| Role enforcement | Attempt API call without required role → expect 403 Forbidden |
| Maker-checker | Attempt to approve own run → expect error message |
| Input validation | Attempt negative variance ceiling → expect rejection |

### 25.5 Sample Audit Workflow

1. **Select a completed run** from Run History
2. **Verify files**: Check SHA-256 hashes against your copies of the SAP/26AS files
3. **Verify algorithm version**: Metadata card shows algorithm_version and config_snapshot
4. **Verify match quality**: Open Matched Pairs tab → expand high-variance matches → check score breakdown
5. **Verify exceptions**: Open Exceptions tab → ensure all HIGH/CRITICAL exceptions are reviewed
6. **Verify unmatched**: Open Unmatched 26AS tab → check reason codes make sense
7. **Verify audit trail**: Open Audit Trail tab → confirm complete chain of events
8. **Download Excel**: Verify output matches the on-screen data
9. **Cross-check totals**: Financial Summary → Total 26AS = Matched + Unmatched + Suggested amounts

---

# Part V — Reference

---

## 26. Match Types

| Type | Phase | Meaning |
|------|-------|---------|
| EXACT | B | Books match 26AS within Rs.0.01 |
| SINGLE | B | One invoice, ≤2% variance |
| COMBO_2 to COMBO_5 | B | 2–5 invoices combined, ≤3% variance |
| CLR_GROUP_2 to CLR_GROUP_5 | A | Invoices linked by clearing document |
| PROXY_GROUP_2 to PROXY_GROUP_5 | A | Invoices clustered by date (no clearing doc) |
| FORCE_SINGLE | C | One invoice, up to 5% variance (needs review) |
| FORCE_COMBO | C | 2–3 invoices, ≤2% variance (needs review) |
| PRIOR_EXACT / PRIOR_SINGLE / PRIOR_COMBO | E | Prior-year matches (needs review) |

---

## 27. Confidence Levels

| Level | Criteria | Action |
|-------|----------|--------|
| **HIGH** | Variance ≤1%, OR ≤2% with composite score ≥70 | Auto-approved |
| **MEDIUM** | Variance 1–5%, OR score ≥50, OR proxy group ≤1%, OR FY boundary zone | Review recommended |
| **LOW** | Force match, prior-year, proxy >1%, advance, or high variance + low score | Must be reviewed |

---

## 28. Variance Thresholds

| Match Type | Max Variance | Phase |
|-----------|-------------|-------|
| Clearing Group / Proxy Group | 3% | A |
| Single Invoice | 2% | B |
| Combo (2–5 invoices) | 3% | B |
| Relaxed Single/Combo | 20% (auto-confirm ceiling) | B.2 |
| Force Single | 5% | C |
| Force Combo (max 3 inv) | 2% | C |

**Formula**: `Variance = (26AS Amount − Books Sum) / 26AS Amount × 100`

**Auto-confirm routing**:

| Variance Range | Routing | Outcome |
|---------------|---------|---------|
| 0–3% | Auto-confirmed | Matched pair, no flag |
| 3–20% | Auto-confirmed with flag | Matched pair + INFO exception + AI risk flag |
| >20% | Suggested | Requires CA review + mandatory remarks |

---

## 29. Reason Codes

| Code | Meaning | Plain English |
|------|---------|---------------|
| **U01** | No candidate found | No SAP invoice exists that could match this 26AS entry |
| **U02** | All candidates consumed | Matching invoices exist but were used by other entries |
| **U04** | Below noise threshold | 26AS amount too small (< Rs.1) |

---

## 30. Exception Types

| Type | Severity | Meaning | Blocks Approval? |
|------|----------|---------|-----------------|
| FORCE_MATCH | HIGH | Force-matched at relaxed thresholds | Yes |
| HIGH_VARIANCE | INFO | 3–20% variance, auto-confirmed | No |
| HIGH_VARIANCE | MEDIUM | >20% variance, suggested | Yes |
| CROSS_FY | HIGH | Invoice from different FY | Yes |
| PRIOR_YEAR | HIGH | Prior-year invoice match | Yes |
| TAN_VALIDATION | HIGH | Section 206AA/206AB indicator | Yes |
| RATE_MISMATCH | MEDIUM | TDS rate doesn't match expected | Yes |
| PAN_ISSUE | HIGH | PAN not available to deductor | Yes |
| DUPLICATE_26AS | HIGH | Duplicate 26AS entry detected | Yes |
| UNMATCHED_HIGH_VALUE | CRITICAL | Unmatched entry > Rs.10 lakh | Yes |

---

## 31. Glossary

| Term | Definition |
|------|-----------|
| **26AS** | Form 26AS — Annual tax credit statement from Income Tax Department showing all TDS credits |
| **SAP AR Ledger** | Accounts Receivable Ledger from SAP — company's record of invoices and payments |
| **TDS** | Tax Deducted at Source — tax withheld by the payer before paying the company |
| **Section 199** | Income Tax Act section allowing credit for TDS only up to the amount shown in books |
| **Deductor** | Entity that deducted tax (the paying company/customer) |
| **TAN** | Tax Deduction Account Number — 10-character alphanumeric ID of the deductor |
| **PAN** | Permanent Account Number — 10-character alphanumeric taxpayer ID |
| **Clearing Document** | SAP document number that links multiple invoices cleared together |
| **SGL_V** | Special G/L Indicator "V" — advance payment from customer |
| **FY** | Financial Year (April 1 to March 31). E.g., FY2023-24 = Apr 2023 to Mar 2024 |
| **Variance** | Difference between 26AS amount and books sum, expressed as percentage |
| **Combo Match** | Multiple invoices matched against a single 26AS entry |
| **Force Match** | Match at relaxed thresholds requiring manual review |
| **Proxy Group** | Pseudo-clearing group formed by clustering invoices with same date |
| **Auto-Confirm** | Matches within auto-confirm ceiling (default 20%) accepted automatically with audit flag |
| **Filing Lag** | Delay between tax deduction (26AS date) and invoice in books. Default tolerance: 45 days |
| **Composite Score** | 0–100 score: variance (30%) + date proximity (20%) + section (20%) + clearing doc (20%) + historical (10%) |
| **Maker-Checker** | Control principle: run creator cannot approve their own run |
| **Bipartite Matching** | Mathematical optimization for finding best set of 1:1 matches (scipy) |
| **WAL Mode** | Write-Ahead Logging — SQLite concurrency mode enabling parallel reads during writes |
| **RBAC** | Role-Based Access Control — ADMIN > REVIEWER > PREPARER |
| **JSONL** | JSON Lines — one JSON object per line, used for append-only audit logs |

---

## 32. Troubleshooting

### "0% match rate but entries aren't unmatched"
Check the **Suggested** card. Entries may be in Suggested Matches tab awaiting review.

### "Match rate shows over 100%"
Delete `backend/reco.db` and restart. The startup process auto-heals counts.

### "Upload fails with 413 error"
File exceeds 50MB limit. Split files or increase `MAX_UPLOAD_MB` in `.env`.

### "Cannot approve my own run"
By design (maker-checker rule). Ask another Reviewer/Admin.

### "PuLP CBC error on Mac"
The app auto-detects Apple Silicon and falls back to scipy. No action needed.

### "Database is locked"
Kill lingering processes: `lsof -ti:8000 | xargs kill -9`, then restart.

### "Count mismatch warning banner"
If Matched + Suggested + Unmatched ≠ Total, re-run the reconciliation.

### "High variance matches with risk flags"
Expected since v2.2.0. Matches 3–20% variance are auto-confirmed with audit flag. Expand match to see alert. These passed all compliance checks.

### "Combo matching is slow"
30-second timeout guard. Split large SAP files by deductor and use batch mode.

### "Cannot approve — match rate below 75%"
Minimum approval gate. Authorize suggested matches first to raise the rate.

### "Force matches had 88% variance in old version"
Fixed in v2.3.0. Force Single hard-capped at 5%. Old matches will appear as unmatched on re-run.

### "Same invoice in multiple matches"
Fixed in v2.3.0. Phase C now runs sequentially with consumed-book tracking.

### "Matched Pairs tab shows error"
The tab now shows explicit error messages. Refresh page; check backend logs if persistent.

### "Page shows Run Not Found"
The run was deleted or URL is invalid. Use the back button to return to Run History.

### "Admin settings won't save"
Numeric validation: non-negative, percentages ≤100%, lookback ≤5 years. Correct and retry.

### "2 entries silently dropped"
Check: (1) Suggested count (entries pending authorization), (2) Validation rejections (null amounts, duplicates excluded before algorithm).

---

*26AS Matcher v2.3.0 — TDS Reconciliation Platform*
*Algorithm v5.3 — Section 199 compliant*
*Backend v2.0.0 — FastAPI + SQLAlchemy 2.0 async*
*Frontend — React 19 + TypeScript + Tailwind CSS 4*
