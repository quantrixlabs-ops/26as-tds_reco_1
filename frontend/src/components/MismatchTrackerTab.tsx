/**
 * MismatchTrackerTab — Resolution Tracker (tabular) for mismatches.
 * Shows matched pairs with high variance or low confidence that need review,
 * along with unmatched entries — as a sortable, searchable table with pagination.
 */
import { useState, useMemo } from 'react';
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
  Filter,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
} from 'lucide-react';
import { TableSearch } from '../components/ui/TableSearch';
import { TablePagination } from '../components/ui/TablePagination';
import { TableExport } from '../components/ui/TableExport';

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

function severityBadge(severity: string) {
  switch (severity) {
    case 'critical': return <Badge variant="red" size="sm">Critical</Badge>;
    case 'warning': return <Badge variant="yellow" size="sm">Warning</Badge>;
    default: return <Badge variant="blue" size="sm">Info</Badge>;
  }
}

function typeBadge(type: string) {
  switch (type) {
    case 'high_variance': return <Badge variant="red" size="sm">High Variance</Badge>;
    case 'low_confidence': return <Badge variant="yellow" size="sm">Low Confidence</Badge>;
    case 'force_match': return <Badge variant="orange" size="sm">Force Match</Badge>;
    case 'unmatched_26as': return <Badge variant="deepred" size="sm">Unmatched 26AS</Badge>;
    case 'unmatched_book': return <Badge variant="blue" size="sm">Unmatched Book</Badge>;
    default: return <Badge variant="gray" size="sm">{type}</Badge>;
  }
}

type SortKey = 'severity' | 'type' | 'reference' | 'section' | 'date' | 'amount';

const SEV_ORDER: Record<string, number> = { critical: 0, warning: 1, info: 2 };

function SortIcon({ active, dir }: { active: boolean; dir: 'asc' | 'desc' }) {
  if (!active) return <ChevronsUpDown className="h-3 w-3 opacity-30" />;
  return dir === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />;
}

export default function MismatchTrackerTab({ runId }: MismatchTrackerTabProps) {
  const [filter, setFilter] = useState<TrackerFilter>('all');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('severity');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(key === 'amount' ? 'desc' : 'asc'); }
  };

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

  const allItems = useMemo(
    () => buildTrackerItems(matched, unmatched26as, unmatchedBooks),
    [matched, unmatched26as, unmatchedBooks],
  );

  const processed = useMemo(() => {
    let result = allItems.filter((item) => {
      if (filter === 'all') return true;
      if (filter === 'unmatched') return item.type === 'unmatched_26as' || item.type === 'unmatched_book';
      return item.type === filter;
    });

    if (search) {
      const q = search.toLowerCase();
      result = result.filter((item) =>
        item.label.toLowerCase().includes(q)
        || item.reference.toLowerCase().includes(q)
        || item.detail.toLowerCase().includes(q)
        || (item.section ?? '').toLowerCase().includes(q)
        || String(item.amount).includes(q),
      );
    }

    result = [...result].sort((a, b) => {
      let av: string | number, bv: string | number;
      switch (sortKey) {
        case 'severity': av = SEV_ORDER[a.severity] ?? 9; bv = SEV_ORDER[b.severity] ?? 9; break;
        case 'type': av = a.type; bv = b.type; break;
        case 'reference': av = a.reference; bv = b.reference; break;
        case 'section': av = a.section ?? ''; bv = b.section ?? ''; break;
        case 'date': av = a.date ?? ''; bv = b.date ?? ''; break;
        case 'amount': av = a.amount; bv = b.amount; break;
        default: return 0;
      }
      if (typeof av === 'number' && typeof bv === 'number') return sortDir === 'asc' ? av - bv : bv - av;
      return sortDir === 'asc' ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
    });

    return result;
  }, [allItems, filter, search, sortKey, sortDir]);

  const paged = processed.slice((page - 1) * pageSize, page * pageSize);

  const criticalCount = allItems.filter((i) => i.severity === 'critical').length;
  const warningCount = allItems.filter((i) => i.severity === 'warning').length;
  const infoCount = allItems.filter((i) => i.severity === 'info').length;
  const totalImpact = processed.reduce((s, i) => s + i.amount, 0);

  if (isLoading) {
    return (
      <Card>
        <div className="flex items-center justify-center py-12">
          <p className="text-sm text-gray-400">Loading resolution tracker...</p>
        </div>
      </Card>
    );
  }

  const SortTh = ({ k, children, align = 'left' }: { k: SortKey; children: React.ReactNode; align?: string }) => (
    <th
      className={cn(
        'px-3 py-2.5 font-semibold text-[10px] text-gray-500 uppercase tracking-wider whitespace-nowrap cursor-pointer select-none hover:text-gray-700 hover:bg-gray-100 transition-colors',
        align === 'right' ? 'text-right' : 'text-left',
      )}
      onClick={() => handleSort(k)}
    >
      <span className="inline-flex items-center gap-0.5">
        {children}
        <SortIcon active={sortKey === k} dir={sortDir} />
      </span>
    </th>
  );

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
          <span className="text-xs text-gray-500">
            Impact: <span className="font-mono font-semibold text-gray-700">{formatCurrency(totalImpact)}</span>
          </span>
        </div>
      </div>

      {/* Filters + Search */}
      <div className="px-4 py-2 border-b border-gray-100 flex items-center gap-2 flex-wrap">
        <TableSearch
          value={search}
          onChange={(v) => { setSearch(v); setPage(1); }}
          placeholder="Search reference, detail, section..."
          className="w-56"
        />
        <Filter className="h-3.5 w-3.5 text-gray-400" />
        <div className="flex gap-1">
          {FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => { setFilter(opt.value); setPage(1); }}
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
        <span className="ml-auto text-[10px] text-gray-400">
          {processed.length} of {allItems.length} items
        </span>
        <TableExport
          headers={['Severity', 'Type', 'Reference', 'Section', 'Date', 'Amount', 'Detail']}
          rows={processed.map((i) => [
            i.severity, i.type, i.reference, i.section ?? '',
            i.date ?? '', String(i.amount), i.detail,
          ])}
          filename="resolution-tracker.csv"
        />
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-gray-50 border-b border-gray-200 sticky top-0 z-10">
            <tr>
              <SortTh k="severity">Severity</SortTh>
              <SortTh k="type">Type</SortTh>
              <SortTh k="reference">Reference</SortTh>
              <SortTh k="section">Section</SortTh>
              <SortTh k="date">Date</SortTh>
              <SortTh k="amount" align="right">Amount</SortTh>
              <th className="px-3 py-2.5 font-semibold text-[10px] text-gray-500 uppercase tracking-wider text-left whitespace-nowrap">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {paged.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-gray-400 text-sm">
                  No issues found for this filter
                </td>
              </tr>
            ) : (
              paged.map((item, idx) => (
                <tr
                  key={item.id}
                  className={cn(
                    'hover:bg-gray-50 transition-colors',
                    idx % 2 === 1 && 'bg-gray-50/30',
                  )}
                >
                  <td className="px-3 py-2.5">{severityBadge(item.severity)}</td>
                  <td className="px-3 py-2.5">{typeBadge(item.type)}</td>
                  <td className="px-3 py-2.5 font-mono text-gray-700">{item.reference}</td>
                  <td className="px-3 py-2.5 font-mono text-gray-600">{item.section ? `S.${item.section}` : '—'}</td>
                  <td className="px-3 py-2.5 text-gray-600">{item.date ? formatDate(item.date) : '—'}</td>
                  <td className="px-3 py-2.5 text-right font-mono font-semibold text-gray-800">{formatCurrency(item.amount)}</td>
                  <td className="px-3 py-2.5 text-gray-600 max-w-[300px]">
                    <span className="truncate block" title={item.detail}>{item.detail}</span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {processed.length > 25 && (
        <TablePagination
          page={page} pageSize={pageSize} total={processed.length}
          onPageChange={setPage}
          onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
        />
      )}
    </Card>
  );
}
