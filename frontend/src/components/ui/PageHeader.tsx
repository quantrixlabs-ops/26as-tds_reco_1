/**
 * PageHeader — standardized page title + subtitle + optional action.
 * Ensures consistent typography hierarchy across all pages.
 */
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  className?: string;
}

export function PageHeader({ title, subtitle, action, className }: PageHeaderProps) {
  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <h1 className="text-xl font-bold text-gray-900 tracking-tight">{title}</h1>
        {subtitle && (
          <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/**
 * PageWrapper — wraps page content with fade-in animation.
 */
export function PageWrapper({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('page-enter space-y-6', className)}>
      {children}
    </div>
  );
}

export default PageHeader;
