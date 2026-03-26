/**
 * MismatchTrackerTab — Resolution Tracker for mismatches
 * Shows matched pairs with high variance or low confidence that need review,
 * along with unmatched entries and their resolution status.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  runsApi,
  type MatchedPair,
  type Unmatched26AS,
  type UnmatchedBook,
} from '../lib/api';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import {
  cn,
  formatCurrency,
  formatPct,
  formatDate,
  truncate,
} from '../lib/utils';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Filter,
} from 'lucide-react';

interface MismatchTrackerTabProps {
  runId: string;
}

type TrackerFilter = 'all' | 'high_variance' | 'low_confidence' | 'force_match' | 'unmatched';

interface TrackerItem {
  id: string;
  type: 'high_variance' | 'low_confidence' | 'force_match' | 'unmatched_26as' | 'unmatched_book';
  label: string;
  severity: 'critical' | 'warning' | 'info';
  reference: string;
  amount: number;
  detail: string;
  section?: string;
  date?: string;
}

function buildTrackerItems(
  matched: MatchedPair[],
  unmatched26as: Unmatched26AS[],
  unmatchedBooks: UnmatchedBook[],
): TrackerItem[] {
  const items: TrackerItem[] = [];

  // High variance matched pairs (>2%)
  for (const m of matched) {
    if (m.variance_pct > 2) {
      items.push({
        id: `hv-${m.as26_index}`,
        type: 'high_variance',
        label: 'High Variance Match',
        severity: m.variance_pct > 5 ? 'critical' : 'warning',
        reference: `26AS #${m.as26_index ?? '—'}`,
        amount: m.as26_amount,
        detail: `Variance ${formatPct(m.variance_pct)} (${formatCurrency(m.variance_amt)}) — ${m.invoice_count} invoice(s)`,
        section: m.section,
        date: m.as26_date ?? undefined,
      });
    }
  }

  // Low confidence matches
  for (const m of matched) {
    if (m.confidence === 'LOW') {
      items.push({
        id: `lc-${m.as26_index}`,
        type: 'low_confidence',
        label: 'Low Confidence Match',
        severity: 'warning',
        reference: `26AS #${m.as26_index ?? '—'}`,
        amount: m.as26_amount,
        detail: `${m.match_type} — ${m.invoice_refs.join(', ')}`,
        section: m.section,
        date: m.as26_date ?? undefined,
      });
    }
  }

  // Force matches
  for (const m of matched) {
    if (m.match_type?.startsWith('FORCE')) {
      items.push({
        id: `fm-${m.as26_index}`,
        type: 'force_match',
        label: 'Force Match',
        severity: 'warning',
        reference: `26AS #${m.as26_index ?? '—'}`,
        amount: m.as26_amount,
        detail: `${m.match_type} — variance ${formatPct(m.variance_pct)}`,
        section: m.section,
        date: m.as26_date ?? undefined,
      });
    }
  }

  // Unmatched 26AS entries
  unmatched26as.forEach((u, i) => {
    items.push({
      id: `u26-${u.index ?? i}`,
      type: 'unmatched_26as',
      label: 'Unmatched 26AS',
      severity: 'critical',
      reference: `26AS #${u.index ?? i + 1}`,
      amount: u.amount,
      detail: `${u.reason_code ?? '—'}: ${u.reason_label ?? '—'}`,
      section: u.section,
      date: (u.date ?? u.transaction_date) ?? undefined,
    });
  });

  // Unmatched books (top entries by amount)
  const sortedBooks = [...unmatchedBooks].sort((a, b) => b.amount - a.amount);
  for (const b of sortedBooks.slice(0, 50)) {
    items.push({
      id: `ub-${b.invoice_ref}-${b.amount}`,
      type: 'unmatched_book',
      label: 'Unmatched Book',
      severity: 'info',
      reference: truncate(b.invoice_ref, 30),
      amount: b.amount,
      detail: `Doc: ${b.clearing_doc || '--'} · Type: ${b.doc_type || '--'}`,
      section: undefined,
      date: b.doc_date ?? undefined,
    });
  }

  // Sort: critical first, then warning, then info
  const sevOrder = { critical: 0, warning: 1, info: 2 };
  items.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity] || b.amount - a.amount);

  return items;
}

const FILTER_OPTIONS: { value: TrackerFilter; label: string }[] = [
  { value: 'all', label: 'All Issues' },
  { value: 'high_variance', label: 'High Variance' },
  { value: 'low_confidence', label: 'Low Confidence' },
  { value: 'force_match', label: 'Force Match' },
  { value: 'unmatched', label: 'Unmatched' },
];

function severityColor(severity: string) {
  switch (severity) {
    case 'critical': return 'text-red-600 bg-red-50 border-red-200';
    case 'warning': return 'text-amber-600 bg-amber-50 border-amber-200';
    default: return 'text-blue-600 bg-blue-50 border-blue-200';
  }
}

function severityIcon(severity: string) {
  switch (severity) {
    case 'critical': return <AlertTriangle className="h-3.5 w-3.5 text-red-500" />;
    case 'warning': return <Clock className="h-3.5 w-3.5 text-amber-500" />;
    default: return <CheckCircle2 className="h-3.5 w-3.5 text-blue-500" />;
  }
}

export default function MismatchTrackerTab({ runId }: MismatchTrackerTabProps) {
  const [filter, setFilter] = useState<TrackerFilter>('all');

  const { data: matched = [], isLoading: loadingMatched } = useQuery({
    queryKey: ['runs', runId, 'matched'],
    queryFn: () => runsApi.matched(runId),
  });

  const { data: unmatched26as = [], isLoading: loadingU26 } = useQuery({
    queryKey: ['runs', runId, 'unmatched-26as'],
    queryFn: () => runsApi.unmatched26as(runId),
  });

  const { data: unmatchedBooks = [], isLoading: loadingUB } = useQuery({
    queryKey: ['runs', runId, 'unmatched-books'],
    queryFn: () => runsApi.unmatchedBooks(runId),
  });

  const isLoading = loadingMatched || loadingU26 || loadingUB;

  if (isLoading) {
    return (
      <Card>
        <div className="flex items-center justify-center py-12">
          <p className="text-sm text-gray-400">Loading resolution tracker...</p>
        </div>
      </Card>
    );
  }

  const allItems = buildTrackerItems(matched, unmatched26as, unmatchedBooks);

  const filtered = allItems.filter((item) => {
    if (filter === 'all') return true;
    if (filter === 'unmatched') return item.type === 'unmatched_26as' || item.type === 'unmatched_book';
    return item.type === filter;
  });

  const criticalCount = allItems.filter((i) => i.severity === 'critical').length;
  const warningCount = allItems.filter((i) => i.severity === 'warning').length;
  const infoCount = allItems.filter((i) => i.severity === 'info').length;
  const totalImpact = filtered.reduce((s, i) => s + i.amount, 0);

  return (
    <Card padding={false}>
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-100">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <p className="text-xs text-gray-500 font-medium">
              {allItems.length} issues requiring attention
            </p>
            <div className="flex items-center gap-1.5">
              {criticalCount > 0 && (
                <Badge variant="red" size="sm">{criticalCount} critical</Badge>
              )}
              {warningCount > 0 && (
                <Badge variant="yellow" size="sm">{warningCount} warning</Badge>
              )}
              {infoCount > 0 && (
                <Badge variant="blue" size="sm">{infoCount} info</Badge>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Filter className="h-3.5 w-3.5 text-gray-400" />
            <div className="flex gap-1">
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
          </div>
        </div>
      </div>

      {/* Summary bar */}
      <div className="px-4 py-2 bg-gray-50 border-b border-gray-100 flex items-center gap-4 text-xs text-gray-500">
        <span>Showing {filtered.length} of {allItems.length} items</span>
        <span className="text-gray-300">|</span>
        <span>Total impact: <span className="font-mono font-semibold text-gray-700">{formatCurrency(totalImpact)}</span></span>
      </div>

      {/* Items list */}
      <div className="divide-y divide-gray-100">
        {filtered.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-8">
            No issues found for this filter
          </p>
        ) : (
          filtered.map((item) => (
            <div
              key={item.id}
              className="px-4 py-3 hover:bg-gray-50 transition-colors"
            >
              <div className="flex items-start gap-3">
                <div className="mt-0.5 shrink-0">
                  {severityIcon(item.severity)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={cn(
                      'text-xs font-semibold px-1.5 py-0.5 rounded border',
                      severityColor(item.severity),
                    )}>
                      {item.label}
                    </span>
                    <span className="font-mono text-xs text-gray-500">{item.reference}</span>
                    {item.section && (
                      <span className="font-mono text-[10px] text-gray-400">S.{item.section}</span>
                    )}
                    {item.date && (
                      <span className="text-[10px] text-gray-400">{formatDate(item.date)}</span>
                    )}
                  </div>
                  <p className="text-xs text-gray-600 mt-1">{item.detail}</p>
                </div>
                <div className="shrink-0 text-right">
                  <span className="font-mono text-xs font-semibold text-gray-800">
                    {formatCurrency(item.amount)}
                  </span>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}
