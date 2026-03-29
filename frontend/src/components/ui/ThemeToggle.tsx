/**
 * ThemeToggle — cycles between light / dark / system with a compact button.
 */
import { Sun, Moon, Monitor } from 'lucide-react';
import { useTheme } from '../../lib/theme';
import { cn } from '../../lib/utils';

export function ThemeToggle({ className }: { className?: string }) {
  const { mode, setMode } = useTheme();

  const next = () => {
    if (mode === 'light') setMode('dark');
    else if (mode === 'dark') setMode('system');
    else setMode('light');
  };

  const Icon = mode === 'dark' ? Moon : mode === 'system' ? Monitor : Sun;
  const label = mode === 'dark' ? 'Dark mode' : mode === 'system' ? 'System theme' : 'Light mode';

  return (
    <button
      onClick={next}
      className={cn(
        'p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/10 transition-colors',
        className,
      )}
      aria-label={`Current theme: ${label}. Click to change.`}
      title={label}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

export default ThemeToggle;
