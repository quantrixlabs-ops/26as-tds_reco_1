/**
 * TablePagination — Compact pagination bar for tables.
 * Shows page info, prev/next, and optional rows-per-page selector.
 */
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { cn } from '../../lib/utils';

interface TablePaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  pageSizeOptions?: number[];
  className?: string;
}

export function TablePagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [25, 50, 100],
  className,
}: TablePaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

  return (
    <div className={cn('flex items-center justify-between px-4 py-2 border-t border-gray-100 bg-gray-50/50', className)}>
      {/* Left: info */}
      <div className="flex items-center gap-3">
        <span className="text-[11px] text-gray-500">
          {total === 0
            ? 'No entries'
            : <>Showing <span className="font-medium text-gray-700">{start}-{end}</span> of <span className="font-medium text-gray-700">{total}</span></>}
        </span>
        {onPageSizeChange && (
          <select
            value={pageSize}
            onChange={(e) => {
              onPageSizeChange(Number(e.target.value));
              onPageChange(1);
            }}
            className="text-[11px] border border-gray-200 rounded px-1.5 py-0.5 outline-none focus:border-[#1B3A5C] bg-white"
          >
            {pageSizeOptions.map((s) => (
              <option key={s} value={s}>{s} / page</option>
            ))}
          </select>
        )}
      </div>

      {/* Right: page controls */}
      <div className="flex items-center gap-1">
        <NavButton
          onClick={() => onPageChange(1)}
          disabled={page <= 1}
          title="First page"
        >
          <ChevronsLeft className="h-3.5 w-3.5" />
        </NavButton>
        <NavButton
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          title="Previous page"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </NavButton>
        <span className="text-[11px] text-gray-500 px-2">
          Page <span className="font-medium text-gray-700">{page}</span> of {totalPages}
        </span>
        <NavButton
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
          title="Next page"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </NavButton>
        <NavButton
          onClick={() => onPageChange(totalPages)}
          disabled={page >= totalPages}
          title="Last page"
        >
          <ChevronsRight className="h-3.5 w-3.5" />
        </NavButton>
      </div>
    </div>
  );
}

function NavButton({
  onClick,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'p-1 rounded transition-colors',
        disabled
          ? 'text-gray-300 cursor-not-allowed'
          : 'text-gray-500 hover:bg-gray-200 hover:text-gray-700',
      )}
    >
      {children}
    </button>
  );
}
