/**
 * RunDetailPage — full run detail with tabs: Matched / Unmatched 26AS / Unmatched Books / Exceptions / Audit Trail
 */
import { Fragment, useState, useRef, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import {
  Download,
  CheckCircle,
  XCircle,
  AlertTriangle,
  RefreshCw,
  ArrowLeft,
  BookOpen,
  ClipboardList,
  Activity,
  Trash2,
  StopCircle,
  Lightbulb,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  PieChart,
  ListChecks,
  FileText,
  RotateCw,
  Filter,
  X,
  Search,
  ArrowUpDown,
  Copy,
  Check,
  MessageCircle,
  Send,
  Edit3,
} from 'lucide-react';
import {
  runsApi,
  settingsApi,
  authApi,
  type Exception,
  type RunSummary,
  type RunComment,
  type User as ApiUser,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/ui/Toast';
import { Card, StatCard } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Table, type Column } from '../components/ui/Table';
import { FullPageSpinner } from '../components/ui/Spinner';
import { RunProgressPanel } from '../components/RunProgressPanel';
import { PageWrapper } from '../components/ui/PageHeader';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import {
  cn,
  formatDate,
  formatDateTime,
  formatCurrency,
  formatPct,
  matchRateColor,
  runStatusVariant,
  runStatusLabel,
  confidenceVariant,
  severityVariant,
  formatFY,
  getErrorMessage,
  truncate,
  copyToClipboard,
} from '../lib/utils';
import { ErrorBoundary } from '../components/ui/ErrorBoundary';
import { TableSearch } from '../components/ui/TableSearch';
import { TablePagination } from '../components/ui/TablePagination';
import { TableExport } from '../components/ui/TableExport';
import { ColumnToggle } from '../components/ui/ColumnToggle';
import SectionSummaryTab from '../components/SectionSummaryTab';
import MismatchTrackerTab from '../components/MismatchTrackerTab';
import MatchingMethodologyPanel from '../components/MatchingMethodologyPanel';
import SuggestedMatchesTab from '../components/SuggestedMatchesTab';

// ── Copy button ──────────────────────────────────────────────────────────────

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();

  const handleCopy = async () => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      toast('Copied', label ? `${label} copied to clipboard` : 'Copied to clipboard', 'success');
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="inline-flex items-center p-0.5 rounded text-gray-300 hover:text-gray-600 transition-colors"
      title={`Copy ${label || 'value'}`}
    >
      {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

// ── Copyable value ───────────────────────────────────────────────────────────

function Copyable({ value, label, className, children }: {
  value: string;
  label?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  const hasTruncate = className?.includes('truncate');
  return (
    <span className={cn('inline-flex items-center gap-1 group', hasTruncate ? 'max-w-full' : '', className)}>
      <span className={hasTruncate ? 'truncate' : undefined}>{children ?? value}</span>
      <span className="opacity-0 group-hover:opacity-100 transition-opacity print:hidden shrink-0">
        <CopyButton text={value} label={label} />
      </span>
    </span>
  );
}

// ── Metadata card ─────────────────────────────────────────────────────────────

function ConfigDiffPanel({ runId }: { runId: string }) {
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['config-diff', runId],
    queryFn: () => runsApi.configDiff(runId),
  });

  if (isLoading || !data?.has_parent) return null;
  if (data.diff.length === 0) {
    return (
      <div className="flex items-center gap-2 text-xs text-emerald-600 bg-emerald-50 px-3 py-2 rounded-lg">
        <CheckCircle className="h-3.5 w-3.5" />
        Rerun — config unchanged from original
      </div>
    );
  }

  return (
    <div className="border border-amber-200 bg-amber-50 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-amber-800 hover:bg-amber-100 transition-colors"
      >
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span>Rerun — {data.diff.length} config change{data.diff.length !== 1 ? 's' : ''} from original</span>
        {expanded ? <ChevronDown className="h-3 w-3 ml-auto" /> : <ChevronRight className="h-3 w-3 ml-auto" />}
      </button>
      {expanded && (
        <div className="px-3 pb-2">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-amber-700">
                <th className="text-left py-1 pr-3">Parameter</th>
                <th className="text-left py-1 pr-3">Original</th>
                <th className="text-left py-1">Current</th>
              </tr>
            </thead>
            <tbody>
              {data.diff.map((d) => (
                <tr key={d.field} className="border-t border-amber-200">
                  <td className="py-1 pr-3 font-mono text-amber-900">{d.field}</td>
                  <td className="py-1 pr-3 text-red-700 line-through">{String(d.old_value ?? '—')}</td>
                  <td className="py-1 text-emerald-700 font-semibold">{String(d.new_value ?? '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function MetadataCard({ run }: { run: RunSummary }) {
  return (
    <Card>
      {run.parent_batch_id && <ConfigDiffPanel runId={run.id} />}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-4 text-sm">
        <div>
          <p className="text-xs text-gray-400 mb-0.5">Run Number</p>
          <Copyable value={String(run.run_number)} label="Run number" className="font-mono text-gray-900 font-semibold">
            #{run.run_number}
          </Copyable>
        </div>
        <div>
          <p className="text-xs text-gray-400 mb-0.5">Financial Year</p>
          <p className="font-medium text-gray-900">{formatFY(run.financial_year)}</p>
        </div>
        <div className="min-w-0">
          <p className="text-xs text-gray-400 mb-0.5">Deductor</p>
          <Copyable value={run.deductor_name} label="Deductor name" className="font-medium text-gray-900 block truncate" />
        </div>
        <div className="min-w-0">
          <p className="text-xs text-gray-400 mb-0.5">TAN</p>
          <Copyable value={run.tan} label="TAN" className="font-mono text-gray-900" />
        </div>
        <div>
          <p className="text-xs text-gray-400 mb-0.5">Status</p>
          <Badge variant={runStatusVariant(run.status)}>{runStatusLabel(run.status)}</Badge>
        </div>
        <div>
          <p className="text-xs text-gray-400 mb-0.5">Algorithm</p>
          <p className="text-gray-700 font-mono text-xs">{run.algorithm_version ?? 'v5'}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400 mb-0.5">Created</p>
          <p className="text-gray-700">{formatDateTime(run.created_at)}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400 mb-0.5">Completed</p>
          <p className="text-gray-700">{formatDateTime(run.completed_at)}</p>
        </div>
        <div className="col-span-2">
          <p className="text-xs text-gray-400 mb-0.5">SAP File Hash (SHA-256)</p>
          <Copyable value={run.sap_file_hash} label="SAP file hash" className="font-mono text-xs text-gray-500 break-all" />
        </div>
        <div className="col-span-2">
          <p className="text-xs text-gray-400 mb-0.5">26AS File Hash (SHA-256)</p>
          <Copyable value={run.as26_file_hash} label="26AS file hash" className="font-mono text-xs text-gray-500 break-all" />
        </div>
      </div>
    </Card>
  );
}

// ── Matched pairs tab ─────────────────────────────────────────────────────────

// ── Helpers for month extraction ────────────────────────────────────────────

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseMonth(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  // Supports "DD-Mon-YYYY", "YYYY-MM-DD", "DD/MM/YYYY" etc.
  const d = new Date(dateStr.replace(/-/g, ' '));
  if (isNaN(d.getTime())) return null;
  return `${MONTH_LABELS[d.getMonth()]} ${d.getFullYear()}`;
}

// ── Excel-style dropdown filter ────────────────────────────────────────────

function DropdownFilter({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: string[];
  selected: Set<string>;
  onChange: (s: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const filtered = options.filter((o) => o.toLowerCase().includes(search.toLowerCase()));
  const isActive = selected.size > 0;

  if (options.length === 0) return null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => { setOpen(!open); setSearch(''); }}
        className={cn(
          'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors',
          isActive
            ? 'bg-[#1B3A5C] text-white border-[#1B3A5C]'
            : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400',
        )}
      >
        <Filter className="h-3 w-3" />
        {label}
        {isActive && (
          <span className="bg-white/20 rounded-full px-1.5 text-[10px] font-bold">{selected.size}</span>
        )}
        <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 w-56 bg-white rounded-lg shadow-lg border border-gray-200 z-50">
          <div className="p-2 border-b border-gray-100">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-gray-400" />
              <input
                type="text"
                placeholder="Search..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-7 pr-2 py-1.5 text-xs border border-gray-200 rounded outline-none focus:border-[#1B3A5C]"
                autoFocus
              />
            </div>
          </div>
          <div className="px-2 py-1.5 border-b border-gray-100 flex items-center justify-between">
            <button
              type="button"
              onClick={() => onChange(new Set(options))}
              className="text-[10px] text-[#1B3A5C] font-medium hover:underline"
            >
              Select all
            </button>
            <button
              type="button"
              onClick={() => onChange(new Set())}
              className="text-[10px] text-red-500 font-medium hover:underline"
            >
              Clear
            </button>
          </div>
          <div className="max-h-48 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <p className="text-xs text-gray-400 text-center py-3">No matches</p>
            ) : (
              filtered.map((opt) => (
                <label
                  key={opt}
                  className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-50 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(opt)}
                    onChange={() => {
                      const next = new Set(selected);
                      if (next.has(opt)) next.delete(opt); else next.add(opt);
                      onChange(next);
                    }}
                    className="rounded border-gray-300 text-[#1B3A5C] focus:ring-[#1B3A5C] h-3.5 w-3.5"
                  />
                  <span className="text-xs text-gray-700">{opt}</span>
                </label>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Matched tab with filters + sorting ──────────────────────────────────────

function MatchedTab({ runId }: { runId: string }) {
  const { data = [], isLoading, isError, error } = useQuery({
    queryKey: ['runs', runId, 'matched'],
    queryFn: () => runsApi.matched(runId),
  });
  const [expandedRow, setExpandedRow] = useState<number | null>(null);

  // Global search
  const [globalSearch, setGlobalSearch] = useState('');
  // Pagination
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  // Dropdown filter state
  const [selectedMonths, setSelectedMonths] = useState<Set<string>>(new Set());
  const [selectedSections, setSelectedSections] = useState<Set<string>>(new Set());
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [selectedConfidence, setSelectedConfidence] = useState<Set<string>>(new Set());

  // Column visibility
  const allColKeys = ['as26_index', 'as26_date', 'section', 'as26_amount', 'books_sum', 'variance_pct', 'match_type', 'confidence', 'invoice_count'];
  const [visibleCols, setVisibleCols] = useState<Set<string>>(new Set(allColKeys));


  // Sort state
  type SortKey = 'as26_index' | 'as26_date' | 'section' | 'as26_amount' | 'books_sum' | 'variance_pct' | 'match_type' | 'confidence' | 'invoice_count';
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  // Derive unique filter options from data
  const monthOptions = [...new Set(data.map((r) => parseMonth(r.as26_date)).filter(Boolean) as string[])].sort(
    (a, b) => new Date(a).getTime() - new Date(b).getTime(),
  );
  const sectionOptions = [...new Set(data.map((r) => r.section).filter(Boolean))].sort();
  const typeOptions = [...new Set(data.map((r) => r.match_type))].sort();
  const confidenceOptions: string[] = ['HIGH', 'MEDIUM', 'LOW'].filter((c) => data.some((r) => r.confidence === c));

  const activeFilterCount =
    (selectedMonths.size > 0 ? 1 : 0) +
    (selectedSections.size > 0 ? 1 : 0) +
    (selectedTypes.size > 0 ? 1 : 0) +
    (selectedConfidence.size > 0 ? 1 : 0) +
    (globalSearch ? 1 : 0);

  const clearAllFilters = () => {
    setSelectedMonths(new Set());
    setSelectedSections(new Set());
    setSelectedTypes(new Set());
    setSelectedConfidence(new Set());
    setGlobalSearch('');
    setPage(1);
  };

  // Apply filters
  const filtered = data.filter((r) => {
    if (globalSearch) {
      const q = globalSearch.toLowerCase();
      const hay = [
        String(r.as26_index ?? ''),
        r.as26_date ?? '',
        r.section ?? '',
        String(r.as26_amount),
        String(r.books_sum),
        r.match_type,
        r.confidence,
        r.invoice_refs.join(' '),
      ].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (selectedMonths.size > 0) {
      const m = parseMonth(r.as26_date);
      if (!m || !selectedMonths.has(m)) return false;
    }
    if (selectedSections.size > 0 && !selectedSections.has(r.section)) return false;
    if (selectedTypes.size > 0 && !selectedTypes.has(r.match_type)) return false;
    if (selectedConfidence.size > 0 && !selectedConfidence.has(r.confidence)) return false;
    return true;
  });

  // Sort
  const CONF_RANK: Record<string, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };
  const sorted = sortKey
    ? [...filtered].sort((a, b) => {
        let cmp = 0;
        switch (sortKey) {
          case 'as26_index': cmp = (a.as26_index ?? 0) - (b.as26_index ?? 0); break;
          case 'as26_date': {
            const da = a.as26_date ? new Date(a.as26_date.replace(/-/g, ' ')).getTime() : 0;
            const db = b.as26_date ? new Date(b.as26_date.replace(/-/g, ' ')).getTime() : 0;
            cmp = da - db;
            break;
          }
          case 'section': cmp = (a.section ?? '').localeCompare(b.section ?? ''); break;
          case 'as26_amount': cmp = a.as26_amount - b.as26_amount; break;
          case 'books_sum': cmp = a.books_sum - b.books_sum; break;
          case 'variance_pct': cmp = a.variance_pct - b.variance_pct; break;
          case 'match_type': cmp = a.match_type.localeCompare(b.match_type); break;
          case 'confidence': cmp = (CONF_RANK[a.confidence] ?? 0) - (CONF_RANK[b.confidence] ?? 0); break;
          case 'invoice_count': cmp = a.invoice_count - b.invoice_count; break;
        }
        return sortDir === 'desc' ? -cmp : cmp;
      })
    : filtered;

  const paged = sorted.slice((page - 1) * pageSize, page * pageSize);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      if (sortDir === 'asc') setSortDir('desc');
      else { setSortKey(null); setSortDir('asc'); }
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <ArrowUpDown className="h-3 w-3 text-gray-300" />;
    return sortDir === 'asc'
      ? <ChevronUp className="h-3 w-3 text-[#1B3A5C]" />
      : <ChevronDown className="h-3 w-3 text-[#1B3A5C]" />;
  };

  const toggleRow = (idx: number) => {
    setExpandedRow(expandedRow === idx ? null : idx);
  };

  const allColumns: { key: SortKey; label: string; align: 'left' | 'right' }[] = [
    { key: 'as26_index', label: '26AS #', align: 'left' },
    { key: 'as26_date', label: 'Date', align: 'left' },
    { key: 'section', label: 'Section', align: 'left' },
    { key: 'as26_amount', label: '26AS Amount', align: 'right' },
    { key: 'books_sum', label: 'Books Sum', align: 'right' },
    { key: 'variance_pct', label: 'Variance', align: 'right' },
    { key: 'match_type', label: 'Type', align: 'left' },
    { key: 'confidence', label: 'Confidence', align: 'left' },
    { key: 'invoice_count', label: 'Invoices', align: 'left' },
  ];
  const columns = allColumns.filter((c) => visibleCols.has(c.key));
  const colCount = columns.length + 1; // +1 for expand chevron

  return (
    <Card padding={false}>
      {/* Toolbar: search bar + dropdown filters */}
      <div className="px-4 py-3 border-b border-gray-100 space-y-2.5">
        <div className="flex items-center gap-3">
          <TableSearch
            value={globalSearch}
            onChange={(v) => { setGlobalSearch(v); setPage(1); }}
            placeholder="Search all columns..."
            className="flex-1 max-w-sm"
          />
          <p className="text-xs text-gray-400 shrink-0">
            {activeFilterCount > 0
              ? <>{sorted.length} of {data.length} pairs</>
              : <>{data.length} matched pairs</>}
            {' · '}
            <span title="Over-claim check: books total never exceeds 26AS credit">Books ≤ 26AS</span>
          </p>
          {activeFilterCount > 0 && (
            <button
              type="button"
              onClick={clearAllFilters}
              className="flex items-center gap-1 text-[11px] text-red-600 hover:text-red-700 font-medium shrink-0"
            >
              <X className="h-3 w-3" /> Clear all
            </button>
          )}
          <TableExport
            headers={['26AS #', 'Date', 'Section', '26AS Amount', 'Books Sum', 'Variance %', 'Variance Amt', 'Type', 'Confidence', 'Invoices', 'Invoice Refs']}
            rows={sorted.map((r) => [
              String(r.as26_index ?? ''),
              r.as26_date ?? '',
              r.section ?? '',
              String(r.as26_amount),
              String(r.books_sum),
              String(r.variance_pct),
              String(r.variance_amt ?? ''),
              r.match_type,
              r.confidence,
              String(r.invoice_count),
              r.invoice_refs.join('; '),
            ])}
            filename="matched-pairs.csv"
          />
          <ColumnToggle
            columns={allColumns.map((c) => ({ key: c.key, label: c.label, locked: c.key === 'as26_amount' }))}
            visible={visibleCols}
            onChange={setVisibleCols}
          />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <DropdownFilter label="Month" options={monthOptions} selected={selectedMonths} onChange={setSelectedMonths} />
          <DropdownFilter label="Section" options={sectionOptions} selected={selectedSections} onChange={setSelectedSections} />
          <DropdownFilter label="Type" options={typeOptions} selected={selectedTypes} onChange={setSelectedTypes} />
          <DropdownFilter label="Confidence" options={confidenceOptions} selected={selectedConfidence} onChange={setSelectedConfidence} />
        </div>
      </div>

      {/* Table with sortable headers */}
      <div className="w-full overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50">
            <tr>
              <th className="px-2 py-3 w-8" />
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={cn(
                    'px-4 py-3 font-semibold text-xs text-gray-500 uppercase tracking-wider whitespace-nowrap cursor-pointer select-none hover:text-gray-700 transition-colors',
                    col.align === 'right' ? 'text-right' : 'text-left',
                  )}
                  onClick={() => handleSort(col.key)}
                >
                  <span className={cn('inline-flex items-center gap-1', col.align === 'right' && 'flex-row-reverse')}>
                    {col.label}
                    <SortIcon col={col.key} />
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: colCount }).map((_, j) => (
                    <td key={j} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td>
                  ))}
                </tr>
              ))
            ) : isError ? (
              <tr>
                <td colSpan={colCount} className="px-4 py-12 text-center text-sm">
                  <div className="flex flex-col items-center gap-2">
                    <AlertTriangle className="h-5 w-5 text-red-400" />
                    <span className="text-red-600 font-medium">Failed to load matched pairs</span>
                    <span className="text-gray-400 text-xs">{getErrorMessage(error)}</span>
                  </div>
                </td>
              </tr>
            ) : sorted.length === 0 ? (
              <tr>
                <td colSpan={colCount} className="px-4 py-12 text-center text-gray-400 text-sm">
                  {activeFilterCount > 0
                    ? 'No matched pairs match your filters'
                    : 'No matched pairs for this run'}
                </td>
              </tr>
            ) : (
              paged.map((r, idx) => (
                <Fragment key={`matched-${r.id || idx}`}>
                  <tr
                    className="hover:bg-gray-50 transition-colors cursor-pointer"
                    onClick={() => toggleRow(idx)}
                  >
                    <td className="px-2 py-3 text-gray-400">
                      {expandedRow === idx
                        ? <ChevronDown className="h-4 w-4 text-[#1B3A5C]" />
                        : <ChevronRight className="h-4 w-4" />}
                    </td>
                    {visibleCols.has('as26_index') && <td className="px-4 py-3"><span className="font-mono text-xs text-gray-500">#{r.as26_index ?? idx + 1}</span></td>}
                    {visibleCols.has('as26_date') && <td className="px-4 py-3"><span className="text-xs">{formatDate(r.as26_date)}</span></td>}
                    {visibleCols.has('section') && <td className="px-4 py-3"><span className="font-mono text-xs">{r.section}</span></td>}
                    {visibleCols.has('as26_amount') && <td className="px-4 py-3 text-right"><span className="font-mono text-xs">{formatCurrency(r.as26_amount)}</span></td>}
                    {visibleCols.has('books_sum') && <td className="px-4 py-3 text-right"><span className="font-mono text-xs">{formatCurrency(r.books_sum)}</span></td>}
                    {visibleCols.has('variance_pct') && (
                      <td className="px-4 py-3 text-right">
                        <span className={cn('font-mono text-xs', r.variance_pct > 3 ? 'text-red-600' : r.variance_pct > 1 ? 'text-amber-600' : 'text-gray-700')}>
                          {formatPct(r.variance_pct)}
                        </span>
                      </td>
                    )}
                    {visibleCols.has('match_type') && <td className="px-4 py-3"><span className="font-mono text-xs text-gray-600">{r.match_type}</span></td>}
                    {visibleCols.has('confidence') && (
                      <td className="px-4 py-3">
                        <Badge variant={confidenceVariant(r.confidence)} size="sm">{r.confidence}</Badge>
                      </td>
                    )}
                    {visibleCols.has('invoice_count') && (
                      <td className="px-4 py-3">
                        <span className="text-xs text-gray-500" title={r.invoice_refs.join(', ')}>{r.invoice_count} inv</span>
                      </td>
                    )}
                  </tr>
                  {expandedRow === idx && (
                    <tr key={`matched-detail-${r.id || idx}`} className="bg-gray-50/70">
                      <td colSpan={colCount} className="px-0 py-0">
                        <div className="border-l-4 border-[#1B3A5C] mx-4 my-3 bg-white rounded-lg shadow-sm overflow-hidden">
                          <div className="grid grid-cols-1 lg:grid-cols-3 gap-0 divide-y lg:divide-y-0 lg:divide-x divide-gray-100">
                            {/* Invoice Details */}
                            <div className="p-4">
                              <p className="text-xs font-semibold text-[#1B3A5C] uppercase tracking-wider mb-2">Invoice Details</p>
                              {r.invoice_refs.length > 0 ? (
                                <div className="space-y-1.5">
                                  {r.invoice_refs.map((ref, i) => (
                                    <div key={i} className="flex items-center justify-between gap-2 text-xs">
                                      <span className="font-mono text-gray-800 truncate" title={ref}>{ref}</span>
                                      <div className="flex items-center gap-2 shrink-0 text-gray-500">
                                        {r.invoice_amounts?.[i] != null && (
                                          <span className="font-mono">{formatCurrency(r.invoice_amounts[i])}</span>
                                        )}
                                        {r.invoice_dates?.[i] && (
                                          <span>{formatDate(r.invoice_dates[i])}</span>
                                        )}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <p className="text-xs text-gray-400">No invoice details</p>
                              )}
                              {r.clearing_doc && (
                                <div className="mt-3 pt-2 border-t border-gray-100">
                                  <span className="text-xs text-gray-400">Clearing Doc: </span>
                                  <span className="text-xs font-mono text-gray-700">{r.clearing_doc}</span>
                                </div>
                              )}
                            </div>

                            {/* Score Breakdown */}
                            <div className="p-4">
                              <p className="text-xs font-semibold text-[#1B3A5C] uppercase tracking-wider mb-2">Score Breakdown</p>
                              {r.composite_score != null && (
                                <div className="flex items-center gap-2 mb-2">
                                  <span className="text-xs text-gray-400">Composite:</span>
                                  <span className="text-sm font-bold text-[#1B3A5C]">{r.composite_score.toFixed(1)}</span>
                                </div>
                              )}
                              {r.score_breakdown ? (
                                <div className="space-y-1.5">
                                  {[
                                    { label: 'Variance', value: r.score_breakdown.variance, max: 30 },
                                    { label: 'Date Proximity', value: r.score_breakdown.date_proximity, max: 20 },
                                    { label: 'Section Match', value: r.score_breakdown.section, max: 20 },
                                    { label: 'Clearing Doc', value: r.score_breakdown.clearing_doc, max: 20 },
                                    { label: 'Historical', value: r.score_breakdown.historical, max: 10 },
                                  ].map((s) => {
                                    const raw = s.value ?? 0;
                                    // Scores come as 0–1 fractions of composite; convert to component points
                                    const pts = raw > 1 ? raw : raw * s.max;
                                    const pct = Math.min(100, (pts / s.max) * 100);
                                    return (
                                      <div key={s.label} className="flex items-center gap-2">
                                        <span className="text-xs text-gray-500 w-24">{s.label}</span>
                                        <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                                          <div
                                            className="h-full bg-[#1B3A5C] rounded-full"
                                            style={{ width: `${pct}%` }}
                                          />
                                        </div>
                                        <span className="text-xs font-mono text-gray-600 w-16 text-right">
                                          {s.value != null ? `${pts.toFixed(1)}/${s.max}` : '—'}
                                        </span>
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : (
                                <p className="text-xs text-gray-400">No score breakdown available</p>
                              )}
                            </div>

                            {/* Match Flags */}
                            <div className="p-4">
                              <p className="text-xs font-semibold text-[#1B3A5C] uppercase tracking-wider mb-2">Match Info</p>
                              <div className="space-y-2">
                                <div className="flex items-center justify-between text-xs">
                                  <span className="text-gray-500">Match Type</span>
                                  <span className="font-mono font-medium text-gray-800">{r.match_type || '—'}</span>
                                </div>
                                <div className="flex items-center justify-between text-xs">
                                  <span className="text-gray-500">Confidence</span>
                                  <Badge variant={confidenceVariant(r.confidence)} size="sm">{r.confidence || '—'}</Badge>
                                </div>
                                <div className="flex items-center justify-between text-xs">
                                  <span className="text-gray-500">Variance Amount</span>
                                  <span className="font-mono text-gray-700">{r.variance_amt != null ? formatCurrency(r.variance_amt) : '—'}</span>
                                </div>
                                <div className="flex items-center justify-between text-xs">
                                  <span className="text-gray-500">Variance %</span>
                                  <span className="font-mono text-gray-700">{r.variance_pct != null ? formatPct(r.variance_pct) : '—'}</span>
                                </div>
                                <div className="flex items-center justify-between text-xs">
                                  <span className="text-gray-500">Cross-FY</span>
                                  {r.cross_fy
                                    ? <Badge variant="orange" size="sm">Yes</Badge>
                                    : <span className="text-gray-400">No</span>}
                                </div>
                                <div className="flex items-center justify-between text-xs">
                                  <span className="text-gray-500">Prior Year</span>
                                  {r.is_prior_year
                                    ? <Badge variant="yellow" size="sm">Yes</Badge>
                                    : <span className="text-gray-400">No</span>}
                                </div>
                                {r.ai_risk_flag && (
                                  <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded-md">
                                    <div className="flex items-center gap-1.5 mb-1">
                                      <AlertTriangle className="h-3 w-3 text-red-500" />
                                      <span className="text-xs font-semibold text-red-700">AI Risk Flag</span>
                                    </div>
                                    {r.ai_risk_reason && (
                                      <p className="text-xs text-red-600">{r.ai_risk_reason}</p>
                                    )}
                                  </div>
                                )}
                                {r.remark && (
                                  <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded-md">
                                    <div className="flex items-center gap-1.5 mb-1">
                                      <AlertTriangle className="h-3 w-3 text-amber-500" />
                                      <span className="text-xs font-semibold text-amber-700">Audit Remark</span>
                                    </div>
                                    <p className="text-xs text-amber-700">{r.remark}</p>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))
            )}
          </tbody>
        </table>
      </div>
      {sorted.length > 25 && (
        <TablePagination
          page={page} pageSize={pageSize} total={sorted.length}
          onPageChange={(p) => { setPage(p); setExpandedRow(null); }}
          onPageSizeChange={(s) => { setPageSize(s); setPage(1); setExpandedRow(null); }}
        />
      )}
    </Card>
  );
}

// ── Unmatched 26AS tab ────────────────────────────────────────────────────────

function Unmatched26ASTab({ runId }: { runId: string }) {
  const { data = [], isLoading } = useQuery({
    queryKey: ['runs', runId, 'unmatched-26as'],
    queryFn: () => runsApi.unmatched26as(runId),
  });
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [reasonFilter, setReasonFilter] = useState<string>('');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<string>('amount');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const handleSort = (key: string) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('desc'); }
  };

  const totalAmount = data.reduce((sum, r) => sum + (r.amount || 0), 0);
  const reasonCodes = [...new Set(data.map((r) => r.reason_code).filter(Boolean))].sort();

  // Filter → Search → Sort → Paginate
  let processed = reasonFilter ? data.filter((r) => r.reason_code === reasonFilter) : data;
  if (search) {
    const q = search.toLowerCase();
    processed = processed.filter((r) =>
      (r.deductor_name ?? '').toLowerCase().includes(q)
      || (r.tan ?? '').toLowerCase().includes(q)
      || (r.section ?? '').toLowerCase().includes(q)
      || (r.reason_code ?? '').toLowerCase().includes(q)
      || String(r.amount).includes(q)
      || String(r.index).includes(q),
    );
  }
  const filteredAmount = processed.reduce((sum, r) => sum + (r.amount || 0), 0);

  processed = [...processed].sort((a, b) => {
    let av: string | number | null, bv: string | number | null;
    switch (sortKey) {
      case 'index': av = a.index ?? 0; bv = b.index ?? 0; break;
      case 'deductor_name': av = (a.deductor_name ?? '').toLowerCase(); bv = (b.deductor_name ?? '').toLowerCase(); break;
      case 'section': av = a.section ?? ''; bv = b.section ?? ''; break;
      case 'date': av = a.date ?? a.transaction_date ?? ''; bv = b.date ?? b.transaction_date ?? ''; break;
      case 'amount': av = a.amount ?? 0; bv = b.amount ?? 0; break;
      case 'reason_code': av = a.reason_code ?? ''; bv = b.reason_code ?? ''; break;
      default: return 0;
    }
    if (typeof av === 'number' && typeof bv === 'number') return sortDir === 'asc' ? av - bv : bv - av;
    return sortDir === 'asc' ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
  });

  const total = processed.length;
  const paged = processed.slice((page - 1) * pageSize, page * pageSize);

  // Reset page on filter/search change
  const resetPage = () => setPage(1);

  const [showLegend, setShowLegend] = useState(false);

  const SortTh = ({ k, children, align = 'left' }: { k: string; children: React.ReactNode; align?: string }) => (
    <th
      className={cn(
        'px-4 py-2.5 font-semibold text-[10px] text-gray-500 uppercase tracking-wider whitespace-nowrap cursor-pointer select-none hover:text-gray-700 hover:bg-gray-100 transition-colors',
        align === 'right' ? 'text-right' : 'text-left',
      )}
      onClick={() => handleSort(k)}
    >
      <span className="inline-flex items-center gap-0.5">
        {children}
        {sortKey === k
          ? (sortDir === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)
          : <ArrowUpDown className="h-3 w-3 opacity-30" />}
      </span>
    </th>
  );

  return (
    <Card padding={false}>
      <div className="px-4 py-3 border-b border-gray-100 space-y-2">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
            <p className="text-xs text-gray-500">
              {(reasonFilter || search)
                ? <>{total} of {data.length} entries · {formatCurrency(filteredAmount)}</>
                : <>{data.length} unmatched 26AS entries</>}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowLegend(!showLegend)}
              className="text-xs text-[#1B3A5C] font-medium hover:underline flex items-center gap-1"
            >
              <BookOpen className="h-3 w-3" />
              {showLegend ? 'Hide legend' : 'Reason code legend'}
            </button>
            {data.length > 0 && (
              <p className="text-sm font-semibold text-red-600">
                Total exposure: {formatCurrency(totalAmount)}
              </p>
            )}
          </div>
        </div>
        {showLegend && (
          <div className="p-2.5 bg-gray-50 rounded-lg border border-gray-100 space-y-1.5">
            <div className="flex items-start gap-2">
              <span className="font-mono text-xs text-red-600 w-8 shrink-0 font-semibold">U01</span>
              <span className="text-xs text-gray-600">No matching invoice found in SAP at any threshold — no candidate even close.</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="font-mono text-xs text-red-600 w-8 shrink-0 font-semibold">U02</span>
              <span className="text-xs text-gray-600">Candidate invoice(s) existed but were consumed by other, higher-scoring matches first.</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="font-mono text-xs text-red-600 w-8 shrink-0 font-semibold">U04</span>
              <span className="text-xs text-gray-600">Below noise threshold (amount &lt; Rs.1) — excluded from matching as immaterial.</span>
            </div>
          </div>
        )}
        <div className="flex items-center gap-2 flex-wrap">
          <TableSearch
            value={search}
            onChange={(v) => { setSearch(v); resetPage(); }}
            placeholder="Search deductor, TAN, section, amount..."
            className="w-64"
          />
          {reasonCodes.length > 1 && (
            <>
              <select
                value={reasonFilter}
                onChange={(e) => { setReasonFilter(e.target.value); resetPage(); }}
                className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:border-[#1B3A5C]"
              >
                <option value="">All reason codes</option>
                {reasonCodes.map((code) => {
                  const count = data.filter((r) => r.reason_code === code).length;
                  return <option key={code} value={code}>{code} ({count})</option>;
                })}
              </select>
            </>
          )}
          {(reasonFilter || search) && (
            <button onClick={() => { setReasonFilter(''); setSearch(''); resetPage(); }} className="text-xs text-red-500 hover:underline">Clear all</button>
          )}
          <TableExport
            headers={['#', 'Deductor', 'TAN', 'Section', 'Date', 'Amount', 'Reason Code', 'Reason']}
            rows={processed.map((r) => [
              String(r.index ?? ''), r.deductor_name ?? '', r.tan ?? '', r.section ?? '',
              r.date ?? r.transaction_date ?? '', String(r.amount ?? 0),
              r.reason_code ?? '', r.reason_label ?? '',
            ])}
            filename="unmatched-26as.csv"
          />
        </div>
      </div>
      <div className="w-full overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="border-b border-gray-200 bg-gray-50 sticky top-0 z-10">
            <tr>
              <th className="px-2 py-2.5 w-8" />
              <SortTh k="index">#</SortTh>
              <SortTh k="deductor_name">Deductor</SortTh>
              <th className="px-4 py-2.5 font-semibold text-[10px] text-gray-500 uppercase tracking-wider text-left whitespace-nowrap">TAN</th>
              <SortTh k="section">Section</SortTh>
              <SortTh k="date">Date</SortTh>
              <SortTh k="amount" align="right">Amount</SortTh>
              <SortTh k="reason_code">Reason</SortTh>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: 8 }).map((_, j) => (
                    <td key={j} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td>
                  ))}
                </tr>
              ))
            ) : paged.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-gray-400 text-sm">
                  {(reasonFilter || search) ? 'No entries match the current filters' : 'All 26AS entries matched'}
                </td>
              </tr>
            ) : (
              paged.map((r, idx) => {
                const rowKey = `u26-${r.index ?? idx}`;
                const isExpanded = expandedRow === rowKey;
                return (
                  <Fragment key={rowKey}>
                    <tr
                      className={cn('hover:bg-gray-50 transition-colors cursor-pointer', idx % 2 === 1 && 'bg-gray-50/30')}
                      onClick={() => setExpandedRow(isExpanded ? null : rowKey)}
                    >
                      <td className="px-2 py-2.5 text-gray-400">
                        {isExpanded
                          ? <ChevronDown className="h-4 w-4 text-[#1B3A5C]" />
                          : <ChevronRight className="h-4 w-4" />}
                      </td>
                      <td className="px-4 py-2.5"><span className="font-mono text-gray-400">#{r.index}</span></td>
                      <td className="px-4 py-2.5" title={r.deductor_name}><span>{truncate(r.deductor_name, 30)}</span></td>
                      <td className="px-4 py-2.5"><span className="font-mono">{r.tan}</span></td>
                      <td className="px-4 py-2.5"><span className="font-mono">{r.section}</span></td>
                      <td className="px-4 py-2.5">{formatDate(r.date ?? r.transaction_date)}</td>
                      <td className="px-4 py-2.5 text-right"><span className="font-mono font-semibold">{formatCurrency(r.amount)}</span></td>
                      <td className="px-4 py-2.5">
                        <div>
                          <span className="font-mono text-red-600 font-semibold">{r.reason_code}</span>
                          <p className="text-gray-400">{r.reason_label}</p>
                        </div>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="bg-gray-50/70">
                        <td colSpan={8} className="px-0 py-0">
                          <div className="border-l-4 border-[#1B3A5C] mx-4 my-3 bg-white rounded-lg shadow-sm p-4">
                            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                              <div>
                                <p className="text-xs text-gray-400 mb-0.5">Full Deductor Name</p>
                                <p className="text-sm font-medium text-gray-900">{r.deductor_name}</p>
                              </div>
                              <div>
                                <p className="text-xs text-gray-400 mb-0.5">TAN</p>
                                <p className="font-mono text-sm text-gray-800">{r.tan}</p>
                              </div>
                              <div>
                                <p className="text-xs text-gray-400 mb-0.5">Section</p>
                                <p className="font-mono text-sm text-gray-800">{r.section}</p>
                              </div>
                              <div>
                                <p className="text-xs text-gray-400 mb-0.5">Amount</p>
                                <p className="font-mono text-sm font-semibold text-[#1B3A5C]">{formatCurrency(r.amount)}</p>
                              </div>
                              <div>
                                <p className="text-xs text-gray-400 mb-0.5">Transaction Date</p>
                                <p className="text-sm text-gray-800">{formatDate(r.date ?? r.transaction_date) || '--'}</p>
                              </div>
                              <div>
                                <p className="text-xs text-gray-400 mb-0.5">Reason Code</p>
                                <p className="font-mono text-sm font-semibold text-red-600">{r.reason_code}</p>
                              </div>
                              <div className="col-span-2">
                                <p className="text-xs text-gray-400 mb-0.5">Reason Detail</p>
                                <p className="text-sm text-gray-700">{r.reason_detail || r.reason_label || '--'}</p>
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {total > 25 && (
        <TablePagination
          page={page} pageSize={pageSize} total={total}
          onPageChange={setPage}
          onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
        />
      )}
    </Card>
  );
}

// ── Unmatched Books tab ───────────────────────────────────────────────────────

function UnmatchedBooksTab({ runId }: { runId: string }) {
  const { data = [], isLoading } = useQuery({
    queryKey: ['runs', runId, 'unmatched-books'],
    queryFn: () => runsApi.unmatchedBooks(runId),
  });
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [docTypeFilter, setDocTypeFilter] = useState('');
  const [sortKey, setSortKey] = useState<string>('amount');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const handleSort = (key: string) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('desc'); }
  };

  const docTypes = [...new Set(data.map((r) => r.doc_type).filter(Boolean))].sort();
  const totalAmount = data.reduce((sum, r) => sum + (r.amount || 0), 0);

  // Filter → Search → Sort → Paginate
  let processed = docTypeFilter ? data.filter((r) => r.doc_type === docTypeFilter) : data;
  if (search) {
    const q = search.toLowerCase();
    processed = processed.filter((r) =>
      (r.invoice_ref ?? '').toLowerCase().includes(q)
      || (r.clearing_doc ?? '').toLowerCase().includes(q)
      || (r.doc_type ?? '').toLowerCase().includes(q)
      || (r.sgl_flag ?? '').toLowerCase().includes(q)
      || String(r.amount).includes(q),
    );
  }

  processed = [...processed].sort((a, b) => {
    let av: string | number | null, bv: string | number | null;
    switch (sortKey) {
      case 'invoice_ref': av = (a.invoice_ref ?? '').toLowerCase(); bv = (b.invoice_ref ?? '').toLowerCase(); break;
      case 'clearing_doc': av = a.clearing_doc ?? ''; bv = b.clearing_doc ?? ''; break;
      case 'doc_date': av = a.doc_date ?? ''; bv = b.doc_date ?? ''; break;
      case 'amount': av = a.amount ?? 0; bv = b.amount ?? 0; break;
      case 'doc_type': av = a.doc_type ?? ''; bv = b.doc_type ?? ''; break;
      default: return 0;
    }
    if (typeof av === 'number' && typeof bv === 'number') return sortDir === 'asc' ? av - bv : bv - av;
    return sortDir === 'asc' ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
  });

  const total = processed.length;
  const paged = processed.slice((page - 1) * pageSize, page * pageSize);
  const resetPage = () => setPage(1);

  const SortTh = ({ k, children, align = 'left' }: { k: string; children: React.ReactNode; align?: string }) => (
    <th
      className={cn(
        'px-4 py-2.5 font-semibold text-[10px] text-gray-500 uppercase tracking-wider whitespace-nowrap cursor-pointer select-none hover:text-gray-700 hover:bg-gray-100 transition-colors',
        align === 'right' ? 'text-right' : 'text-left',
      )}
      onClick={() => handleSort(k)}
    >
      <span className="inline-flex items-center gap-0.5">
        {children}
        {sortKey === k
          ? (sortDir === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)
          : <ArrowUpDown className="h-3 w-3 opacity-30" />}
      </span>
    </th>
  );

  return (
    <Card padding={false}>
      <div className="px-4 py-3 border-b border-gray-100 space-y-2">
        <div className="flex items-center justify-between gap-4">
          <p className="text-xs text-gray-500">
            {(search || docTypeFilter) ? `${total} of ${data.length}` : data.length} unmatched SAP book entries
          </p>
          {data.length > 0 && (
            <p className="text-xs text-gray-500">
              Total: <span className="font-mono font-semibold text-gray-700">{formatCurrency(totalAmount)}</span>
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <TableSearch
            value={search}
            onChange={(v) => { setSearch(v); resetPage(); }}
            placeholder="Search invoice, clearing doc, amount..."
            className="w-64"
          />
          {docTypes.length > 1 && (
            <select
              value={docTypeFilter}
              onChange={(e) => { setDocTypeFilter(e.target.value); resetPage(); }}
              className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:border-[#1B3A5C]"
            >
              <option value="">All doc types</option>
              {docTypes.map((dt) => {
                const count = data.filter((r) => r.doc_type === dt).length;
                return <option key={dt} value={dt}>{dt} ({count})</option>;
              })}
            </select>
          )}
          {(search || docTypeFilter) && (
            <button onClick={() => { setSearch(''); setDocTypeFilter(''); resetPage(); }} className="text-xs text-red-500 hover:underline">Clear all</button>
          )}
          <TableExport
            headers={['Invoice Ref', 'Clearing Doc', 'Doc Date', 'Amount', 'Doc Type', 'SGL Flag']}
            rows={processed.map((r) => [
              r.invoice_ref ?? '', r.clearing_doc ?? '', r.doc_date ?? '',
              String(r.amount ?? 0), r.doc_type ?? '', r.sgl_flag ?? '',
            ])}
            filename="unmatched-books.csv"
          />
        </div>
      </div>
      <div className="w-full overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="border-b border-gray-200 bg-gray-50 sticky top-0 z-10">
            <tr>
              <th className="px-2 py-2.5 w-8" />
              <SortTh k="invoice_ref">Invoice Ref</SortTh>
              <SortTh k="clearing_doc">Clearing Doc</SortTh>
              <SortTh k="doc_date">Doc Date</SortTh>
              <SortTh k="amount" align="right">Amount</SortTh>
              <SortTh k="doc_type">Doc Type</SortTh>
              <th className="px-4 py-2.5 font-semibold text-[10px] text-gray-500 uppercase tracking-wider text-left whitespace-nowrap">SGL Flag</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: 7 }).map((_, j) => (
                    <td key={j} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td>
                  ))}
                </tr>
              ))
            ) : paged.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-gray-400 text-sm">
                  {(search || docTypeFilter) ? 'No entries match the current filters' : 'No unmatched book entries'}
                </td>
              </tr>
            ) : (
              paged.map((r, idx) => {
                const rowKey = `ub-${r.invoice_ref}-${r.amount}-${idx}`;
                const isExpanded = expandedRow === rowKey;
                return (
                  <Fragment key={rowKey}>
                    <tr
                      className={cn('hover:bg-gray-50 transition-colors cursor-pointer', idx % 2 === 1 && 'bg-gray-50/30')}
                      onClick={() => setExpandedRow(isExpanded ? null : rowKey)}
                    >
                      <td className="px-2 py-2.5 text-gray-400">
                        {isExpanded
                          ? <ChevronDown className="h-4 w-4 text-[#1B3A5C]" />
                          : <ChevronRight className="h-4 w-4" />}
                      </td>
                      <td className="px-4 py-2.5" title={r.invoice_ref}><span className="font-mono">{truncate(r.invoice_ref, 24)}</span></td>
                      <td className="px-4 py-2.5"><span className="font-mono text-gray-500">{r.clearing_doc || '—'}</span></td>
                      <td className="px-4 py-2.5">{formatDate(r.doc_date)}</td>
                      <td className="px-4 py-2.5 text-right"><span className="font-mono font-semibold">{formatCurrency(r.amount)}</span></td>
                      <td className="px-4 py-2.5"><span className="font-mono">{r.doc_type}</span></td>
                      <td className="px-4 py-2.5">
                        {r.sgl_flag
                          ? <Badge variant="yellow" size="sm">{r.sgl_flag}</Badge>
                          : <span className="text-gray-300">—</span>}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="bg-gray-50/70">
                        <td colSpan={7} className="px-0 py-0">
                          <div className="border-l-4 border-[#1B3A5C] mx-4 my-3 bg-white rounded-lg shadow-sm p-4">
                            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
                              <div>
                                <p className="text-xs text-gray-400 mb-0.5">Full Invoice Ref</p>
                                <p className="font-mono text-sm font-medium text-gray-900 break-all">{r.invoice_ref}</p>
                              </div>
                              <div>
                                <p className="text-xs text-gray-400 mb-0.5">Clearing Document</p>
                                <p className="font-mono text-sm text-gray-800">{r.clearing_doc || '--'}</p>
                              </div>
                              <div>
                                <p className="text-xs text-gray-400 mb-0.5">Amount</p>
                                <p className="font-mono text-sm font-semibold text-[#1B3A5C]">{formatCurrency(r.amount)}</p>
                              </div>
                              <div>
                                <p className="text-xs text-gray-400 mb-0.5">Document Type</p>
                                <p className="font-mono text-sm text-gray-800">{r.doc_type || '--'}</p>
                              </div>
                              <div>
                                <p className="text-xs text-gray-400 mb-0.5">Document Date</p>
                                <p className="text-sm text-gray-800">{formatDate(r.doc_date) || '--'}</p>
                              </div>
                              <div>
                                <p className="text-xs text-gray-400 mb-0.5">SGL Flag</p>
                                {r.sgl_flag
                                  ? <Badge variant="yellow" size="sm">{r.sgl_flag}</Badge>
                                  : <p className="text-sm text-gray-400">None</p>}
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {total > 25 && (
        <TablePagination
          page={page} pageSize={pageSize} total={total}
          onPageChange={setPage}
          onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
        />
      )}
    </Card>
  );
}

// ── Exceptions tab ────────────────────────────────────────────────────────────

function ExceptionsTab({ runId, canReview }: { runId: string; canReview: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data = [], isLoading } = useQuery({
    queryKey: ['runs', runId, 'exceptions'],
    queryFn: () => runsApi.exceptions(runId),
  });

  const [reviewing, setReviewing] = useState<string | null>(null);
  const [noteInput, setNoteInput] = useState('');
  const [actionInput, setActionInput] = useState('ACKNOWLEDGED');
  const [expandedDesc, setExpandedDesc] = useState<Set<string>>(new Set());
  const [sevFilter, setSevFilter] = useState<string>('');
  const [catFilter, setCatFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState('ACKNOWLEDGED');
  const [bulkProcessing, setBulkProcessing] = useState(false);
  const [excSearch, setExcSearch] = useState('');

  const reviewMut = useMutation({
    mutationFn: ({ id, action, notes }: { id: string; action: string; notes: string }) =>
      runsApi.reviewException(runId, id, action, notes),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['runs', runId, 'exceptions'] });
      setReviewing(null);
      toast('Exception reviewed', undefined, 'success');
    },
    onError: (err) => toast('Review failed', getErrorMessage(err), 'error'),
  });

  const toggleDesc = (id: string) => {
    const next = new Set(expandedDesc);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExpandedDesc(next);
  };

  const sevOptions = [...new Set(data.map((e) => e.severity))].sort();
  const catOptions = [...new Set(data.map((e) => e.category))].sort();

  let filtered = data;
  if (sevFilter) filtered = filtered.filter((e) => e.severity === sevFilter);
  if (catFilter) filtered = filtered.filter((e) => e.category === catFilter);
  if (statusFilter === 'pending') filtered = filtered.filter((e) => !e.reviewed);
  if (statusFilter === 'reviewed') filtered = filtered.filter((e) => e.reviewed);
  if (excSearch) {
    const q = excSearch.toLowerCase();
    filtered = filtered.filter((e) =>
      (e.description ?? '').toLowerCase().includes(q)
      || (e.category ?? '').toLowerCase().includes(q)
      || (e.severity ?? '').toLowerCase().includes(q)
      || String(e.amount ?? '').includes(q),
    );
  }

  const unreviewed = data.filter((e) => !e.reviewed).length;

  const handleBulkReview = async () => {
    if (selectedIds.size === 0) return;
    setBulkProcessing(true);
    let success = 0;
    for (const excId of selectedIds) {
      try {
        await runsApi.reviewException(runId, excId, bulkAction, 'Bulk reviewed');
        success++;
      } catch { /* continue */ }
    }
    qc.invalidateQueries({ queryKey: ['runs', runId, 'exceptions'] });
    setSelectedIds(new Set());
    setBulkProcessing(false);
    toast(`${success} exceptions reviewed`, undefined, 'success');
  };

  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedIds(next);
  };

  const selectAllPending = () => {
    setSelectedIds(new Set(filtered.filter((e) => !e.reviewed).map((e) => e.id)));
  };

  const cols: Column<Exception>[] = [
    ...(canReview ? [{
      key: 'select' as keyof Exception,
      header: '',
      render: (r: Exception) => !r.reviewed ? (
        <input
          type="checkbox"
          checked={selectedIds.has(r.id)}
          onChange={() => toggleSelect(r.id)}
          className="rounded border-gray-300 text-[#1B3A5C] focus:ring-[#1B3A5C] h-3.5 w-3.5"
        />
      ) : null,
    }] : []),
    {
      key: 'severity',
      header: 'Severity',
      sortable: true,
      render: (r) => (
        <Badge variant={severityVariant(r.severity)} size="sm">
          {r.severity}
        </Badge>
      ),
    },
    { key: 'category', header: 'Category', render: (r) => <span className="text-xs font-medium text-gray-700">{r.category}</span> },
    {
      key: 'description',
      header: 'Description',
      render: (r) => {
        const isLong = r.description.length > 60;
        const isExpanded = expandedDesc.has(r.id);
        return (
          <div>
            <span className="text-xs text-gray-600">
              {isLong && !isExpanded ? truncate(r.description, 60) : r.description}
            </span>
            {isLong && (
              <button
                onClick={(e) => { e.stopPropagation(); toggleDesc(r.id); }}
                className="ml-1 text-[10px] text-[#1B3A5C] font-medium hover:underline"
              >
                {isExpanded ? 'less' : 'more'}
              </button>
            )}
          </div>
        );
      },
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      render: (r) =>
        r.amount != null ? (
          <span className="font-mono text-xs">{formatCurrency(r.amount)}</span>
        ) : (
          <span className="text-gray-300 text-xs">—</span>
        ),
    },
    {
      key: 'reviewed',
      header: 'Status',
      render: (r) =>
        r.reviewed ? (
          <Badge variant="green" size="sm">{r.review_action ?? 'Reviewed'}</Badge>
        ) : (
          <Badge variant="yellow" size="sm">Pending</Badge>
        ),
    },
    {
      key: 'actions' as keyof Exception,
      header: '',
      render: (r) =>
        !r.reviewed && canReview ? (
          reviewing === r.id ? (
            <div className="flex items-center gap-2">
              <select
                className="text-xs border border-gray-300 rounded px-2 py-1 outline-none"
                value={actionInput}
                onChange={(e) => setActionInput(e.target.value)}
              >
                <option value="ACKNOWLEDGED">Acknowledge</option>
                <option value="WAIVED">Waive</option>
                <option value="ESCALATED">Escalate</option>
              </select>
              <input
                className="text-xs border border-gray-300 rounded px-2 py-1 w-24 outline-none"
                placeholder="Notes…"
                value={noteInput}
                onChange={(e) => setNoteInput(e.target.value)}
              />
              <button
                onClick={() =>
                  reviewMut.mutate({ id: r.id, action: actionInput, notes: noteInput })
                }
                disabled={reviewMut.isPending}
                className="text-xs bg-[#1B3A5C] text-white px-2 py-1 rounded hover:bg-[#15304d]"
              >
                {reviewMut.isPending ? '…' : 'Save'}
              </button>
              <button
                onClick={() => setReviewing(null)}
                className="text-xs text-gray-400 hover:text-gray-600"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => {
                setReviewing(r.id);
                setNoteInput('');
                setActionInput('ACKNOWLEDGED');
              }}
              className="text-xs text-[#1B3A5C] font-medium hover:underline"
            >
              Review
            </button>
          )
        ) : null,
    },
  ];

  return (
    <Card padding={false}>
      <div className="px-4 py-3 border-b border-gray-100 space-y-2">
        <div className="flex items-center justify-between gap-4">
          <p className="text-xs text-gray-500">
            {unreviewed} unreviewed of {data.length} exceptions
            {sevFilter || catFilter || statusFilter ? ` · showing ${filtered.length}` : ''}
          </p>
          {selectedIds.size > 0 && canReview && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">{selectedIds.size} selected</span>
              <select
                value={bulkAction}
                onChange={(e) => setBulkAction(e.target.value)}
                className="text-xs border border-gray-200 rounded px-2 py-1"
              >
                <option value="ACKNOWLEDGED">Acknowledge</option>
                <option value="WAIVED">Waive</option>
              </select>
              <button
                onClick={handleBulkReview}
                disabled={bulkProcessing}
                className="text-xs bg-[#1B3A5C] text-white px-3 py-1 rounded hover:bg-[#15304d] disabled:opacity-50"
              >
                {bulkProcessing ? 'Processing…' : 'Mark selected'}
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <TableSearch
            value={excSearch}
            onChange={setExcSearch}
            placeholder="Search description, category, amount..."
            className="w-56"
          />
          <select
            value={sevFilter}
            onChange={(e) => setSevFilter(e.target.value)}
            className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:border-[#1B3A5C]"
          >
            <option value="">All severities</option>
            {sevOptions.map((s) => <option key={s} value={s}>{s} ({data.filter((e) => e.severity === s).length})</option>)}
          </select>
          <select
            value={catFilter}
            onChange={(e) => setCatFilter(e.target.value)}
            className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:border-[#1B3A5C]"
          >
            <option value="">All categories</option>
            {catOptions.map((c) => <option key={c} value={c}>{c} ({data.filter((e) => e.category === c).length})</option>)}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:border-[#1B3A5C]"
          >
            <option value="">All statuses</option>
            <option value="pending">Pending ({unreviewed})</option>
            <option value="reviewed">Reviewed ({data.length - unreviewed})</option>
          </select>
          {canReview && unreviewed > 0 && (
            <button
              onClick={selectAllPending}
              className="text-xs text-[#1B3A5C] font-medium hover:underline"
            >
              Select all pending
            </button>
          )}
          {(sevFilter || catFilter || statusFilter || excSearch) && (
            <button
              onClick={() => { setSevFilter(''); setCatFilter(''); setStatusFilter(''); setExcSearch(''); }}
              className="text-xs text-red-500 hover:underline"
            >
              Clear all
            </button>
          )}
          <TableExport
            headers={['Severity', 'Category', 'Description', 'Amount', 'Status']}
            rows={filtered.map((e) => [
              e.severity, e.category, e.description,
              e.amount != null ? String(e.amount) : '', e.reviewed ? 'Reviewed' : 'Pending',
            ])}
            filename="exceptions.csv"
          />
        </div>
      </div>
      <Table
        columns={cols}
        data={filtered}
        keyExtractor={(r) => r.id}
        loading={isLoading}
        emptyMessage="No exceptions found"
      />
    </Card>
  );
}

// ── Audit Trail tab ───────────────────────────────────────────────────────────

function AuditTrailTab({ runId, runStatus }: { runId: string; runStatus?: string }) {
  const { data = [], isLoading } = useQuery({
    queryKey: ['runs', runId, 'audit'],
    queryFn: () => runsApi.auditTrail(runId),
  });

  if (isLoading) return <FullPageSpinner />;

  const isApproved = runStatus === 'APPROVED';
  const hasReviewEvent = data.some((e: any) => e.event_type === 'REVIEW_APPROVED');

  return (
    <Card>
      {isApproved && !hasReviewEvent && (
        <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
          <p className="text-xs text-amber-800">
            Review authorization event not recorded — this run may have been approved outside normal workflow (e.g., auto-approved by the batch pipeline).
          </p>
        </div>
      )}
      <div className="space-y-4">
        {data.length === 0 && (
          <p className="text-sm text-gray-400 text-center py-8">No audit events yet</p>
        )}
        {data.map((event) => {
          const HIGH_SIG = new Set([
            'RUN_CREATED', 'RERUN_CREATED', 'RUN_APPROVED', 'RUN_REJECTED',
            'REVIEW_APPROVED', 'REVIEW_REJECTED', 'SUGGESTED_AUTHORIZED',
            'SUGGESTED_REJECTED', 'RUN_FAILED',
          ]);
          const isHigh = HIGH_SIG.has(event.event_type);
          const isApproval = event.event_type.includes('APPROVED');
          const isRejection = event.event_type.includes('REJECTED') || event.event_type === 'RUN_FAILED';
          const dotColor = isApproval ? 'bg-emerald-500' : isRejection ? 'bg-red-500' : isHigh ? 'bg-[#1B3A5C]' : 'bg-gray-300';
          const eventBadgeVariant = isApproval ? 'green' as const : isRejection ? 'red' as const : 'gray' as const;

          return (
            <div key={event.id} className="flex gap-4">
              <div className="flex flex-col items-center">
                <div className={cn('w-2 h-2 rounded-full mt-1', dotColor)} />
                <div className="w-px flex-1 bg-gray-100 mt-1" />
              </div>
              <div className="flex-1 pb-4">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={cn(
                    'text-sm',
                    isHigh ? 'font-semibold text-gray-900' : 'font-normal text-gray-500',
                  )}>{event.event_type}</span>
                  <Badge variant={eventBadgeVariant} size="sm">{event.actor_role}</Badge>
                </div>
                <p className={cn('text-xs mt-0.5', isHigh ? 'text-gray-600' : 'text-gray-400')}>
                  {event.actor} · {formatDateTime(event.timestamp)}
                </p>
                {event.notes && (
                  <p className="text-xs text-gray-600 mt-1 italic">"{event.notes}"</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ── Comments tab (Phase 4B) ──────────────────────────────────────────────────

function CommentsTab({ runId }: { runId: string }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const { toast } = useToast();
  const [newComment, setNewComment] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');

  const { data: comments = [], isLoading } = useQuery({
    queryKey: ['runs', runId, 'comments'],
    queryFn: () => runsApi.comments(runId),
  });

  const addMut = useMutation({
    mutationFn: (data: { content: string; parentId?: string }) =>
      runsApi.addComment(runId, data.content, data.parentId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['runs', runId, 'comments'] });
      setNewComment('');
      setReplyTo(null);
    },
    onError: (err) => toast('Error', getErrorMessage(err), 'error'),
  });

  const updateMut = useMutation({
    mutationFn: (data: { id: string; content: string }) =>
      runsApi.updateComment(runId, data.id, data.content),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['runs', runId, 'comments'] });
      setEditingId(null);
      setEditContent('');
    },
    onError: (err) => toast('Error', getErrorMessage(err), 'error'),
  });

  const deleteMut = useMutation({
    mutationFn: (commentId: string) => runsApi.deleteComment(runId, commentId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['runs', runId, 'comments'] });
    },
    onError: (err) => toast('Error', getErrorMessage(err), 'error'),
  });

  if (isLoading) return <FullPageSpinner />;

  // Build threaded structure: top-level comments + replies
  const topLevel = comments.filter((c: RunComment) => !c.parent_id);
  const repliesMap = new Map<string, RunComment[]>();
  comments.forEach((c: RunComment) => {
    if (c.parent_id) {
      const arr = repliesMap.get(c.parent_id) || [];
      arr.push(c);
      repliesMap.set(c.parent_id, arr);
    }
  });

  const renderComment = (c: RunComment, isReply = false) => (
    <div key={c.id} className={cn('flex gap-3', isReply && 'ml-8 mt-2')}>
      <div className="w-8 h-8 rounded-full bg-[#1B3A5C]/10 flex items-center justify-center text-xs font-bold text-[#1B3A5C] shrink-0">
        {(c.user_name || '?')[0].toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-900">{c.user_name}</span>
          {c.user_role && <Badge variant="gray" size="sm">{c.user_role}</Badge>}
          <span className="text-xs text-gray-400">{c.created_at ? formatDateTime(c.created_at) : ''}</span>
          {c.updated_at && c.updated_at !== c.created_at && (
            <span className="text-xs text-gray-400 italic">(edited)</span>
          )}
        </div>
        {editingId === c.id ? (
          <div className="mt-1 flex gap-2">
            <input
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="flex-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#1B3A5C]/20 focus:border-[#1B3A5C] outline-none"
            />
            <button
              onClick={() => updateMut.mutate({ id: c.id, content: editContent })}
              disabled={!editContent.trim() || updateMut.isPending}
              className="px-3 py-1.5 text-xs font-semibold bg-[#1B3A5C] text-white rounded-lg hover:bg-[#15304d] disabled:opacity-50"
            >
              Save
            </button>
            <button
              onClick={() => { setEditingId(null); setEditContent(''); }}
              className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700"
            >
              Cancel
            </button>
          </div>
        ) : (
          <p className="text-sm text-gray-700 mt-0.5">{c.content}</p>
        )}
        <div className="flex items-center gap-3 mt-1">
          {!isReply && (
            <button
              onClick={() => setReplyTo(replyTo === c.id ? null : c.id)}
              className="text-xs text-gray-400 hover:text-[#1B3A5C] flex items-center gap-1"
            >
              <MessageCircle className="h-3 w-3" />
              Reply
            </button>
          )}
          {c.user_id === user?.id && (
            <>
              <button
                onClick={() => { setEditingId(c.id); setEditContent(c.content); }}
                className="text-xs text-gray-400 hover:text-[#1B3A5C] flex items-center gap-1"
              >
                <Edit3 className="h-3 w-3" />
                Edit
              </button>
              <button
                onClick={() => deleteMut.mutate(c.id)}
                className="text-xs text-gray-400 hover:text-red-500 flex items-center gap-1"
              >
                <Trash2 className="h-3 w-3" />
                Delete
              </button>
            </>
          )}
        </div>
        {/* Inline reply input */}
        {replyTo === c.id && (
          <div className="mt-2 flex gap-2">
            <input
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              placeholder="Write a reply..."
              className="flex-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#1B3A5C]/20 focus:border-[#1B3A5C] outline-none"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newComment.trim()) {
                  addMut.mutate({ content: newComment, parentId: c.id });
                }
              }}
            />
            <button
              onClick={() => addMut.mutate({ content: newComment, parentId: c.id })}
              disabled={!newComment.trim() || addMut.isPending}
              className="px-3 py-1.5 text-xs font-semibold bg-[#1B3A5C] text-white rounded-lg hover:bg-[#15304d] disabled:opacity-50"
            >
              <Send className="h-3 w-3" />
            </button>
          </div>
        )}
        {/* Replies */}
        {(repliesMap.get(c.id) || []).map((r: RunComment) => renderComment(r, true))}
      </div>
    </div>
  );

  return (
    <Card>
      {/* New top-level comment */}
      <div className="flex gap-3 mb-6 pb-4 border-b border-gray-100">
        <div className="w-8 h-8 rounded-full bg-[#1B3A5C]/10 flex items-center justify-center text-xs font-bold text-[#1B3A5C] shrink-0">
          {(user?.full_name || '?')[0].toUpperCase()}
        </div>
        <div className="flex-1 flex gap-2">
          <input
            value={replyTo ? '' : newComment}
            onChange={(e) => { setReplyTo(null); setNewComment(e.target.value); }}
            placeholder="Add a comment..."
            className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-[#1B3A5C]/20 focus:border-[#1B3A5C] outline-none"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newComment.trim() && !replyTo) {
                addMut.mutate({ content: newComment });
              }
            }}
          />
          <button
            onClick={() => addMut.mutate({ content: newComment })}
            disabled={!newComment.trim() || addMut.isPending || !!replyTo}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold bg-[#1B3A5C] text-white rounded-lg hover:bg-[#15304d] disabled:opacity-50 transition-colors"
          >
            <Send className="h-3.5 w-3.5" />
            Post
          </button>
        </div>
      </div>

      {/* Comment list */}
      {topLevel.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-8">No comments yet. Start the conversation.</p>
      ) : (
        <div className="space-y-4">
          {topLevel.map((c: RunComment) => renderComment(c))}
        </div>
      )}
    </Card>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState('matched');

  const { data: run, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['runs', id],
    queryFn: () => runsApi.get(id!),
    retry: (failureCount, err: any) => {
      // Don't retry on 404 or 422 (invalid UUID)
      const status = err?.response?.status;
      if (status === 404 || status === 422) return false;
      return failureCount < 2;
    },
    refetchInterval: (query) => {
      const d = query.state.data as RunSummary | undefined;
      return d?.status === 'PROCESSING' ? 5000 : false;
    },
  });

  // Fetch exceptions for badge counts (lightweight — only needs count + severity)
  const { data: exceptions = [] } = useQuery({
    queryKey: ['runs', id, 'exceptions'],
    queryFn: () => runsApi.exceptions(id!),
    enabled: !!run && run.status !== 'PROCESSING',
  });

  const exceptionsHighCount = exceptions.filter(
    (e: Exception) => e.severity === 'CRITICAL' || e.severity === 'HIGH',
  ).length;

  // Fetch audit trail for compliance checks
  const { data: auditEvents = [] } = useQuery({
    queryKey: ['runs', id, 'audit'],
    queryFn: () => runsApi.auditTrail(id!),
    enabled: !!run && run.status !== 'PROCESSING',
  });

  // Fetch admin settings for workflow flags
  const { data: adminSettings } = useQuery({
    queryKey: ['admin-settings'],
    queryFn: settingsApi.get,
  });
  const approvalWorkflowEnabled = adminSettings?.approval_workflow_enabled ?? true;
  const reviewerAssignmentEnabled = adminSettings?.reviewer_assignment_enabled ?? false;

  // Fetch users for reviewer assignment dropdown
  const { data: allUsers = [] } = useQuery({
    queryKey: ['users'],
    queryFn: authApi.users,
    enabled: reviewerAssignmentEnabled,
  });
  const reviewers = allUsers.filter((u: ApiUser) => u.role === 'REVIEWER' || u.role === 'ADMIN');

  const assignMut = useMutation({
    mutationFn: (reviewerId: string | null) => runsApi.assignReviewer(id!, reviewerId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['runs', id] });
      toast('Reviewer updated', undefined, 'success');
    },
    onError: (err) => toast('Assignment failed', getErrorMessage(err), 'error'),
  });

  const isAutoApprovedBelowThreshold =
    run?.status === 'APPROVED' &&
    run.match_rate_pct < 75 &&
    !auditEvents.some((e: any) => e.event_type === 'REVIEW_APPROVED');


  const reviewMut = useMutation({
    mutationFn: ({ action, notes }: { action: 'APPROVED' | 'REJECTED'; notes?: string }) =>
      runsApi.review(id!, action, notes),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['runs', id] });
      qc.invalidateQueries({ queryKey: ['runs'] });
      toast(
        vars.action === 'APPROVED' ? 'Run approved' : 'Run rejected',
        undefined,
        vars.action === 'APPROVED' ? 'success' : 'info',
      );
    },
    onError: (err) => toast('Review failed', getErrorMessage(err), 'error'),
  });

  const cancelMut = useMutation({
    mutationFn: () => runsApi.cancel(id!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['runs', id] });
      qc.invalidateQueries({ queryKey: ['runs'] });
      toast('Run cancelled', undefined, 'info');
    },
    onError: (err) => toast('Cancel failed', getErrorMessage(err), 'error'),
  });

  const deleteMut = useMutation({
    mutationFn: () => runsApi.delete(id!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['runs'] });
      toast('Run deleted', undefined, 'info');
      navigate('/runs');
    },
    onError: (err) => toast('Delete failed', getErrorMessage(err), 'error'),
  });

  const rerunMut = useMutation({
    mutationFn: () => runsApi.rerun(id!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['runs'] });
      qc.invalidateQueries({ queryKey: ['runs', id] });
      qc.invalidateQueries({ queryKey: ['runs', id, 'matched'] });
      qc.invalidateQueries({ queryKey: ['runs', id, 'unmatched-26as'] });
      qc.invalidateQueries({ queryKey: ['runs', id, 'unmatched-books'] });
      qc.invalidateQueries({ queryKey: ['runs', id, 'exceptions'] });
      toast('Re-run started', 'Reconciliation is re-processing with current settings', 'success');
    },
    onError: (err) => toast('Re-run failed', getErrorMessage(err), 'error'),
  });

  const [rejectNotes, setRejectNotes] = useState('');
  const [showReject, setShowReject] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRerun, setConfirmRerun] = useState(false);

  if (isLoading) return <FullPageSpinner message="Loading run…" />;

  if (isError || !run) {
    const status = (error as any)?.response?.status;
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <div className="w-16 h-16 rounded-full bg-red-50 flex items-center justify-center">
          <AlertTriangle className="h-8 w-8 text-red-400" />
        </div>
        <h2 className="text-lg font-bold text-gray-900">
          {status === 404 ? 'Run Not Found' : 'Failed to Load Run'}
        </h2>
        <p className="text-sm text-gray-500 text-center max-w-md">
          {status === 404
            ? 'This run does not exist or has been deleted. Check the URL and try again.'
            : `An error occurred while loading this run. ${getErrorMessage(error)}`}
        </p>
        <div className="flex gap-3">
          <button
            onClick={() => navigate('/runs')}
            className="flex items-center gap-2 px-4 py-2 bg-[#1B3A5C] text-white text-sm font-semibold rounded-lg hover:bg-[#15304d] transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Run History
          </button>
          {status !== 404 && (
            <button
              onClick={() => refetch()}
              className="flex items-center gap-2 px-4 py-2 border border-gray-200 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
            >
              <RefreshCw className="h-4 w-4" />
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  const canReview =
    approvalWorkflowEnabled &&
    (user?.role === 'REVIEWER' || user?.role === 'ADMIN') &&
    run.status === 'PENDING_REVIEW' &&
    run.created_by !== user?.id;

  return (
    <PageWrapper>
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/runs')}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold text-gray-900">
                Run #{run.run_number}
              </h1>
              <Badge variant={runStatusVariant(run.status)}>
                {runStatusLabel(run.status)}
              </Badge>
              {!approvalWorkflowEnabled && run.status === 'APPROVED' && (
                <Badge variant="blue" size="sm">
                  Workflow disabled — auto-approved
                </Badge>
              )}
              {isAutoApprovedBelowThreshold && (
                <Badge variant="orange" size="sm">
                  Auto-approved below 75% threshold
                </Badge>
              )}
              {run.constraint_violations > 0 && (
                <Badge variant="red" size="sm">
                  {run.constraint_violations} violations
                </Badge>
              )}
            </div>
            <p className="text-sm text-gray-500 mt-0.5">
              {run.deductor_name} · {run.tan} · {formatFY(run.financial_year)}
              {reviewerAssignmentEnabled && run.status === 'PENDING_REVIEW' && (
                <span className="ml-3 inline-flex items-center gap-1.5">
                  <span className="text-xs text-gray-400">Reviewer:</span>
                  <select
                    value={run.assigned_reviewer_id || ''}
                    onChange={(e) => assignMut.mutate(e.target.value || null)}
                    className="text-xs border border-gray-200 rounded px-2 py-0.5 focus:ring-1 focus:ring-[#1B3A5C]/20 outline-none"
                    disabled={assignMut.isPending}
                  >
                    <option value="">Unassigned</option>
                    {reviewers.map((u: ApiUser) => (
                      <option key={u.id} value={u.id}>{u.full_name}</option>
                    ))}
                  </select>
                </span>
              )}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Refresh data (NOT a reconciliation rerun) */}
          <button
            onClick={() => refetch()}
            title="Refresh data"
            className="p-2 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50"
          >
            <RefreshCw className="h-4 w-4" />
          </button>

          {/* Stop — visible during PROCESSING */}
          {run.status === 'PROCESSING' && (
            <button
              onClick={() => cancelMut.mutate()}
              disabled={cancelMut.isPending}
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-red-200 text-red-600 text-sm font-semibold hover:bg-red-50 transition-colors disabled:opacity-50"
            >
              <StopCircle className="h-4 w-4" />
              {cancelMut.isPending ? 'Stopping…' : 'Stop'}
            </button>
          )}

          {/* Delete — visible when not PROCESSING */}
          {run.status !== 'PROCESSING' && (
            <button
              onClick={() => setConfirmDelete(true)}
              className="p-2 rounded-lg border border-gray-200 text-gray-400 hover:text-red-600 hover:border-red-200 hover:bg-red-50 transition-colors"
              title="Delete run"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}

          {/* Re-run */}
          {run.status !== 'PROCESSING' && (
            <button
              onClick={() => setConfirmRerun(true)}
              disabled={rerunMut.isPending}
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-blue-200 text-blue-700 text-sm font-medium hover:bg-blue-50 transition-colors disabled:opacity-50"
              title="Re-run this reconciliation with the same files"
            >
              <RotateCw className="h-4 w-4" />
              {rerunMut.isPending ? 'Starting…' : 'Re-run'}
            </button>
          )}

          {/* Download */}
          {run.status !== 'PROCESSING' && run.status !== 'FAILED' && (
            <button
              onClick={async () => {
                try {
                  await runsApi.download(run.id);
                  toast('Excel downloaded', undefined, 'success');
                } catch (err) {
                  toast('Download failed', getErrorMessage(err), 'error');
                }
              }}
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200 text-gray-700 text-sm font-medium hover:bg-gray-50 transition-colors"
            >
              <Download className="h-4 w-4" />
              Download
            </button>
          )}

          {/* Compliance Report (Phase 4F) */}
          {adminSettings?.compliance_report_enabled && run.status !== 'PROCESSING' && run.status !== 'FAILED' && (
            <button
              onClick={async () => {
                try {
                  await runsApi.downloadComplianceReport(run.id);
                  toast('Compliance report downloaded', undefined, 'success');
                } catch (err) {
                  toast('Download failed', getErrorMessage(err), 'error');
                }
              }}
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-emerald-200 text-emerald-700 text-sm font-medium hover:bg-emerald-50 transition-colors"
            >
              <FileText className="h-4 w-4" />
              Compliance
            </button>
          )}

          {/* Reviewer actions */}
          {canReview && (
            <>
              <button
                onClick={() => reviewMut.mutate({ action: 'APPROVED' })}
                disabled={reviewMut.isPending}
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 transition-colors disabled:opacity-50"
              >
                <CheckCircle className="h-4 w-4" />
                Approve
              </button>
              <button
                onClick={() => setShowReject(!showReject)}
                className="flex items-center gap-2 px-3 py-2 rounded-lg border border-red-200 text-red-600 text-sm font-semibold hover:bg-red-50 transition-colors"
              >
                <XCircle className="h-4 w-4" />
                Reject
              </button>
            </>
          )}
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => deleteMut.mutate()}
        title={`Delete Run #${run.run_number}?`}
        description="All matched pairs, exceptions, audit trail entries, and uploaded files for this run will be permanently deleted. This action cannot be undone."
        confirmLabel="Delete permanently"
        variant="danger"
        loading={deleteMut.isPending}
        icon={<Trash2 className="h-5 w-5 text-red-600" />}
      />

      {/* Re-run confirmation dialog */}
      <ConfirmDialog
        open={confirmRerun}
        onClose={() => setConfirmRerun(false)}
        onConfirm={() => { setConfirmRerun(false); rerunMut.mutate(); }}
        title={`Re-run #${run.run_number}?`}
        description={`The reconciliation for ${run.deductor_name || 'this party'} will be re-processed using the same files but current settings. Existing results will be replaced.`}
        confirmLabel="Re-run reconciliation"
        variant="info"
        loading={rerunMut.isPending}
        icon={<RotateCw className="h-5 w-5 text-[#1B3A5C]" />}
      />

      {/* Live progress panel — shown while PROCESSING */}
      {run.status === 'PROCESSING' && (
        <RunProgressPanel runId={id!} onComplete={() => refetch()} />
      )}

      {/* Reject panel */}
      {showReject && canReview && (
        <Card className="border-red-200 bg-red-50">
          <p className="text-sm font-semibold text-red-800 mb-2">Rejection notes</p>
          <textarea
            className="w-full border border-red-300 rounded-lg px-3 py-2 text-sm outline-none focus:border-red-500 bg-white resize-none"
            rows={3}
            placeholder="Reason for rejection (required)…"
            value={rejectNotes}
            onChange={(e) => setRejectNotes(e.target.value)}
          />
          <div className="flex gap-2 mt-2">
            <button
              disabled={!rejectNotes.trim() || reviewMut.isPending}
              onClick={() =>
                reviewMut.mutate({ action: 'REJECTED', notes: rejectNotes })
              }
              className="px-4 py-2 bg-red-600 text-white text-sm font-semibold rounded-lg hover:bg-red-700 disabled:opacity-50"
            >
              {reviewMut.isPending ? 'Submitting…' : 'Confirm Rejection'}
            </button>
            <button
              onClick={() => setShowReject(false)}
              className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900"
            >
              Cancel
            </button>
          </div>
        </Card>
      )}

      {/* Metrics grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <StatCard
          label="Match Rate"
          value={formatPct(run.match_rate_pct)}
          accentColor={matchRateColor(run.match_rate_pct)}
        />
        <StatCard
          label="Matched"
          value={`${run.matched_count} / ${run.total_26as_entries}`}
          sub="26AS entries"
          accentColor="text-[#1B3A5C]"
        />
        <StatCard
          label="Suggested"
          value={run.suggested_count ?? 0}
          sub={(run.suggested_count ?? 0) > 0 ? 'Needs review' : 'All resolved'}
          accentColor={run.suggested_count > 0 ? 'text-amber-600' : 'text-emerald-600'}
        />
        <StatCard
          label="Unmatched 26AS"
          value={run.unmatched_26as_count}
          accentColor={run.unmatched_26as_count > 0 ? 'text-red-600' : 'text-emerald-600'}
        />
        <StatCard
          label="Violations"
          value={run.constraint_violations}
          accentColor={run.constraint_violations > 0 ? 'text-red-600' : 'text-emerald-600'}
        />
        <StatCard
          label="Control Total"
          value={run.control_total_balanced == null ? 'N/A' : run.control_total_balanced ? 'Balanced' : 'Unbalanced'}
          accentColor={run.control_total_balanced == null ? 'text-gray-400' : run.control_total_balanced ? 'text-emerald-600' : 'text-red-600'}
        />
      </div>

      {/* Financial totals */}
      {run.status !== 'PROCESSING' && run.status !== 'FAILED' && (run.total_26as_amount ?? 0) > 0 && (
        <Card>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Financial Summary</p>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            <div>
              <p className="text-xs text-gray-400 mb-0.5">Total as per 26AS</p>
              <p className="text-base font-bold text-[#1B3A5C]">{formatCurrency(run.total_26as_amount)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-0.5">Total as per Books</p>
              {run.total_sap_amount && run.total_sap_amount > 0 ? (
                <>
                  <p className="text-base font-bold text-gray-800">{formatCurrency(run.total_sap_amount)}</p>
                  <p className="text-[10px] text-gray-400">{run.total_sap_entries || 0} SAP entries</p>
                </>
              ) : (
                <>
                  <p className="text-base font-bold text-gray-400">—</p>
                  <p className="text-[10px] text-gray-400">{run.total_sap_entries || 0} SAP entries (total not aggregated)</p>
                </>
              )}
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-0.5">Matched Total</p>
              <p className="text-base font-bold text-emerald-600">{formatCurrency(run.matched_amount)}</p>
              <p className="text-[10px] text-gray-400">{run.matched_count} pairs</p>
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-0.5">Unmatched Total</p>
              <p className={cn('text-base font-bold', run.unmatched_26as_amount > 0 ? 'text-red-600' : 'text-emerald-600')}>
                {formatCurrency(run.unmatched_26as_amount)}
              </p>
              <p className="text-[10px] text-gray-400">{run.unmatched_26as_count} entries</p>
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-0.5">Suggested Matches Total</p>
              <p className={cn('text-base font-bold', (run.suggested_count ?? 0) > 0 ? 'text-amber-600' : 'text-emerald-600')}>
                {formatCurrency(Math.max(0, run.total_26as_amount - run.matched_amount - run.unmatched_26as_amount))}
              </p>
              <p className="text-[10px] text-gray-400">{run.suggested_count ?? 0} entries</p>
            </div>
          </div>
        </Card>
      )}

      {/* Count integrity warning */}
      {run.status !== 'PROCESSING' && run.total_26as_entries > 0 &&
        run.matched_count + (run.suggested_count ?? 0) + run.unmatched_26as_count !== run.total_26as_entries && (
        <Card className="border-red-200 bg-red-50">
          <div className="flex items-center gap-2 text-red-700 text-sm">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" />
            <span>
              Count mismatch: Matched ({run.matched_count}) + Suggested ({run.suggested_count ?? 0}) + Unmatched ({run.unmatched_26as_count}) = {run.matched_count + (run.suggested_count ?? 0) + run.unmatched_26as_count}, but total 26AS entries = {run.total_26as_entries}. Re-run this reconciliation to fix.
            </span>
          </div>
        </Card>
      )}

      {/* Confidence breakdown */}
      <Card>
        <div className="flex items-center gap-6 flex-wrap">
          {(() => {
            const confTotal = (run.high_confidence_count || 0) + (run.medium_confidence_count || 0) + (run.low_confidence_count || 0);
            return (
              <>
          <div>
            <p className="text-xs text-gray-400 mb-1">High Confidence</p>
            <div className="flex items-center gap-1.5">
              <div className="w-24 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                <div
                  className="h-full bg-emerald-500 rounded-full"
                  style={{
                    width: `${confTotal > 0 ? (run.high_confidence_count / confTotal) * 100 : 0}%`,
                  }}
                />
              </div>
              <span className="text-xs font-semibold text-emerald-600">
                {run.high_confidence_count}
              </span>
            </div>
          </div>
          <div>
            <p className="text-xs text-gray-400 mb-1">Medium Confidence</p>
            <div className="flex items-center gap-1.5">
              <div className="w-24 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                <div
                  className="h-full bg-amber-400 rounded-full"
                  style={{
                    width: `${confTotal > 0 ? (run.medium_confidence_count / confTotal) * 100 : 0}%`,
                  }}
                />
              </div>
              <span className="text-xs font-semibold text-amber-600">
                {run.medium_confidence_count}
              </span>
            </div>
          </div>
          <div>
            <p className="text-xs text-gray-400 mb-1">Low Confidence</p>
            <div className="flex items-center gap-1.5">
              <div className="w-24 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                <div
                  className="h-full bg-orange-400 rounded-full"
                  style={{
                    width: `${confTotal > 0 ? (run.low_confidence_count / confTotal) * 100 : 0}%`,
                  }}
                />
              </div>
              <span className="text-xs font-semibold text-orange-600">
                {run.low_confidence_count}
              </span>
            </div>
          </div>
              </>
            );
          })()}
          {run.has_pan_issues && (
            <Badge variant="red">PAN issues detected</Badge>
          )}
          {run.has_rate_mismatches && (
            <Badge variant="orange">Rate mismatches</Badge>
          )}
        </div>
      </Card>

      {/* Metadata card */}
      <MetadataCard run={run} />

      {/* Tabs */}
      <TabsPrimitive.Root value={tab} onValueChange={setTab}>
        <TabsPrimitive.List className="flex gap-1 border-b border-gray-200 mb-4 overflow-x-auto scrollbar-thin">
          {[
            { value: 'matched', label: 'Matched Pairs', icon: <CheckCircle className="h-3.5 w-3.5" />, count: run.matched_count },
            { value: 'unmatched-26as', label: 'Unmatched 26AS', icon: <AlertTriangle className="h-3.5 w-3.5" />, count: run.unmatched_26as_count },
            { value: 'unmatched-books', label: 'Unmatched Books', icon: <BookOpen className="h-3.5 w-3.5" /> },
            { value: 'suggested', label: 'Suggested Matches', icon: <Lightbulb className="h-3.5 w-3.5" />,
              count: run.suggested_count, badgeColor: run.suggested_count > 0 ? 'bg-amber-100 text-amber-700' : undefined },
            { value: 'sections', label: 'Section Summary', icon: <PieChart className="h-3.5 w-3.5" /> },
            { value: 'tracker', label: 'Resolution Tracker', icon: <ListChecks className="h-3.5 w-3.5" /> },
            { value: 'methodology', label: 'Methodology', icon: <FileText className="h-3.5 w-3.5" /> },
            { value: 'exceptions', label: 'Exceptions', icon: <ClipboardList className="h-3.5 w-3.5" />,
              count: exceptions.length, badgeColor: exceptionsHighCount > 0 ? 'bg-red-100 text-red-700' : undefined },
            { value: 'audit', label: 'Audit Trail', icon: <Activity className="h-3.5 w-3.5" /> },
            ...(adminSettings?.comment_threads_enabled !== false ? [{ value: 'comments', label: 'Comments', icon: <MessageCircle className="h-3.5 w-3.5" /> }] : []),
          ].map((t) => (
            <TabsPrimitive.Trigger
              key={t.value}
              value={t.value}
              className={cn(
                'flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium border-b-2 -mb-px transition-colors',
                tab === t.value
                  ? 'border-[#1B3A5C] text-[#1B3A5C]'
                  : 'border-transparent text-gray-500 hover:text-gray-700',
              )}
            >
              {t.icon}
              {t.label}
              {t.count != null && t.count > 0 && (
                <span
                  className={cn(
                    'ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold',
                    tab === t.value
                      ? 'bg-[#1B3A5C] text-white'
                      : t.badgeColor || 'bg-gray-100 text-gray-600',
                  )}
                >
                  {t.count}
                </span>
              )}
            </TabsPrimitive.Trigger>
          ))}
        </TabsPrimitive.List>

        <TabsPrimitive.Content value="matched">
          <MatchedTab runId={id!} />
        </TabsPrimitive.Content>
        <TabsPrimitive.Content value="unmatched-26as">
          <Unmatched26ASTab runId={id!} />
        </TabsPrimitive.Content>
        <TabsPrimitive.Content value="unmatched-books">
          <UnmatchedBooksTab runId={id!} />
        </TabsPrimitive.Content>
        <TabsPrimitive.Content value="suggested">
          <ErrorBoundary
            fallback={(_err, reset) => (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <AlertTriangle className="h-10 w-10 text-amber-500 mb-3" />
                <h3 className="text-base font-semibold text-gray-900 mb-1">Unable to load suggested matches</h3>
                <p className="text-sm text-gray-500 mb-4">An error occurred while rendering this tab. Please try again.</p>
                <button
                  onClick={reset}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-[#1B3A5C] text-white hover:bg-[#15304d] transition-colors"
                >
                  <RefreshCw className="h-4 w-4" />
                  Retry
                </button>
              </div>
            )}
          >
            <SuggestedMatchesTab runId={id!} />
          </ErrorBoundary>
        </TabsPrimitive.Content>
        <TabsPrimitive.Content value="sections">
          <SectionSummaryTab runId={id!} />
        </TabsPrimitive.Content>
        <TabsPrimitive.Content value="tracker">
          <MismatchTrackerTab runId={id!} />
        </TabsPrimitive.Content>
        <TabsPrimitive.Content value="methodology">
          <MatchingMethodologyPanel runId={id!} />
        </TabsPrimitive.Content>
        <TabsPrimitive.Content value="exceptions">
          <ExceptionsTab runId={id!} canReview={canReview} />
        </TabsPrimitive.Content>
        <TabsPrimitive.Content value="audit">
          <AuditTrailTab runId={id!} runStatus={run.status} />
        </TabsPrimitive.Content>
        {adminSettings?.comment_threads_enabled !== false && (
          <TabsPrimitive.Content value="comments">
            <CommentsTab runId={id!} />
          </TabsPrimitive.Content>
        )}
      </TabsPrimitive.Root>
    </PageWrapper>
  );
}
