/**
 * SuggestedMatchesTab — Authorization workflow for suggested matches
 * that need human review (high variance, force matches, cross-FY, advances, etc.)
 */
import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  runsApi,
  type SuggestedMatch,
  type SuggestedCategory,
} from '../lib/api';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
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
  ChevronRight,
  ChevronDown,
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

// ── Helpers ────────────────────────────────────────────────────────────

function categoryBadge(category: SuggestedCategory, size: 'sm' | 'md' = 'sm') {
  const meta = CATEGORY_META[category] ?? { label: category, variant: 'gray' as BadgeVariant };
  return (
    <Badge variant={meta.variant} size={size} className={meta.customClass}>
      {meta.label}
    </Badge>
  );
}

function statusBadge(item: SuggestedMatch) {
  if (item.authorized) return <Badge variant="green" size="sm">Authorized</Badge>;
  if (item.rejected) return <Badge variant="red" size="sm">Rejected</Badge>;
  return <Badge variant="gray" size="sm">Pending</Badge>;
}

function varianceColor(pct: number): string {
  if (pct > 20) return 'text-red-600';
  if (pct > 3) return 'text-amber-600';
  return 'text-gray-700';
}

// ── Props ──────────────────────────────────────────────────────────────

interface SuggestedMatchesTabProps {
  runId: string;
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

  // ── Derived data ──
  const filtered = useMemo(() => {
    if (filter === 'all') return suggestions;
    return suggestions.filter((s) => s.category === filter);
  }, [suggestions, filter]);

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

  // ── Does any selected item require remarks? ──
  const selectedRequireRemarks = useMemo(() => {
    return suggestions.some((s) => selectedIds.has(s.id) && s.requires_remarks);
  }, [suggestions, selectedIds]);

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

        {/* ── Filter pills ── */}
        <div className="px-4 py-2 border-b border-gray-100 flex items-center gap-2">
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

        {/* ── Items list ── */}
        <div className="divide-y divide-gray-100">
          {filtered.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">
              No suggested matches found for this filter
            </p>
          ) : (
            filtered.map((item) => {
              const isPending = !item.authorized && !item.rejected;
              const isExpanded = expandedRow === item.id;

              return (
                <div key={item.id}>
                  <div
                    className={cn(
                      'px-4 py-3 transition-colors',
                      isPending ? 'hover:bg-gray-50 cursor-pointer' : 'opacity-75',
                    )}
                  >
                    <div className="flex items-start gap-3">
                      {/* Checkbox (pending only) */}
                      <div className="flex items-center gap-2 mt-0.5 shrink-0">
                        {isPending && (
                          <input
                            type="checkbox"
                            checked={selectedIds.has(item.id)}
                            onChange={() => toggleSelect(item.id)}
                            onClick={(e) => e.stopPropagation()}
                            className="rounded border-gray-300 text-[#1B3A5C] focus:ring-[#1B3A5C]"
                          />
                        )}
                        <button
                          onClick={() => setExpandedRow(isExpanded ? null : item.id)}
                          className="text-gray-400"
                        >
                          {isExpanded
                            ? <ChevronDown className="h-4 w-4 text-[#1B3A5C]" />
                            : <ChevronRight className="h-4 w-4" />}
                        </button>
                      </div>

                      {/* Main content */}
                      <div
                        className="flex-1 min-w-0"
                        onClick={() => setExpandedRow(isExpanded ? null : item.id)}
                      >
                        {/* Top row: category + 26AS ref + status */}
                        <div className="flex items-center gap-2 flex-wrap">
                          {categoryBadge(item.category)}
                          <span className="font-mono text-xs text-gray-400">
                            26AS #{item.as26_index}
                          </span>
                          {item.section && (
                            <span className="font-mono text-[10px] text-gray-400">
                              S.{item.section}
                            </span>
                          )}
                          {item.as26_date && (
                            <span className="text-[10px] text-gray-400">
                              {formatDate(item.as26_date)}
                            </span>
                          )}
                          {statusBadge(item)}
                          {item.requires_remarks && isPending && (
                            <span
                              className="flex items-center gap-0.5 text-[10px] text-amber-600"
                              title="Remarks required for authorization"
                            >
                              <MessageSquare className="h-3 w-3" />
                              Remarks required
                            </span>
                          )}
                        </div>

                        {/* Second row: amounts + variance + match type */}
                        <div className="flex items-center gap-4 mt-1.5 flex-wrap">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] text-gray-400 uppercase">26AS</span>
                            <span className="font-mono text-sm font-semibold text-gray-900">
                              {formatCurrency(item.as26_amount)}
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] text-gray-400 uppercase">Books</span>
                            <span className="font-mono text-sm text-gray-700">
                              {formatCurrency(item.books_sum)}
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] text-gray-400 uppercase">Var</span>
                            <span className={cn('font-mono text-xs font-semibold', varianceColor(item.variance_pct))}>
                              {formatPct(item.variance_pct)}
                            </span>
                          </div>
                          {item.match_type && (
                            <span className="font-mono text-xs text-gray-500">
                              {item.match_type}
                            </span>
                          )}
                        </div>

                        {/* Invoice refs (compact) */}
                        <p className="text-[10px] text-gray-400 mt-1 truncate">
                          {item.invoice_refs.length > 0
                            ? item.invoice_refs.map((ref) => truncate(ref, 20)).join(', ')
                            : 'No invoices'}
                        </p>

                        {/* Alert message */}
                        {item.alert_message && (
                          <div className="flex items-center gap-1.5 mt-1.5">
                            <AlertTriangle className="h-3 w-3 text-amber-500 shrink-0" />
                            <p className="text-xs text-amber-700">{item.alert_message}</p>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* ── Expanded detail row ── */}
                  {isExpanded && (
                    <div className="bg-gray-50/70 px-4 py-0">
                      <div className="border-l-4 border-[#1B3A5C] mx-4 my-3 bg-white rounded-lg shadow-sm overflow-hidden">
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
                              <div className="flex items-center justify-between text-xs">
                                <span className="text-gray-500">Match Type</span>
                                <span className="font-mono font-medium text-gray-800">
                                  {item.match_type ?? '--'}
                                </span>
                              </div>
                              <div className="flex items-center justify-between text-xs">
                                <span className="text-gray-500">Confidence</span>
                                <Badge
                                  variant={
                                    item.confidence === 'HIGH'
                                      ? 'green'
                                      : item.confidence === 'MEDIUM'
                                      ? 'yellow'
                                      : 'orange'
                                  }
                                  size="sm"
                                >
                                  {item.confidence}
                                </Badge>
                              </div>
                              <div className="flex items-center justify-between text-xs">
                                <span className="text-gray-500">Composite Score</span>
                                <span className="font-mono text-sm font-bold text-[#1B3A5C]">
                                  {item.composite_score.toFixed(1)}
                                </span>
                              </div>
                              <div className="flex items-center justify-between text-xs">
                                <span className="text-gray-500">Variance Amount</span>
                                <span className="font-mono text-gray-700">
                                  {formatCurrency(item.variance_amt)}
                                </span>
                              </div>
                              {item.cross_fy && (
                                <div className="flex items-center justify-between text-xs">
                                  <span className="text-gray-500">Cross-FY</span>
                                  <Badge variant="orange" size="sm">Yes</Badge>
                                </div>
                              )}
                              {item.is_prior_year && (
                                <div className="flex items-center justify-between text-xs">
                                  <span className="text-gray-500">Prior Year</span>
                                  <Badge variant="yellow" size="sm">Yes</Badge>
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Authorization Info */}
                          <div className="p-4">
                            <p className="text-xs font-semibold text-[#1B3A5C] uppercase tracking-wider mb-2">
                              Authorization
                            </p>
                            <div className="space-y-2">
                              <div className="flex items-center justify-between text-xs">
                                <span className="text-gray-500">Status</span>
                                {statusBadge(item)}
                              </div>
                              {item.authorized_at && (
                                <div className="flex items-center justify-between text-xs">
                                  <span className="text-gray-500">Authorized At</span>
                                  <span className="text-gray-700">
                                    {formatDate(item.authorized_at, 'dd MMM yyyy, HH:mm')}
                                  </span>
                                </div>
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
                                <div className="flex items-center justify-between text-xs">
                                  <span className="text-gray-500">Rejected At</span>
                                  <span className="text-gray-700">
                                    {formatDate(item.rejected_at, 'dd MMM yyyy, HH:mm')}
                                  </span>
                                </div>
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
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
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
