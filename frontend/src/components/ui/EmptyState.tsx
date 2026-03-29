/**
 * EmptyState — illustrated empty/zero-data placeholders with optional CTA.
 */
import type { ReactNode } from 'react';
import { FileText, PlusCircle, Search, Inbox } from 'lucide-react';
import { cn } from '../../lib/utils';

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
    icon?: ReactNode;
  };
  className?: string;
  compact?: boolean;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  compact = false,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'py-8 px-4' : 'py-16 px-6',
        className,
      )}
    >
      <div
        className={cn(
          'rounded-2xl bg-gray-100 flex items-center justify-center mb-4',
          compact ? 'w-10 h-10' : 'w-14 h-14',
        )}
      >
        <div className={cn('text-gray-400', compact ? '[&>svg]:h-5 [&>svg]:w-5' : '[&>svg]:h-7 [&>svg]:w-7')}>
          {icon ?? <Inbox />}
        </div>
      </div>
      <h3
        className={cn(
          'font-semibold text-gray-900',
          compact ? 'text-sm' : 'text-base',
        )}
      >
        {title}
      </h3>
      {description && (
        <p
          className={cn(
            'text-gray-500 mt-1 max-w-sm',
            compact ? 'text-xs' : 'text-sm',
          )}
        >
          {description}
        </p>
      )}
      {action && (
        <button
          onClick={action.onClick}
          className={cn(
            'mt-4 inline-flex items-center gap-2 font-medium rounded-lg transition-colors',
            'bg-[#1B3A5C] text-white hover:bg-[#15304d]',
            compact ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm',
          )}
        >
          {action.icon ?? <PlusCircle className="h-4 w-4" />}
          {action.label}
        </button>
      )}
    </div>
  );
}

/* ── Pre-composed empty states ─────────────────────────────────────────────── */

export function NoRunsEmpty({ onNewRun }: { onNewRun: () => void }) {
  return (
    <EmptyState
      icon={<FileText />}
      title="No reconciliation runs yet"
      description="Upload your SAP AR Ledger and Form 26AS files to start your first TDS reconciliation."
      action={{ label: 'Start New Run', onClick: onNewRun }}
    />
  );
}

export function NoSearchResultsEmpty({ query }: { query: string }) {
  return (
    <EmptyState
      icon={<Search />}
      title="No results found"
      description={`No runs matching "${query}". Try adjusting your search or filters.`}
      compact
    />
  );
}

export function NoMatchesEmpty() {
  return (
    <EmptyState
      icon={<FileText />}
      title="No matched entries"
      description="This run has no matched entries. Check the unmatched tab for details."
      compact
    />
  );
}

export function NoExceptionsEmpty() {
  return (
    <EmptyState
      icon={<FileText />}
      title="No exceptions"
      description="Great news! No exceptions were found for this run."
      compact
    />
  );
}

export default EmptyState;
