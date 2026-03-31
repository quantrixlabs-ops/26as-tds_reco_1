# TDS Reconciliation Platform — Complete Documentation
### For Client Presentation & Technical Deep-Dive
**Version**: v2.3.0 · **Algorithm**: v5.4 · **Prepared**: March 2026

---

## Table of Contents

1. [What is This Platform?](#1-what-is-this-platform)
2. [The Problem We Solve](#2-the-problem-we-solve)
3. [USP — Why We Are Different](#3-usp--why-we-are-different)
4. [System Architecture](#4-system-architecture)
5. [User Roles & Access Control](#5-user-roles--access-control)
6. [Module-by-Module Feature Guide](#6-module-by-module-feature-guide)
7. [The Reconciliation Algorithm — Deep Dive](#7-the-reconciliation-algorithm--deep-dive)
8. [Scoring Engine](#8-scoring-engine)
9. [Compliance & Audit Framework](#9-compliance--audit-framework)
10. [Data Formats & File Handling](#10-data-formats--file-handling)
11. [Real-Time Processing Pipeline](#11-real-time-processing-pipeline)
12. [Excel Output — Deliverable Format](#12-excel-output--deliverable-format)
13. [Administration & Configuration](#13-administration--configuration)
14. [Common Use Cases](#14-common-use-cases)
15. [Glossary](#15-glossary)

---

## 1. What is This Platform?

The **TDS Reconciliation Platform** is a web application purpose-built for Chartered Accountants and their teams to perform **Form 26AS to SAP AR Ledger reconciliation** — a mandatory step in verifying TDS (Tax Deducted at Source) credit claims under **Section 199 of the Income Tax Act, 1961**.

### In Plain Language

Every time a company (the "deductor") pays you (the vendor/seller), they deduct TDS at the applicable rate and deposit it with the government. The government records this in **Form 26AS** — your official TDS credit statement. Your SAP books record the same payment as an invoice/receipt entry.

To claim the TDS credit in your income tax return, you must **prove that every 26AS entry matches a real invoice in your books**. This is the reconciliation.

### The Scale of the Problem

A typical large company has:
- **5,000–10,000** Form 26AS entries per financial year
- **Hundreds of deductors** (clients, government departments)
- Each deductor has different payment patterns, invoice references, and TDS sections

Manual reconciliation of this at scale is **impossible within time constraints** — and errors mean either missed TDS credits (money left on the table) or incorrect claims (regulatory risk).

---

## 2. The Problem We Solve

### What Happens Without This Tool

```
Manual Process (Traditional CA Firm):
─────────────────────────────────────
1. CA downloads 26AS from TRACES portal → massive Excel file
2. Exports SAP FBL5N report → another massive Excel
3. Uses VLOOKUP / INDEX-MATCH → fails on:
   • Amount mismatches (TDS rounding)
   • Date mismatches (invoice date ≠ 26AS date)
   • Invoice ref mismatches (different naming conventions)
   • Multiple invoices combined into one 26AS entry
4. Manual line-by-line review of thousands of rows
5. Partner review → approval → revised workings → rework
Timeline: 2–4 weeks per company, per FY
Error rate: High (manual = fatigue-prone)
Audit trail: None / scattered Excel version history
```

### What This Platform Does

```
Automated Process (Our Platform):
──────────────────────────────────
1. Upload SAP file + 26AS file → takes 30 seconds
2. Algorithm runs 5 matching phases → takes 2–5 minutes
3. High-confidence matches: auto-accepted
4. Edge cases: flagged for CA review with explanation
5. CA approves → Excel output generated instantly
6. Full audit trail preserved for assessment proceedings
Timeline: Same-day turnaround
Error rate: Compliance-validated (Section 199 hard assert)
Audit trail: Immutable, role-stamped, timestamped
```

---

## 3. USP — Why We Are Different

### Comparison Table

| Feature | Our Platform | Excel VLOOKUP | Generic Reco Tools | ERP Add-ons |
|---------|:---:|:---:|:---:|:---:|
| **Handles amount variance (rounding)** | ✅ Up to 20% configurable | ❌ Exact match only | ⚠️ Basic % only | ⚠️ Fixed threshold |
| **Multi-invoice combo matching** | ✅ Up to 5 invoices | ❌ No | ⚠️ Rarely | ❌ No |
| **Clearing document grouping** | ✅ Phase A | ❌ No | ❌ No | ⚠️ Sometimes |
| **Date flexibility** | ✅ 180-day window, configurable | ❌ No | ⚠️ Basic | ⚠️ Fixed |
| **Bipartite global optimisation** | ✅ Scipy Hungarian algorithm | ❌ No | ❌ No | ❌ No |
| **Section 199 hard compliance** | ✅ Never over-claims | ❌ N/A | ❌ No | ⚠️ Manual check |
| **Prior-year exception handling** | ✅ Phase E | ❌ No | ❌ No | ❌ No |
| **Maker-checker workflow** | ✅ Role-based, enforced | ❌ No | ❌ No | ⚠️ Sometimes |
| **Full audit trail** | ✅ DB + JSONL dual-sink | ❌ No | ❌ No | ⚠️ Partial |
| **6-sheet structured Excel output** | ✅ Ready for Assessment | ❌ Manual | ❌ No | ⚠️ Basic |
| **Batch mode (multiple parties)** | ✅ Parallelised | ❌ Manual | ❌ No | ❌ No |
| **Real-time progress tracking** | ✅ 11-stage pipeline | ❌ No | ❌ No | ❌ No |
| **Configurable per-client algorithm** | ✅ 14 parameters | ❌ No | ❌ No | ❌ No |
| **Indian FY awareness (Apr–Mar)** | ✅ Native | ❌ No | ❌ No | ⚠️ Sometimes |

### Our 5 Core Differentiators

**1. Global Optimisation (Not Greedy)**
Traditional tools match entry-by-entry: pick the best match for entry 1, commit it, move to entry 2. This "greedy" approach creates a cascade — entry 1 consumes a book that entry 2 also needed, leaving entry 2 unmatched. Our platform uses the **Hungarian algorithm (bipartite matching)** to find the globally optimal assignment across ALL entries simultaneously, maximising total matches.

**2. Intelligent Combo Matching**
A single 26AS entry often represents TDS on multiple invoices paid in one batch. Our platform finds combinations of 2–5 SAP invoices whose sum matches the 26AS amount within tolerance. This is computationally hard (subset-sum problem) — we solve it with a custom two-pass DP algorithm that respects both amount and date constraints.

**3. Compliance-First Architecture**
The Section 199 hard assert is built into the algorithm's core: `books_sum ≤ as26_amount`. This constraint is enforced at every match step, not just validated at the end. You cannot accidentally over-claim TDS credit.

**4. Configurable Per-Client**
Different clients have different payment patterns. One client always pays within 30 days; another has 180-day payment cycles. One uses RV/DC document types; another only RV. Every algorithm parameter is configurable by client, by batch, or globally via the Admin panel — without changing any code.

**5. Structured for Assessment Defence**
The Excel output is not just a data dump — it's structured for presentation in assessment proceedings: Summary sheet with compliance status, matched pairs with full score breakdowns, exceptions with severity levels, and a complete audit trail that shows who matched what, when, and why.

---

## 4. System Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────┐
│                    BROWSER (React)                   │
│  Dashboard · NewRun · RunDetail · History · Admin   │
└───────────────────┬─────────────────────────────────┘
                    │ HTTPS / REST API (Vite Proxy)
                    │
┌───────────────────▼─────────────────────────────────┐
│              FASTAPI BACKEND (Python 3.9)            │
│                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────┐ │
│  │  Auth Layer  │  │  API Routes  │  │  Progress  │ │
│  │  JWT + RBAC  │  │  /api/...    │  │   Store   │ │
│  └──────────────┘  └──────────────┘  └───────────┘ │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │           Reconciliation Engine               │   │
│  │                                              │   │
│  │  Validator → Scorer → Optimizer (5 Phases) │   │
│  │                                              │   │
│  │  Phase A: Clearing Groups                   │   │
│  │  Phase B: Bipartite + Combo (DP/Hungarian)  │   │
│  │  Phase C: Force Match                       │   │
│  │  Phase E: Prior-Year                        │   │
│  │  Phase D: Unmatched Classification          │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  ┌──────────────────┐  ┌─────────────────────────┐  │
│  │  Excel Generator │  │  Audit Engine           │  │
│  │  (6-sheet)       │  │  DB + JSONL dual-sink   │  │
│  └──────────────────┘  └─────────────────────────┘  │
└───────────────────┬─────────────────────────────────┘
                    │
┌───────────────────▼─────────────────────────────────┐
│              SQLite / PostgreSQL Database            │
│  10 tables: users, runs, matched_pairs,              │
│  unmatched_26as, unmatched_books, suggested_matches, │
│  exceptions, audit_logs, settings, batches           │
└─────────────────────────────────────────────────────┘
```

### Technology Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Frontend | React 19 + TypeScript | Type-safe, modern UI |
| Styling | Tailwind CSS v4 | Rapid, consistent design |
| Data Fetching | TanStack Query | Auto-caching, background refresh |
| Routing | React Router v6 | SPA navigation |
| Charts | Recharts | Match rate trend visualisation |
| Backend | FastAPI (Python) | Async-first, auto OpenAPI docs |
| ORM | SQLAlchemy 2.0 async | Non-blocking DB operations |
| Database | SQLite (dev) / PostgreSQL (prod) | WAL mode for concurrent reads |
| Auth | JWT + bcrypt | Industry standard, stateless |
| Optimisation | scipy (Hungarian) | Proven bipartite matching |
| Async Processing | asyncio.create_task + Thread Pool | Non-blocking heavy computation |

---

## 5. User Roles & Access Control

### The Three Roles

```
PREPARER ──────── Creates runs, uploads files, reviews results
     │
     ▼ Run created (cannot approve own work)

REVIEWER ──────── Approves or rejects runs created by others
     │             Reviews exceptions, authorises suggested matches
     │
     ▼ (Also a REVIEWER)

ADMIN ─────────── All REVIEWER capabilities +
                  User management, algorithm configuration
```

### Maker-Checker Enforcement

The platform enforces a **segregation of duties** principle:
- The person who prepares a run **cannot** approve it
- This is enforced at the API level (not just UI) — backend validates `created_by ≠ current_user.id`
- Applicable to: Approve, Reject actions

This satisfies the internal control requirements of most CA firms and corporate audit policies.

### Permission Matrix

| Action | PREPARER | REVIEWER | ADMIN |
|--------|:---:|:---:|:---:|
| Create/upload runs | ✅ | ✅ | ✅ |
| View all runs | ✅ | ✅ | ✅ |
| Download Excel | ✅ | ✅ | ✅ |
| Re-run / Delete | ✅ | ✅ | ✅ |
| Authorise suggested matches | ✅ | ✅ | ✅ |
| Approve/Reject runs (not own) | ❌ | ✅ | ✅ |
| Review exceptions | ❌ | ✅ | ✅ |
| Manage users | ❌ | ❌ | ✅ |
| Configure algorithm | ❌ | ❌ | ✅ |

---

## 6. Module-by-Module Feature Guide

### Module 1: Dashboard

**Purpose**: At-a-glance health check of all reconciliation activity.

```
┌─────────────────────────────────────────────────────────┐
│  Good morning, Rajesh                       [New Run ↗] │
│  26AS TDS Reconciliation Platform · HRA & Co.          │
├──────────┬──────────┬────────────────┬──────────────────┤
│ Total    │ Avg Match│ Pending Review │ Failed           │
│ Runs: 42 │ Rate: 96%│ 3 runs         │ 0 runs           │
│  [Navy]  │  [Green] │  [Amber]       │  [Green]         │
├──────────┴──────────┴────────────────┴──────────────────┤
│                                                         │
│  Recent Runs Table (last 8)    │ Match Rate Trend Chart │
│  Run# · Deductor · FY · Status │ Area chart (10 runs)   │
│  · Match Rate · Created        │                        │
│  ─ rows are clickable ─        │ Quick Actions          │
│                                │ [New Run] [View All]   │
│                                │                        │
│                                │ Compliance Note        │
│                                │ Section 199 reminder   │
└────────────────────────────────┴────────────────────────┘
```

**Key Features**:
- Auto-refreshes every 15 seconds (live during batch processing)
- Match rate colour-coded: ≥95% = green, ≥80% = amber, <80% = red
- "Pending Review" shows amber alert when CA action is needed
- Trend chart shows the last 10 runs — spot deteriorating match rates

---

### Module 2: New Run — Single Party Mode

**Purpose**: Run reconciliation for one company against one 26AS.

**Flow**:
```
Step 1: Upload                    Step 2: Map & Run
──────────────                    ─────────────────
Select Financial Year             Auto-detected identity:
                                  "TECHNOCRAFTS SWITCHGEARS"
[📁 SAP AR Ledger.xlsx]
                                  Match: TECHNOCRAFTS SWITCHGEARS
[📁 Form_26AS_FY24.xlsx]         PRIVATE LTD · MUMT11136G
                                  Score: 98% ✅ [Auto-confirmed]
[Continue →]
                                  [🚀 Start Reconciliation]
```

**Fuzzy Name Matching Logic**:
The SAP filename (e.g., `TECHNOCRAFTS_SWITCHGEARS.xlsx`) is cleaned (underscores → spaces, uppercase) and matched against every deductor name in the 26AS using `rapidfuzz token_sort_ratio`:

| Score | Status | User Action |
|-------|--------|-------------|
| ≥ 95% AND runner-up < 80% | ✅ Auto-confirmed | None needed |
| 80–94% | ⚠️ Needs review | Confirm or change |
| < 80% | ❌ No match | Search and select manually |

**Example**:
- SAP file: `ABB_INDIA_LIMITED.xlsx` → identity: "ABB INDIA LIMITED"
- 26AS has: "ABB India Ltd" → score 94% → user confirms
- 26AS has: "ABB India Limited" → score 100% → auto-confirmed

---

### Module 3: New Run — Batch Mode

**Purpose**: Reconcile multiple companies (deductors) against a single 26AS in one operation.

**Flow**:
```
Step 1: Upload             Step 2: Config (Optional)
──────────────             ────────────────────────
[📁 26AS_Master.xlsx]      ◉ Use Admin Defaults
                           ○ Custom Settings
[📁 ABB_INDIA.xlsx    ×]      → 14 parameters exposed
[📁 SIEMENS_LTD.xlsx  ×]
[📁 BOSCH_INDIA.xlsx  ×]   [Continue →]
[+ Add more files]

Step 3: Review Mappings
───────────────────────
ABB_INDIA.xlsx → [ABB INDIA LIMITED · AAACA1596H] ✅ 98%
SIEMENS_LTD.xlsx → [SIEMENS LIMITED · AABCS0012Q] ✅ 96%
BOSCH_INDIA.xlsx → [BOSCH LIMITED] ⚠️ 84% [Change]
                   [Select parties ▼]

[🚀 Run All — 3 parties]
```

**Key Batch Features**:
- Each SAP file is auto-mapped to one or more deductor(s) from the 26AS
- Processing is sequential with a progress indicator per party
- Results available individually (each party gets its own run) AND as a combined batch view
- **Batch-level "Authorize All Suggested"**: Bulk-authorize suggested matches across all parties in one action
- **Combined Excel Download**: One workbook with all parties' results

---

### Module 4: Run Detail Page

The most feature-rich page. Contains 9 tabs of information.

```
Run #265 · PENDING REVIEW                    [↺ Refresh] [⟳ Rerun] [↓ Download] [✓ Approve] [✗ Reject]
TECHNOCRAFTS SWITCHGEARS PRIVATE LIMITED · MUMT11136G · FY 2022-23
──────────────────────────────────────────────────────────────────────────────────────────────
Match Rate    Matched         Suggested      Unmatched 26AS   Violations   Control Total
66.8%         633 / 948       96             219              0            N/A
[Green]       entries         (Needs review) [Red]            [Green]      [Gray]
──────────────────────────────────────────────────────────────────────────────────────────────
Financial Summary:
Total 26AS: ₹8,42,45,600  |  Books Total: ₹7,45,32,100  |  Matched: ₹5,62,80,400  |  Unmatched: ₹1,23,45,200  |  Suggested: ₹55,80,000
──────────────────────────────────────────────────────────────────────────────────────────────
Confidence:  [HIGH ████████░░ 380]  [MEDIUM ████░░░░░░ 200]  [LOW ██░░░░░░░░ 53]
──────────────────────────────────────────────────────────────────────────────────────────────

[Matched Pairs 633] [Unmatched 26AS 219] [Unmatched Books] [Suggested 96] [Section Summary]
[Resolution Tracker] [Methodology] [Exceptions] [Audit Trail]
```

#### Tab 1: Matched Pairs
Shows all confirmed matches. Expandable rows reveal:
- Invoice references + amounts + dates
- 5-factor score breakdown (bar charts per factor)
- AI risk flags (e.g., "Variance 4.2% — above base cap")

**Example matched pair expanded**:
```
26AS Entry #42 · 194C · 15-Jun-2023 · ₹2,85,000
├── Books Sum: ₹2,82,750 (Variance: 0.79%)
├── Match Type: COMBO_3
├── Confidence: HIGH
├── Invoices:
│   INV/2023/0042 · ₹1,00,000 · 10-Jun-2023
│   INV/2023/0043 · ₹90,000  · 10-Jun-2023
│   INV/2023/0044 · ₹92,750  · 12-Jun-2023
│   Clearing Doc: 5000012345
└── Score: 87.5
    ├── Variance:      ██████████░ 28/30 (0.79% is excellent)
    ├── Date Proximity: █████████░ 18/20 (2 days average gap)
    ├── Section Match:  ████████████ 20/20 (194C ↔ 194C)
    ├── Clearing Doc:   ████████████ 20/20 (linked)
    └── Historical:     ████░░░░░░ 5/10 (default neutral)
```

#### Tab 2: Unmatched 26AS
Entries that could not be matched, with reason codes:

| Code | Meaning | Example |
|------|---------|---------|
| U01 | No SAP invoice found | Entry for a deductor not in SAP at all |
| U02 | Best candidate already consumed | Another 26AS entry claimed the only matching invoice |
| U04 | Amount < ₹1 or negative | Data quality issue in 26AS |

#### Tab 4: Suggested Matches
Matches that were found but require CA review (above auto-confirm threshold). CAs can:
- **Authorize**: Promotes to matched pair (counts in match rate)
- **Reject**: Keeps as unmatched
- **Bulk select**: Checkbox all + bulk authorize/reject

**Categories requiring review**:
- HIGH_VARIANCE_3_20: Variance 3–20%
- HIGH_VARIANCE_20_PLUS: Variance >20%
- DATE_SOFT_PREFERENCE: Date outside preferred window
- ADVANCE_PAYMENT: Book is an SGL_V advance
- FORCE: Force-matched (last resort)
- CROSS_FY: Prior financial year match

#### Tab 8: Exceptions
Auto-generated items. Severity levels:

| Severity | Examples |
|----------|---------|
| CRITICAL | Unmatched high-value 26AS entry (>₹10L), Section 199 violation |
| HIGH | Match variance >5%, low confidence with high amount |
| MEDIUM | Force match, prior-year exception, advance payment |
| LOW | Informational — unmatched book entry |

Reviewers can action each exception: **Acknowledge / Waive / Escalate**.

---

### Module 5: Run History

```
Reconciliation History                         [↺] [New Run]
42 total runs · 5 batches · 42 shown
──────────────────────────────────────────────────────────
Filters: [Search...] [All|Single|Batch] [Status▼] [FY▼] [Clear]
──────────────────────────────────────────────────────────

BATCH RUNS (5)
┌────────────────────────────────────────────────────┐
│ BATCH · 8 Parties · FY 2023-24 · 15-Mar-2026 [▼] │
│ 7 finished · 1 failed · Rate: 94% · Violations: 0 │
│ [Rerun Batch] [Authorize All Suggested] [↓ Excel] │
│                                                    │
│ # │ Deductor        │ Rate │ Matched │ Status     │
│ 42│ ABB INDIA       │ 97% │ 423/436 │ ✅ Approved │
│ 41│ SIEMENS LTD     │ 94% │ 381/405 │ 🔄 Pending  │
│ ...                                                │
└────────────────────────────────────────────────────┘

SINGLE RUNS (37)
# │ Deductor │ FY │ Status │ Rate │ Matched │ Created
```

---

## 7. The Reconciliation Algorithm — Deep Dive

### Overview

The algorithm processes 26AS entries against SAP books in **5 sequential phases**, from strictest criteria to most relaxed. Each phase handles a different class of matching scenario.

```
ALL 26AS ENTRIES (e.g., 948 entries)
         │
         ▼
┌────────────────────────────────────────────────────┐
│  PHASE A: Clearing Group Matching                  │
│  "These 3 SAP invoices share clearing doc 500001, │
│   and they sum to ₹2,85,000 = this 26AS entry"   │
│  → Commits 181 matches                             │
└──────────────┬─────────────────────────────────────┘
               │ 767 entries unmatched
               ▼
┌────────────────────────────────────────────────────┐
│  PHASE B.1: Bipartite Single-Invoice Matching     │
│  "Find the globally optimal 1:1 assignment across  │
│   all remaining entries using Hungarian algorithm" │
│  → Commits 484 matches                             │
└──────────────┬─────────────────────────────────────┘
               │ 283 entries unmatched
               ▼
┌────────────────────────────────────────────────────┐
│  PHASE B.2: Combo Matching (2–5 invoices)         │
│  "Find 2–5 SAP invoices that sum to match each    │
│   26AS entry" (Two-pass DP + greedy algorithm)    │
│  → Commits additional matches                      │
└──────────────┬─────────────────────────────────────┘
               │ Remaining unmatched
               ▼
┌────────────────────────────────────────────────────┐
│  PHASE B.2 RELAXED: Wider Date Window             │
│  "Try again with 180-day date window instead of   │
│   90-day, allow books after 26AS date"            │
│  → Commits 64 more matches                        │
└──────────────┬─────────────────────────────────────┘
               │ Still unmatched
               ▼
┌────────────────────────────────────────────────────┐
│  PHASE C: Force Match                             │
│  "Last resort — match up to 5% variance or        │
│   3-invoice combo at 2%"                         │
└──────────────┬─────────────────────────────────────┘
               │
               ▼
┌────────────────────────────────────────────────────┐
│  PHASE E: Prior-Year Exception                    │
│  "Maybe this 26AS entry is for an invoice from    │
│   last FY that is in prior-year SAP books"       │
└──────────────┬─────────────────────────────────────┘
               │
               ▼
         PHASE D: Truly Unmatched
         U01 / U02 / U04 reason codes
```

---

### Phase A — Clearing Group Matching

**What it does**: Groups SAP entries by their **Clearing Document** number (col[4] in SAP). When multiple invoices share a clearing document, they were likely processed as one payment batch — and the 26AS entry reflects the combined amount.

**Logic**:
1. Group all SAP books by `clearing_doc`
2. For each group of 2–5 books, compute `group_sum`
3. Find the 26AS entry where `group_sum ≤ as26_amount` AND `variance ≤ 3%`
4. Score and commit the best match

**Example**:
```
26AS Entry: ₹5,00,000 · 15-Jun-2023 · 194C

SAP Clearing Group (Doc: 5000012345):
  INV/23/001 · ₹1,80,000 · 10-Jun-2023
  INV/23/002 · ₹1,60,000 · 10-Jun-2023
  INV/23/003 · ₹1,57,500 · 12-Jun-2023
  ─────────────────────────────────────
  Sum:          ₹4,97,500

Variance: (5,00,000 - 4,97,500) / 5,00,000 = 0.5% ✅
Match Type: CLR_GROUP_3 ✅ Committed
```

**Why critical**: Clearing groups are the most reliable matches — the same clearing document appears in both SAP and 26AS, providing an explicit link beyond amount+date similarity.

---

### Phase B.1 — Bipartite Single-Invoice Matching

**What it does**: For each unmatched 26AS entry, find candidate SAP invoices (single books within variance tolerance). Then use the **Hungarian algorithm** (scipy `linear_sum_assignment`) to find the globally optimal 1:1 assignment.

**Why not greedy?**

```
Greedy problem (without bipartite):
────────────────────────────────────
26AS Entry A: ₹1,000  →  Book X: ₹998 (0.2% variance) ← greedy picks this
26AS Entry B: ₹1,000  →  NOTHING LEFT (Book X taken)
26AS Entry B: U02 (unmatched)

Bipartite solution:
───────────────────
26AS Entry A: ₹1,000  →  Book Y: ₹985 (1.5% variance) ← assigned here
26AS Entry B: ₹1,000  →  Book X: ₹998 (0.2% variance) ← assigned here
Both matched! Total variance lower globally.
```

**Candidate building**:
- Amount window: `book_amount` between `as26_amount × 0.70` and `as26_amount` (30% cap)
- Date window: within 90 days (hard) or 180 days (soft)
- No over-claiming: books > as26_amount are excluded (Section 199)

**Cost matrix**: `cost[entry][book] = 100 - score` → scipy minimises total cost → maximises total quality.

**Result**: After bipartite, books are committed — Phase B.2 combo only works with remaining books.

---

### Phase B.2 — Combo Matching

**What it does**: For entries that couldn't be matched to a single invoice, find 2–5 SAP invoices whose sum equals the 26AS amount within tolerance.

**Two-pass strategy** (prevents "starvation"):
```
Pass 1 (max 5 books): Process ALL entries (smallest first)
    → Small entries claim their combos before large entries can

Pass 2 (admin max_size): Process remaining entries with larger combos
    → Allows flexible combo sizes for complex cases
```

**Algorithm per entry**:
1. **Greedy Accumulate**: Sort eligible books by date proximity; greedily add books to reach target
2. **Subset-Sum DP**: If greedy fails, use dynamic programming to find exact subset

**Example**:
```
26AS Entry: ₹7,50,000 · 194C

Eligible books (within amount + date):
  INV/23/010 · ₹3,00,000
  INV/23/011 · ₹2,50,000
  INV/23/012 · ₹2,00,000

Greedy: 3,00,000 + 2,50,000 = 5,50,000 (no)
        3,00,000 + 2,50,000 + 2,00,000 = 7,50,000 (yes! 0% variance)
Match Type: COMBO_3 ✅
```

**Computational safeguards**:
- Pool cap: Top 5000 most date-proximate books per entry
- Total timeout: 120 seconds for all combo matching
- DP budget: 2M iterations per entry (prevents blocking)

---

### Phase C — Restricted Force Match

**What it does**: Last-resort matching for entries that couldn't be matched within standard thresholds. Uses relaxed variance.

| Strategy | Max Variance | Max Invoices | Confidence |
|----------|-------------|-------------|-----------|
| FORCE_SINGLE | 5% | 1 | LOW |
| FORCE_COMBO | 2% | 3 max | LOW |

**When used**: Very rarely — only after Phase B.2 relaxed matching fails. Forces a suggested match for CA to review.

---

### Phase E — Prior-Year Exception

**What it does**: When cross-FY matching is disabled (default), some 26AS entries may represent TDS on invoices from the **previous financial year** (timing differences). Phase E explicitly tries these prior-year books.

**Example**:
```
FY 2023-24 26AS Entry: ₹1,50,000 · 194C · 30-Apr-2023
  → This TDS was deducted on payment in Apr-2023
  → But the invoice date is 15-Mar-2023 (FY 2022-23)

Phase B: Looking in FY 2023-24 books only → not found
Phase E: Looking in FY 2022-23 books → FOUND
Match Type: PRIOR_SINGLE (tagged for CA awareness)
```

---

### Phase D — Unmatched Classification

Entries that no phase could match:

| Code | Reason | Typical Cause |
|------|--------|---------------|
| U01 | No candidate found | Invoice doesn't exist in SAP, TAN mismatch, different FY |
| U02 | Best candidate already consumed | Greedy/bipartite assigned book elsewhere, genuinely ambiguous |
| U04 | Amount too small (<₹1) | Data quality — zero-amount entries in 26AS |

---

### Key Algorithm Constraints (Never Violated)

```
1. Section 199 Hard Assert:
   books_sum MUST NEVER exceed as26_amount
   → If books_sum > as26_amount: match is REJECTED

2. Invoice Uniqueness:
   Same SAP invoice cannot back 2 different 26AS entries
   → consumed_invoice_refs set tracks every committed book

3. Combo Size Cap:
   MAX_COMBO_SIZE = 5 in ALL phases (including Phase A)
   → Groups of 6+ books treated as payment batches, not clearing groups

4. FY Boundary:
   Prior-year books held separate → Phase E only
   → No accidental mixing of FY when ALLOW_CROSS_FY = False

5. Post-Run Validation:
   All constraints validated again after all phases
   → Any violation surfaced as CRITICAL exception
```

---

## 8. Scoring Engine

Every candidate match is scored 0–100. Higher = better match.

### Score Formula

```
Total Score = Variance Score (0-30)
            + Date Proximity Score (0-20)
            + Section Match Score (0-20)
            + Clearing Doc Score (0-20)
            + Historical Score (0-10)
            ─────────────────────────
            = 0 to 100
```

### Factor Details

**1. Variance Score (0–30 points)**
```
0% variance   → 30 points (perfect)
0.5% variance → ~28 points
1% variance   → ~26 points
2% variance   → ~22 points
5% variance   → ~15 points
20% variance  → ~6 points
```

**2. Date Proximity Score (0–20 points)**
```
Same day         → 20 points
≤7 days          → ~18 points
≤30 days         → ~15 points
≤90 days         → ~10 points
91–180 days      → ~5 points (soft preference zone)
Book after 26AS  → Penalised (unless within filing lag)
```

**3. Section Match Score (0–20 points)**
```
Section codes match exactly (e.g., 194C ↔ 194C)  → 20 points
No section data available                          → 10 points (neutral)
Known mismatch                                     → 0 points
```

**4. Clearing Document Score (0–20 points)**
```
Clearing document present and linked  → 20 points
No clearing document data             → 5 points (default neutral)
```

**5. Historical Score (0–10 points)**
```
Default: 5 points (neutral — future enhancement)
This will use historical matching patterns when enough data accumulates
```

### Confidence Tier Assignment

| Tier | Criteria |
|------|---------|
| **HIGH** | variance ≤ 1% AND not FORCE AND not PRIOR_YEAR |
| **MEDIUM** | variance ≤ 5% AND not FORCE AND not PRIOR_YEAR |
| **LOW** | Any FORCE match OR PRIOR_YEAR match |

---

## 9. Compliance & Audit Framework

### Section 199 Compliance

Section 199 of the Income Tax Act restricts TDS credit to the **amount actually credited in the 26AS**. The platform enforces:

```
Compliance Rule:
  matched_pair.books_sum ≤ matched_pair.as26_amount

If violated: the match is REJECTED at the algorithmic level.
  A CRITICAL exception is generated.
  The run cannot be approved until resolved.
```

This means:
- You can claim LESS TDS credit than the 26AS shows (if books are short)
- You CANNOT claim MORE TDS credit than the 26AS shows

### Dual-Sink Audit Trail

Every action is recorded in TWO places simultaneously:
1. **Database** (`audit_logs` table) — queryable, reportable
2. **JSONL files** on disk (`backend/audit_logs/YYYY-MM-DD.jsonl`) — tamper-evident, preservable

Events logged:
- RUN_CREATED, PROCESSING_STARTED, PROCESSING_COMPLETED
- RUN_APPROVED, RUN_REJECTED (with rejector ID + reason)
- EXCEPTION_REVIEWED (with reviewer ID + action + notes)
- SUGGESTED_AUTHORIZED, SUGGESTED_REJECTED (with authoriser ID)
- BATCH_RERUN, SETTINGS_UPDATED
- USER_LOGIN, USER_CREATED

Each event contains: `user_id`, `user_email`, `role`, `timestamp`, `run_id`, `description`, full metadata.

### File Integrity Verification

SHA-256 hashes of the original uploaded SAP and 26AS files are computed and stored:
- In the database (per run)
- Embedded in the Excel output (Summary sheet)

This allows **forensic verification**: "Was the original file tampered with after reconciliation?"

---

## 10. Data Formats & File Handling

### SAP AR Ledger (Input)

**Format**: Excel (.xlsx), exported from SAP FBL5N or similar.

**Positional columns** (column names are ignored, only position matters):

| Column Index | Field | Required | Example |
|:---:|------|:---:|---------|
| 0 | Company Code | No | 1000 |
| 1 | Customer Code | No | 100234 |
| 2 | Customer Name | No | ABC Corp |
| 3 | Account | No | 110100 |
| **4** | **Clearing Document** | ✅ | 5000012345 |
| **5** | **Document Type** | ✅ | RV, DC, DR |
| **6** | **Document Date** | ✅ | 15-Jun-2023 |
| 7 | Posting Date | No | 15-Jun-2023 |
| **8** | **Special G/L Indicator** | ✅ | (blank), V, O, A |
| 9 | Currency | No | INR |
| **10** | **Amount (Local Currency)** | ✅ | 285000.00 |
| 11 | Tax Amount | No | 28500.00 |
| 12 | Document Number | No | 1400056789 |
| 13 | Reference | No | PO-2023-001 |
| **14** | **Invoice Reference** | ✅ | INV/2023/0042 |

**Cleaning rules**:
- Document types kept: **RV, DC, DR** (fallback to all if none found)
- Document types excluded: **CC, BR** (reversals/credit notes)
- SGL excluded: **L, E, U** (internal transfers)
- SGL flagged: **V** → advance payment, **O/A/N** → other
- Noise filter: amounts < ₹1 excluded
- Deduplication: same (invoice_ref, clearing_doc, amount) = true duplicate removed

### Form 26AS (Input)

**Format**: Excel (.xlsx), downloaded from TRACES portal or Income Tax portal.

**Header-detected columns** (flexible naming):

| Canonical Name | Accepted Column Headers |
|----------------|------------------------|
| deductor_name | "Name of Deductor", "Particulars", "Deductor Name" |
| tan | "TAN of Deductor", "TAN" |
| amount | "Amount Paid/Credited", "Amount Credited" |
| status | "Status of Booking", "Status of..." |
| section | "Section" |
| transaction_date | "Transaction Date", "Date of Payment/Credit" |
| invoice_number | "Invoice Number", "Invoice No" |

**Key rules**:
- Only **Status = F** (Final booking) rows are processed
- Amount column used: **"Amount Paid/Credited"** (NOT "Tax Deducted")
- Sheets named "tanwise" or "summary" are skipped
- Header auto-detected within the first 5 rows

---

## 11. Real-Time Processing Pipeline

When a run is submitted, the backend processes it asynchronously. The user sees live progress.

```
Submit Run → HTTP 202 (immediate) → Frontend polls every 800ms
                                          │
    ┌─────────────────────────────────────┘
    │
    ▼ Background Thread (asyncio.to_thread)

Stage 1: PARSING
    Read SAP Excel → clean → 991 books extracted
    Read 26AS Excel → filter Status=F → 948 entries

Stage 2: VALIDATING
    6 validators: null amounts, negative amounts,
    unknown sections, rate mismatches, 206AA flag, duplicates

Stage 3: PHASE_A
    Build clearing groups → score → commit 181 matches

Stage 4: PHASE_B_SINGLE
    Build candidates (525 unique books)
    Bipartite matching (scipy) → 484 matches

Stage 5: PHASE_B_COMBO
    Two-pass combo: Pass 1 (≤5 books) + Pass 2 (admin max)

Stage 6: PHASE_C (Force)
    FORCE_SINGLE (5%) + FORCE_COMBO (3 inv, 2%)

Stage 7: PHASE_E (Prior-Year)
    Try prior-FY books for remaining unmatched entries

Stage 8: POST_VALIDATE
    Section 199 + invoice uniqueness + combo cap checks

Stage 9: PERSISTING
    Write all results to database

Stage 10: EXCEPTIONS
    Auto-generate exception items by severity

Stage 11: FINALIZING
    Compute match_rate, confidence breakdown, update status
    → PENDING_REVIEW
```

**Typical runtime**: 2–5 minutes for 1,000 entries. Server stays responsive throughout (heavy computation runs in thread pool, not event loop).

---

## 12. Excel Output — Deliverable Format

The downloaded Excel workbook is ready for presentation to clients, filing, and assessment defence.

### Sheet 1: Summary
```
RUN METADATA
  Run Number:       #265
  Deductor:         TECHNOCRAFTS SWITCHGEARS PRIVATE LIMITED
  TAN:              MUMT11136G
  Financial Year:   FY 2022-23
  Status:           APPROVED
  Prepared By:      Priya Sharma (PREPARER)
  Approved By:      Rajesh Kumar (REVIEWER) · 31-Mar-2026

STATISTICS
  Total 26AS Entries:     948
  Matched:                633 (66.8%)
  Suggested (Authorised): 96
  Unmatched:              219

COMPLIANCE
  Section 199 Violations:  0
  Invoice Reuse:           0
  Algorithm Version:       v5.4

FILE INTEGRITY
  SAP File SHA-256:   d48a2d6a7f4df390...
  26AS File SHA-256:  3f099f18bf91780d...
```

### Sheet 2: Matched Pairs
Each row: 26AS index, date, section, amount, books sum, variance%, match type, confidence, invoice refs, clearing doc, score breakdown (5 columns)

### Sheet 3: Unmatched 26AS
Each row: index, deductor, TAN, section, date, amount, reason code, reason detail

### Sheet 4: Unmatched Books
Each row: invoice ref, clearing doc, date, amount, document type, SGL flag

### Sheet 5: Exceptions
Each row: severity, category, description, amount, status, reviewer, notes

### Sheet 6: Audit Trail
Each row: timestamp, event type, actor, role, description, notes

---

## 13. Administration & Configuration

### Algorithm Configuration (14 Parameters)

Accessible at: `/admin` → Algorithm Settings

| Parameter | Default | Description |
|-----------|---------|-------------|
| **Date Rules** | | |
| Hard Cutoff Days | 90 | Book date must be within N days of 26AS date |
| Soft Preference Days | 180 | Beyond hard cutoff but within N days → allowed with flag |
| Enforce Books Before 26AS | true | Books dated after 26AS date get penalised |
| **Variance Thresholds** | | |
| Normal Ceiling % | 3.0 | Auto-confirmed if below this; suggested if above |
| Suggested Ceiling % | 20.0 | Maximum variance for a suggested match |
| **Document Filters** | | |
| Include Doc Types | RV, DC, DR | Which SAP doc types to process |
| Exclude Doc Types | CC, BR | Which SAP doc types to skip |
| **Matching Behaviour** | | |
| Max Combo Size | 5 | Maximum invoices in a combo match |
| Noise Threshold (₹) | 1.0 | Ignore SAP entries below this amount |
| Date Clustering Preference | true | Prefer books closest in date when building combo pool |
| Force Match Enabled | true | Whether Phase C runs at all |
| **Advances & Cross-FY** | | |
| Exclude SGL_V | false | Skip advance payments from matching |
| Allow Cross-FY | false | Use prior-year books in main phases (not just Phase E) |
| Lookback Years | 1 | How many prior years to include (if cross-FY enabled) |

### Per-Batch Configuration Override

Individual batches can override admin defaults (Step 2 of batch upload). This allows different settings for:
- Clients with unusual payment patterns (very long date gaps)
- Historical reconciliation (older FYs may need wider variance)
- Special document type configurations per client

---

## 14. Common Use Cases

### Use Case 1: Annual 26AS Reconciliation (Single Client)

**Scenario**: CA firm reconciling one corporate client's FY 2023-24 26AS.

**Steps**:
1. Client provides SAP FBL5N export (Excel)
2. CA downloads 26AS from TRACES
3. Upload both → system auto-detects deductor → Start Run
4. 5 minutes later: 96% match rate, 40 suggested
5. CA reviews 40 suggestions: authorises 35, rejects 5
6. Approves run → downloads Excel
7. Submits to client for ITR filing

**Time**: 30 minutes total (vs 3 days manually)

---

### Use Case 2: Batch Reconciliation (Multiple Clients, Same 26AS)

**Scenario**: Large company with 50+ deductors. Download one consolidated 26AS. Have 50 SAP files.

**Steps**:
1. Upload 26AS once
2. Upload all 50 SAP files in one batch
3. System auto-maps each SAP file to its deductor in 26AS
4. Processing runs for all 50 simultaneously
5. Batch dashboard shows: 47 done, 3 need attention
6. Reviewer bulk-authorises low-risk suggested matches
7. Downloads combined Excel with all 50 parties

**Time**: 30 minutes for all 50 (vs 6 weeks manually)

---

### Use Case 3: Assessment Defence

**Scenario**: Income Tax department queries a TDS credit claim from 3 years ago.

**What the platform provides**:
- Original file hashes prove the exact files used for reconciliation
- Complete audit trail shows who prepared, who reviewed, timestamps
- Methodology tab shows exactly which algorithm phase matched each entry
- Exceptions tab shows all items that were reviewed and resolved
- Score breakdown proves each match was based on systematic criteria

---

### Use Case 4: Prior-Year Exception Handling

**Scenario**: FY 2023-24 26AS has entries for invoices that are in FY 2022-23 SAP books (timing: paid in April 2023 but invoiced in March 2023).

**Without Phase E**: All these entries show as unmatched (U01)
**With Phase E**: Automatically tried against prior-year books, matched as PRIOR_SINGLE with LOW confidence, flagged for CA review

---

### Use Case 5: High-Volume Processing (Large Conglomerate)

**Scenario**: Company with 10,000+ 26AS entries from 500+ deductors.

**Platform capabilities**:
- Batch mode handles unlimited SAP files
- Bipartite matching scales to any number of entries
- DP combo timeout (120s) prevents runaway computation
- asyncio.to_thread keeps server responsive during heavy runs
- Progress polling shows real-time status per party

---

## 15. Glossary

| Term | Definition |
|------|-----------|
| **26AS** | Form 26AS — the government's official statement of TDS credit for a taxpayer, downloadable from TRACES/ITD portal |
| **TDS** | Tax Deducted at Source — tax withheld by payers (deductors) before making payment |
| **TAN** | Tax Deduction Account Number — unique 10-character identifier for each deductor |
| **Deductor** | The company/entity that deducts TDS when making payments (your client, employer, etc.) |
| **SAP FBL5N** | SAP transaction to view customer line items — source of the AR Ledger data |
| **Clearing Document** | SAP document number that groups related payment entries under one settlement |
| **SGL Indicator** | Special G/L indicator in SAP — V = advance, L = letter of credit, etc. |
| **Section 199** | Income Tax Act section governing TDS credit — cannot claim more than what's in 26AS |
| **TRACES** | TDS Reconciliation Analysis and Correction Enabling System — government portal for 26AS |
| **Bipartite Matching** | Graph theory algorithm for optimal 1:1 assignment between two sets |
| **Hungarian Algorithm** | Specific bipartite matching algorithm that guarantees globally optimal assignment |
| **Maker-Checker** | Internal control: one person prepares, a different person reviews/approves |
| **FORCE Match** | Match made under relaxed criteria (>3% variance) — always needs CA review |
| **PRIOR_YEAR** | Match made against prior financial year's SAP books via Phase E |
| **Variance** | Percentage difference: `(26AS_amount - books_sum) / 26AS_amount × 100` |
| **Suggested Match** | System-identified match above auto-confirm threshold — needs CA authorisation |
| **Exception** | Auto-generated review item when a compliance concern is detected |
| **JWT** | JSON Web Token — stateless authentication mechanism |
| **SHA-256** | Cryptographic hash function used for file integrity verification |
| **COMBO_N** | Match type where N SAP invoices are combined to match one 26AS entry |
| **CLR_GROUP** | Phase A match type — books grouped by clearing document |
| **U01/U02/U04** | Unmatched reason codes: no candidate / variance exceeded / amount too small |
| **HIGH/MEDIUM/LOW** | Confidence tiers assigned to each match based on variance and match type |

---

*Documentation generated from codebase analysis · TDS Reco Phase 1 · HRA & Co. / Akurat Advisory*
