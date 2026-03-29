/**
 * Badge — status / confidence / severity badges built with clsx + tailwind
 */
import { cn, type BadgeVariant } from '../../lib/utils';

const variantClasses: Record<BadgeVariant, string> = {
  default: 'bg-gray-100 text-gray-700 border-gray-200',
  green: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  yellow: 'bg-amber-50 text-amber-700 border-amber-200',
  orange: 'bg-orange-50 text-orange-700 border-orange-200',
  red: 'bg-red-50 text-red-700 border-red-200',
  deepred: 'bg-red-100 text-red-900 border-red-300',
  blue: 'bg-blue-50 text-blue-700 border-blue-200',
  gray: 'bg-gray-50 text-gray-600 border-gray-200',
  navy: 'bg-[#1B3A5C]/10 text-[#1B3A5C] border-[#1B3A5C]/20',
};

interface BadgeProps {
  variant?: BadgeVariant;
  children: React.ReactNode;
  className?: string;
  size?: 'sm' | 'md';
  'aria-label'?: string;
}

export function Badge({
  variant = 'default',
  children,
  className,
  size = 'sm',
  ...rest
}: BadgeProps) {
  return (
    <span
      role="status"
      className={cn(
        'inline-flex items-center font-medium rounded-full border',
        size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-sm',
        variantClasses[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}

export default Badge;
