/**
 * Card — clean bordered card with variant support.
 * Variants: default, outlined, elevated, interactive.
 */
import { cn } from '../../lib/utils';
import type { ReactNode } from 'react';

type CardVariant = 'default' | 'outlined' | 'elevated' | 'interactive';

interface CardProps {
  className?: string;
  children: ReactNode;
  padding?: boolean;
  variant?: CardVariant;
  onClick?: () => void;
}

const variantClasses: Record<CardVariant, string> = {
  default: 'bg-white border border-gray-200 rounded-xl shadow-sm',
  outlined: 'bg-white border-2 border-gray-200 rounded-xl',
  elevated: 'bg-white border border-gray-100 rounded-xl shadow-md',
  interactive:
    'bg-white border border-gray-200 rounded-xl shadow-sm card-interactive cursor-pointer',
};

export function Card({
  className,
  children,
  padding = true,
  variant = 'default',
  onClick,
}: CardProps) {
  return (
    <div
      className={cn(variantClasses[variant], padding && 'p-6', className)}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      {children}
    </div>
  );
}

interface CardHeaderProps {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  className?: string;
}

export function CardHeader({ title, subtitle, action, className }: CardHeaderProps) {
  return (
    <div className={cn('flex items-start justify-between mb-4', className)}>
      <div>
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}

interface StatCardProps {
  label: string;
  value: string | number;
  sub?: string;
  icon?: ReactNode;
  accentColor?: string;
  className?: string;
}

export function StatCard({
  label,
  value,
  sub,
  icon,
  accentColor = 'text-[#1B3A5C]',
  className,
}: StatCardProps) {
  return (
    <Card className={cn('', className)}>
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">
            {label}
          </p>
          <p className={cn('text-2xl font-bold mt-1', accentColor)}>{value}</p>
          {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
        </div>
        {icon && (
          <div className="ml-3 p-2 rounded-lg bg-gray-50 text-gray-400" aria-hidden="true">
            {icon}
          </div>
        )}
      </div>
    </Card>
  );
}

export default Card;
