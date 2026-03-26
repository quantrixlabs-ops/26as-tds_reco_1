# TDS Reconciliation Platform — Complete Feature Reference

**Version**: v2.3.0 | **Algorithm**: v5.3
**Purpose**: Matches government Form 26AS entries against SAP AR Ledger to verify TDS credit claims under Section 199 of the Income Tax Act.

---

## Table of Contents

1. [Authentication & Onboarding](#1-authentication--onboarding)
2. [Dashboard](#2-dashboard)
3. [New Run (Upload & Configure)](#3-new-run-upload--configure)
4. [Run Detail Page](#4-run-detail-page)
5. [Run History](#5-run-history)
6. [Administration](#6-administration)
7. [Sidebar Navigation & Layout](#7-sidebar-navigation--layout)
8. [Role-Based Access Control](#8-role-based-access-control)
9. [Real-Time Processing Pipeline](#9-real-time-processing-pipeline)
10. [Reconciliation Algorithm (5 Phases)](#10-reconciliation-algorithm-5-phases)

---

## 1. Authentication & Onboarding

### 1.1 Setup Page (`/setup`)

Available only when **no users exist** in the system. Creates the first administrator account.

| Field | Validation |
|-------|-----------|
| Full Name | Minimum 2 characters |
| Email | Valid email format |
| Password | Minimum 8 characters |
| Confirm Password | Must match password |

- A blue info banner reads: *"This form is only available before any users are registered."*
- On success, the user is automatically logged in and redirected to the Dashboard.
- Once the first user is created, this page redirects authenticated users to `/` and shows the login form to unauthenticated visitors.

### 1.2 Login Page (`/login`)

Standard email + password authentication.

| Element | Detail |
|---------|--------|
| Email input | Mail icon, required |
| Password input | Lock icon, required |
| Submit button | "Sign in" — shows a spinner while authenticating |
| Error banner | Red alert with `AlertCircle` icon on authentication failure |
| Setup link | "Create your first account" — only relevant before any user exists |

- On successful login, a JWT token is stored in `localStorage`.
- If already authenticated, the page auto-redirects to Dashboard.
- Login state is managed via React Context (`AuthProvider`), making the current user available to all components.

---

## 2. Dashboard

**Route**: `/` (home page after login)

### 2.1 Greeting Header

- Time-of-day greeting: "Good morning / Good afternoon / Good evening, [First Name]"
- Subtitle: "26AS TDS Reconciliation Platform · HRA & Co."
- **New Run** button (navy blue, `PlusCircle` icon) — navigates to `/runs/new`

### 2.2 Stats Grid (4 Cards)

| Card | Value | Color Logic |
|------|-------|-------------|
| **Total Runs** | Count of all runs | Navy accent |
| **Avg Match Rate** | Average match_rate_pct across all runs | Green if >= 95%, navy otherwise |
| **Pending Review** | Count of `PENDING_REVIEW` runs | Amber if > 0, green if 0 |
| **Failed** | Count of `FAILED` runs | Red if > 0, green if 0 |

### 2.3 Recent Runs Table (Left Column, 2/3 Width)

Displays the **8 most recent** runs sorted by creation date (newest first).

| Column | Detail |
|--------|--------|
| Run # | Monospace, e.g. `#42` |
| Deductor | Name (truncated) + TAN below |
| FY | Formatted as "FY 2023-24" |
| Status | Color-coded badge (green=Approved, amber=Pending Review, red=Failed, blue=Processing, gray=Rejected) |
| Match Rate | Right-aligned percentage, color-coded: green >= 95%, amber >= 80%, red < 80% |
| Created | Date + time |

- Rows are **clickable** — navigates to the run's detail page.
- Columns are **sortable** by Run #, Deductor, Match Rate, and Created date.
- "View all" link in the header navigates to Run History.
- Empty state: *"No runs yet. Click 'New Run' to get started."*

### 2.4 Right Column (3 Stacked Cards)

#### Match Rate Trend Chart
- Area chart (Recharts library) showing the last **10 completed runs**.
- X-axis: Run labels (e.g., "Run #42").
- Y-axis: Match rate 0–100%.
- Navy gradient fill with dot markers.
- Tooltip shows exact percentage on hover.
- If fewer than 2 completed runs: *"Need at least 2 completed runs"*.

#### Quick Actions
- **Start New Reconciliation** — navy button, navigates to `/runs/new`
- **View All Runs** — bordered button, navigates to `/runs`
- **Review N pending runs** — amber-bordered button, only shown when pending > 0, navigates to `/runs?status=PENDING_REVIEW`

#### Compliance Note (Blue Card)
- Info icon + static text: *"Section 199 requires books_sum ≤ 26AS amount. Approved runs are eligible for client deliverables."*

### 2.5 Auto-Refresh

Dashboard data refreshes automatically every **15 seconds**.

---

## 3. New Run (Upload & Configure)

**Route**: `/runs/new`

### 3.1 Mode Toggle

A two-button toggle at the top of the page:

| Mode | Description |
|------|-------------|
| **Single Party** | One SAP file + one 26AS file → one reconciliation run |
| **Batch Multi-Party** | Multiple SAP files + one 26AS file → multiple runs (one per deductor) |

The description text below the toggle changes based on the selected mode.

---

### 3.2 Single Party Mode

#### Step 1 of 2: Upload Files

| Element | Detail |
|---------|--------|
| Financial Year Selector | Dropdown with options: FY2020-21 through FY2025-26 |
| SAP AR Ledger upload zone | Drag-and-drop or click-to-browse. Shows file name + size + checkmark when selected. Clear (X) button to remove. Hint: *"Excel file exported from SAP (FBL5N or similar)"* |
| Form 26AS upload zone | Same pattern. Hint: *"26AS Excel download from TRACES / ITD portal"* |
| Info banner (yellow) | *"Only Status=F (Final) entries from Form 26AS will be processed..."* |
| Continue button | Disabled until both files are selected |
| Cancel button | Resets the form |

#### Step 2 of 2: Mapping Review

After uploading, the system performs **fuzzy name matching** between the SAP filename and 26AS deductor names.

**SAP File Identity Card:**
- File icon + filename
- "Identity: [extracted name]" — derived from the SAP filename (underscores become spaces, uppercased)
- Mapping status badge:
  - **Auto (95%)** — green, auto-confirmed (score >= 95 AND second candidate < 80)
  - **Review (87%)** — amber, needs user confirmation (score 80–94)
  - **No match** — red, manual search required (score < 80)
- Match score percentage

**Party Selection:**
- Selected party shown as an emerald chip (deductor name + TAN)
- "Change selection" link toggles a searchable dropdown
- **Search input**: "Search by name or TAN…"
- **Dropdown list** of all deductors found in the 26AS file:
  - Party name (bold)
  - TAN (monospace)
  - Entry count
  - Highlighted if currently selected
  - Scrollable (max height ~208px)
- If no deductor info found in 26AS: shows an "All Data" badge (blue) — uses all 26AS entries

**Start Reconciliation** button — disabled until a party is selected. Submits the run (returns HTTP 202, processing runs asynchronously). Navigates to the Run Detail page.

---

### 3.3 Batch Mode

#### Step 1 of 3: Upload Files

| Element | Detail |
|---------|--------|
| Financial Year Selector | Same as Single mode |
| Form 26AS upload | Single file upload (required) |
| SAP AR Ledger files | **Multiple file upload** — drag-and-drop multiple or click to browse. Tip: *"Name each file after the deductor (e.g ACME_LIMITED.xlsx)"*. Shows list of selected files with name + size + remove (X) button. "+ Add more files" button to append. Count label: "N files selected". |
| Info banner (blue) | *"Auto-mapping: Each SAP filename is fuzzy-matched..."* |
| Preview Mappings button | Disabled until at least one SAP file and the 26AS file are selected |

#### Step 2 of 3: Algorithm Configuration (Optional)

A collapsible settings card with a **Use Admin Defaults** toggle:

- **If toggled ON**: Uses the admin-configured algorithm settings. Shows a summary of default values and last-updated timestamp.
- **If toggled OFF**: Exposes all configurable parameters:

| Section | Parameters |
|---------|-----------|
| **Document Filters** | Include doc types (toggleable buttons: RV, DR, DC). Exclude doc types (toggleable buttons: CC, BR). |
| **Date Rules** | Hard cutoff (days, default 90). Soft preference (days, default 180). Checkbox: "Books date must be on or before 26AS date". |
| **Variance Thresholds** | Normal ceiling % (default 3.0, step 0.5). Suggested ceiling % (default 20.0, step 0.5). |
| **Matching Behavior** | Max combo size (default 5, 0=unlimited). Noise threshold Rs. (default 1.0, step 0.5). Checkbox: "Date clustering preference". Checkbox: "Force match enabled". |
| **Advances & Cross-FY** | Checkbox: "Exclude advance payments (SGL_V)". Checkbox: "Allow cross-FY matching". If cross-FY enabled: "Lookback years" input (1–3). |

#### Step 3 of 3: Review Mappings

**Header indicators:**
- Green badge: "N ready"
- Amber badge (if any): "M need review"

**Per-file card** (scrollable list, max-height 60vh):
- File icon + filename
- Extracted identity string
- Arrow icon →
- Status badge or multi-party count
- Selected party chips (max 2 visible; overflow shows "+N more" with expand)
- "+ Select parties" or "+ Add party" button

**Multi-select dropdown** (per file):
- Search input (auto-focused on open)
- Checkbox list of all deductors from the 26AS:
  - Party name
  - TAN + entry count
  - Check/uncheck state
  - Scrollable (max ~192px)
- "N selected" count
- Done button

**Batch Actions:**
- **"Run All — N parties"** button — disabled if no mappings are resolved
- Warning text if some files will be skipped (no mapping set)
- While submitting: a loading card shows *"Running batch reconciliation… Processing N parties sequentially…"*

---

## 4. Run Detail Page

**Route**: `/runs/:id`

This is the most feature-rich page in the application. It displays complete reconciliation results for a single party.

### 4.1 Header Bar

**Left side:**
- Back arrow button (navigates to `/runs`)
- **"Run #N"** title
- Status badge (color-coded)
- Constraint violations badge (red, shown only if violations > 0)
- Subtitle line: Deductor name · TAN · Financial Year

**Right side (action buttons):**

| Button | Visibility | Action |
|--------|-----------|--------|
| **Refresh** (icon only) | Always | Refreshes data from server |
| **Stop** | Only during `PROCESSING` | Cancels the running reconciliation (red border) |
| **Delete** (trash icon) | When not `PROCESSING` | Opens delete confirmation modal |
| **Re-run** | When not `PROCESSING` | Opens re-run confirmation modal. Creates a new run using the same uploaded files. |
| **Download** | When not `PROCESSING` or `FAILED` | Downloads the 6-sheet Excel output |
| **Approve** | Reviewer/Admin only, when `PENDING_REVIEW` and not own run | Approves the run (green button) |
| **Reject** | Reviewer/Admin only, when `PENDING_REVIEW` and not own run | Opens rejection panel (red border) |

### 4.2 Confirmation Modals

#### Delete Confirmation
- Trash icon in a red circle
- Title: "Delete Run #N?"
- Warning: *"This action cannot be undone"*
- Body: *"All matched pairs, exceptions, audit trail entries, and uploaded files for this run will be permanently deleted."*
- Buttons: Cancel | Delete permanently

#### Re-run Confirmation
- Refresh icon in a blue circle
- Title: "Re-run #N?"
- Body: *"A new reconciliation will be created using the same files and settings. The original run will not be modified."*
- Buttons: Cancel | Re-run reconciliation
- On success: navigates to the new run's detail page

#### Rejection Panel (Inline Card)
- Red-bordered card with red background
- "Rejection notes" title
- Textarea: "Reason for rejection (required)…"
- **Confirm Rejection** button (disabled until notes are entered)
- Cancel button

### 4.3 Live Progress Panel

Shown **only during `PROCESSING` status**. Displays a real-time pipeline visualization.

**Header:**
- Animated spinner (or checkmark when complete, or X when failed)
- Current stage label + detail text
- Overall progress percentage (large, bold)

**Progress Bar:**
- Navy gradient fill (animates to the current percentage)
- Turns emerald on completion, red on failure
- Pulses while waiting in queue

**Stats Row (4 cards):**
| Stat | Detail |
|------|--------|
| 26AS Entries | Total count from the parsed file |
| SAP Entries | Total count from the parsed file |
| Matched | Running count + current match rate % |
| Elapsed / Duration | Time elapsed with ETA if available (e.g., "12s (ETA: ~35s)") |

**Pipeline Visualization:**

Horizontal chip row showing all 11 stages:
1. **Parse** — Reading SAP & 26AS files
2. **Validate** — Checking data integrity & formats
3. **Phase A** — Matching clearing document groups
4. **Phase B₁** — Single invoice optimal assignment (bipartite)
5. **Phase B₂** — Multi-invoice ILP optimization (combo)
6. **Phase C** — Relaxed variance force-match
7. **Phase E** — Cross-FY exception matching
8. **Comply** — Section 199, uniqueness, combo cap check
9. **Save** — Writing matched pairs to database
10. **Except** — Generating review items
11. **Finalize** — Computing stats & completing run

Each chip shows:
- Green checkmark + green background = completed
- Spinning loader + navy background = currently active
- Gray background = upcoming

Below the chips: a vertical grid listing all stages with their full names and descriptions.

**Polling**: Progress is fetched every **800ms** via `GET /api/runs/{id}/progress`.

### 4.4 Metrics Grid (6 Cards)

| Metric | Value | Color Logic |
|--------|-------|-------------|
| **Match Rate** | Percentage | Green >= 95%, amber >= 80%, red < 80% |
| **Matched** | "N / M 26AS entries" | Navy |
| **Suggested** | Count + "(Needs review)" or "(All resolved)" | Amber if > 0, green if 0 |
| **Unmatched 26AS** | Count | Red if > 0, green if 0 |
| **Violations** | Count of constraint violations | Red if > 0, green if 0 |
| **Control Total** | "Balanced" / "Unbalanced" / "N/A" | Green=Balanced, red=Unbalanced, gray=N/A |

### 4.5 Financial Summary Card

Visible when status is not `PROCESSING` or `FAILED` and total 26AS amount > 0.

5-column layout:

| Column | Value | Color |
|--------|-------|-------|
| **Total as per 26AS** | Sum of all 26AS amounts | Navy bold |
| **Total as per Books** | Computed total from SAP | Gray bold, with SAP entry count subtitle |
| **Matched Total** | Sum of matched 26AS amounts | Emerald bold, with pair count subtitle |
| **Unmatched Total** | Sum of unmatched 26AS amounts | Red if > 0, emerald if 0, with entry count subtitle |
| **Suggested Matches Total** | Derived amount (26AS - matched - unmatched) | Amber if > 0, emerald if 0, with entry count subtitle |

All amounts are formatted as Indian Rupees (₹ with commas: e.g., ₹11,02,200.00).

### 4.6 Count Integrity Warning

A red alert card shown when:
`matched_count + suggested_count + unmatched_26as_count ≠ total_26as_entries`

Displays the exact breakdown and suggests re-running the reconciliation.

### 4.7 Confidence Breakdown Card

Three horizontal progress bars:

| Tier | Bar Color | Description |
|------|-----------|-------------|
| **High Confidence** | Emerald | Variance ≤ 1%, non-FORCE match |
| **Medium Confidence** | Amber | Variance 1–5%, non-FORCE match |
| **Low Confidence** | Orange | FORCE or PRIOR_YEAR match |

Each bar shows the count of matches in that tier. Bar width is proportional to `tier_count / total_matched`.

**Conditional badges** (shown if applicable):
- "PAN issues detected" (red badge)
- "Rate mismatches" (orange badge)

### 4.8 Metadata Card

Displays run properties in a 4-column grid:

| Field | Format |
|-------|--------|
| Run Number | Monospace (#N) |
| Financial Year | Formatted (e.g., "FY 2023-24") |
| Deductor | Full name (truncated with tooltip) |
| TAN | Monospace |
| Status | Color-coded badge |
| Algorithm | Monospace version string (e.g., "v5") |
| Created | Full date/time |
| Completed | Full date/time |
| SAP File Hash (SHA-256) | Full hash, monospace, break-all |
| 26AS File Hash (SHA-256) | Full hash, monospace, break-all |

### 4.9 Tabs (9 Tabs)

Radix UI Tabs with horizontal scrolling. Each tab has an icon, label, and optional count badge.

---

#### Tab 1: Matched Pairs

**Icon**: CheckCircle | **Badge**: matched count

**Header**: "N matched pairs · Sec 199 compliant"

**Table Columns:**

| Column | Align | Detail |
|--------|-------|--------|
| Expand/Collapse | — | Chevron icon |
| 26AS # | Left | Monospace index |
| Date | Left | Formatted date |
| Section | Left | Monospace (e.g., "194C") |
| 26AS Amount | Right | Monospace currency (₹) |
| Books Sum | Right | Monospace currency (₹) |
| Variance | Right | Percentage, color: red > 3%, amber > 1%, gray ≤ 1% |
| Type | Left | Monospace match type (EXACT, SINGLE, COMBO_3, etc.) |
| Confidence | Left | Badge: HIGH (green), MEDIUM (yellow), LOW (orange) |
| Invoices | Left | "N inv" text with tooltip showing full refs |

**Expanded Detail Row** (on click): A 3-column panel with navy left border:

**Invoice Details:**
- List of invoice references with amounts and dates
- Clearing Document number

**Score Breakdown:**
- Composite score (bold, e.g., "82.0")
- 5 factor bars:
  - **Variance** — how close the amounts are
  - **Date Proximity** — how close the dates are
  - **Section Match** — whether TDS section codes align
  - **Clearing Doc** — whether clearing documents match
  - **Historical** — historical pattern scoring
- Each bar shows a navy fill proportional to the score (0–100%) with the percentage label

**Match Info:**
- Match Type (e.g., SINGLE, COMBO_3)
- Confidence tier badge
- Variance Amount (₹)
- Cross-FY flag (Yes badge / "No" text)
- Prior Year flag (Yes badge / "No" text)
- **AI Risk Flag** (red box): shown if the match has been flagged by the AI risk detector, with the risk reason
- **Audit Remark** (amber box): shown if a remark was added during matching

**States:**
- Loading: 5 skeleton rows with pulse animation
- Error: AlertTriangle + error message
- Empty: *"No matched pairs for this run"*

---

#### Tab 2: Unmatched 26AS

**Icon**: AlertTriangle | **Badge**: unmatched count

**Header**: "N unmatched 26AS entries" (with amber warning icon)

**Table Columns:**

| Column | Detail |
|--------|--------|
| Expand/Collapse | Chevron icon |
| # | Monospace index |
| Deductor | Name (truncated to 30 chars) |
| TAN | Monospace |
| Section | Monospace |
| Date | Formatted |
| Amount | Right-aligned currency |
| Reason | Red monospace reason code (e.g., "U01") + reason label below |

**Reason Codes:**
- **U01**: No matching invoice found in SAP
- **U02**: Invoice found but variance exceeds all thresholds
- **U04**: Amount too small or negative

**Expanded Detail Row**: 4-column grid showing Full Deductor Name, TAN, Section, Amount, Transaction Date, Reason Code, Reason Detail.

**Empty state**: *"All 26AS entries matched"*

---

#### Tab 3: Unmatched Books

**Icon**: BookOpen

**Header**: "N unmatched SAP book entries"

**Table Columns:**

| Column | Detail |
|--------|--------|
| Expand/Collapse | Chevron |
| Invoice Ref | Monospace (truncated to 24 chars) |
| Clearing Doc | Monospace |
| Doc Date | Formatted |
| Amount | Right-aligned currency |
| Doc Type | Monospace (RV, DC, DR) |
| SGL Flag | Yellow badge if present (e.g., "SGL_V"), dash if not |

**Expanded Detail Row**: 3-column grid showing Full Invoice Ref, Clearing Document, Amount, Document Type, Document Date, SGL Flag.

**Empty state**: *"No unmatched book entries"*

---

#### Tab 4: Suggested Matches

**Icon**: Lightbulb

An authorization workflow for matches that need human review.

**Header Bar:**
- Left: "N suggested matches" + status badges (N pending / N authorized / N rejected)
- Right: **Authorize Selected (N)** button (navy) and **Reject Selected (N)** button (red border) — appear when items are selected

**Category Summary Row:**
Clickable category badges acting as quick filters. Categories:

| Category | Badge Color | Meaning |
|----------|-------------|---------|
| HIGH_VARIANCE_3_20 | Yellow | Variance between 3–20% |
| HIGH_VARIANCE_20_PLUS | Red | Variance exceeds 20% |
| DATE_SOFT_PREFERENCE | Blue | Date falls outside preferred window |
| ADVANCE_PAYMENT | Violet | SGL_V advance payment |
| FORCE | Orange | Force-matched entry |
| CROSS_FY | Gray | Cross-financial-year match |

**Filter Pills Row:**
- Filter icon + pill buttons: All, Variance 3-20%, Variance 20%+, Date Pref., Advance, Force, Cross-FY
- Active pill is navy; inactive is gray
- "Select All Pending" checkbox (right side) — bulk selects all pending items in current filter

**Item List:**
Each suggested match shows:
- Checkbox (for pending items only)
- Expand/Collapse chevron
- **Top row**: Category badge + 26AS index + Section + Date + Status badge (Pending/Authorized/Rejected) + "Remarks required" indicator (if applicable)
- **Second row**: 26AS amount (bold) + Books sum + Variance % (color-coded) + Match type
- **Third row**: Truncated invoice references
- **Alert message** (if any): amber warning with the alert text

**Expanded Detail Row** (3-column panel):

1. **Invoice Details**: Invoice refs with amounts + dates, clearing doc
2. **Match Info**: Match type, confidence badge, composite score, variance amount, cross-FY flag, prior year flag
3. **Authorization**: Status badge, authorized/rejected timestamp, remarks, rejection reason

**Authorization Modal** (when remarks required):
- Title: "Authorize N Suggested Match(es)"
- Warning if remarks required
- Textarea for remarks (required or optional depending on selection)
- Cancel | Confirm buttons

**Rejection Modal:**
- Title: "Reject N Suggested Match(es)"
- Textarea for reason (optional)
- Cancel | Confirm Rejection buttons

After authorization, suggested matches are **promoted to matched pairs** — the matched/unmatched counts update automatically.

---

#### Tab 5: Section Summary

**Icon**: PieChart

Groups matched pairs by TDS section code (e.g., 194C, 194J, 194H).

**Header**: "N sections across M matched pairs"

**Table** (navy header row):

| Column | Detail |
|--------|--------|
| Section | Monospace, navy bold (e.g., "194C") |
| Matches | Count per section |
| 26AS Amount | Sum of 26AS amounts |
| Books Sum | Sum of books amounts |
| Avg Variance | Color-coded: red > 3%, amber > 1%, gray ≤ 1% |
| Confidence Distribution | Badges: "H: N" (green) + "M: N" (yellow) + "L: N" (orange) |

**Footer Row**: Totals for Matches, 26AS Amount, and Books Sum.

Sorted by total 26AS amount (descending).

---

#### Tab 6: Resolution Tracker

**Icon**: ListChecks

Aggregates all items that need attention: high-variance matches, low-confidence matches, force matches, and unmatched entries.

**Header:**
- "N issues requiring attention"
- Severity badges: "N critical" (red) + "N warning" (amber) + "N info" (blue)

**Filter Buttons**: All Issues | High Variance | Low Confidence | Force Match | Unmatched

**Summary Bar**: "Showing N of M items" + "Total impact: ₹X,XX,XXX"

**Item List** (sorted by severity, then by amount descending):

| Severity | Icon | Item Types |
|----------|------|-----------|
| **Critical** | Red AlertTriangle | Unmatched 26AS entries, matches with variance > 5% |
| **Warning** | Amber Clock | Low confidence matches, force matches, matches with variance 2–5% |
| **Info** | Blue CheckCircle | Unmatched book entries (top 50 by amount) |

Each item shows:
- Severity icon
- Severity-colored label (e.g., "High Variance Match", "Force Match", "Unmatched 26AS")
- Reference (e.g., "26AS #42")
- Section + Date
- Detail line (e.g., "Variance 4.2% (₹1,761.00) — 1 invoice(s)")
- Amount (right-aligned, monospace)

---

#### Tab 7: Methodology

**Icon**: FileText

Explains the reconciliation algorithm's 5 phases with actual data from the current run.

**Header**: "Matching Methodology — Algorithm v5"

**Collapsible Phase Sections:**

Each phase shows:
- Phase label (e.g., "Phase A — Clearing Group")
- Match count badge (green if > 0, gray if 0)
- Description text
- **Percentage of total matches** from this phase (right side, with total amount)

**Expanded content per phase:**
- **Variance Cap**: The configured threshold for this phase
- **Actual Avg**: The actual average variance achieved (color-coded)
- **Match Types**: Navy-tinted chips listing all match types (e.g., `CLR_GROUP`, `EXACT`, `SINGLE`)
- **Volume Bar**: Progress bar showing this phase's contribution to total matches (e.g., "342 / 4336")
- **Rules**: Bulleted list of compliance rules for this phase

---

#### Tab 8: Exceptions

**Icon**: ClipboardList | **Badge**: unreviewed exception count

Auto-generated exception items that require human review.

**Header**: "N unreviewed exceptions"

**Table Columns:**

| Column | Detail |
|--------|--------|
| Severity | Badge: CRITICAL (deep red), HIGH (red), MEDIUM (yellow), LOW (gray) |
| Category | Text label (e.g., "VARIANCE", "COUNT_MISMATCH") |
| Description | Truncated to 60 chars |
| Amount | Monospace currency (or dash if N/A) |
| Status | "Reviewed" badge (green, with action type) or "Pending" badge (yellow) |
| Actions | "Review" link (only for pending items, only for Reviewer/Admin users) |

**Inline Review Form** (when "Review" is clicked):
- Action dropdown: Acknowledge / Waive / Escalate
- Notes input
- Save / Cancel buttons

After review, the exception's status updates to the chosen action (ACKNOWLEDGED, WAIVED, ESCALATED).

---

#### Tab 9: Audit Trail

**Icon**: Activity

A chronological timeline of all events for this run.

Each event shows:
- Navy dot + connecting line (timeline visual)
- **Event type** (bold) + **Actor role** badge (gray)
- Actor name · Timestamp
- Notes (italicized, if present)

Example events:
- RUN_CREATED — when the run was initiated
- PROCESSING_STARTED — when the engine began
- PROCESSING_COMPLETED — when results were saved
- RUN_APPROVED / RUN_REJECTED — when a reviewer took action
- EXCEPTION_REVIEWED — when an exception was reviewed

**Empty state**: *"No audit events yet"*

### 4.10 Error & Not Found States

**Run Not Found (404)**:
- Red AlertTriangle in a circle
- "Run Not Found" title
- *"This run does not exist or has been deleted."*
- "Back to Run History" button

**Failed to Load**:
- Same layout with "Failed to Load Run" title
- Error message detail
- "Back to Run History" + "Retry" buttons

---

## 5. Run History

**Route**: `/runs`

### 5.1 Header

- Title: "Reconciliation History"
- Subtitle: "X total runs · Y batches · Z shown" (dynamic counts)
- **Refresh** button (icon)
- **New Run** button (navy)

### 5.2 Filters Bar

A card containing:

| Filter | Type | Options |
|--------|------|---------|
| **Search** | Text input | "Search deductor, TAN, run #…" (with Search icon) |
| **Mode** | 3-button toggle | All / Single (N) / Batch (M) |
| **Status** | Dropdown | All statuses / Processing / Pending Review / Approved / Rejected / Failed |
| **FY** | Dropdown | All FYs / FY 2020-21 through FY 2025-26 |
| **Clear filters** | Link | Shown only when any filter is active |

### 5.3 Batch Runs Section

Shown when mode filter is "All" or "Batch" and batch runs exist.

**Heading**: "Batch Runs (N)"

Each batch is displayed as a **BatchGroupCard**:

**Collapsed view:**
- "BATCH" badge (navy)
- "N Parties · FY YYYY-YY · Timestamp"
- Status summary: "N finished" (green) + "N processing" (blue) + "N failed" (red)
- Aggregate stats: Match Rate %, Matched "X / Y", Violations count
- Expand/Collapse chevron

**Expanded view:**

**Summary bar (4 cards):**

| Card | Value |
|------|-------|
| Overall Match Rate | Percentage (color-coded) + "X / Y entries" |
| Parties | Count + "N finished · M failed" |
| Unmatched 26AS | Count (color-coded) |
| Total Violations | Count (color-coded) |

**Batch Actions** (shown when completed runs exist):
- **Rerun Batch** — blue button
- **Authorize All Suggested** — emerald button (opens confirmation modal with remarks textarea)
- **Download Combined Excel** — navy button

After "Authorize All Suggested":
- Green feedback message: *"N suggested matches authorized and promoted"*
- Note: *"M skipped (require individual review with remarks)"*

**Per-party table** (dark navy header):

| Column | Detail |
|--------|--------|
| # | Run number (monospace) |
| Deductor | Name (truncated) |
| TAN | Monospace |
| Match Rate | Percentage or "—" if processing |
| Matched | "X / Y" or "—" |
| Unmatched | Count (color-coded) or "—" |
| Violations | Count (color-coded) or "—" |
| Confidence | "NH·AM·OL" format (High count, Medium count, Low count) |
| Status | Icon + label (spinner if processing, checkmark if approved, X if failed, etc.) |

Rows are clickable — navigate to individual run detail.

### 5.4 Single Runs Section

Shown when mode filter is "All" or "Single" and single-party runs exist.

**Heading** (if batches also shown): "Single Runs (N)"

**Table Columns:**

| Column | Sortable | Detail |
|--------|----------|--------|
| Run # | Yes | Monospace |
| Deductor | Yes | Name + TAN below |
| FY | — | Formatted |
| Status | — | Badge |
| Match Rate | Yes | Percentage or "—" |
| Matched | Yes | "X / Y" |
| Violations | — | Badge if > 0 |
| Created | Yes | Timestamp |

Rows are clickable — navigate to run detail.

### 5.5 Empty States

- Batch filter, no batches: *"No batch runs yet"*
- Filtered results empty: *"No runs match your filters"*
- No runs at all: *"No runs yet. Click 'New Run' to get started."*

### 5.6 Auto-Refresh

Run list refreshes every **30 seconds**.

---

## 6. Administration

**Route**: `/admin` (ADMIN role only)

### 6.1 Header

- Title: "Administration"
- Subtitle: "User management and platform settings"
- **Add User** button (UserPlus icon, toggles the create user form)

### 6.2 Maker-Checker Policy Notice

A blue info card explaining:
- PREPARERs cannot approve their own runs
- REVIEWER/ADMIN must review runs created by someone else
- This is enforced on both frontend and backend

### 6.3 Algorithm Settings Card (Collapsible)

**Header** (clickable to expand/collapse):
- SlidersHorizontal icon
- "Algorithm Settings"
- "Configure reconciliation engine parameters"
- "14 parameters" badge
- Chevron

**Expanded Content:**

**Use Admin Defaults Toggle** — switch with "Last updated: [date]"

When custom settings are enabled, 5 configuration sections are shown:

| Section | Parameters |
|---------|-----------|
| **Document Filters** | Tag inputs for included/excluded doc types |
| **Date Rules** | Hard cutoff days (number), Soft preference days (number), "Enforce books before 26AS date" checkbox |
| **Variance Thresholds** | Normal ceiling % (number, step 0.1), Suggested ceiling % (number, step 0.5) |
| **Matching Behavior** | Max combo size (number), Noise threshold Rs. (number, step 0.5), "Date clustering preference" checkbox, "Force match enabled" checkbox |
| **Advances & Cross-FY** | "Exclude SGL_V (advances)" checkbox, "Allow cross-FY matching" checkbox, Lookback years (conditional, 1–5) |

**Save Settings** button (navy) — shows spinner while saving, checkmark on success. Displays "Last updated: [timestamp]" in footer.

### 6.4 User Management

**Layout**: 2/3 + 1/3 grid

**Left: User List Table**

| Column | Detail |
|--------|--------|
| Name | Avatar initial circle + name + "(you)" if current user |
| Email | Email address |
| Role | Badge: navy=ADMIN, blue=REVIEWER, gray=PREPARER |
| User ID | Monospace, first 8 chars + "…" |

**Right: Create User Form** (shown when "Add User" is toggled on)

| Field | Detail |
|-------|--------|
| Full name | User icon, required |
| Email | Mail icon, required |
| Password | Lock icon, "Min 8 chars" |
| Confirm password | Lock icon, "Repeat" |
| Role | Radio buttons with descriptions |

**Role Descriptions:**
- **PREPARER**: "Can upload files and start reconciliation runs"
- **REVIEWER**: "Can approve or reject runs prepared by others"
- **ADMIN**: "Full access including user management"

"Create user" button (with UserPlus icon). On success: toast notification "User created: [name] ([role])".

---

## 7. Sidebar Navigation & Layout

### 7.1 Desktop Sidebar (Left, 224px Wide)

**Logo area:**
- TDS logo badge (white-on-navy square)
- "26AS Matcher" title
- "TDS Reco Platform" subtitle

**Navigation items:**

| Item | Icon | Route | Visibility |
|------|------|-------|-----------|
| Dashboard | LayoutDashboard | `/` | All users |
| Run History | FolderOpen | `/runs` | All users |
| New Run | PlusCircle | `/runs/new` | All users |
| Admin | ShieldCheck | `/admin` | ADMIN only |

Active item: navy background (`#1B3A5C`) with white text.
Inactive items: gray text with hover white background effect.
Each item shows a subtle chevron-right on hover.

**User footer:**
- Avatar circle with first letter of name
- Full name + Role
- **Sign out** button (LogOut icon)

### 7.2 Mobile Sidebar

- **Hamburger menu** button in the top bar (visible on screens < 1024px)
- Opens as a slide-over overlay with dark backdrop
- **X button** to close
- Same content as desktop sidebar
- Closes automatically when a nav link is clicked

### 7.3 Top Bar

- Hamburger button (mobile only)
- Flex spacer
- User info (right): Full name (bold) · Role

### 7.4 Page Content Area

- Max width: 1280px (centered)
- Horizontal padding: 16px (mobile) / 24px (desktop)
- Vertical padding: 24px
- Scrollable (overflow-y auto)

---

## 8. Role-Based Access Control

Three roles with hierarchical permissions:

| Feature | PREPARER | REVIEWER | ADMIN |
|---------|----------|----------|-------|
| View Dashboard | Yes | Yes | Yes |
| Create Single Run | Yes | Yes | Yes |
| Create Batch Run | Yes | Yes | Yes |
| View Run Detail | Yes | Yes | Yes |
| Download Excel | Yes | Yes | Yes |
| Re-run a Run | Yes | Yes | Yes |
| Delete a Run | Yes | Yes | Yes |
| Approve/Reject Runs | No | Yes (not own) | Yes (not own) |
| Review Exceptions | No | Yes | Yes |
| Authorize Suggested Matches | Yes | Yes | Yes |
| View Admin Page | No | No | Yes |
| Create Users | No | No | Yes |
| Modify Algorithm Settings | No | No | Yes |

**Maker-Checker Enforcement**: A user cannot approve or reject a run that they created (`created_by ≠ user.id`). This prevents the same person from both preparing and reviewing a reconciliation, as required by audit standards.

---

## 9. Real-Time Processing Pipeline

When a run is submitted (Single or Batch), the backend processes it asynchronously:

1. The API returns **HTTP 202** immediately with the run ID.
2. Processing runs as a background `asyncio.create_task`.
3. Frontend polls `GET /api/runs/{id}/progress` every **800ms**.
4. The Run Detail page auto-refreshes summary data every **5 seconds** while status is `PROCESSING`.

**11 Pipeline Stages:**

| # | Stage | Description |
|---|-------|-------------|
| 1 | PARSING | Reading and parsing SAP & 26AS Excel files |
| 2 | VALIDATING | Checking data integrity, column detection, format validation |
| 3 | PHASE_A | Clearing Group matching (shared clearing documents) |
| 4 | PHASE_B_SINGLE | Bipartite matching — scipy optimal assignment for single invoices |
| 5 | PHASE_B_COMBO | Combo matching — PuLP ILP optimization for multi-invoice combos |
| 6 | PHASE_C | Force matching — relaxed variance last-resort matching |
| 7 | PHASE_E | Prior-year exception matching (when cross-FY disabled) |
| 8 | POST_VALIDATE | Compliance validation (Section 199, invoice uniqueness, combo cap) |
| 9 | PERSISTING | Writing all matched pairs, unmatched entries to database |
| 10 | EXCEPTIONS | Auto-generating exception items for review |
| 11 | FINALIZING | Computing final stats, updating run status |

---

## 10. Reconciliation Algorithm (5 Phases)

### Phase A — Clearing Group Matching
- Groups SAP entries sharing a **Clearing Document** number
- Group size: 2–5 entries (hard cap at `MAX_COMBO_SIZE=5`)
- Variance tolerance: ≤ 3%
- books_sum must not exceed as26_amount (Section 199 compliance)
- Match type: `CLR_GROUP`

### Phase B — Individual Matching
Progressive matching from strictest to most relaxed:

| Strategy | Max Variance | Invoices | Match Type |
|----------|-------------|----------|-----------|
| Exact | 0% | 1 | `EXACT` |
| Single | ≤ 2% | 1 | `SINGLE` |
| Combo 2 | ≤ 2% | 2 | `COMBO_2` |
| Combo 3–5 | ≤ 3% | 3–5 | `COMBO_3` to `COMBO_5` |

- Uses **scipy bipartite** assignment for single-invoice matching (optimal global assignment)
- Uses **PuLP ILP** (Integer Linear Programming) for combo matching
- Per-size combo budget prevents combinatorial explosion
- Pool cap: 50 candidate books per 26AS entry
- Iteration budget: 50K combinations

### Phase C — Restricted Force-Match
Last-resort matching for remaining unmatched entries:

| Strategy | Max Variance | Max Invoices | Match Type |
|----------|-------------|-------------|-----------|
| Force Single | ≤ 5% | 1 | `FORCE_SINGLE` |
| Force Combo | ≤ 2% | 3 | `FORCE_COMBO` |

- All force matches are classified as **LOW confidence**
- Returns `None` if no match found (does not blindly force-fit)

### Phase E — Prior-Year Exception
- Only runs when `ALLOW_CROSS_FY=False` (default)
- Matches current-year 26AS entries against **prior financial year** SAP books
- Uses Phase B matching logic
- Tagged with `PRIOR_*` match types (PRIOR_EXACT, PRIOR_SINGLE, PRIOR_COMBO)
- Always LOW confidence

### Phase D — Truly Unmatched
Entries that could not be matched in any phase. Assigned reason codes:

| Code | Meaning |
|------|---------|
| **U01** | No matching invoice found in SAP books |
| **U02** | Invoice found but variance exceeds all thresholds |
| **U04** | Amount too small (< ₹1) or negative |

### Confidence Tiers

| Tier | Criteria |
|------|---------|
| **HIGH** | Variance ≤ 1% AND not a FORCE or PRIOR match |
| **MEDIUM** | Variance 1–5% AND not a FORCE or PRIOR match |
| **LOW** | Any FORCE match OR any PRIOR_YEAR match |

### Compliance Rules (Always Enforced)

1. **Section 199 Hard Assert**: `books_sum` must NEVER exceed `as26_amount`
2. **Invoice Uniqueness**: Same invoice cannot back two different matches (`consumed_invoice_refs` set)
3. **Combo Size Cap**: `MAX_COMBO_SIZE=5` enforced in ALL phases including CLR_GROUP
4. **FY Boundary**: Prior-FY books separated into Phase E when cross-FY is disabled
5. **Post-run Validation**: Invoice uniqueness + books ≤ 26AS + combo cap + FY boundary checked after all phases

---

## Excel Download Output

The downloadable Excel workbook contains **6 sheets**:

1. **Summary** — Run metadata, stats, and compliance status
2. **Matched Pairs** — All matched entries with scores and invoice details
3. **Unmatched 26AS** — Unmatched government entries with reason codes
4. **Unmatched Books** — Unmatched SAP entries
5. **Exceptions** — Auto-generated exception items
6. **Audit Trail** — Event log with actors and timestamps

File hashes (SHA-256) of the original uploaded files are embedded for audit traceability.
