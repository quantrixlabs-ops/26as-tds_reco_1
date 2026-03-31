/**
 * ColumnToggle — Dropdown to show/hide table columns.
 * Accepts column definitions and returns a set of visible column keys.
 */
import { useState, useRef, useEffect } from 'react';
import { Columns3, Check } from 'lucide-react';
import { cn } from '../../lib/utils';

interface ColumnDef {
  key: string;
  label: string;
  /** If true, column cannot be hidden */
  locked?: boolean;
}

interface ColumnToggleProps {
  columns: ColumnDef[];
  visible: Set<string>;
  onChange: (visible: Set<string>) => void;
  className?: string;
}

export function ColumnToggle({ columns, visible, onChange, className }: ColumnToggleProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const toggle = (key: string) => {
    const next = new Set(visible);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  };

  const showAll = () => onChange(new Set(columns.map((c) => c.key)));

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        onClick={() => setOpen(!open)}
        title="Toggle columns"
        className={cn(
          'p-1.5 rounded transition-colors',
          open
            ? 'text-[#1B3A5C] bg-[#1B3A5C]/10'
            : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100',
        )}
      >
        <Columns3 className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-48 bg-white border border-gray-200 rounded-lg shadow-lg z-50 py-1">
          <div className="px-3 py-1.5 border-b border-gray-100 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase text-gray-400 tracking-wider">Columns</span>
            <button
              onClick={showAll}
              className="text-[10px] text-[#1B3A5C] hover:underline font-medium"
            >
              Show all
            </button>
          </div>
          {columns.map((col) => {
            const isVisible = visible.has(col.key);
            return (
              <button
                key={col.key}
                onClick={() => !col.locked && toggle(col.key)}
                disabled={col.locked}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors',
                  col.locked
                    ? 'text-gray-300 cursor-not-allowed'
                    : 'text-gray-700 hover:bg-gray-50',
                )}
              >
                <span className={cn(
                  'w-4 h-4 rounded border flex items-center justify-center shrink-0',
                  isVisible ? 'bg-[#1B3A5C] border-[#1B3A5C]' : 'border-gray-300',
                )}>
                  {isVisible && <Check className="h-3 w-3 text-white" />}
                </span>
                {col.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
