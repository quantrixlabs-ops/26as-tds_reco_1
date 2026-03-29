/**
 * RunHistoryPage — filterable/searchable list of all reconciliation runs.
 * Batch runs are grouped by batch_id with expandable per-party breakdown.
 */
import { useMemo, useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Search,
  SlidersHorizontal,
  RefreshCw,
  PlusCircle,
  Layers,
  ChevronDown,
  ChevronUp,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Loader2,
  Download,
  Trash2,
} from 'lucide-react';
import { runsApi, type RunSummary, type RunStatus } from '../lib/api';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Table, type Column } from '../components/ui/Table';
import { useToast } from '../components/ui/Toast';
import { PageWrapper } from '../components/ui/PageHeader';
import { TableSkeleton } from '../components/ui/Skeleton';
import { NoRunsEmpty, NoSearchResultsEmpty } from '../components/ui/EmptyState';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import {
  formatDateTime,
  formatPct,
  matchRateColor,
  runStatusVariant,
  runStatusLabel,
  formatFY,
  cn,
} from '../lib/utils';

const STATUS_OPTIONS: Array<{ value: RunStatus | ''; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'PROCESSING', label: 'Processing' },
  { value: 'PENDING_REVIEW', label: 'Pending Review' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'FAILED', label: 'Failed' },
];

const FY_OPTIONS = [
  '', 'FY2020-21', 'FY2021-22', 'FY2022-23', 'FY2023-24', 'FY2024-25', 'FY2025-26',
];

type ModeFilter = '' | 'SINGLE' | 'BATCH';

// ── Batch group type ────────────────────────────────────────────────────────

interface BatchGroup {
  batch_id: string;
  runs: RunSummary[];
  financial_year: string;
  created_at: string;
  total_parties: number;
  completed: number;
  failed: number;
  processing: number;
  total_matched: number;
  total_26as: number;
  overall_match_rate: number;
  total_unmatched: number;
  total_violations: number;
}

function buildBatchGroups(runs: RunSummary[]): BatchGroup[] {
  const map = new Map<string, RunSummary[]>();
  for (const r of runs) {
    if (r.mode === 'BATCH' && r.batch_id) {
      const list = map.get(r.batch_id) || [];
      list.push(r);
      map.set(r.batch_id, list);
    }
  }

  const groups: BatchGroup[] = [];
  for (const [batch_id, batchRuns] of map) {
    const sorted = batchRuns.sort((a, b) => a.run_number - b.run_number);
    const completed = sorted.filter((r) => r.status !== 'PROCESSING' && r.status !== 'FAILED').length;
    const failed = sorted.filter((r) => r.status === 'FAILED').length;
    const processing = sorted.filter((r) => r.status === 'PROCESSING').length;
    const total_matched = sorted.reduce((s, r) => s + r.matched_count, 0);
    const total_26as = sorted.reduce((s, r) => s + r.total_26as_entries, 0);

    groups.push({
      batch_id,
      runs: sorted,
      financial_year: sorted[0].financial_year,
      created_at: sorted[0].created_at,
      total_parties: sorted.length,
      completed,
      failed,
      processing,
      total_matched,
      total_26as,
      overall_match_rate: total_26as > 0 ? (total_matched / total_26as) * 100 : 0,
      total_unmatched: sorted.reduce((s, r) => s + r.unmatched_26as_count, 0),
      total_violations: sorted.reduce((s, r) => s + r.constraint_violations, 0),
    });
  }

  return groups.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

// ── Match rate color ────────────────────────────────────────────────────────

// matchRateColor imported from utils — 75% is the legal approval gate

function statusIcon(status: string) {
  if (status === 'PROCESSING') return <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin" />;
  if (status === 'FAILED') return <XCircle className="h-3.5 w-3.5 text-red-500" />;
  if (status === 'APPROVED') return <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />;
  if (status === 'PENDING_REVIEW') return <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />;
  if (status === 'REJECTED') return <XCircle className="h-3.5 w-3.5 text-orange-500" />;
  return <CheckCircle className="h-3.5 w-3.5 text-gray-400" />;
}

// ── Batch group card ────────────────────────────────────────────────────────

function BatchGroupCard({ group, onRunClick, onRefresh }: { group: BatchGroup; onRunClick: (id: string) => void; onRefresh: () => void }) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [authResult, setAuthResult] = useState<{ success_count: number; skipped_requires_remarks: number } | null>(null);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authRemarks, setAuthRemarks] = useState('');
  const [rerunning, setRerunning] = useState(false);
  const [showRerunConfirm, setShowRerunConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const hasCompletedRuns = group.completed > 0;
  const allDone = group.processing === 0;
  const borderColor = group.failed > 0
    ? 'border-red-200'
    : !allDone
    ? 'border-blue-200'
    : group.overall_match_rate >= 95
    ? 'border-emerald-200'
    : 'border-gray-200';

  return (
    <div className={cn('border rounded-xl bg-white overflow-hidden transition-all', borderColor)}>
      {/* Batch header row */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-5 py-4 flex items-center gap-4 text-left hover:bg-gray-50/50 transition-colors"
      >
        <div className="flex items-center gap-2 shrink-0">
          <Layers className="h-4 w-4 text-[#1B3A5C]" />
          <span className="text-xs font-bold text-[#1B3A5C] bg-[#1B3A5C]/10 px-2 py-0.5 rounded">
            BATCH
          </span>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-gray-900">
              {group.total_parties} Parties
            </span>
            <span className="text-xs text-gray-400">·</span>
            <span className="text-xs font-medium text-gray-600">{formatFY(group.financial_year)}</span>
            <span className="text-xs text-gray-400">·</span>
            <span className="text-xs text-gray-400">{formatDateTime(group.created_at)}</span>
          </div>
          <p className="text-xs text-gray-500 mt-0.5 truncate">
            {group.runs.slice(0, 3).map((r) => r.deductor_name || '—').join(', ')}
            {group.runs.length > 3 && ` +${group.runs.length - 3} more`}
          </p>
          <div className="flex items-center gap-3 mt-1 flex-wrap">
            {group.completed > 0 && (
              <span className="text-xs text-emerald-600 font-medium">{group.completed} finished</span>
            )}
            {group.processing > 0 && (
              <span className="text-xs text-blue-600 font-medium">{group.processing} processing</span>
            )}
            {group.failed > 0 && (
              <span className="text-xs text-red-600 font-medium">{group.failed} failed</span>
            )}
          </div>
        </div>

        {/* Aggregate stats */}
        <div className="flex items-center gap-6 shrink-0">
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold">Match Rate</p>
            <p className={cn('text-sm font-bold tabular-nums', matchRateColor(group.overall_match_rate))}>
              {formatPct(group.overall_match_rate)}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold">Matched</p>
            <p className="text-sm font-bold text-gray-900 tabular-nums">
              {group.total_matched}/{group.total_26as}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold">Violations</p>
            <p className={cn('text-sm font-bold tabular-nums', group.total_violations > 0 ? 'text-red-600' : 'text-emerald-600')}>
              {group.total_violations}
            </p>
          </div>
        </div>

        <div className="shrink-0 text-gray-400">
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </div>
      </button>

      {/* Expanded per-party breakdown */}
      {expanded && (
        <div className="border-t border-gray-100">
          {/* Aggregate summary bar */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 px-5 py-3 bg-gray-50/50 relative">
            <div className="bg-white rounded-lg px-3 py-2 border border-gray-100">
              <p className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold">Overall Match Rate</p>
              <p className={cn('text-lg font-bold', matchRateColor(group.overall_match_rate))}>
                {formatPct(group.overall_match_rate)}
              </p>
              <p className="text-xs text-gray-400">{group.total_matched} / {group.total_26as} entries</p>
            </div>
            <div className="bg-white rounded-lg px-3 py-2 border border-gray-100">
              <p className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold">Parties</p>
              <p className="text-lg font-bold text-gray-900">{group.total_parties}</p>
              <p className="text-xs text-gray-400">
                {group.completed} finished · {group.failed} failed
              </p>
            </div>
            <div className="bg-white rounded-lg px-3 py-2 border border-gray-100">
              <p className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold">Unmatched 26AS</p>
              <p className={cn('text-lg font-bold', group.total_unmatched > 0 ? 'text-amber-600' : 'text-emerald-600')}>
                {group.total_unmatched}
              </p>
            </div>
            <div className="bg-white rounded-lg px-3 py-2 border border-gray-100">
              <p className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold">Total Violations</p>
              <p className={cn('text-lg font-bold', group.total_violations > 0 ? 'text-red-600' : 'text-emerald-600')}>
                {group.total_violations}
              </p>
            </div>
            {/* Batch actions */}
            {hasCompletedRuns && (
              <div className="col-span-2 sm:col-span-4 flex items-center justify-end gap-3">
                {/* Rerun Batch */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowRerunConfirm(true);
                  }}
                  disabled={rerunning}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
                >
                  {rerunning ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  Rerun Batch
                </button>
                <ConfirmDialog
                  open={showRerunConfirm}
                  onClose={() => setShowRerunConfirm(false)}
                  onConfirm={async () => {
                    setShowRerunConfirm(false);
                    setRerunning(true);
                    try {
                      const res = await runsApi.batchRerun(group.batch_id);
                      onRefresh();
                      toast('Batch rerun started', `${res.total} runs processing. New batch created.`, 'success');
                    } catch (err: any) {
                      const msg = err?.response?.data?.detail || 'Rerun failed';
                      toast('Rerun failed', msg, 'error');
                    } finally {
                      setRerunning(false);
                    }
                  }}
                  title={`Rerun batch (${group.total_parties} parties)?`}
                  description={
                    group.runs.some((r) => r.status === 'APPROVED')
                      ? 'This batch contains APPROVED runs. Rerunning will create a new batch with fresh (unapproved) results. The original approved runs will NOT be affected.'
                      : 'A new batch will be created with fresh reconciliation results. The original batch will not be modified.'
                  }
                  confirmLabel="Rerun batch"
                  variant="info"
                  loading={rerunning}
                  icon={<RefreshCw className="h-5 w-5 text-[#1B3A5C]" />}
                />
                {/* Authorize All Suggested */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setAuthRemarks('');
                    setShowAuthModal(true);
                  }}
                  disabled={authorizing}
                  className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white text-sm font-semibold rounded-lg hover:bg-emerald-700 transition-colors disabled:opacity-50"
                >
                  {authorizing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle className="h-4 w-4" />
                  )}
                  Authorize All Suggested
                </button>
                {/* Download combined Excel */}
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    setDownloading(true);
                    try {
                      await runsApi.batchDownload(group.batch_id);
                      toast('Excel downloaded', `Combined batch workbook saved`, 'success');
                    } catch (err: any) {
                      const msg = err?.response?.data?.detail || err?.message || 'Download failed';
                      toast('Download failed', msg, 'error');
                    } finally {
                      setDownloading(false);
                    }
                  }}
                  disabled={downloading}
                  className="flex items-center gap-2 px-4 py-2 bg-[#1B3A5C] text-white text-sm font-semibold rounded-lg hover:bg-[#15304d] transition-colors disabled:opacity-50"
                >
                  {downloading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                  Download Combined Excel
                </button>
                {/* Delete Batch */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowDeleteConfirm(true);
                  }}
                  disabled={deleting}
                  className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white text-sm font-semibold rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50"
                >
                  {deleting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                  Delete Batch
                </button>
                <ConfirmDialog
                  open={showDeleteConfirm}
                  onClose={() => setShowDeleteConfirm(false)}
                  onConfirm={async () => {
                    setShowDeleteConfirm(false);
                    setDeleting(true);
                    try {
                      const res = await runsApi.batchDelete(group.batch_id);
                      onRefresh();
                      toast('Batch deleted', `${res.deleted_runs} runs permanently deleted.`, 'success');
                    } catch (err: any) {
                      const msg = err?.response?.data?.detail || 'Delete failed';
                      toast('Delete failed', msg, 'error');
                    } finally {
                      setDeleting(false);
                    }
                  }}
                  title={`Delete entire batch (${group.total_parties} parties)?`}
                  description="All matched pairs, suggested matches, exceptions, and uploaded files for every run in this batch will be permanently deleted. Audit logs are preserved. This action cannot be undone."
                  confirmLabel="Delete batch"
                  variant="danger"
                  loading={deleting}
                  icon={<Trash2 className="h-5 w-5 text-red-600" />}
                />
              </div>
            )}
            {/* Feedback message after authorize */}
            {authResult && (
              <div className="col-span-2 sm:col-span-4">
                <div className="text-sm bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg px-4 py-2.5 flex items-center gap-2">
                  <CheckCircle className="h-4 w-4 shrink-0" />
                  <span>
                    {authResult.success_count} suggested match{authResult.success_count !== 1 ? 'es' : ''} authorized and promoted.
                    {authResult.skipped_requires_remarks > 0 && (
                      <> {authResult.skipped_requires_remarks} skipped (require individual review with remarks).</>
                    )}
                  </span>
                  <button onClick={() => setAuthResult(null)} className="ml-auto text-emerald-600 hover:text-emerald-800">
                    <XCircle className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}

            {/* Authorize modal */}
            {showAuthModal && (
              <div className="col-span-2 sm:col-span-4">
                <div className="bg-white border border-gray-200 rounded-xl shadow-lg p-5">
                  <h3 className="text-sm font-bold text-gray-900 mb-3">Authorize All Suggested Matches</h3>
                  <p className="text-xs text-gray-500 mb-3">
                    This will authorize all pending suggested matches across every party in this batch.
                    Add remarks to also include high-variance items that normally require individual review.
                  </p>
                  <textarea
                    value={authRemarks}
                    onChange={(e) => setAuthRemarks(e.target.value)}
                    placeholder="Bulk remarks (optional — required to include high-variance items)..."
                    rows={2}
                    className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-[#1B3A5C] focus:ring-2 focus:ring-[#1B3A5C]/10 placeholder-gray-400 mb-3 resize-none"
                  />
                  <div className="flex items-center justify-end gap-2">
                    <button
                      onClick={() => setShowAuthModal(false)}
                      className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-100 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={async () => {
                        setShowAuthModal(false);
                        setAuthorizing(true);
                        setAuthResult(null);
                        try {
                          const res = await runsApi.batchAuthorizeAllSuggested(
                            group.batch_id,
                            authRemarks.trim() || undefined,
                          );
                          setAuthResult({ success_count: res.success_count, skipped_requires_remarks: res.skipped_requires_remarks });
                          onRefresh();
                        } catch (err) {
                          console.error('Batch authorize failed:', err);
                        } finally {
                          setAuthorizing(false);
                        }
                      }}
                      disabled={authorizing}
                      className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white text-sm font-semibold rounded-lg hover:bg-emerald-700 transition-colors disabled:opacity-50"
                    >
                      <CheckCircle className="h-4 w-4" />
                      {authRemarks.trim() ? 'Authorize All (incl. high-variance)' : 'Authorize All'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Per-party table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-[#1B3A5C] text-white text-xs uppercase tracking-wide">
                  <th className="px-4 py-2.5 text-left">#</th>
                  <th className="px-4 py-2.5 text-left">Deductor</th>
                  <th className="px-4 py-2.5 text-center">TAN</th>
                  <th className="px-4 py-2.5 text-center">Match Rate</th>
                  <th className="px-4 py-2.5 text-center">Matched</th>
                  <th className="px-4 py-2.5 text-center">Unmatched</th>
                  <th className="px-4 py-2.5 text-center">Violations</th>
                  <th className="px-4 py-2.5 text-center">Confidence</th>
                  <th className="px-4 py-2.5 text-center">Status</th>
                  <th className="px-4 py-2.5 text-center">Excel</th>
                </tr>
              </thead>
              <tbody>
                {group.runs.map((r, idx) => (
                  <tr
                    key={r.id}
                    onClick={() => onRunClick(r.id)}
                    className={cn(
                      'border-t border-gray-100 cursor-pointer transition-colors hover:bg-[#1B3A5C]/5',
                      idx % 2 === 0 ? 'bg-white' : 'bg-gray-50/50',
                    )}
                  >
                    <td className="px-4 py-2.5">
                      <span className="font-mono text-xs text-gray-400">#{r.run_number}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      <p className="font-medium text-gray-900 truncate max-w-[200px]">
                        {r.deductor_name || r.sap_file_hash?.slice(0, 12) || '—'}
                      </p>
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <span className="font-mono text-xs text-gray-600">{r.tan || '—'}</span>
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      {r.status === 'PROCESSING' ? (
                        <span className="text-xs text-gray-300">—</span>
                      ) : (
                        <span className={cn('font-bold', matchRateColor(r.match_rate_pct))}>
                          {formatPct(r.match_rate_pct)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-center text-gray-700">
                      {r.status !== 'PROCESSING' ? `${r.matched_count}/${r.total_26as_entries}` : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      {r.status !== 'PROCESSING' ? (
                        <span className={r.unmatched_26as_count > 0 ? 'text-amber-600 font-semibold' : 'text-emerald-600'}>
                          {r.unmatched_26as_count}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      {r.status !== 'PROCESSING' ? (
                        <span className={r.constraint_violations > 0 ? 'text-red-600 font-bold' : 'text-emerald-600'}>
                          {r.constraint_violations}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      {r.status !== 'PROCESSING' && r.status !== 'FAILED' ? (
                        <div className="flex items-center justify-center gap-1 text-[10px]">
                          <span className="text-emerald-600 font-semibold">{r.high_confidence_count}H</span>
                          <span className="text-gray-300">·</span>
                          <span className="text-amber-600 font-semibold">{r.medium_confidence_count}M</span>
                          <span className="text-gray-300">·</span>
                          <span className="text-orange-600 font-semibold">{r.low_confidence_count}L</span>
                        </div>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <div className="flex items-center justify-center gap-1.5">
                        {statusIcon(r.status)}
                        <span className="text-xs">{runStatusLabel(r.status)}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      {r.status !== 'PROCESSING' && r.status !== 'FAILED' && (
                        <button
                          onClick={async (e) => {
                            e.stopPropagation();
                            try {
                              await runsApi.download(r.id);
                              toast('Excel downloaded', `${r.deductor_name || 'Run'} exported`, 'success');
                            } catch (err: any) {
                              toast('Download failed', err?.response?.data?.detail || err?.message || 'Download failed', 'error');
                            }
                          }}
                          className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-gray-600 hover:text-[#1B3A5C] hover:bg-[#1B3A5C]/5 rounded transition-colors"
                          title={`Download Excel for ${r.deductor_name || 'this run'}`}
                        >
                          <Download className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────

interface RunHistoryPageProps {
  defaultMode?: ModeFilter;
}

export default function RunHistoryPage({ defaultMode = '' }: RunHistoryPageProps) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<RunStatus | ''>(
    (searchParams.get('status') as RunStatus | '') || '',
  );
  const [fyFilter, setFyFilter] = useState('');
  const [modeFilter, setModeFilter] = useState<ModeFilter>(defaultMode);

  const { data: runs = [], isLoading, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ['runs'],
    queryFn: runsApi.list,
    refetchInterval: 30_000,
  });

  // "Last refreshed" relative time
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(timer);
  }, []);
  const lastRefreshed = dataUpdatedAt
    ? (() => {
        const secs = Math.floor((Date.now() - dataUpdatedAt) / 1000);
        if (secs < 10) return 'just now';
        if (secs < 60) return `${secs}s ago`;
        const mins = Math.floor(secs / 60);
        return `${mins}m ago`;
      })()
    : null;

  // Apply filters
  const filtered = useMemo(() => {
    return runs
      .filter((r) => {
        if (statusFilter && r.status !== statusFilter) return false;
        if (fyFilter && r.financial_year !== fyFilter) return false;
        if (modeFilter && r.mode !== modeFilter) return false;
        if (search) {
          const q = search.toLowerCase();
          if (
            !(r.deductor_name || '').toLowerCase().includes(q) &&
            !(r.tan || '').toLowerCase().includes(q) &&
            !String(r.run_number).includes(q)
          ) {
            return false;
          }
        }
        return true;
      })
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [runs, search, statusFilter, fyFilter, modeFilter]);

  // Split into single runs and batch groups
  const singleRuns = useMemo(() => filtered.filter((r) => r.mode !== 'BATCH'), [filtered]);
  const batchGroups = useMemo(() => buildBatchGroups(filtered.filter((r) => r.mode === 'BATCH')), [filtered]);

  // Counts for mode toggle
  const singleCount = runs.filter((r) => r.mode !== 'BATCH').length;
  const batchGroupCount = buildBatchGroups(runs.filter((r) => r.mode === 'BATCH')).length;

  // Single run table columns
  const columns: Column<RunSummary>[] = [
    {
      key: 'run_number',
      header: 'Run #',
      sortable: true,
      render: (r) => (
        <span className="font-mono text-xs text-gray-500 font-medium">#{r.run_number}</span>
      ),
    },
    {
      key: 'deductor_name',
      header: 'Deductor',
      sortable: true,
      render: (r) => (
        <div>
          <p className="text-sm font-medium text-gray-900 truncate max-w-[220px]">
            {r.deductor_name}
          </p>
          <p className="text-xs text-gray-400 font-mono">{r.tan}</p>
        </div>
      ),
    },
    {
      key: 'financial_year',
      header: 'FY',
      sortable: true,
      render: (r) => (
        <span className="text-xs font-medium text-gray-600">{formatFY(r.financial_year)}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (r) => (
        <Badge variant={runStatusVariant(r.status)}>{runStatusLabel(r.status)}</Badge>
      ),
    },
    {
      key: 'match_rate_pct',
      header: 'Match Rate',
      align: 'right',
      sortable: true,
      render: (r) =>
        r.status === 'PROCESSING' ? (
          <span className="text-xs text-gray-300">—</span>
        ) : (
          <span className={cn('font-semibold text-sm', matchRateColor(r.match_rate_pct))}>
            {formatPct(r.match_rate_pct)}
          </span>
        ),
    },
    {
      key: 'matched_count',
      header: 'Matched',
      align: 'right',
      sortable: true,
      render: (r) => (
        <span className="text-xs text-gray-600">
          {r.matched_count} / {r.total_26as_entries}
        </span>
      ),
    },
    {
      key: 'constraint_violations',
      header: 'Violations',
      align: 'center',
      sortable: true,
      render: (r) =>
        r.constraint_violations > 0 ? (
          <Badge variant="red" size="sm">{r.constraint_violations}</Badge>
        ) : (
          <span className="text-xs text-emerald-500 font-semibold">0</span>
        ),
    },
    {
      key: 'created_at',
      header: 'Created',
      sortable: true,
      render: (r) => (
        <span className="text-xs text-gray-400">{formatDateTime(r.created_at)}</span>
      ),
    },
  ];

  if (isLoading) {
    return (
      <PageWrapper>
        <div className="flex items-start justify-between">
          <div className="space-y-2">
            <div className="h-6 w-48 bg-gray-200/70 rounded-md animate-pulse" />
            <div className="h-4 w-64 bg-gray-200/70 rounded-md animate-pulse" />
          </div>
          <div className="h-10 w-28 bg-gray-200/70 rounded-lg animate-pulse" />
        </div>
        <Card padding={false}>
          <TableSkeleton columns={7} rows={6} />
        </Card>
      </PageWrapper>
    );
  }

  const hasActiveFilters = !!(search || statusFilter || fyFilter || modeFilter);

  return (
    <PageWrapper>
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-gray-900">
            {defaultMode === 'BATCH' ? 'Batch Run History' : 'Reconciliation History'}
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {runs.length} total run{runs.length !== 1 ? 's' : ''}
            {batchGroupCount > 0 && ` · ${batchGroupCount} batch${batchGroupCount !== 1 ? 'es' : ''}`}
            {filtered.length !== runs.length && ` · ${filtered.length} shown`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => refetch()}
              disabled={isFetching}
              className="p-2 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-50"
            >
              <RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} />
            </button>
            {lastRefreshed && (
              <span className="text-[10px] text-gray-400 whitespace-nowrap">{lastRefreshed}</span>
            )}
          </div>
          <button
            onClick={() => navigate('/runs/new')}
            className="flex items-center gap-2 px-4 py-2 bg-[#1B3A5C] text-white text-sm font-semibold rounded-lg hover:bg-[#15304d] transition-colors"
          >
            <PlusCircle className="h-4 w-4" />
            New Run
          </button>
        </div>
      </div>

      {/* Filters bar */}
      <Card padding={false}>
        <div className="px-4 py-3 border-b border-gray-100 flex flex-wrap items-center gap-3">
          {/* Search */}
          <div className="relative flex-1 min-w-[180px] max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
            <input
              type="text"
              placeholder="Search deductor, TAN, run #…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:border-[#1B3A5C] focus:ring-2 focus:ring-[#1B3A5C]/10"
            />
          </div>

          <SlidersHorizontal className="h-4 w-4 text-gray-400 shrink-0" />

          {/* Mode filter */}
          <div className="flex items-center gap-0.5 bg-gray-100 rounded-lg p-0.5">
            {([
              { value: '' as ModeFilter, label: 'All' },
              { value: 'SINGLE' as ModeFilter, label: `Single (${singleCount})` },
              { value: 'BATCH' as ModeFilter, label: `Batch (${batchGroupCount})` },
            ]).map((opt) => (
              <button
                key={opt.value}
                onClick={() => setModeFilter(opt.value)}
                className={cn(
                  'px-3 py-1.5 text-xs font-medium rounded-md transition-colors',
                  modeFilter === opt.value
                    ? 'bg-white text-[#1B3A5C] shadow-sm'
                    : 'text-gray-500 hover:text-gray-700',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Status filter */}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as RunStatus | '')}
            className="text-sm border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-[#1B3A5C] bg-white text-gray-700"
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>

          {/* FY filter */}
          <select
            value={fyFilter}
            onChange={(e) => setFyFilter(e.target.value)}
            className="text-sm border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-[#1B3A5C] bg-white text-gray-700"
          >
            <option value="">All FYs</option>
            {FY_OPTIONS.filter(Boolean).map((fy) => (
              <option key={fy} value={fy}>
                {formatFY(fy)}
              </option>
            ))}
          </select>

          {hasActiveFilters && (
            <button
              onClick={() => {
                setSearch('');
                setStatusFilter('');
                setFyFilter('');
                setModeFilter('');
              }}
              className="text-xs text-gray-400 hover:text-gray-600 font-medium"
            >
              Clear filters
            </button>
          )}
        </div>
      </Card>

      {/* Batch groups */}
      {(modeFilter === '' || modeFilter === 'BATCH') && batchGroups.length > 0 && (
        <div className="space-y-3">
          {modeFilter === '' && (
            <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
              <Layers className="h-4 w-4 text-[#1B3A5C]" />
              Batch Runs ({batchGroups.length})
            </h2>
          )}
          {batchGroups.map((group) => (
            <BatchGroupCard
              key={group.batch_id}
              group={group}
              onRunClick={(id) => navigate(`/runs/${id}`)}
              onRefresh={() => refetch()}
            />
          ))}
        </div>
      )}

      {/* Single runs table */}
      {(modeFilter === '' || modeFilter === 'SINGLE') && (
        <div>
          {modeFilter === '' && batchGroups.length > 0 && singleRuns.length > 0 && (
            <h2 className="text-sm font-semibold text-gray-700 mb-3">
              Single Runs ({singleRuns.length})
            </h2>
          )}
          <Card padding={false}>
            <Table
              columns={columns}
              data={singleRuns}
              keyExtractor={(r) => r.id}
              onRowClick={(r) => navigate(`/runs/${r.id}`)}
              emptyMessage={
                hasActiveFilters
                  ? 'No runs match your filters'
                  : 'No runs yet. Click "New Run" to get started.'
              }
            />
          </Card>
        </div>
      )}

      {/* Empty state when only batch filter active and no batches */}
      {modeFilter === 'BATCH' && batchGroups.length === 0 && (
        <Card>
          {hasActiveFilters ? (
            <NoSearchResultsEmpty query={search || 'batch'} />
          ) : (
            <NoRunsEmpty onNewRun={() => navigate('/runs/new')} />
          )}
        </Card>
      )}

      {/* Empty state when no runs at all */}
      {runs.length === 0 && !hasActiveFilters && (
        <Card>
          <NoRunsEmpty onNewRun={() => navigate('/runs/new')} />
        </Card>
      )}
    </PageWrapper>
  );
}
