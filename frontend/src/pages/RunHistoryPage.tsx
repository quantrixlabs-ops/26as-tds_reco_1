/**
 * RunHistoryPage — filterable/searchable list of all reconciliation runs.
 * Batch runs are grouped by batch_id with expandable per-party breakdown.
 */
import { useMemo, useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Search,
  SlidersHorizontal,
  RefreshCw,
  PlusCircle,
  Layers,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Loader2,
  Download,
  Trash2,
  Pencil,
  Check,
  X,
  Plus,
  Tag,
  BarChart3,
  Clock,
} from 'lucide-react';
import { runsApi, settingsApi, type RunSummary, type RunStatus } from '../lib/api';
import { useAuth } from '../lib/auth';
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
  batch_name: string | null;
  batch_tags: string[] | null;
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
      batch_name: sorted[0].batch_name ?? null,
      batch_tags: sorted[0].batch_tags ?? null,
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

// ── Batch Comparison Panel ────────────────────────────────────────────────────

function BatchComparisonPanel({ batchId }: { batchId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['batch-compare', batchId],
    queryFn: () => runsApi.batchCompare(batchId),
    staleTime: 60_000,
  });

  if (isLoading) return (
    <div className="flex items-center justify-center py-4">
      <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
      <span className="text-xs text-gray-400 ml-2">Loading comparison...</span>
    </div>
  );
  if (!data || !data.has_parent) return (
    <div className="px-5 py-4 text-xs text-gray-500">
      No parent batch found — comparison requires a rerun batch.
    </div>
  );

  const fmtDelta = (v: number, suffix = '') => {
    if (v === 0) return <span className="text-gray-400">0{suffix}</span>;
    const color = v > 0 ? 'text-emerald-600' : 'text-red-600';
    return <span className={cn('font-semibold', color)}>{v > 0 ? '+' : ''}{v}{suffix}</span>;
  };

  return (
    <div className="px-5 py-4">
      <p className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold mb-2">
        Rerun vs Original — Per-Party Delta
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-gray-200 text-gray-500 text-left">
              <th className="py-1.5 pr-3 font-semibold">Party</th>
              <th className="py-1.5 px-2 text-center font-semibold">Match Rate</th>
              <th className="py-1.5 px-2 text-center font-semibold">Matched</th>
              <th className="py-1.5 px-2 text-center font-semibold">Suggested</th>
              <th className="py-1.5 px-2 text-center font-semibold">Unmatched</th>
              <th className="py-1.5 px-2 text-center font-semibold">Violations</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {data.parties.map((p) => (
              <tr key={p.current.run_id}>
                <td className="py-1.5 pr-3 text-gray-700 font-medium truncate max-w-[200px]">
                  {p.current.deductor_name || `RUN-${String(p.current.run_number).padStart(4, '0')}`}
                </td>
                <td className="py-1.5 px-2 text-center">
                  {p.delta ? fmtDelta(p.delta.match_rate_pct, '%') : '—'}
                </td>
                <td className="py-1.5 px-2 text-center">
                  {p.delta ? fmtDelta(p.delta.matched_count) : '—'}
                </td>
                <td className="py-1.5 px-2 text-center">
                  {p.delta ? fmtDelta(p.delta.suggested_count) : '—'}
                </td>
                <td className="py-1.5 px-2 text-center">
                  {p.delta ? fmtDelta(-p.delta.unmatched_26as_count) : '—'}
                </td>
                <td className="py-1.5 px-2 text-center">
                  {p.delta ? fmtDelta(-p.delta.constraint_violations) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}


// ── Batch Progress Panel ─────────────────────────────────────────────────────

function BatchProgressPanel({ batchId }: { batchId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['batch-progress', batchId],
    queryFn: () => runsApi.batchProgress(batchId),
    refetchInterval: (query) => {
      // Stop polling once batch is complete
      return query.state.data?.is_complete ? false : 2000;
    },
  });

  if (isLoading) return (
    <div className="flex items-center justify-center py-4">
      <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
      <span className="text-xs text-gray-400 ml-2">Loading progress...</span>
    </div>
  );
  if (!data) return null;

  const { overall_pct, total_runs, completed, failed, processing, runs } = data;

  return (
    <div className="px-5 py-4 space-y-3">
      {/* Overall progress bar */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-xs font-semibold text-gray-700">
            Batch Progress — {completed + failed}/{total_runs} parties done
          </p>
          <span className="text-xs font-bold text-[#1B3A5C]">{overall_pct.toFixed(0)}%</span>
        </div>
        <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
          <div
            className={cn(
              'h-full rounded-full transition-all duration-500',
              failed > 0 && processing === 0 ? 'bg-amber-500' : 'bg-[#1B3A5C]',
            )}
            style={{ width: `${overall_pct}%` }}
          />
        </div>
        <div className="flex items-center gap-4 mt-1.5 text-[10px] text-gray-500">
          {processing > 0 && <span className="flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin text-blue-500" />{processing} processing</span>}
          {completed > 0 && <span className="text-emerald-600 font-medium">{completed} completed</span>}
          {failed > 0 && <span className="text-red-600 font-medium">{failed} failed</span>}
        </div>
      </div>

      {/* Per-run progress rows */}
      <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
        {runs.map((r) => (
          <div key={r.run_id} className="flex items-center gap-3">
            <div className="w-36 truncate text-xs text-gray-600 font-medium">
              {r.deductor_name || r.sap_filename}
            </div>
            <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
              <div
                className={cn(
                  'h-full rounded-full transition-all duration-300',
                  r.status === 'FAILED' ? 'bg-red-400' :
                  r.status === 'PROCESSING' ? 'bg-blue-500' :
                  'bg-emerald-500',
                )}
                style={{ width: `${r.progress_pct}%` }}
              />
            </div>
            <span className="w-12 text-right text-[10px] font-semibold text-gray-500">
              {r.status === 'FAILED' ? 'FAIL' : `${r.progress_pct.toFixed(0)}%`}
            </span>
            <span className="w-16 text-right text-[10px] text-gray-400">
              {r.stage}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}


// ── Batch Analytics Panel ────────────────────────────────────────────────────

function BatchAnalyticsPanel({ batchId }: { batchId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['batch-analytics', batchId],
    queryFn: () => runsApi.batchAnalytics(batchId),
    staleTime: 30_000,
  });

  if (isLoading) return (
    <div className="flex items-center justify-center py-6">
      <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
      <span className="text-xs text-gray-400 ml-2">Loading analytics...</span>
    </div>
  );
  if (!data) return null;

  const { confidence_distribution: conf, match_type_breakdown: mt, financial_waterfall: fw, risk_matrix: risk } = data;
  const confTotal = Object.values(conf).reduce((s, v) => s + v, 0) || 1;
  const fmtAmt = (n: number) => n >= 10_000_000 ? `${(n / 10_000_000).toFixed(2)} Cr` : n >= 100_000 ? `${(n / 100_000).toFixed(2)} L` : n.toLocaleString('en-IN', { maximumFractionDigits: 0 });

  return (
    <div className="px-5 py-4 space-y-4">
      {/* Row 1: Confidence + Match Types + Financial Waterfall */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Confidence Distribution */}
        <div className="bg-white border border-gray-100 rounded-lg p-3">
          <p className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold mb-2">Confidence Distribution</p>
          <div className="space-y-2">
            {(['HIGH', 'MEDIUM', 'LOW'] as const).map((tier) => {
              const count = conf[tier] || 0;
              const pct = (count / confTotal * 100);
              const color = tier === 'HIGH' ? 'bg-emerald-500' : tier === 'MEDIUM' ? 'bg-amber-500' : 'bg-orange-500';
              return (
                <div key={tier}>
                  <div className="flex items-center justify-between text-xs mb-0.5">
                    <span className="text-gray-600">{tier}</span>
                    <span className="font-semibold text-gray-900">{count} ({pct.toFixed(0)}%)</span>
                  </div>
                  <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Match Type Breakdown */}
        <div className="bg-white border border-gray-100 rounded-lg p-3">
          <p className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold mb-2">Match Type Breakdown</p>
          <div className="space-y-1.5 max-h-[120px] overflow-y-auto">
            {Object.entries(mt).sort((a, b) => b[1] - a[1]).map(([type, count]) => (
              <div key={type} className="flex items-center justify-between text-xs">
                <span className="text-gray-600 font-mono truncate mr-2">{type}</span>
                <span className="font-semibold text-gray-900 shrink-0">{count}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Financial Waterfall */}
        <div className="bg-white border border-gray-100 rounded-lg p-3">
          <p className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold mb-2">Financial Summary</p>
          <div className="space-y-2">
            {[
              { label: 'Total 26AS', value: fw.total_26as, color: 'text-gray-900' },
              { label: 'Matched', value: fw.matched, color: 'text-emerald-600' },
              { label: 'Suggested', value: fw.suggested, color: 'text-amber-600' },
              { label: 'Unmatched', value: fw.unmatched, color: 'text-red-600' },
            ].map((row) => (
              <div key={row.label} className="flex items-center justify-between text-xs">
                <span className="text-gray-600">{row.label}</span>
                <span className={cn('font-semibold font-mono', row.color)}>{fmtAmt(row.value)}</span>
              </div>
            ))}
            {fw.total_26as > 0 && (
              <div className="h-3 bg-gray-100 rounded-full overflow-hidden flex">
                <div className="bg-emerald-500 h-full" style={{ width: `${(fw.matched / fw.total_26as) * 100}%` }} />
                <div className="bg-amber-400 h-full" style={{ width: `${(fw.suggested / fw.total_26as) * 100}%` }} />
                <div className="bg-red-400 h-full" style={{ width: `${(fw.unmatched / fw.total_26as) * 100}%` }} />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Row 2: Risk Matrix (top 5 riskiest parties) */}
      {risk.length > 0 && (
        <div className="bg-white border border-gray-100 rounded-lg p-3">
          <p className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold mb-2">Risk Matrix (by risk score)</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-100">
                  <th className="text-left py-1 pr-3">Party</th>
                  <th className="text-center py-1 px-2">Match%</th>
                  <th className="text-center py-1 px-2">Violations</th>
                  <th className="text-center py-1 px-2">Low Conf.</th>
                  <th className="text-center py-1 px-2">Unmatched Amt</th>
                  <th className="text-center py-1 px-2">Risk Score</th>
                </tr>
              </thead>
              <tbody>
                {risk.slice(0, 5).map((r) => (
                  <tr key={r.run_id} className="border-t border-gray-50">
                    <td className="py-1.5 pr-3 font-medium text-gray-900 truncate max-w-[160px]">{r.deductor_name}</td>
                    <td className={cn('py-1.5 px-2 text-center font-semibold', matchRateColor(r.match_rate_pct))}>{formatPct(r.match_rate_pct)}</td>
                    <td className={cn('py-1.5 px-2 text-center font-semibold', r.violations > 0 ? 'text-red-600' : 'text-emerald-600')}>{r.violations}</td>
                    <td className={cn('py-1.5 px-2 text-center', r.low_confidence_count > 0 ? 'text-orange-600 font-semibold' : 'text-gray-400')}>{r.low_confidence_count}</td>
                    <td className={cn('py-1.5 px-2 text-center font-mono', r.unmatched_amount > 0 ? 'text-red-600' : 'text-gray-400')}>{fmtAmt(r.unmatched_amount)}</td>
                    <td className="py-1.5 px-2 text-center">
                      <span className={cn(
                        'inline-flex items-center px-1.5 py-0.5 rounded font-bold text-[10px]',
                        r.risk_score >= 30 ? 'bg-red-100 text-red-700'
                          : r.risk_score >= 15 ? 'bg-amber-100 text-amber-700'
                          : 'bg-emerald-100 text-emerald-700',
                      )}>
                        {r.risk_score}
                      </span>
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


// ── Batch group card ────────────────────────────────────────────────────────

type BatchSortKey = 'run_number' | 'deductor_name' | 'match_rate_pct' | 'matched_count' | 'unmatched_26as_count' | 'constraint_violations' | 'status';

function BatchGroupCard({ group, onRunClick, onRefresh }: { group: BatchGroup; onRunClick: (id: string) => void; onRefresh: () => void }) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [authResult, setAuthResult] = useState<{ success_count: number; skipped_requires_remarks: number; skipped_invoice_reuse: number } | null>(null);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authRemarks, setAuthRemarks] = useState('');
  const [rerunning, setRerunning] = useState(false);
  const [showRerunConfirm, setShowRerunConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [showComparison, setShowComparison] = useState(false);
  const hasParent = group.runs.some((r) => r.parent_batch_id);
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleDate, setScheduleDate] = useState('');
  const [scheduling, setScheduling] = useState(false);

  // Batch naming & tagging state
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(group.batch_name || '');
  const [editingTags, setEditingTags] = useState(false);
  const [tagsValue, setTagsValue] = useState<string[]>(group.batch_tags || []);
  const [tagInput, setTagInput] = useState('');
  const [savingMeta, setSavingMeta] = useState(false);

  const saveBatchMeta = async (data: { batch_name?: string; batch_tags?: string[] }) => {
    setSavingMeta(true);
    try {
      await runsApi.batchUpdateMetadata(group.batch_id, data);
      onRefresh();
      toast('Batch updated', 'Metadata saved successfully', 'success');
    } catch (err: any) {
      toast('Save failed', err?.response?.data?.detail || 'Failed to update batch metadata', 'error');
    } finally {
      setSavingMeta(false);
    }
  };

  // Sort state for per-party table
  const [batchSortKey, setBatchSortKey] = useState<BatchSortKey>('run_number');
  const [batchSortDir, setBatchSortDir] = useState<'asc' | 'desc'>('asc');

  const handleBatchSort = (key: BatchSortKey) => {
    if (batchSortKey === key) setBatchSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setBatchSortKey(key); setBatchSortDir(key === 'run_number' || key === 'deductor_name' ? 'asc' : 'desc'); }
  };

  const STATUS_RANK: Record<string, number> = { PROCESSING: 0, FAILED: 1, PENDING_REVIEW: 2, APPROVED: 3, REJECTED: 4 };

  const sortedRuns = [...group.runs].sort((a, b) => {
    let cmp = 0;
    switch (batchSortKey) {
      case 'run_number': cmp = a.run_number - b.run_number; break;
      case 'deductor_name': cmp = (a.deductor_name || '').localeCompare(b.deductor_name || ''); break;
      case 'match_rate_pct': cmp = a.match_rate_pct - b.match_rate_pct; break;
      case 'matched_count': cmp = a.matched_count - b.matched_count; break;
      case 'unmatched_26as_count': cmp = a.unmatched_26as_count - b.unmatched_26as_count; break;
      case 'constraint_violations': cmp = a.constraint_violations - b.constraint_violations; break;
      case 'status': cmp = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9); break;
    }
    return batchSortDir === 'desc' ? -cmp : cmp;
  });

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
            {group.batch_name ? (
              <span className="text-sm font-semibold text-gray-900 truncate max-w-[240px]" title={group.batch_name}>
                {group.batch_name}
              </span>
            ) : (
              <span className="text-sm font-semibold text-gray-900">
                {group.total_parties} Parties
              </span>
            )}
            <span className="text-xs text-gray-400">·</span>
            <span className="text-xs font-medium text-gray-600">{formatFY(group.financial_year)}</span>
            <span className="text-xs text-gray-400">·</span>
            <span className="text-xs text-gray-400">{formatDateTime(group.created_at)}</span>
            {group.batch_name && (
              <>
                <span className="text-xs text-gray-400">·</span>
                <span className="text-xs text-gray-500">{group.total_parties} parties</span>
              </>
            )}
          </div>
          {/* Tags row */}
          {group.batch_tags && group.batch_tags.length > 0 && (
            <div className="flex items-center gap-1 mt-1 flex-wrap">
              <Tag className="h-3 w-3 text-gray-400 shrink-0" />
              {group.batch_tags.map((tag) => (
                <span key={tag} className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium bg-[#1B3A5C]/10 text-[#1B3A5C] rounded">
                  {tag}
                </span>
              ))}
            </div>
          )}
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
                {/* Comparison Toggle (only for rerun batches) */}
                {hasParent && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowComparison(!showComparison);
                    }}
                    className={cn(
                      'flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg transition-colors',
                      showComparison
                        ? 'bg-amber-600 text-white'
                        : 'bg-gray-100 text-gray-700 hover:bg-gray-200',
                    )}
                  >
                    <ChevronsUpDown className="h-4 w-4" />
                    Compare
                  </button>
                )}
                {/* Analytics Toggle */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowAnalytics(!showAnalytics);
                  }}
                  className={cn(
                    'flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg transition-colors',
                    showAnalytics
                      ? 'bg-[#1B3A5C] text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200',
                  )}
                >
                  <BarChart3 className="h-4 w-4" />
                  Analytics
                </button>
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
                      toast('Batch rerun started', `${res.total} runs re-processing with current settings.`, 'success');
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
                      ? 'This batch contains APPROVED runs. Rerunning will clear existing results and re-process all runs with current settings. Approved status will be reset.'
                      : 'All runs in this batch will be re-processed with current settings. Existing results will be replaced.'
                  }
                  confirmLabel="Rerun batch"
                  variant="info"
                  loading={rerunning}
                  icon={<RefreshCw className="h-5 w-5 text-[#1B3A5C]" />}
                />
                {/* Schedule Rerun */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowSchedule(!showSchedule);
                  }}
                  className={cn(
                    'flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg transition-colors',
                    showSchedule
                      ? 'bg-purple-600 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200',
                  )}
                >
                  <Clock className="h-4 w-4" />
                  Schedule
                </button>
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
                    {authResult.skipped_invoice_reuse > 0 && (
                      <> ({authResult.skipped_invoice_reuse} with shared invoice refs — flagged for audit review).</>
                    )}
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
                          setAuthResult({ success_count: res.success_count, skipped_requires_remarks: res.skipped_requires_remarks, skipped_invoice_reuse: res.skipped_invoice_reuse || 0 });
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

          {/* Batch naming & tagging */}
          <div className="px-5 py-3 border-t border-gray-100 bg-white">
            <div className="flex items-start gap-6 flex-wrap">
              {/* Batch Name */}
              <div className="flex-1 min-w-[200px]">
                <p className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold mb-1">Batch Name</p>
                {editingName ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={nameValue}
                      onChange={(e) => setNameValue(e.target.value)}
                      placeholder="e.g. Q4 FY23 Final Reco"
                      className="flex-1 text-sm border border-gray-300 rounded-lg px-3 py-1.5 outline-none focus:border-[#1B3A5C] focus:ring-2 focus:ring-[#1B3A5C]/10"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          setEditingName(false);
                          saveBatchMeta({ batch_name: nameValue.trim() || undefined });
                        }
                        if (e.key === 'Escape') {
                          setEditingName(false);
                          setNameValue(group.batch_name || '');
                        }
                      }}
                    />
                    <button
                      onClick={() => {
                        setEditingName(false);
                        saveBatchMeta({ batch_name: nameValue.trim() || undefined });
                      }}
                      disabled={savingMeta}
                      className="p-1 text-emerald-600 hover:bg-emerald-50 rounded transition-colors"
                    >
                      <Check className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => {
                        setEditingName(false);
                        setNameValue(group.batch_name || '');
                      }}
                      className="p-1 text-gray-400 hover:bg-gray-100 rounded transition-colors"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-gray-700">
                      {group.batch_name || <span className="text-gray-400 italic">No name set</span>}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setNameValue(group.batch_name || '');
                        setEditingName(true);
                      }}
                      className="p-1 text-gray-400 hover:text-[#1B3A5C] hover:bg-[#1B3A5C]/5 rounded transition-colors"
                      title="Edit batch name"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </div>

              {/* Batch Tags */}
              <div className="flex-1 min-w-[200px]">
                <p className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold mb-1">Tags</p>
                {editingTags ? (
                  <div>
                    <div className="flex items-center gap-1 flex-wrap mb-1.5">
                      {tagsValue.map((tag) => (
                        <span
                          key={tag}
                          className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-[#1B3A5C]/10 text-[#1B3A5C] rounded"
                        >
                          {tag}
                          <button
                            onClick={() => setTagsValue(tagsValue.filter((t) => t !== tag))}
                            className="hover:text-red-600 transition-colors"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={tagInput}
                        onChange={(e) => setTagInput(e.target.value)}
                        placeholder="Add tag..."
                        className="flex-1 text-sm border border-gray-300 rounded-lg px-3 py-1.5 outline-none focus:border-[#1B3A5C] focus:ring-2 focus:ring-[#1B3A5C]/10"
                        onKeyDown={(e) => {
                          if ((e.key === 'Enter' || e.key === ',') && tagInput.trim()) {
                            e.preventDefault();
                            const val = tagInput.trim().toUpperCase();
                            if (!tagsValue.includes(val)) setTagsValue([...tagsValue, val]);
                            setTagInput('');
                          }
                          if (e.key === 'Escape') {
                            setEditingTags(false);
                            setTagsValue(group.batch_tags || []);
                            setTagInput('');
                          }
                        }}
                      />
                      {tagInput.trim() && (
                        <button
                          onClick={() => {
                            const val = tagInput.trim().toUpperCase();
                            if (!tagsValue.includes(val)) setTagsValue([...tagsValue, val]);
                            setTagInput('');
                          }}
                          className="p-1 text-[#1B3A5C] hover:bg-[#1B3A5C]/5 rounded transition-colors"
                        >
                          <Plus className="h-4 w-4" />
                        </button>
                      )}
                      <button
                        onClick={() => {
                          setEditingTags(false);
                          setTagInput('');
                          saveBatchMeta({ batch_tags: tagsValue });
                        }}
                        disabled={savingMeta}
                        className="p-1 text-emerald-600 hover:bg-emerald-50 rounded transition-colors"
                      >
                        <Check className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => {
                          setEditingTags(false);
                          setTagsValue(group.batch_tags || []);
                          setTagInput('');
                        }}
                        className="p-1 text-gray-400 hover:bg-gray-100 rounded transition-colors"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    {tagsValue.length > 0 ? (
                      <div className="flex items-center gap-1 flex-wrap">
                        {tagsValue.map((tag) => (
                          <span key={tag} className="inline-flex items-center px-2 py-0.5 text-xs font-medium bg-[#1B3A5C]/10 text-[#1B3A5C] rounded">
                            {tag}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-sm text-gray-400 italic">No tags</span>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setTagsValue(group.batch_tags || []);
                        setEditingTags(true);
                      }}
                      className="p-1 text-gray-400 hover:text-[#1B3A5C] hover:bg-[#1B3A5C]/5 rounded transition-colors"
                      title="Edit tags"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Batch progress panel — shown automatically when any run is processing */}
          {group.processing > 0 && (
            <div className="border-t border-gray-100 bg-blue-50/30">
              <BatchProgressPanel batchId={group.batch_id} />
            </div>
          )}

          {/* Analytics panel */}
          {showAnalytics && (
            <div className="border-t border-gray-100 bg-gray-50/30">
              <BatchAnalyticsPanel batchId={group.batch_id} />
            </div>
          )}

          {/* Comparison panel (rerun vs original) */}
          {showComparison && hasParent && (
            <div className="border-t border-gray-100 bg-amber-50/20">
              <BatchComparisonPanel batchId={group.batch_id} />
            </div>
          )}

          {/* Schedule rerun panel */}
          {showSchedule && (
            <div className="border-t border-gray-100 bg-purple-50/20 px-5 py-4">
              <p className="text-xs font-semibold text-gray-700 mb-2">Schedule Batch Rerun</p>
              <div className="flex items-end gap-3">
                <div>
                  <label className="block text-[10px] text-gray-500 mb-1">Date &amp; Time (UTC)</label>
                  <input
                    type="datetime-local"
                    value={scheduleDate}
                    onChange={(e) => setScheduleDate(e.target.value)}
                    className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg outline-none focus:border-purple-500 focus:ring-2 focus:ring-purple-500/10"
                  />
                </div>
                <button
                  disabled={!scheduleDate || scheduling}
                  onClick={async (e) => {
                    e.stopPropagation();
                    setScheduling(true);
                    try {
                      const isoDate = new Date(scheduleDate).toISOString();
                      await runsApi.batchSchedule(group.batch_id, isoDate);
                      toast('Rerun scheduled', `Batch will rerun at ${new Date(scheduleDate).toLocaleString()}`, 'success');
                      setShowSchedule(false);
                      setScheduleDate('');
                    } catch (err: any) {
                      toast('Schedule failed', err?.response?.data?.detail || 'Failed to schedule', 'error');
                    } finally {
                      setScheduling(false);
                    }
                  }}
                  className="flex items-center gap-2 px-4 py-1.5 bg-purple-600 text-white text-sm font-semibold rounded-lg hover:bg-purple-700 transition-colors disabled:opacity-50"
                >
                  {scheduling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clock className="h-3.5 w-3.5" />}
                  Schedule
                </button>
              </div>
              <p className="text-[10px] text-gray-400 mt-2">
                A new batch will be created from the original files at the scheduled time.
              </p>
            </div>
          )}

          {/* Per-party table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-[#1B3A5C] text-white text-xs uppercase tracking-wide">
                  {([
                    { key: 'run_number' as BatchSortKey, label: '#', align: 'left' },
                    { key: 'deductor_name' as BatchSortKey, label: 'Deductor', align: 'left' },
                    { key: null, label: 'TAN', align: 'center' },
                    { key: 'match_rate_pct' as BatchSortKey, label: 'Match Rate', align: 'center' },
                    { key: 'matched_count' as BatchSortKey, label: 'Matched', align: 'center' },
                    { key: 'unmatched_26as_count' as BatchSortKey, label: 'Unmatched', align: 'center' },
                    { key: 'constraint_violations' as BatchSortKey, label: 'Violations', align: 'center' },
                    { key: null, label: 'Confidence', align: 'center' },
                    { key: 'status' as BatchSortKey, label: 'Status', align: 'center' },
                    { key: null, label: 'Excel', align: 'center' },
                  ] as const).map((col) => (
                    <th
                      key={col.label}
                      className={cn(
                        'px-4 py-2.5',
                        col.align === 'center' ? 'text-center' : 'text-left',
                        col.key && 'cursor-pointer select-none hover:bg-white/10 transition-colors',
                      )}
                      onClick={col.key ? () => handleBatchSort(col.key!) : undefined}
                    >
                      <span className="inline-flex items-center gap-0.5">
                        {col.label}
                        {col.key && (
                          batchSortKey === col.key
                            ? batchSortDir === 'asc'
                              ? <ChevronUp className="h-3 w-3" />
                              : <ChevronDown className="h-3 w-3" />
                            : <ChevronsUpDown className="h-3 w-3 opacity-40" />
                        )}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedRuns.map((r, idx) => (
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
  const { user } = useAuth();
  const qc = useQueryClient();
  const { toast } = useToast();

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

  // ── Bulk Operations (Phase 4D) ──
  const { data: adminSettings } = useQuery({ queryKey: ['admin-settings'], queryFn: settingsApi.get });
  const bulkEnabled = adminSettings?.bulk_operations_enabled ?? true;
  const isReviewerOrAdmin = user?.role === 'REVIEWER' || user?.role === 'ADMIN';
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const selectAll = () => {
    const pending = singleRuns.filter((r) => r.status === 'PENDING_REVIEW').map((r) => r.id);
    setSelectedIds(new Set(pending));
  };
  const clearSelection = () => setSelectedIds(new Set());

  const bulkReviewMut = useMutation({
    mutationFn: ({ action, notes }: { action: 'APPROVED' | 'REJECTED'; notes?: string }) =>
      runsApi.bulkReview(Array.from(selectedIds), action, notes),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['runs'] });
      clearSelection();
      toast(`Bulk ${data.success > 0 ? 'success' : 'failed'}`,
        `${data.success} succeeded, ${data.failed} failed`, data.success > 0 ? 'success' : 'error');
    },
    onError: (err) => toast('Bulk review failed', String(err), 'error'),
  });

  const bulkArchiveMut = useMutation({
    mutationFn: () => runsApi.bulkArchive(Array.from(selectedIds)),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['runs'] });
      clearSelection();
      toast('Archived', `${data.archived} runs archived`, 'success');
    },
    onError: (err) => toast('Archive failed', String(err), 'error'),
  });

  // Single run table columns
  const columns: Column<RunSummary>[] = [
    ...(bulkEnabled && isReviewerOrAdmin ? [{
      key: 'select' as keyof RunSummary,
      header: (
        <input type="checkbox"
          checked={selectedIds.size > 0 && singleRuns.filter(r => r.status === 'PENDING_REVIEW').every(r => selectedIds.has(r.id))}
          onChange={(e) => e.target.checked ? selectAll() : clearSelection()}
          className="rounded border-gray-300"
        />
      ) as any,
      render: (r: RunSummary) => (
        <input type="checkbox"
          checked={selectedIds.has(r.id)}
          onChange={(e) => { e.stopPropagation(); toggleSelect(r.id); }}
          onClick={(e) => e.stopPropagation()}
          disabled={r.status !== 'PENDING_REVIEW'}
          className="rounded border-gray-300 disabled:opacity-30"
        />
      ),
    }] : []),
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

      {/* Bulk action toolbar (Phase 4D) */}
      {bulkEnabled && isReviewerOrAdmin && selectedIds.size > 0 && (
        <div className="flex items-center gap-3 p-3 bg-[#1B3A5C]/5 border border-[#1B3A5C]/20 rounded-lg">
          <span className="text-sm font-semibold text-[#1B3A5C]">{selectedIds.size} selected</span>
          <button
            onClick={() => bulkReviewMut.mutate({ action: 'APPROVED' })}
            disabled={bulkReviewMut.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50"
          >
            <CheckCircle className="h-3 w-3" />
            Approve All
          </button>
          <button
            onClick={() => bulkReviewMut.mutate({ action: 'REJECTED' })}
            disabled={bulkReviewMut.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
          >
            <XCircle className="h-3 w-3" />
            Reject All
          </button>
          {adminSettings?.run_archival_enabled && (
            <button
              onClick={() => bulkArchiveMut.mutate()}
              disabled={bulkArchiveMut.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-gray-600 text-white rounded-lg hover:bg-gray-700 disabled:opacity-50"
            >
              Archive
            </button>
          )}
          <button onClick={clearSelection} className="ml-auto text-xs text-gray-500 hover:text-gray-700">
            Clear selection
          </button>
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
              pageSize={50}
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
