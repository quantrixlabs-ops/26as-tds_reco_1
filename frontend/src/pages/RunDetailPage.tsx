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
} from 'lucide-react';
import {
  runsApi,
  type Exception,
  type RunSummary,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/ui/Toast';
import { Card, StatCard } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Table, type Column } from '../components/ui/Table';
import { FullPageSpinner } from '../components/ui/Spinner';
import { RunProgressPanel } from '../components/RunProgressPanel';
import {
  cn,
  formatDate,
  formatDateTime,
  formatCurrency,
  formatPct,
  runStatusVariant,
  runStatusLabel,
  confidenceVariant,
  severityVariant,
  formatFY,
  getErrorMessage,
  truncate,
} from '../lib/utils';
import SectionSummaryTab from '../components/SectionSummaryTab';
import MismatchTrackerTab from '../components/MismatchTrackerTab';
import MatchingMethodologyPanel from '../components/MatchingMethodologyPanel';
import SuggestedMatchesTab from '../components/SuggestedMatchesTab';

// ── Metadata card ─────────────────────────────────────────────────────────────

function MetadataCard({ run }: { run: RunSummary }) {
  return (
    <Card>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-4 text-sm">
        <div>
          <p className="text-xs text-gray-400 mb-0.5">Run Number</p>
          <p className="font-mono text-gray-900 font-semibold">#{run.run_number}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400 mb-0.5">Financial Year</p>
          <p className="font-medium text-gray-900">{formatFY(run.financial_year)}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400 mb-0.5">Deductor</p>
          <p className="font-medium text-gray-900 truncate" title={run.deductor_name}>{run.deductor_name}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400 mb-0.5">TAN</p>
          <p className="font-mono text-gray-900">{run.tan}</p>
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
          <p className="font-mono text-xs text-gray-500 break-all">{run.sap_file_hash}</p>
        </div>
        <div className="col-span-2">
          <p className="text-xs text-gray-400 mb-0.5">26AS File Hash (SHA-256)</p>
          <p className="font-mono text-xs text-gray-500 break-all">{run.as26_file_hash}</p>
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

  // Dropdown filter state
  const [selectedMonths, setSelectedMonths] = useState<Set<string>>(new Set());
  const [selectedSections, setSelectedSections] = useState<Set<string>>(new Set());
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [selectedConfidence, setSelectedConfidence] = useState<Set<string>>(new Set());

  // Variance range slider state
  const [varMin, setVarMin] = useState(0);
  const [varMax, setVarMax] = useState(100);
  const dataVarMax = data.length > 0 ? Math.ceil(Math.max(...data.map((r) => r.variance_pct), 1)) : 100;
  const varRangeActive = varMin > 0 || varMax < dataVarMax;

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
    (varRangeActive ? 1 : 0) +
    (globalSearch ? 1 : 0);

  const clearAllFilters = () => {
    setSelectedMonths(new Set());
    setSelectedSections(new Set());
    setSelectedTypes(new Set());
    setSelectedConfidence(new Set());
    setVarMin(0);
    setVarMax(dataVarMax);
    setGlobalSearch('');
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
    if (varRangeActive && (r.variance_pct < varMin || r.variance_pct > varMax)) return false;
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

  const columns: { key: SortKey; label: string; align: 'left' | 'right' }[] = [
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

  return (
    <Card padding={false}>
      {/* Toolbar: search bar + dropdown filters */}
      <div className="px-4 py-3 border-b border-gray-100 space-y-2.5">
        <div className="flex items-center gap-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
            <input
              type="text"
              placeholder="Search all columns..."
              value={globalSearch}
              onChange={(e) => setGlobalSearch(e.target.value)}
              className="w-full pl-8 pr-8 py-1.5 text-xs border border-gray-200 rounded-lg outline-none focus:border-[#1B3A5C] bg-white"
            />
            {globalSearch && (
              <button
                type="button"
                onClick={() => setGlobalSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <p className="text-xs text-gray-400 shrink-0">
            {activeFilterCount > 0
              ? <>{sorted.length} of {data.length} pairs</>
              : <>{data.length} matched pairs</>}
            {' · '}
            <span title="Section 199 compliance: books total never exceeds 26AS credit">Sec 199 compliant</span>
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
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <DropdownFilter label="Month" options={monthOptions} selected={selectedMonths} onChange={setSelectedMonths} />
          <DropdownFilter label="Section" options={sectionOptions} selected={selectedSections} onChange={setSelectedSections} />
          <DropdownFilter label="Type" options={typeOptions} selected={selectedTypes} onChange={setSelectedTypes} />
          <DropdownFilter label="Confidence" options={confidenceOptions} selected={selectedConfidence} onChange={setSelectedConfidence} />
          {/* Variance range slider */}
          <div className={cn(
            'flex items-center gap-2 px-2.5 py-1 rounded-lg border text-xs',
            varRangeActive
              ? 'bg-[#1B3A5C] text-white border-[#1B3A5C]'
              : 'bg-white text-gray-600 border-gray-200',
          )}>
            <span className="font-medium whitespace-nowrap">Var %</span>
            <input
              type="range"
              min={0}
              max={dataVarMax}
              step={0.5}
              value={varMin}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                setVarMin(Math.min(v, varMax));
              }}
              className="w-16 h-1 accent-[#1B3A5C] cursor-pointer"
            />
            <span className="font-mono text-[10px] w-16 text-center tabular-nums">
              {varMin.toFixed(1)}–{varMax.toFixed(1)}%
            </span>
            <input
              type="range"
              min={0}
              max={dataVarMax}
              step={0.5}
              value={varMax}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                setVarMax(Math.max(v, varMin));
              }}
              className="w-16 h-1 accent-[#1B3A5C] cursor-pointer"
            />
            {varRangeActive && (
              <button
                type="button"
                onClick={() => { setVarMin(0); setVarMax(dataVarMax); }}
                className="text-white/70 hover:text-white"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
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
                  {Array.from({ length: 10 }).map((_, j) => (
                    <td key={j} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td>
                  ))}
                </tr>
              ))
            ) : isError ? (
              <tr>
                <td colSpan={10} className="px-4 py-12 text-center text-sm">
                  <div className="flex flex-col items-center gap-2">
                    <AlertTriangle className="h-5 w-5 text-red-400" />
                    <span className="text-red-600 font-medium">Failed to load matched pairs</span>
                    <span className="text-gray-400 text-xs">{getErrorMessage(error)}</span>
                  </div>
                </td>
              </tr>
            ) : sorted.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-4 py-12 text-center text-gray-400 text-sm">
                  {activeFilterCount > 0
                    ? 'No matched pairs match your filters'
                    : 'No matched pairs for this run'}
                </td>
              </tr>
            ) : (
              sorted.map((r, idx) => (
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
                    <td className="px-4 py-3"><span className="font-mono text-xs text-gray-500">#{r.as26_index ?? idx + 1}</span></td>
                    <td className="px-4 py-3"><span className="text-xs">{formatDate(r.as26_date)}</span></td>
                    <td className="px-4 py-3"><span className="font-mono text-xs">{r.section}</span></td>
                    <td className="px-4 py-3 text-right"><span className="font-mono text-xs">{formatCurrency(r.as26_amount)}</span></td>
                    <td className="px-4 py-3 text-right"><span className="font-mono text-xs">{formatCurrency(r.books_sum)}</span></td>
                    <td className="px-4 py-3 text-right">
                      <span className={cn('font-mono text-xs', r.variance_pct > 3 ? 'text-red-600' : r.variance_pct > 1 ? 'text-amber-600' : 'text-gray-700')}>
                        {formatPct(r.variance_pct)}
                      </span>
                    </td>
                    <td className="px-4 py-3"><span className="font-mono text-xs text-gray-600">{r.match_type}</span></td>
                    <td className="px-4 py-3">
                      <Badge variant={confidenceVariant(r.confidence)} size="sm">{r.confidence}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs text-gray-500" title={r.invoice_refs.join(', ')}>{r.invoice_count} inv</span>
                    </td>
                  </tr>
                  {expandedRow === idx && (
                    <tr key={`matched-detail-${r.id || idx}`} className="bg-gray-50/70">
                      <td colSpan={10} className="px-0 py-0">
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
                                    { label: 'Variance', value: r.score_breakdown.variance },
                                    { label: 'Date Proximity', value: r.score_breakdown.date_proximity },
                                    { label: 'Section Match', value: r.score_breakdown.section },
                                    { label: 'Clearing Doc', value: r.score_breakdown.clearing_doc },
                                    { label: 'Historical', value: r.score_breakdown.historical },
                                  ].map((s) => (
                                    <div key={s.label} className="flex items-center gap-2">
                                      <span className="text-xs text-gray-500 w-24">{s.label}</span>
                                      <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                                        <div
                                          className="h-full bg-[#1B3A5C] rounded-full"
                                          style={{ width: `${Math.min(100, (s.value ?? 0) * 100)}%` }}
                                        />
                                      </div>
                                      <span className="text-xs font-mono text-gray-600 w-10 text-right">
                                        {s.value != null ? (s.value * 100).toFixed(0) + '%' : '--'}
                                      </span>
                                    </div>
                                  ))}
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
                                  <span className="font-mono font-medium text-gray-800">{r.match_type}</span>
                                </div>
                                <div className="flex items-center justify-between text-xs">
                                  <span className="text-gray-500">Confidence</span>
                                  <Badge variant={confidenceVariant(r.confidence)} size="sm">{r.confidence}</Badge>
                                </div>
                                <div className="flex items-center justify-between text-xs">
                                  <span className="text-gray-500">Variance Amount</span>
                                  <span className="font-mono text-gray-700">{formatCurrency(r.variance_amt)}</span>
                                </div>
                                {r.cross_fy != null && (
                                  <div className="flex items-center justify-between text-xs">
                                    <span className="text-gray-500">Cross-FY</span>
                                    {r.cross_fy
                                      ? <Badge variant="orange" size="sm">Yes</Badge>
                                      : <span className="text-gray-400">No</span>}
                                  </div>
                                )}
                                {r.is_prior_year != null && (
                                  <div className="flex items-center justify-between text-xs">
                                    <span className="text-gray-500">Prior Year</span>
                                    {r.is_prior_year
                                      ? <Badge variant="yellow" size="sm">Yes</Badge>
                                      : <span className="text-gray-400">No</span>}
                                  </div>
                                )}
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
    </Card>
  );
}

// ── Unmatched 26AS tab ────────────────────────────────────────────────────────

function Unmatched26ASTab({ runId }: { runId: string }) {
  const { data = [], isLoading } = useQuery({
    queryKey: ['runs', runId, 'unmatched-26as'],
    queryFn: () => runsApi.unmatched26as(runId),
  });
  const [expandedRow, setExpandedRow] = useState<number | null>(null);

  const toggleRow = (idx: number) => {
    setExpandedRow(expandedRow === idx ? null : idx);
  };

  return (
    <Card padding={false}>
      <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
        <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
        <p className="text-xs text-gray-500">{data.length} unmatched 26AS entries</p>
      </div>
      <div className="w-full overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50">
            <tr>
              <th className="px-2 py-3 w-8" />
              <th className="px-4 py-3 font-semibold text-xs text-gray-500 uppercase tracking-wider text-left whitespace-nowrap">#</th>
              <th className="px-4 py-3 font-semibold text-xs text-gray-500 uppercase tracking-wider text-left whitespace-nowrap">Deductor</th>
              <th className="px-4 py-3 font-semibold text-xs text-gray-500 uppercase tracking-wider text-left whitespace-nowrap">TAN</th>
              <th className="px-4 py-3 font-semibold text-xs text-gray-500 uppercase tracking-wider text-left whitespace-nowrap">Section</th>
              <th className="px-4 py-3 font-semibold text-xs text-gray-500 uppercase tracking-wider text-left whitespace-nowrap">Date</th>
              <th className="px-4 py-3 font-semibold text-xs text-gray-500 uppercase tracking-wider text-right whitespace-nowrap">Amount</th>
              <th className="px-4 py-3 font-semibold text-xs text-gray-500 uppercase tracking-wider text-left whitespace-nowrap">Reason</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: 8 }).map((_, j) => (
                    <td key={j} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td>
                  ))}
                </tr>
              ))
            ) : data.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-gray-400 text-sm">All 26AS entries matched</td>
              </tr>
            ) : (
              data.map((r, idx) => (
                <Fragment key={`u26-${idx}`}>
                  <tr
                    className="hover:bg-gray-50 transition-colors cursor-pointer"
                    onClick={() => toggleRow(idx)}
                  >
                    <td className="px-2 py-3 text-gray-400">
                      {expandedRow === idx
                        ? <ChevronDown className="h-4 w-4 text-[#1B3A5C]" />
                        : <ChevronRight className="h-4 w-4" />}
                    </td>
                    <td className="px-4 py-3"><span className="font-mono text-xs text-gray-400">#{r.index}</span></td>
                    <td className="px-4 py-3"><span className="text-sm">{truncate(r.deductor_name, 30)}</span></td>
                    <td className="px-4 py-3"><span className="font-mono text-xs">{r.tan}</span></td>
                    <td className="px-4 py-3"><span className="font-mono text-xs">{r.section}</span></td>
                    <td className="px-4 py-3"><span className="text-xs">{formatDate(r.date ?? r.transaction_date)}</span></td>
                    <td className="px-4 py-3 text-right"><span className="font-mono text-xs">{formatCurrency(r.amount)}</span></td>
                    <td className="px-4 py-3">
                      <div>
                        <span className="font-mono text-xs text-red-600">{r.reason_code}</span>
                        <p className="text-xs text-gray-400">{r.reason_label}</p>
                      </div>
                    </td>
                  </tr>
                  {expandedRow === idx && (
                    <tr key={`u26-detail-${idx}`} className="bg-gray-50/70">
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
              ))
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ── Unmatched Books tab ───────────────────────────────────────────────────────

function UnmatchedBooksTab({ runId }: { runId: string }) {
  const { data = [], isLoading } = useQuery({
    queryKey: ['runs', runId, 'unmatched-books'],
    queryFn: () => runsApi.unmatchedBooks(runId),
  });
  const [expandedRow, setExpandedRow] = useState<number | null>(null);

  const toggleRow = (idx: number) => {
    setExpandedRow(expandedRow === idx ? null : idx);
  };

  return (
    <Card padding={false}>
      <div className="px-4 py-3 border-b border-gray-100">
        <p className="text-xs text-gray-500">{data.length} unmatched SAP book entries</p>
      </div>
      <div className="w-full overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50">
            <tr>
              <th className="px-2 py-3 w-8" />
              <th className="px-4 py-3 font-semibold text-xs text-gray-500 uppercase tracking-wider text-left whitespace-nowrap">Invoice Ref</th>
              <th className="px-4 py-3 font-semibold text-xs text-gray-500 uppercase tracking-wider text-left whitespace-nowrap">Clearing Doc</th>
              <th className="px-4 py-3 font-semibold text-xs text-gray-500 uppercase tracking-wider text-left whitespace-nowrap">Doc Date</th>
              <th className="px-4 py-3 font-semibold text-xs text-gray-500 uppercase tracking-wider text-right whitespace-nowrap">Amount</th>
              <th className="px-4 py-3 font-semibold text-xs text-gray-500 uppercase tracking-wider text-left whitespace-nowrap">Doc Type</th>
              <th className="px-4 py-3 font-semibold text-xs text-gray-500 uppercase tracking-wider text-left whitespace-nowrap">SGL Flag</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: 7 }).map((_, j) => (
                    <td key={j} className="px-4 py-3"><div className="h-4 bg-gray-100 rounded animate-pulse" /></td>
                  ))}
                </tr>
              ))
            ) : data.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-gray-400 text-sm">No unmatched book entries</td>
              </tr>
            ) : (
              data.map((r, idx) => (
                <Fragment key={`ub-${idx}`}>
                  <tr
                    className="hover:bg-gray-50 transition-colors cursor-pointer"
                    onClick={() => toggleRow(idx)}
                  >
                    <td className="px-2 py-3 text-gray-400">
                      {expandedRow === idx
                        ? <ChevronDown className="h-4 w-4 text-[#1B3A5C]" />
                        : <ChevronRight className="h-4 w-4" />}
                    </td>
                    <td className="px-4 py-3"><span className="font-mono text-xs">{truncate(r.invoice_ref, 24)}</span></td>
                    <td className="px-4 py-3"><span className="font-mono text-xs text-gray-500">{r.clearing_doc}</span></td>
                    <td className="px-4 py-3"><span className="text-xs">{formatDate(r.doc_date)}</span></td>
                    <td className="px-4 py-3 text-right"><span className="font-mono text-xs">{formatCurrency(r.amount)}</span></td>
                    <td className="px-4 py-3"><span className="font-mono text-xs">{r.doc_type}</span></td>
                    <td className="px-4 py-3">
                      {r.sgl_flag
                        ? <Badge variant="yellow" size="sm">{r.sgl_flag}</Badge>
                        : <span className="text-xs text-gray-300">—</span>}
                    </td>
                  </tr>
                  {expandedRow === idx && (
                    <tr key={`ub-detail-${idx}`} className="bg-gray-50/70">
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
              ))
            )}
          </tbody>
        </table>
      </div>
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

  const cols: Column<Exception>[] = [
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
      render: (r) => <span className="text-xs text-gray-600">{truncate(r.description, 60)}</span>,
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
      key: 'actions',
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
      <div className="px-4 py-3 border-b border-gray-100">
        <p className="text-xs text-gray-500">
          {data.filter((e) => !e.reviewed).length} unreviewed exceptions
        </p>
      </div>
      <Table
        columns={cols}
        data={data}
        keyExtractor={(r) => r.id}
        loading={isLoading}
        emptyMessage="No exceptions found"
      />
    </Card>
  );
}

// ── Audit Trail tab ───────────────────────────────────────────────────────────

function AuditTrailTab({ runId }: { runId: string }) {
  const { data = [], isLoading } = useQuery({
    queryKey: ['runs', runId, 'audit'],
    queryFn: () => runsApi.auditTrail(runId),
  });

  if (isLoading) return <FullPageSpinner />;

  return (
    <Card>
      <div className="space-y-4">
        {data.length === 0 && (
          <p className="text-sm text-gray-400 text-center py-8">No audit events yet</p>
        )}
        {data.map((event) => (
          <div key={event.id} className="flex gap-4">
            <div className="flex flex-col items-center">
              <div className="w-2 h-2 rounded-full bg-[#1B3A5C] mt-1" />
              <div className="w-px flex-1 bg-gray-100 mt-1" />
            </div>
            <div className="flex-1 pb-4">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-gray-900">{event.event_type}</span>
                <Badge variant="gray" size="sm">{event.actor_role}</Badge>
              </div>
              <p className="text-xs text-gray-500 mt-0.5">
                {event.actor} · {formatDateTime(event.timestamp)}
              </p>
              {event.notes && (
                <p className="text-xs text-gray-600 mt-1 italic">"{event.notes}"</p>
              )}
            </div>
          </div>
        ))}
      </div>
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
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['runs'] });
      toast('Re-run started', `New run #${data.run_number} created`, 'success');
      navigate(`/runs/${data.run_id}`);
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
    (user?.role === 'REVIEWER' || user?.role === 'ADMIN') &&
    run.status === 'PENDING_REVIEW' &&
    run.created_by !== user?.id;

  return (
    <div className="space-y-6">
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
              {run.constraint_violations > 0 && (
                <Badge variant="red" size="sm">
                  {run.constraint_violations} violations
                </Badge>
              )}
            </div>
            <p className="text-sm text-gray-500 mt-0.5">
              {run.deductor_name} · {run.tan} · {formatFY(run.financial_year)}
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

      {/* Delete confirmation modal */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl max-w-sm w-full mx-4 p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
                <Trash2 className="h-5 w-5 text-red-600" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-gray-900">Delete Run #{run.run_number}?</h3>
                <p className="text-xs text-gray-500 mt-0.5">This action cannot be undone</p>
              </div>
            </div>
            <p className="text-sm text-gray-600 mb-5">
              All matched pairs, exceptions, audit trail entries, and uploaded files for this run will be permanently deleted.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setConfirmDelete(false)}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteMut.mutate()}
                disabled={deleteMut.isPending}
                className="px-4 py-2 text-sm font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50"
              >
                {deleteMut.isPending ? 'Deleting…' : 'Delete permanently'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Re-run confirmation modal */}
      {confirmRerun && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl max-w-sm w-full mx-4 p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
                <RotateCw className="h-5 w-5 text-blue-600" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-gray-900">Re-run #{run.run_number}?</h3>
                <p className="text-xs text-gray-500 mt-0.5">{run.deductor_name}</p>
              </div>
            </div>
            <p className="text-sm text-gray-600 mb-5">
              A new reconciliation will be created using the same files and settings. The original run will not be modified.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setConfirmRerun(false)}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => { setConfirmRerun(false); rerunMut.mutate(); }}
                disabled={rerunMut.isPending}
                className="px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
              >
                {rerunMut.isPending ? 'Starting…' : 'Re-run reconciliation'}
              </button>
            </div>
          </div>
        </div>
      )}

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
          accentColor={
            run.match_rate_pct >= 95
              ? 'text-emerald-600'
              : run.match_rate_pct >= 80
              ? 'text-amber-600'
              : 'text-red-600'
          }
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
              <p className="text-base font-bold text-gray-800">{formatCurrency(run.matched_amount + (run.total_26as_amount - run.matched_amount - run.unmatched_26as_amount > 0 ? run.total_26as_amount - run.matched_amount - run.unmatched_26as_amount : 0))}</p>
              <p className="text-[10px] text-gray-400">{run.total_sap_entries || 0} SAP entries</p>
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
            { value: 'suggested', label: 'Suggested Matches', icon: <Lightbulb className="h-3.5 w-3.5" /> },
            { value: 'sections', label: 'Section Summary', icon: <PieChart className="h-3.5 w-3.5" /> },
            { value: 'tracker', label: 'Resolution Tracker', icon: <ListChecks className="h-3.5 w-3.5" /> },
            { value: 'methodology', label: 'Methodology', icon: <FileText className="h-3.5 w-3.5" /> },
            { value: 'exceptions', label: 'Exceptions', icon: <ClipboardList className="h-3.5 w-3.5" /> },
            { value: 'audit', label: 'Audit Trail', icon: <Activity className="h-3.5 w-3.5" /> },
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
                      : 'bg-gray-100 text-gray-600',
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
          <SuggestedMatchesTab runId={id!} />
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
          <AuditTrailTab runId={id!} />
        </TabsPrimitive.Content>
      </TabsPrimitive.Root>
    </div>
  );
}
