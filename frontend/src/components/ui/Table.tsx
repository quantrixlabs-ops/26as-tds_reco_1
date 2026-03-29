/**
 * Reusable data table with optional sorting
 */
import { useState, type ReactNode } from 'react';
import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface Column<T> {
  key: string;
  header: string;
  render?: (row: T, idx: number) => ReactNode;
  sortable?: boolean;
  className?: string;
  headerClassName?: string;
  align?: 'left' | 'right' | 'center';
}

interface TableProps<T> {
  columns: Column<T>[];
  data: T[];
  keyExtractor: (row: T, idx: number) => string | number;
  onRowClick?: (row: T) => void;
  emptyMessage?: string;
  loading?: boolean;
  className?: string;
  rowClassName?: (row: T) => string;
  stickyHeader?: boolean;
}

type SortDir = 'asc' | 'desc' | null;

function SortIcon({ dir }: { dir: SortDir }) {
  if (dir === 'asc') return <ChevronUp className="h-3.5 w-3.5" />;
  if (dir === 'desc') return <ChevronDown className="h-3.5 w-3.5" />;
  return <ChevronsUpDown className="h-3.5 w-3.5 opacity-40" />;
}

export function Table<T extends object>({
  columns,
  data,
  keyExtractor,
  onRowClick,
  emptyMessage = 'No data available',
  loading = false,
  className,
  rowClassName,
  stickyHeader = false,
}: TableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);

  const handleSort = (key: string) => {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDir('asc');
    } else if (sortDir === 'asc') {
      setSortDir('desc');
    } else {
      setSortKey(null);
      setSortDir(null);
    }
  };

  const sortedData = (() => {
    if (!sortKey || !sortDir) return data;
    const col = columns.find((c) => c.key === sortKey);
    if (!col) return data;
    return [...data].sort((a, b) => {
      const av = (a as Record<string, unknown>)[sortKey];
      const bv = (b as Record<string, unknown>)[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') {
        return sortDir === 'asc' ? av - bv : bv - av;
      }
      const as = String(av).toLowerCase();
      const bs = String(bv).toLowerCase();
      if (sortDir === 'asc') return as < bs ? -1 : as > bs ? 1 : 0;
      return bs < as ? -1 : bs > as ? 1 : 0;
    });
  })();

  const alignClass = (align?: 'left' | 'right' | 'center') => {
    if (align === 'right') return 'text-right';
    if (align === 'center') return 'text-center';
    return 'text-left';
  };

  return (
    <div className={cn('w-full overflow-x-auto', className)}>
      <table className="w-full text-sm" role="table">
        <thead
          className={cn(
            'border-b border-gray-200 bg-gray-50',
            stickyHeader && 'sticky top-0 z-10',
          )}
        >
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                className={cn(
                  'px-4 py-3 font-semibold text-xs text-gray-500 uppercase tracking-wider whitespace-nowrap',
                  alignClass(col.align),
                  col.sortable && 'cursor-pointer select-none hover:text-gray-700',
                  col.headerClassName,
                )}
                onClick={col.sortable ? () => handleSort(col.key) : undefined}
                aria-sort={
                  col.sortable && sortKey === col.key
                    ? sortDir === 'asc' ? 'ascending' : 'descending'
                    : undefined
                }
                scope="col"
              >
                <span className="inline-flex items-center gap-1">
                  {col.header}
                  {col.sortable && (
                    <SortIcon dir={sortKey === col.key ? sortDir : null} />
                  )}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {loading ? (
            Array.from({ length: 5 }).map((_, i) => (
              <tr key={i}>
                {columns.map((col) => (
                  <td key={col.key} className="px-4 py-3">
                    <div className="h-4 bg-gray-100 rounded animate-pulse" />
                  </td>
                ))}
              </tr>
            ))
          ) : sortedData.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                className="px-4 py-12 text-center text-gray-500 text-sm"
              >
                {emptyMessage}
              </td>
            </tr>
          ) : (
            sortedData.map((row, idx) => (
              <tr
                key={keyExtractor(row, idx)}
                className={cn(
                  'hover:bg-gray-50 transition-colors',
                  onRowClick && 'cursor-pointer',
                  rowClassName?.(row),
                )}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={cn(
                      'px-4 py-3 text-gray-700 whitespace-nowrap',
                      alignClass(col.align),
                      col.className,
                    )}
                  >
                    {col.render
                      ? col.render(row, idx)
                      : String((row as Record<string, unknown>)[col.key] ?? '—')}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export default Table;
