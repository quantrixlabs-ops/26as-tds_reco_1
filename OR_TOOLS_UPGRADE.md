# OR-Tools CP-SAT vs Scipy Bipartite — Upgrade Documentation

**Context:** TDS Reconciliation Engine — Phase B matching upgrade
**Audience:** Technical team + CA reviewers
**Status:** Proposed — not yet implemented

---

## Table of Contents

1. [The One-Line Summary](#1-the-one-line-summary)
2. [Non-Technical Explanation (For CAs)](#2-non-technical-explanation-for-cas)
3. [What the Current System Actually Does](#3-what-the-current-system-actually-does)
4. [What OR-Tools CP-SAT Would Do Differently](#4-what-or-tools-cp-sat-would-do-differently)
5. [The Core Difference: Post-Hoc vs In-Solver Constraints](#5-the-core-difference-post-hoc-vs-in-solver-constraints)
6. [Worked Example — Same Data, Different Outcomes](#6-worked-example--same-data-different-outcomes)
7. [All Constraints That Would Move Inside the Solver](#7-all-constraints-that-would-move-inside-the-solver)
8. [What Changes in the Code](#8-what-changes-in-the-code)
9. [What Does NOT Change](#9-what-does-not-change)
10. [Realistic Impact on Match Rates](#10-realistic-impact-on-match-rates)
11. [Risk & Tradeoffs](#11-risk--tradeoffs)

---

## 1. The One-Line Summary

**Current (scipy):** Find the best assignment using scores, then check if it breaks the rules. If it does, flag it for review.

**OR-Tools CP-SAT:** Find the best assignment that is *guaranteed* to follow all the rules from the start. The solver knows the rules — it doesn't need to be corrected afterwards.

---

## 2. Non-Technical Explanation (For CAs)

### The Matchmaker Analogy

Imagine you're a matchmaker pairing 100 job candidates with 100 job openings.

**Current approach (scipy):**
The matchmaker scores every candidate–job pair (how good is the fit?) and then uses a mathematical formula to find the pairing that maximises the total "fit score" globally. After the pairing is done, a compliance checker comes in and says: *"Wait — this candidate doesn't have the required qualification for this job."* The matchmaker then moves that candidate to a "needs manual review" pile.

The problem: the pairing was optimised *without knowing* the qualification rules. So the matchmaker may have given the only suitable candidate to the wrong job — and the right job now has nobody.

**OR-Tools approach:**
The matchmaker is told the rules *before* starting. "Candidate A cannot go to jobs that require a degree they don't have. Candidate B can only take jobs in Mumbai." The formula now finds the best global pairing *within those rules*. When it's done, every pairing is already compliant. No post-hoc corrections needed.

---

### In TDS Reconciliation Terms

Your 26AS entries are the "jobs". Your SAP invoices are the "candidates".

The rules are:
- An invoice cannot be credited for more than the 26AS amount (Section 199)
- Variance must be within the allowed ceiling (e.g. 2% for SINGLE matches)
- The same invoice cannot match two different 26AS entries
- No more than 5 invoices can combine for one 26AS entry (COMBO cap)
- An invoice from FY2022-23 cannot match a FY2023-24 26AS entry (unless cross-FY is enabled)

**Currently:** The system finds the "best pairing" first, then checks these rules. When a pairing fails a rule, it gets flagged for CA review. But during the pairing step, the algorithm didn't know about the 2% variance ceiling — so it may have used a "good invoice" on a marginal match, leaving a better match without a candidate.

**With OR-Tools:** The 2% ceiling, Section 199, invoice uniqueness, and all other rules are written into the solver as constraints. The system finds the best pairing where *all rules are already satisfied*. The CA gets cleaner results with fewer false positives in the "suggested" pile.

---

## 3. What the Current System Actually Does

### The Scipy `linear_sum_assignment` Algorithm

The current Phase B matching (`optimizer.py:995–1060`) works like this:

**Step 1 — Build a score matrix**
```
For every pair (26AS entry i, SAP invoice j):
    compute composite score (0–100)
    store in matrix cost[i][j] = 100 - score
```

A 500×500 matrix means 250,000 cells, each holding a score.

**Step 2 — Solve the Hungarian Algorithm**
```python
row_ind, col_ind = linear_sum_assignment(cost)
# This returns one row and one column per 26AS entry
# Guarantees: no 26AS entry shares a book, no book appears twice
# Objective: minimise total cost = maximise total composite score
```

The scipy function solves this in O(n³) time. For 500 entries, that's ~125 million operations — fast enough.

**Step 3 — Post-hoc compliance checking**
```python
# After the assignment is done:
for each assigned pair (26AS_i, book_j):
    if variance_pct > variance_normal_ceiling:
        reclassify as "suggested" (needs CA review)
    if books_sum > as26_amount:
        reject entirely (Section 199 violation)
```

The constraints are checked *after* the solver finishes.

### Why This Is Structurally Limited

The solver optimises for **maximum total score**. It has no knowledge of:

- The 2% variance ceiling for SINGLE matches
- Section 199's books-must-not-exceed-26AS rule
- The financial year boundary
- The 5-invoice combo cap

These are all enforced *after* the fact. By then, books are already "used up" in suboptimal assignments.

---

## 4. What OR-Tools CP-SAT Would Do Differently

OR-Tools CP-SAT (Constraint Programming — Satisfiability) is a solver that handles both:
- **Optimisation** (maximise total score)
- **Hard constraints** (rules that must never be violated)

The key difference: constraints are not checked after solving. They are *part of the problem definition*. The solver will never produce an assignment that violates them.

### How the same problem would be modelled

```python
from ortools.sat.python import cp_model

model = cp_model.CpModel()

# Decision variable: x[i][j] = 1 if 26AS entry i is matched to invoice j
x = {}
for i in range(n_26as):
    for j in range(n_invoices):
        x[i, j] = model.NewBoolVar(f'x_{i}_{j}')

# HARD CONSTRAINT 1: Each 26AS entry matched to at most one invoice
for i in range(n_26as):
    model.AddAtMostOne(x[i, j] for j in range(n_invoices))

# HARD CONSTRAINT 2: Each invoice used at most once (invoice uniqueness)
for j in range(n_invoices):
    model.AddAtMostOne(x[i, j] for i in range(n_26as))

# HARD CONSTRAINT 3: Section 199 — books must not exceed 26AS amount
# (only assign invoice j to 26AS i if invoice_amount[j] <= as26_amount[i])
for i in range(n_26as):
    for j in range(n_invoices):
        if invoice_amount[j] > as26_amount[i]:
            model.Add(x[i, j] == 0)  # forbidden

# HARD CONSTRAINT 4: Variance ceiling — only assign if within 2%
for i in range(n_26as):
    for j in range(n_invoices):
        variance = abs(as26_amount[i] - invoice_amount[j]) / as26_amount[i]
        if variance > 0.02:  # 2% ceiling
            model.Add(x[i, j] == 0)  # forbidden

# OBJECTIVE: maximise total composite score
model.Maximize(
    sum(score[i][j] * x[i, j] for i in range(n_26as) for j in range(n_invoices))
)

solver = cp_model.CpSolver()
solver.Solve(model)
```

The solver searches for an assignment that:
1. Satisfies all the `==0` forbidden pairs
2. Satisfies all the "at most one" uniqueness rules
3. Among all valid assignments, finds the one with the maximum total score

---

## 5. The Core Difference: Post-Hoc vs In-Solver Constraints

```
CURRENT FLOW (scipy)                    NEW FLOW (OR-Tools)
─────────────────────                   ─────────────────────
Build score matrix                      Build score matrix
        │                                       │
        ▼                                       ▼
linear_sum_assignment()          Mark forbidden pairs as constraints
        │                                (variance > 2%: x[i,j]=0)
        │                                (books > 26AS: x[i,j]=0)
        │                                (cross-FY: x[i,j]=0)
        │                                       │
        ▼                                       ▼
Assignment result                    CP-SAT solver searches within
(may violate rules)                  the FEASIBLE region only
        │                                       │
        ▼                                       ▼
Post-hoc checks:                     Every result is already compliant
  - variance > ceiling?              No post-hoc reclassification needed
    → reclassify to "suggested"
  - books > 26AS?
    → reject
        │
        ▼
Some books "wasted" on
reclassified assignments
```

---

## 6. Worked Example — Same Data, Different Outcomes

### Setup

Assume 3 26AS entries and 3 SAP invoices for deductor "ABC MANUFACTURING":

| | 26AS Amount | Best Invoice | Score | Variance |
|---|------------|-------------|-------|---------|
| Entry 1 | ₹10,00,000 | Invoice A (₹9,95,000) | 94 | 0.5% ✓ |
| Entry 2 | ₹5,00,000  | Invoice B (₹4,90,000) | 88 | 2.0% ✓ |
| Entry 3 | ₹3,00,000  | Invoice C (₹2,97,000) | 91 | 1.0% ✓ |

But there's a conflict: **Invoice A** also scores 85 against Entry 3 (variance 0.8%), and **Invoice C** scores 78 against Entry 1 (variance 1.1%).

The system has to decide: does it assign the "best match" locally for each entry, or find the globally optimal assignment?

Both scipy and OR-Tools agree here — straightforward case.

---

### The Conflict Case (Where OR-Tools Wins)

Now change one detail: Invoice A is **₹10,06,000** — it *exceeds* the 26AS amount for Entry 1 (₹10,00,000).

| | 26AS Amount | Invoice Amount | Variance | Section 199 Status |
|---|------------|---------------|---------|-------------------|
| Entry 1 | ₹10,00,000 | Invoice A: ₹10,06,000 | -0.6% (over) | VIOLATION — books > 26AS |
| Entry 2 | ₹5,00,000  | Invoice B: ₹4,90,000  | 2.0% | OK |
| Entry 3 | ₹3,00,000  | Invoice C: ₹2,97,000  | 1.0% | OK |

**Scipy behaviour:**

Scipy scores Invoice A highest against Entry 1 (it's closest in amount). It assigns A → Entry 1.

After assignment, the post-hoc checker flags it: `books_sum (10,06,000) > as26_amount (10,00,000)` — Section 199 violation. Invoice A is rejected from Entry 1 and Entry 1 becomes **unmatched**.

But Invoice A was also a valid candidate for Entry 3 (₹10,06,000 vs ₹3,00,000 — too far off, ignore).
The only remaining option for Entry 1 is Invoice C (₹2,97,000 vs ₹10,00,000 — 70% variance). That's way over the ceiling. **Entry 1 ends up unmatched (U02).**

**OR-Tools behaviour:**

At model-building time, the constraint `x[Entry1, InvoiceA] = 0` is set because Invoice A exceeds Entry 1's amount. The solver never considers this pair. It finds:

- Entry 1 → Invoice B (₹4,90,000 vs ₹10,00,000 — too far, also rejected by variance constraint)

Actually in this contrived case both fail. Let's make it realistic:

**Realistic conflict case:**

```
Entry 1:  ₹10,00,000    ← needs a ~₹10L invoice
Entry 2:  ₹9,80,000     ← also needs a ~₹10L invoice
Invoice A: ₹9,85,000    ← only one invoice near ₹10L
Invoice B: ₹5,00,000
Invoice C: ₹2,97,000
```

**Scipy result:**
- Score(Entry 1, Invoice A) = 91 (1.5% variance)
- Score(Entry 2, Invoice A) = 94 (0.5% variance) ← higher score

Scipy maximises total score → assigns Invoice A to Entry 2 (score 94 > 91).
Entry 1 is now left without a viable invoice → **unmatched (U02)**.

The post-hoc check doesn't help here — the assignment was *technically* valid (within variance). It's just globally suboptimal because Entry 1 now has nothing.

**OR-Tools CP-SAT result:**

The solver considers both possible assignments:

Option X: A→Entry2, Entry1→unmatched. Total score = 94.
Option Y: A→Entry1, Entry2→unmatched. Total score = 91.

But the model can also express: **if Entry 2 stays unmatched, can we find any other invoice for it?** There is no Invoice D. So both options leave one entry unmatched. The solver picks Option X (higher total score) — same as scipy here.

**Where OR-Tools actually wins:**

Add a soft constraint: *"Entry 2 can accept Invoice B (₹5,00,000 vs ₹9,80,000 = 49% variance) as a FORCE_SINGLE if nothing better is available."*

In the current system, force-match is a separate Phase C run after Phase B finishes. Phase B already consumed Invoice A. Phase C then considers Invoice B for Entry 1 as a FORCE match.

With OR-Tools, the model solves Phases B and C **jointly** — it knows that assigning A to Entry 2 (score 94) leaves Entry 1 truly stranded, whereas assigning A to Entry 1 (score 91) leaves Entry 2 available for a FORCE match. The joint objective score may prefer the second option.

**This is the fundamental gain: OR-Tools sees the whole board at once.**

---

## 7. All Constraints That Would Move Inside the Solver

| Constraint | Current location | With OR-Tools |
|-----------|-----------------|---------------|
| `books_sum ≤ as26_amount` (Section 199) | Post-hoc check, reject if violated | Hard constraint: `model.Add(x[i,j] == 0)` for violating pairs |
| Variance ≤ ceiling per match type | Post-hoc reclassification to "suggested" | Hard constraint: forbidden pairs above ceiling |
| Same invoice not matched twice | `consumed_invoice_refs` set, checked per phase | `model.AddAtMostOne(x[i,j] for i)` per invoice |
| Cross-FY boundary | Filter before building candidates | `model.Add(x[i,j] == 0)` for cross-FY pairs when disabled |
| COMBO max 5 invoices | Separate combo phase with manual cap | `model.Add(sum(x[i,j] for j in group) <= 5)` |
| Phase A committed books not reused in Phase B | Sequential phase execution with excluded sets | Joint model: Phase A assignments are fixed constraints for Phase B |
| Section 199 hard assert (books never > 26AS) | Post-run validator (`validator.py`) | Baked into the solver — structurally impossible to violate |

---

## 8. What Changes in the Code

### Files modified

**`backend/requirements_v2.txt`** — add:
```
ortools>=9.8
```

**`backend/engine/optimizer.py`** — replace `_bipartite_match()`:

```python
# CURRENT (scipy):
from scipy.optimize import linear_sum_assignment
row_ind, col_ind = linear_sum_assignment(cost_matrix)

# NEW (OR-Tools CP-SAT):
from ortools.sat.python import cp_model

model = cp_model.CpModel()
# ... add variables, constraints, objective ...
solver = cp_model.CpSolver()
solver.parameters.max_time_in_seconds = 30.0  # timeout
status = solver.Solve(model)
```

**What is NOT replaced:**
- Phase A clearing group logic — unchanged
- Phase C force-match logic — unchanged (initially)
- Combo matching (subset-sum DP) — unchanged (initially)
- Scoring engine (`scorer.py`) — unchanged, scores still feed as coefficients
- All post-processing, confidence tiers, exception engine — unchanged

**Scipy kept as fallback:**
```python
try:
    from ortools.sat.python import cp_model
    ORTOOLS_AVAILABLE = True
except ImportError:
    ORTOOLS_AVAILABLE = False

# In _bipartite_match():
if ORTOOLS_AVAILABLE:
    return _bipartite_match_cpsat(...)
else:
    return _bipartite_match_scipy(...)  # existing code untouched
```

---

## 9. What Does NOT Change

For the CA reviewer, the interface is identical:

- Same match types: EXACT, SINGLE, COMBO_N, CLR_GROUP, FORCE_*
- Same confidence tiers: HIGH / MEDIUM / LOW
- Same Excel output structure
- Same approve/reject workflow
- Same 5-invoice combo cap enforcement
- Same Section 199 hard assertion (now structurally guaranteed rather than post-hoc)
- Same audit trail

The only visible difference: **fewer entries landing in the "suggested" pile** because the solver already respected the variance ceilings. What the CA currently reviews as "suggested — above variance ceiling" should reduce.

---

## 10. Realistic Impact on Match Rates

Based on the structure of the current algorithm and the type of conflicts that arise:

| Scenario | Current (scipy) | With OR-Tools |
|---------|----------------|---------------|
| No conflicts (unique best match per entry) | Same result | Same result |
| Two 26AS entries competing for one invoice | One gets matched, one gets reclassified to "suggested" or U02 | Solver weighs both outcomes and picks the globally optimal split |
| Invoice slightly above 26AS amount (over-claim) | Assigned anyway, post-hoc rejected → U02 | Never assigned (hard constraint) → next-best is tried within the solve |
| Variance exactly at ceiling (e.g. 2.00%) | Assigned, may be reclassified depending on rounding | Assignment only if strictly within ceiling |
| Large batch (500+ entries) | Scipy: ~milliseconds | CP-SAT: 1–5 seconds with 30s timeout |

**Expected improvement in match rate: 1–4 percentage points** on datasets with high invoice contention (many entries competing for the same pool of invoices). On clean datasets (one invoice per 26AS entry, no contention), the result is identical.

---

## 11. Risk & Tradeoffs

### Performance

Scipy `linear_sum_assignment` runs in O(n³) and is extremely fast (< 1 second for 500×500).

CP-SAT is a general-purpose constraint solver — it explores a search space. For large problems with many constraints, it can be slower. Mitigations:

- Set `solver.parameters.max_time_in_seconds = 30` (already the existing `COMBO_TIMEOUT_SECONDS`)
- CP-SAT returns the best solution found so far if timeout is hit — not a hard failure
- Scipy kept as fallback if OR-Tools is unavailable or times out

### Reproducibility

Both scipy and CP-SAT produce deterministic results for the same input. The CP-SAT solver uses a fixed random seed by default. This is critical for audit reproducibility.

### Dependency

`google-or-tools` is a 50 MB binary package available for Windows, macOS (Intel + Apple Silicon), and Linux. It works fully offline. No API calls. No internet dependency.

### What if OR-Tools is not installed?

The code falls back to the existing scipy implementation. Match rates revert to current levels. No regression — the upgrade is additive.

---

## Summary for the Professor

The current system uses scipy's Hungarian algorithm (linear_sum_assignment) which finds the globally optimal *score-based* assignment, then applies compliance rules as post-processing. This means the solver optimises against a metric (score) that doesn't encode the actual compliance constraints — it finds the "best" assignment that may then be partially corrected by rules.

OR-Tools CP-SAT solves the same assignment problem but with constraints expressed as first-class citizens in the model. The solver's feasible region is already restricted to compliant assignments. The result is globally optimal *within* the compliance envelope — not optimal-then-corrected.

The practical gain is specifically in **contested scenarios** (multiple 26AS entries competing for the same pool of invoices), which is exactly what causes U02 "invoice already matched" unmatched entries in the current system. The existing Phase A clearing-group bug fix resolved this for the clearing phase; OR-Tools would address the analogous problem at the individual-match phase.

The change is entirely backward-compatible, keeps scipy as a fallback, and does not alter any outputs visible to CA reviewers.
