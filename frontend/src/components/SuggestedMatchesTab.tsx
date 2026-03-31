/**
 * SuggestedMatchesTab — Tabular authorization workflow for suggested matches.
 * Sortable columns, expandable row detail, batch select, authorize/reject.
 */
import { useState, useMemo, useCallback, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  runsApi,
  type SuggestedMatch,
  type SuggestedCategory,
} from '../lib/api';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { TableSearch } from '../components/ui/TableSearch';
import { TablePagination } from '../components/ui/TablePagination';
import { TableExport } from '../components/ui/TableExport';
import {
  cn,
  formatCurrency,
  formatPct,
  formatDate,
  truncate,
  getErrorMessage,
  type BadgeVariant,
} from '../lib/utils';
import { useToast } from '../components/ui/Toast';
import {
  Filter,
  CheckCheck,
  XCircle,
  AlertTriangle,
  MessageSquare,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
} from 'lucide-react';

// ── Constants ──────────────────────────────────────────────────────────

interface CategoryMeta {
  label: string;
  variant: BadgeVariant;
  customClass?: string;
}

const CATEGORY_META: Record<string, CategoryMeta> = {
  HIGH_VARIANCE_3_20: { label: 'Variance 3-20%', variant: 'yellow' },
  HIGH_VARIANCE_20_PLUS: { label: 'Variance 20%+', variant: 'red' },
  DATE_SOFT_PREFERENCE: { label: 'Date Pref.', variant: 'blue' },
  ADVANCE_PAYMENT: {
    label: 'Advance',
    variant: 'default',
    customClass: 'bg-violet-50 text-violet-700 border-violet-200',
  },
  FORCE: { label: 'Force', variant: 'orange' },
  CROSS_FY: { label: 'Cross-FY', variant: 'gray' },
  TIER_CAP_EXCEEDED: { label: 'Tier Cap', variant: 'yellow' },
};

const ALL_CATEGORIES: SuggestedCategory[] = [
  'HIGH_VARIANCE_3_20',
  'HIGH_VARIANCE_20_PLUS',
  'DATE_SOFT_PREFERENCE',
  'ADVANCE_PAYMENT',
  'FORCE',
  'CROSS_FY',
  'TIER_CAP_EXCEEDED',
];

type FilterValue = 'all' | SuggestedCategory;

const FILTER_OPTIONS: { value: FilterValue; label: string }[] = [
  { value: 'all', label: 'All' },
  ...ALL_CATEGORIES.map((c) => ({ value: c as FilterValue, label: CATEGORY_META[c].label })),
];

// ── Sort helpers ──────────────────────────────────────────────────────

type SortDir = 'asc' | 'desc';
type SortKey =
  | 'as26_index'
  | 'category'
  | 'section'
  | 'as26_date'
  | 'as26_amount'
  | 'books_sum'
  | 'variance_amt'
  | 'variance_pct'
  | 'match_type'
  | 'confidence'
  | 'composite_score'
  | 'status';

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <ChevronsUpDown className="h-3 w-3 opacity-30" />;
  return dir === 'asc'
    ? <ChevronUp className="h-3 w-3" />
    : <ChevronDown className="h-3 w-3" />;
}

const CONFIDENCE_ORDER: Record<string, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };

function compareSuggested(a: SuggestedMatch, b: SuggestedMatch, key: SortKey, dir: SortDir): number {
  let av: string | number | null;
  let bv: string | number | null;

  if (key === 'status') {
    av = a.authorized ? 2 : a.rejected ? 0 : 1;
    bv = b.authorized ? 2 : b.rejected ? 0 : 1;
  } else if (key === 'confidence') {
    av = CONFIDENCE_ORDER[a.confidence] ?? 0;
    bv = CONFIDENCE_ORDER[b.confidence] ?? 0;
  } else {
    av = a[key] as string | number | null;
    bv = b[key] as string | number | null;
  }

  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  if (typeof av === 'number' && typeof bv === 'number') {
    return dir === 'asc' ? av - bv : bv - av;
  }
  const sa = String(av).toLowerCase();
  const sb = String(bv).toLowerCase();
  return dir === 'asc' ? sa.localeCompare(sb) : sb.localeCompare(sa);
}

// ── Badge helpers ─────────────────────────────────────────────────────

function categoryBadge(category: SuggestedCategory) {
  const meta = CATEGORY_META[category] ?? { label: category, variant: 'gray' as BadgeVariant };
  return (
    <Badge variant={meta.variant} size="sm" className={meta.customClass}>
      {meta.label}
    </Badge>
  );
}

function statusBadge(item: SuggestedMatch) {
  if (item.authorized) return <Badge variant="green" size="sm">Authorized</Badge>;
  if (item.rejected) return <Badge variant="red" size="sm">Rejected</Badge>;
  return <Badge variant="yellow" size="sm">Pending</Badge>;
}

function confidenceBadge(conf: string) {
  const v = conf === 'HIGH' ? 'green' : conf === 'MEDIUM' ? 'yellow' : 'orange';
  return <Badge variant={v} size="sm">{conf}</Badge>;
}

function varianceColor(pct: number): string {
  if (pct > 20) return 'text-red-600 font-bold';
  if (pct > 3) return 'text-amber-600 font-semibold';
  return 'text-gray-700';
}

// ── Props ──────────────────────────────────────────────────────────────

interface SuggestedMatchesTabProps {
  runId: string;
}

// ── Column header definition ──────────────────────────────────────────

interface ColDef {
  key: SortKey | '_checkbox' | '_alert';
  label: string | ReactNode;
  sortable: boolean;
  align: 'left' | 'right' | 'center';
  width?: string;
}

// ── Component ──────────────────────────────────────────────────────────

export default function SuggestedMatchesTab({ runId }: SuggestedMatchesTabProps) {
  const qc = useQueryClient();
  const { toast } = useToast();

  // ── Data fetching ──
  const { data: suggestions = [], isLoading, refetch } = useQuery({
    queryKey: ['runs', runId, 'suggested'],
    queryFn: () => runsApi.suggested(runId),
  });

  // ── Local state ──
  const [filter, setFilter] = useState<FilterValue>('all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [showAuthorizeModal, setShowAuthorizeModal] = useState(false);
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [remarks, setRemarks] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('variance_pct');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  // ── Derived data ──
  const filtered = useMemo(() => {
    let result = filter === 'all' ? suggestions : suggestions.filter((s) => s.category === filter);
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((s) =>
        (s.section ?? '').toLowerCase().includes(q)
        || (s.match_type ?? '').toLowerCase().includes(q)
        || (s.confidence ?? '').toLowerCase().includes(q)
        || s.invoice_refs.some((r) => r.toLowerCase().includes(q))
        || String(s.as26_amount).includes(q)
        || String(s.books_sum).includes(q)
        || String(s.as26_index).includes(q)
        || String(s.variance_pct).includes(q),
      );
    }
    return result;
  }, [suggestions, filter, search]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => compareSuggested(a, b, sortKey, sortDir));
  }, [filtered, sortKey, sortDir]);

  const paged = useMemo(() => {
    return sorted.slice((page - 1) * pageSize, page * pageSize);
  }, [sorted, page, pageSize]);

  const pendingFiltered = useMemo(
    () => filtered.filter((s) => !s.authorized && !s.rejected),
    [filtered],
  );

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of suggestions) {
      counts[s.category] = (counts[s.category] ?? 0) + 1;
    }
    return counts;
  }, [suggestions]);

  const pendingCount = suggestions.filter((s) => !s.authorized && !s.rejected).length;
  const authorizedCount = suggestions.filter((s) => s.authorized).length;
  const rejectedCount = suggestions.filter((s) => s.rejected).length;

  // ── Selection helpers ──
  const allPendingSelected =
    pendingFiltered.length > 0 && pendingFiltered.every((s) => selectedIds.has(s.id));

  const toggleSelectAll = () => {
    if (allPendingSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(pendingFiltered.map((s) => s.id)));
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedRequireRemarks = useMemo(() => {
    return suggestions.some((s) => selectedIds.has(s.id) && s.requires_remarks);
  }, [suggestions, selectedIds]);

  // ── Sort handler ──
  const handleSort = useCallback((key: SortKey) => {
    setSortKey((prev) => {
      if (prev === key) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        return key;
      }
      setSortDir('desc');
      return key;
    });
  }, []);

  // ── Mutations ──
  const authorizeMut = useMutation({
    mutationFn: (params: { ids: string[]; remarks?: string }) =>
      runsApi.authorizeSuggested(runId, params.ids, params.remarks),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ['runs', runId] });
      qc.invalidateQueries({ queryKey: ['runs', runId, 'matched'] });
      qc.invalidateQueries({ queryKey: ['runs', runId, 'unmatched-26as'] });
      refetch();
      setSelectedIds(new Set());
      setShowAuthorizeModal(false);
      setRemarks('');
      toast(`${result.success_count} suggested match(es) authorized and promoted to matched pairs`, undefined, 'success');
    },
    onError: (err) => toast('Authorization failed', getErrorMessage(err), 'error'),
  });

  const rejectMut = useMutation({
    mutationFn: (params: { ids: string[]; reason?: string }) =>
      runsApi.rejectSuggested(runId, params.ids, params.reason),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ['runs', runId] });
      refetch();
      setSelectedIds(new Set());
      setShowRejectModal(false);
      setRejectReason('');
      toast(`${result.rejected} suggested match(es) rejected`, undefined, 'success');
    },
    onError: (err) => toast('Rejection failed', getErrorMessage(err), 'error'),
  });

  // ── Handlers ──
  const handleAuthorize = () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (selectedRequireRemarks) {
      setShowAuthorizeModal(true);
    } else {
      authorizeMut.mutate({ ids });
    }
  };

  const handleConfirmAuthorize = () => {
    const ids = Array.from(selectedIds);
    if (selectedRequireRemarks && !remarks.trim()) return;
    authorizeMut.mutate({ ids, remarks: remarks.trim() || undefined });
  };

  const handleReject = () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setShowRejectModal(true);
  };

  const handleConfirmReject = () => {
    const ids = Array.from(selectedIds);
    rejectMut.mutate({ ids, reason: rejectReason.trim() || undefined });
  };

  // ── Column definitions ──
  const columns: ColDef[] = [
    { key: '_checkbox', label: '', sortable: false, align: 'center', width: 'w-10' },
    { key: 'as26_index', label: '#', sortable: true, align: 'center', width: 'w-14' },
    { key: 'category', label: 'Category', sortable: true, align: 'left' },
    { key: 'section', label: 'Section', sortable: true, align: 'left', width: 'w-20' },
    { key: 'as26_date', label: '26AS Date', sortable: true, align: 'left' },
    { key: 'as26_amount', label: '26AS Amt (₹)', sortable: true, align: 'right' },
    { key: 'books_sum', label: 'Books Amt (₹)', sortable: true, align: 'right' },
    { key: 'variance_amt', label: 'Var ₹', sortable: true, align: 'right' },
    { key: 'variance_pct', label: 'Var %', sortable: true, align: 'right', width: 'w-20' },
    { key: 'match_type', label: 'Match Type', sortable: true, align: 'left' },
    { key: 'confidence', label: 'Confidence', sortable: true, align: 'center' },
    { key: 'composite_score', label: 'Score', sortable: true, align: 'right', width: 'w-16' },
    { key: '_alert', label: 'Invoices', sortable: false, align: 'left' },
    { key: 'status', label: 'Status', sortable: true, align: 'center' },
  ];

  // ── Loading state ──
  if (isLoading) {
    return (
      <Card>
        <div className="flex items-center justify-center py-12">
          <p className="text-sm text-gray-400">Loading suggested matches...</p>
        </div>
      </Card>
    );
  }

  return (
    <>
      <Card padding={false}>
        {/* ── Header with summary badges ── */}
        <div className="px-4 py-3 border-b border-gray-100">
          <div className="flex items-center justify-between flex-wrap gap-2">
            {/* Left: summary */}
            <div className="flex items-center gap-3 flex-wrap">
              <p className="text-xs text-gray-500 font-medium">
                {suggestions.length} suggested matches
              </p>
              <div className="flex items-center gap-1.5 flex-wrap">
                {pendingCount > 0 && (
                  <Badge variant="yellow" size="sm">{pendingCount} pending</Badge>
                )}
                {authorizedCount > 0 && (
                  <Badge variant="green" size="sm">{authorizedCount} authorized</Badge>
                )}
                {rejectedCount > 0 && (
                  <Badge variant="red" size="sm">{rejectedCount} rejected</Badge>
                )}
              </div>
            </div>

            {/* Right: action buttons */}
            <div className="flex items-center gap-2">
              {selectedIds.size > 0 && (
                <>
                  <button
                    onClick={handleAuthorize}
                    disabled={authorizeMut.isPending}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#1B3A5C] text-white text-xs font-semibold hover:bg-[#15304d] transition-colors disabled:opacity-50"
                  >
                    <CheckCheck className="h-3.5 w-3.5" />
                    {authorizeMut.isPending
                      ? 'Authorizing...'
                      : `Authorize Selected (${selectedIds.size})`}
                  </button>
                  <button
                    onClick={handleReject}
                    disabled={rejectMut.isPending}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-200 text-red-600 text-xs font-semibold hover:bg-red-50 transition-colors disabled:opacity-50"
                  >
                    <XCircle className="h-3.5 w-3.5" />
                    {rejectMut.isPending
                      ? 'Rejecting...'
                      : `Reject Selected (${selectedIds.size})`}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>

        {/* ── Category summary badges ── */}
        <div className="px-4 py-2 border-b border-gray-100 bg-gray-50/50 flex items-center gap-2 flex-wrap">
          {ALL_CATEGORIES.map((cat) => {
            const count = categoryCounts[cat] ?? 0;
            if (count === 0) return null;
            return (
              <button
                key={cat}
                onClick={() => setFilter(filter === cat ? 'all' : cat)}
                className="flex items-center gap-1"
              >
                {categoryBadge(cat)}
                <span className="text-[10px] font-mono text-gray-500">{count}</span>
              </button>
            );
          })}
        </div>

        {/* ── Search + Filter pills ── */}
        <div className="px-4 py-2 border-b border-gray-100 flex items-center gap-2">
          <TableSearch
            value={search}
            onChange={(v) => { setSearch(v); setPage(1); }}
            placeholder="Search section, invoice, amount..."
            className="w-56"
          />
          <Filter className="h-3.5 w-3.5 text-gray-400" />
          <div className="flex gap-1 flex-wrap">
            {FILTER_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setFilter(opt.value)}
                className={cn(
                  'px-2.5 py-1 rounded-full text-[10px] font-medium transition-colors',
                  filter === opt.value
                    ? 'bg-[#1B3A5C] text-white'
                    : 'bg-gray-100 text-gray-500 hover:bg-gray-200',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <TableExport
            headers={['Category', 'Section', '26AS Date', '26AS Amt', 'Books Amt', 'Var ₹', 'Var %', 'Match Type', 'Confidence', 'Score', 'Invoices', 'Status']}
            rows={filtered.map((s) => [
              s.category, s.section ?? '', s.as26_date ?? '',
              String(s.as26_amount), String(s.books_sum),
              String(s.variance_amt ?? ''), String(s.variance_pct ?? ''),
              s.match_type ?? '', s.confidence ?? '', String(s.composite_score ?? ''),
              (s.invoice_refs ?? []).join('; '), s.authorized ? 'Authorized' : s.rejected ? 'Rejected' : 'Pending',
            ])}
            filename="suggested-matches.csv"
          />
          {pendingFiltered.length > 0 && (
            <div className="ml-auto flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={allPendingSelected}
                  onChange={toggleSelectAll}
                  className="rounded border-gray-300 text-[#1B3A5C] focus:ring-[#1B3A5C]"
                />
                Select All Pending
              </label>
            </div>
          )}
        </div>

        {/* ── Table ── */}
        <div className="overflow-x-auto">
          <table className="w-full text-xs" role="table">
            <thead className="bg-gray-50 border-b border-gray-200 sticky top-0 z-10">
              <tr>
                {columns.map((col) => (
                  <th
                    key={col.key}
                    className={cn(
                      'px-3 py-2.5 font-semibold text-[10px] text-gray-500 uppercase tracking-wider whitespace-nowrap',
                      col.align === 'right' && 'text-right',
                      col.align === 'center' && 'text-center',
                      col.align === 'left' && 'text-left',
                      col.sortable && 'cursor-pointer select-none hover:text-gray-700 hover:bg-gray-100 transition-colors',
                      col.width,
                    )}
                    onClick={col.sortable ? () => handleSort(col.key as SortKey) : undefined}
                  >
                    <span className="inline-flex items-center gap-0.5">
                      {col.label}
                      {col.sortable && (
                        <SortIcon active={sortKey === col.key} dir={sortDir} />
                      )}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {paged.length === 0 ? (
                <tr>
                  <td colSpan={columns.length} className="px-4 py-12 text-center text-gray-400 text-sm">
                    No suggested matches found for this filter
                  </td>
                </tr>
              ) : (
                paged.map((item, idx) => {
                  const isPending = !item.authorized && !item.rejected;
                  const isExpanded = expandedRow === item.id;

                  return (
                    <TableRow
                      key={item.id}
                      item={item}
                      idx={idx}
                      isPending={isPending}
                      isExpanded={isExpanded}
                      isSelected={selectedIds.has(item.id)}
                      onToggleSelect={() => toggleSelect(item.id)}
                      onToggleExpand={() => setExpandedRow(isExpanded ? null : item.id)}
                      colCount={columns.length}
                    />
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* ── Table footer with count ── */}
        {filtered.length > 25 && (
          <TablePagination
            page={page} pageSize={pageSize} total={filtered.length}
            onPageChange={setPage}
            onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
          />
        )}
      </Card>

      {/* ── Authorize Modal (remarks required) ── */}
      {showAuthorizeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
            <h3 className="text-lg font-bold text-gray-900 mb-2">
              Authorize {selectedIds.size} Suggested Match{selectedIds.size > 1 ? 'es' : ''}
            </h3>
            {selectedRequireRemarks && (
              <div className="flex items-center gap-1.5 mb-3">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                <p className="text-xs text-amber-700">
                  One or more selected items require remarks for authorization.
                </p>
              </div>
            )}
            <textarea
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#1B3A5C] focus:ring-1 focus:ring-[#1B3A5C] resize-none"
              rows={3}
              placeholder={selectedRequireRemarks ? 'Remarks (required)...' : 'Remarks (optional)...'}
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
            />
            <div className="flex gap-2 mt-4 justify-end">
              <button
                onClick={() => {
                  setShowAuthorizeModal(false);
                  setRemarks('');
                }}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900 transition-colors"
              >
                Cancel
              </button>
              <button
                disabled={
                  (selectedRequireRemarks && !remarks.trim()) || authorizeMut.isPending
                }
                onClick={handleConfirmAuthorize}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#1B3A5C] text-white text-sm font-semibold hover:bg-[#15304d] transition-colors disabled:opacity-50"
              >
                <CheckCheck className="h-4 w-4" />
                {authorizeMut.isPending ? 'Authorizing...' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Reject Modal ── */}
      {showRejectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
            <h3 className="text-lg font-bold text-gray-900 mb-2">
              Reject {selectedIds.size} Suggested Match{selectedIds.size > 1 ? 'es' : ''}
            </h3>
            <textarea
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500 resize-none"
              rows={3}
              placeholder="Reason for rejection (optional)..."
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            />
            <div className="flex gap-2 mt-4 justify-end">
              <button
                onClick={() => {
                  setShowRejectModal(false);
                  setRejectReason('');
                }}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900 transition-colors"
              >
                Cancel
              </button>
              <button
                disabled={rejectMut.isPending}
                onClick={handleConfirmReject}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-700 transition-colors disabled:opacity-50"
              >
                <XCircle className="h-4 w-4" />
                {rejectMut.isPending ? 'Rejecting...' : 'Confirm Rejection'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Table Row (memoizable) ────────────────────────────────────────────

interface TableRowProps {
  item: SuggestedMatch;
  idx: number;
  isPending: boolean;
  isExpanded: boolean;
  isSelected: boolean;
  onToggleSelect: () => void;
  onToggleExpand: () => void;
  colCount: number;
}

function TableRow({
  item,
  idx,
  isPending,
  isExpanded,
  isSelected,
  onToggleSelect,
  onToggleExpand,
  colCount,
}: TableRowProps) {
  const invoiceText =
    item.invoice_refs.length > 0
      ? item.invoice_refs.map((r) => truncate(r, 18)).join(', ')
      : '—';

  return (
    <>
      {/* ── Data row ── */}
      <tr
        className={cn(
          'transition-colors group',
          isPending ? 'hover:bg-blue-50/40 cursor-pointer' : '',
          item.authorized && 'bg-green-50/30',
          item.rejected && 'bg-red-50/20 opacity-60',
          isExpanded && 'bg-blue-50/50',
          idx % 2 === 1 && !isExpanded && !item.authorized && !item.rejected && 'bg-gray-50/30',
        )}
        onClick={onToggleExpand}
      >
        {/* Checkbox */}
        <td className="px-3 py-2.5 text-center" onClick={(e) => e.stopPropagation()}>
          {isPending ? (
            <input
              type="checkbox"
              checked={isSelected}
              onChange={onToggleSelect}
              className="rounded border-gray-300 text-[#1B3A5C] focus:ring-[#1B3A5C]"
            />
          ) : (
            <span className="text-gray-300">—</span>
          )}
        </td>

        {/* # */}
        <td className="px-3 py-2.5 text-center font-mono text-gray-500">
          {item.as26_index ?? '—'}
        </td>

        {/* Category */}
        <td className="px-3 py-2.5">
          <div className="flex items-center gap-1">
            {categoryBadge(item.category)}
            {item.alert_message && (
              <span title={item.alert_message}>
                <AlertTriangle className="h-3 w-3 text-amber-500" />
              </span>
            )}
            {item.requires_remarks && isPending && (
              <span title="Remarks required for authorization">
                <MessageSquare className="h-3 w-3 text-amber-500" />
              </span>
            )}
          </div>
        </td>

        {/* Section */}
        <td className="px-3 py-2.5 font-mono text-gray-600">
          {item.section ? `S.${item.section}` : '—'}
        </td>

        {/* 26AS Date */}
        <td className="px-3 py-2.5 text-gray-600">
          {formatDate(item.as26_date)}
        </td>

        {/* 26AS Amount */}
        <td className="px-3 py-2.5 text-right font-mono font-semibold text-gray-900">
          {formatCurrency(item.as26_amount)}
        </td>

        {/* Books Sum */}
        <td className="px-3 py-2.5 text-right font-mono text-gray-700">
          {formatCurrency(item.books_sum)}
        </td>

        {/* Variance ₹ */}
        <td className={cn('px-3 py-2.5 text-right font-mono', varianceColor(item.variance_pct))}>
          {formatCurrency(item.variance_amt)}
        </td>

        {/* Variance % */}
        <td className={cn('px-3 py-2.5 text-right font-mono', varianceColor(item.variance_pct))}>
          {formatPct(item.variance_pct)}
        </td>

        {/* Match Type */}
        <td className="px-3 py-2.5 font-mono text-gray-600">
          {item.match_type ?? '—'}
        </td>

        {/* Confidence */}
        <td className="px-3 py-2.5 text-center">
          {confidenceBadge(item.confidence)}
        </td>

        {/* Composite Score */}
        <td className="px-3 py-2.5 text-right font-mono font-bold text-[#1B3A5C]">
          {item.composite_score.toFixed(1)}
        </td>

        {/* Invoices */}
        <td className="px-3 py-2.5 max-w-[180px]" title={item.invoice_refs.join(', ')}>
          <span className="text-gray-500 truncate block">
            {invoiceText}
          </span>
        </td>

        {/* Status */}
        <td className="px-3 py-2.5 text-center">
          {statusBadge(item)}
        </td>
      </tr>

      {/* ── Expanded detail row ── */}
      {isExpanded && (
        <tr className="bg-slate-50">
          <td colSpan={colCount} className="px-0 py-0">
            <ExpandedDetail item={item} />
          </td>
        </tr>
      )}
    </>
  );
}

// ── Expanded Detail Panel ─────────────────────────────────────────────

function ExpandedDetail({ item }: { item: SuggestedMatch }) {
  return (
    <div className="border-l-4 border-[#1B3A5C] mx-6 my-3 bg-white rounded-lg shadow-sm overflow-hidden">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-0 divide-y lg:divide-y-0 lg:divide-x divide-gray-100">
        {/* Invoice Details */}
        <div className="p-4">
          <p className="text-xs font-semibold text-[#1B3A5C] uppercase tracking-wider mb-2">
            Invoice Details
          </p>
          {item.invoice_refs.length > 0 ? (
            <div className="space-y-1.5">
              {item.invoice_refs.map((ref, i) => (
                <div key={i} className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-mono text-gray-800 truncate" title={ref}>
                    {ref}
                  </span>
                  <div className="flex items-center gap-2 shrink-0 text-gray-500">
                    {item.invoice_amounts?.[i] != null && (
                      <span className="font-mono">
                        {formatCurrency(item.invoice_amounts[i])}
                      </span>
                    )}
                    {item.invoice_dates?.[i] && (
                      <span>{formatDate(item.invoice_dates[i])}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-gray-400">No invoice details</p>
          )}
          {item.clearing_doc && (
            <div className="mt-3 pt-2 border-t border-gray-100">
              <span className="text-xs text-gray-400">Clearing Doc: </span>
              <span className="text-xs font-mono text-gray-700">
                {item.clearing_doc}
              </span>
            </div>
          )}
        </div>

        {/* Match Info */}
        <div className="p-4">
          <p className="text-xs font-semibold text-[#1B3A5C] uppercase tracking-wider mb-2">
            Match Info
          </p>
          <div className="space-y-2">
            <DetailRow label="Match Type" value={item.match_type ?? '—'} mono />
            <DetailRow label="Confidence">
              {confidenceBadge(item.confidence)}
            </DetailRow>
            <DetailRow label="Composite Score">
              <span className="font-mono text-sm font-bold text-[#1B3A5C]">
                {item.composite_score.toFixed(1)}
              </span>
            </DetailRow>
            <DetailRow label="Variance Amount" value={formatCurrency(item.variance_amt)} mono />
            <DetailRow label="Variance %" value={formatPct(item.variance_pct)} mono />
            {item.cross_fy && (
              <DetailRow label="Cross-FY">
                <Badge variant="orange" size="sm">Yes</Badge>
              </DetailRow>
            )}
            {item.is_prior_year && (
              <DetailRow label="Prior Year">
                <Badge variant="yellow" size="sm">Yes</Badge>
              </DetailRow>
            )}
          </div>
        </div>

        {/* Authorization Info */}
        <div className="p-4">
          <p className="text-xs font-semibold text-[#1B3A5C] uppercase tracking-wider mb-2">
            Authorization
          </p>
          <div className="space-y-2">
            <DetailRow label="Status">
              {statusBadge(item)}
            </DetailRow>
            {item.alert_message && (
              <div className="flex items-start gap-1.5 mt-1">
                <AlertTriangle className="h-3 w-3 text-amber-500 shrink-0 mt-0.5" />
                <p className="text-xs text-amber-700">{item.alert_message}</p>
              </div>
            )}
            {item.authorized_at && (
              <DetailRow label="Authorized At" value={formatDate(item.authorized_at, 'dd MMM yyyy, HH:mm')} />
            )}
            {item.remarks && (
              <div className="mt-2">
                <p className="text-xs text-gray-500 mb-0.5">Remarks</p>
                <p className="text-xs text-gray-700 italic">
                  &quot;{item.remarks}&quot;
                </p>
              </div>
            )}
            {item.rejected_at && (
              <DetailRow label="Rejected At" value={formatDate(item.rejected_at, 'dd MMM yyyy, HH:mm')} />
            )}
            {item.rejection_reason && (
              <div className="mt-2">
                <p className="text-xs text-gray-500 mb-0.5">Rejection Reason</p>
                <p className="text-xs text-red-600 italic">
                  &quot;{item.rejection_reason}&quot;
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Detail row helper ─────────────────────────────────────────────────

function DetailRow({
  label,
  value,
  mono,
  children,
}: {
  label: string;
  value?: string;
  mono?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-gray-500">{label}</span>
      {children ?? (
        <span className={cn('text-gray-800', mono && 'font-mono')}>
          {value}
        </span>
      )}
    </div>
  );
}
