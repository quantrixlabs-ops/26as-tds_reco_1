# CLAUDE.local.md

Local-only instructions for testing and working with uploaded files. Do NOT commit this file.

## Test Data Location

Place test Excel files in `backend/test_data/`:
```
backend/test_data/
├── sap/              # SAP AR Ledger files (one per deductor)
│   ├── VASHI_ELECTRICALS.xlsx
│   └── ABB_INDIA.xlsx
└── 26as/             # Form 26AS files
    └── MASTER_26AS_FY2023-24.xlsx
```

Create the directory if it doesn't exist: `mkdir -p backend/test_data/sap backend/test_data/26as`

## SAP AR Ledger File Format

SAP files are **positional** (column names are ignored, only index matters). Minimum 15 columns:

| Index | Column | Required | Example |
|-------|--------|----------|---------|
| 0 | Company Code | no | 1000 |
| 1 | Customer | no | 100234 |
| 2 | Customer Name | no | ABC Corp |
| 3 | Account | no | 110100 |
| **4** | **Clearing Document** | **yes** | 5000012345 |
| **5** | **Document Type** | **yes** | RV, DC, DR |
| **6** | **Document Date** | **yes** | 2023-06-15 |
| 7 | Posting Date | no | 2023-06-15 |
| **8** | **Special G/L ind.** | **yes** | (blank), V, O, A, N, L, E, U |
| 9 | Currency | no | INR |
| **10** | **Amount in local cur.** | **yes** | 150000.00 |
| 11 | Tax Amount | no | 15000.00 |
| 12 | Document Number | no | 1400056789 |
| 13 | Reference | no | PO-2023-001 |
| **14** | **Invoice Reference** | **yes** | INV/2023/0042 |

Rules applied during cleaning:
- **Doc types kept**: RV, DC, DR (fallback to all if none found)
- **Doc types excluded**: CC, BR
- **SGL excluded**: L, E, U
- **SGL flagged**: V (advance), O/A/N (other)
- **Noise filter**: amounts < Rs.1 excluded
- **Dedup**: same (invoice_ref, clearing_doc, amount) = true duplicate removed; different clearing_doc = separate payment event kept

## Form 26AS File Format

26AS files are **header-detected** (column names matter). The parser searches first 5 rows for headers.

Required columns (flexible naming via regex):
| Canonical Name | Accepted Headers |
|----------------|-----------------|
| `deductor_name` | "Name of Deductor", "Particulars", "Deductor Name", "Name" |
| `tan` | "TAN of Deductor", "TAN" |
| `amount` | "Amount Paid/Credited", "Amount Credited", "Amount" |
| `status` | "Status of Booking", "Status of..." |
| `section` | "Section" (optional but expected) |
| `transaction_date` | "Transaction Date", "Date", "Date of Payment/Credit" (optional) |
| `invoice_number` | "Invoice Number", "Invoice No" (optional) |

Rules:
- Only **Status = F** (Final) rows are processed
- "Amount Paid/Credited" column is used (NOT "Tax Deducted" or "TDS Deposited")
- Sheets named "tanwise" or "summary" are skipped for main data
- Header auto-detected within first 5 rows by searching for "Name of Deductor"

## Quick Test via CLI

```bash
# Single-party test (from backend/)
curl -X POST http://localhost:8000/api/runs \
  -H "Authorization: Bearer $TOKEN" \
  -F "sap_file=@test_data/sap/VASHI_ELECTRICALS.xlsx" \
  -F "as26_file=@test_data/26as/MASTER_26AS_FY2023-24.xlsx" \
  -F "financial_year=FY2023-24"

# Get auth token first
TOKEN=$(curl -s -X POST http://localhost:8000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@tds.com","password":"admin123"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
```

## Quick Test via UI

1. `http://localhost:3000` -> login `admin@tds.com` / `admin123`
2. Dashboard -> "New Run" button
3. Upload SAP file + 26AS file, pick FY, confirm party mapping, run
4. Processing is async — progress bar updates every 800ms
5. Results page shows matched/unmatched/exceptions

## Known Gotchas

- **LOT 3 WORKINGS files are NOT raw SAP** — they're pre-reconciled outputs with only 6 columns. You need original 15-column SAP AR Ledger exports.
- **Multi-deductor SAP files cause invoice reuse violations** — in batch mode, use one SAP file per deductor. If you combine all deductors into one SAP file, the same invoice refs across different parties trigger compliance violations.
- **PuLP CBC may fail on Apple Silicon** — the bundled binary is x86_64. The engine auto-detects and falls back to scipy/greedy. No action needed.
- **SQLite lock after benchmark** — if you run `benchmark.py` and it crashes, a stale lock may remain. Kill lingering python processes: `lsof -ti:8000 | xargs kill -9` and delete `reco.db-wal` / `reco.db-shm` if needed.
- **DB reset** — delete `backend/reco.db*` and restart the server. Tables auto-create on startup. You'll need to re-register via the setup page.

## Environment

- Backend: `uvicorn main_v2:app --reload --port 8000` (from `backend/`)
- Frontend: `npm run dev` (from `frontend/`, serves on port 3000)
- Login: `admin@tds.com` / `admin123`
- API docs: `http://localhost:8000/api/docs`
