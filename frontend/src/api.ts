/**
 * API client — all fetch calls to the TDS Reco backend
 */

const BASE = '/api';

export interface DeductorCandidate {
  rank: number;
  deductor_name: string;
  tan: string;
  score: number;
  entry_count: number;
}

export interface CleaningReport {
  total_rows_input: number;
  rows_after_cleaning: number;
  excluded_null: number;
  excluded_negative: number;
  excluded_noise: number;
  excluded_doc_type: number;
  excluded_sgl: number;
  flagged_advance: number;
  flagged_ab: number;
  flagged_other_sgl: number;
  duplicates_removed: number;
  split_invoices_flagged: number;
}

export interface MatchedPair {
  as26_index: number;
  as26_date: string | null;
  as26_amount: number;
  section: string;
  books_sum: number;
  variance_amt: number;
  variance_pct: number;
  match_type: string;
  invoice_count: number;
  invoice_refs: string[];
  invoice_dates: (string | null)[];
  invoice_amounts: number[];
  sgl_flags: string[];
}

export interface RecoResult {
  deductor_name: string;
  tan: string;
  fuzzy_score: number | null;
  total_26as_entries: number;
  matched_count: number;
  match_rate_pct: number;
  unmatched_26as_count: number;
  unmatched_books_count: number;
  avg_variance_pct: number;
  constraint_violations: number;
  matched_pairs: MatchedPair[];
  session_id: string;
}

export interface ReconcileResponse {
  status: 'complete' | 'pending' | 'no_match';
  alignment_id?: string;
  top_candidates?: DeductorCandidate[];
  identity_string?: string;
  reco_summary?: RecoResult;
  download_url?: string;
  error_message?: string;
  cleaning_report?: CleaningReport;
}

export async function reconcile(
  sapFile: File,
  as26File: File,
): Promise<ReconcileResponse> {
  const form = new FormData();
  form.append('sap_file', sapFile);
  form.append('as26_file', as26File);

  const res = await fetch(`${BASE}/reconcile`, { method: 'POST', body: form });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || 'Reconciliation failed');
  }
  return res.json();
}

export async function confirmAlignment(
  alignment_id: string,
  deductor_name: string,
  tan: string,
): Promise<ReconcileResponse> {
  const res = await fetch(`${BASE}/confirm-alignment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ alignment_id, deductor_name, tan }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || 'Alignment confirmation failed');
  }
  return res.json();
}

export async function searchDeductor(
  q: string,
  alignment_id: string,
): Promise<DeductorCandidate[]> {
  const res = await fetch(
    `${BASE}/search-deductor?q=${encodeURIComponent(q)}&alignment_id=${alignment_id}`,
  );
  if (!res.ok) throw new Error('Search failed');
  return res.json();
}

export function downloadUrl(session_id: string): string {
  return `${BASE}/download/${session_id}`;
}
