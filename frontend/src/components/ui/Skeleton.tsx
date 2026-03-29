/**
 * Skeleton — shimmer placeholders for loading states.
 * Provides individual primitives + pre-composed patterns for tables, stat cards, etc.
 */
import { cn } from '../../lib/utils';

/* ── Base skeleton bar ────────────────────────────────────────────────────── */

interface SkeletonProps {
  className?: string;
  style?: React.CSSProperties;
}

export function Skeleton({ className, style }: SkeletonProps) {
  return (
    <div
      className={cn(
        'animate-pulse rounded-md bg-gray-200/70',
        className,
      )}
      style={style}
    />
  );
}

/* ── Stat card skeleton ───────────────────────────────────────────────────── */

export function StatCardSkeleton() {
  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6">
      <div className="flex items-start justify-between">
        <div className="flex-1 space-y-3">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-7 w-16" />
          <Skeleton className="h-3 w-20" />
        </div>
        <Skeleton className="h-9 w-9 rounded-lg" />
      </div>
    </div>
  );
}

/* ── Table row skeleton ───────────────────────────────────────────────────── */

interface TableSkeletonProps {
  columns?: number;
  rows?: number;
}

export function TableSkeleton({ columns = 5, rows = 6 }: TableSkeletonProps) {
  return (
    <div className="w-full">
      {/* Header */}
      <div className="border-b border-gray-200 bg-gray-50 px-4 py-3 flex gap-4">
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={i} className="h-3 flex-1 max-w-[120px]" />
        ))}
      </div>
      {/* Rows */}
      {Array.from({ length: rows }).map((_, ri) => (
        <div
          key={ri}
          className="border-b border-gray-100 px-4 py-3.5 flex gap-4 items-center"
        >
          {Array.from({ length: columns }).map((_, ci) => (
            <Skeleton
              key={ci}
              className={cn(
                'h-4 flex-1',
                ci === 0 ? 'max-w-[60px]' : ci === 1 ? 'max-w-[180px]' : 'max-w-[100px]',
              )}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/* ── Chart skeleton ───────────────────────────────────────────────────────── */

export function ChartSkeleton({ height = 150 }: { height?: number }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-24" />
      </div>
      <div className="flex items-end gap-1" style={{ height }}>
        {[40, 65, 45, 80, 55, 90, 70, 60].map((h, i) => (
          <Skeleton
            key={i}
            className="flex-1 rounded-t-sm"
            style={{ height: `${h}%` }}
          />
        ))}
      </div>
    </div>
  );
}

/* ── Page-level skeleton (full dashboard) ─────────────────────────────────── */

export function DashboardSkeleton() {
  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="space-y-2">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-10 w-28 rounded-lg" />
      </div>
      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <StatCardSkeleton key={i} />
        ))}
      </div>
      {/* Content */}
      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white border border-gray-200 rounded-xl shadow-sm">
          <TableSkeleton columns={5} rows={5} />
        </div>
        <div className="space-y-4">
          <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6">
            <ChartSkeleton />
          </div>
        </div>
      </div>
    </div>
  );
}

export default Skeleton;
