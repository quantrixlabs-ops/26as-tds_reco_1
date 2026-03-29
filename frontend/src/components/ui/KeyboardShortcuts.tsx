/**
 * KeyboardShortcuts — overlay showing available keyboard shortcuts.
 * Toggle with the "?" key. Also handles global navigation shortcuts.
 */
import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Keyboard } from 'lucide-react';

interface Shortcut {
  keys: string[];
  label: string;
}

const SHORTCUTS: Shortcut[] = [
  { keys: ['?'], label: 'Show keyboard shortcuts' },
  { keys: ['g', 'h'], label: 'Go to Dashboard' },
  { keys: ['g', 'r'], label: 'Go to Run History' },
  { keys: ['g', 'n'], label: 'Go to New Run' },
  { keys: ['g', 'a'], label: 'Go to Admin' },
  { keys: ['Esc'], label: 'Close dialog / overlay' },
];

export function KeyboardShortcutsProvider() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Ignore if user is typing in an input/textarea
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setOpen((prev) => !prev);
        return;
      }

      if (e.key === 'Escape') {
        setOpen(false);
        return;
      }
    },
    [],
  );

  // Two-key sequence for "g + x" shortcuts
  useEffect(() => {
    let gPressed = false;
    let timeout: ReturnType<typeof setTimeout>;

    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.key === 'g' && !e.ctrlKey && !e.metaKey) {
        gPressed = true;
        timeout = setTimeout(() => { gPressed = false; }, 1000);
        return;
      }

      if (gPressed) {
        gPressed = false;
        clearTimeout(timeout);
        switch (e.key) {
          case 'h': navigate('/'); break;
          case 'r': navigate('/runs'); break;
          case 'n': navigate('/runs/new'); break;
          case 'a': navigate('/admin'); break;
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
      clearTimeout(timeout);
    };
  }, [navigate]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={() => setOpen(false)}
      />
      <div className="relative bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-[420px] max-w-[90vw] overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <Keyboard className="h-5 w-5 text-gray-500" />
            <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">
              Keyboard Shortcuts
            </h2>
          </div>
          <button
            onClick={() => setOpen(false)}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            aria-label="Close shortcuts overlay"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-6 py-4 space-y-3">
          {SHORTCUTS.map((s) => (
            <div key={s.label} className="flex items-center justify-between">
              <span className="text-sm text-gray-600 dark:text-gray-300">{s.label}</span>
              <div className="flex items-center gap-1">
                {s.keys.map((k, i) => (
                  <span key={i}>
                    <kbd className="inline-flex items-center justify-center min-w-[24px] h-6 px-1.5 text-xs font-mono font-semibold text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded">
                      {k}
                    </kbd>
                    {i < s.keys.length - 1 && (
                      <span className="text-gray-400 text-xs mx-0.5">then</span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="px-6 py-3 bg-gray-50 dark:bg-gray-700/50 text-xs text-gray-500 dark:text-gray-400 text-center">
          Press <kbd className="px-1 py-0.5 text-[10px] bg-gray-100 dark:bg-gray-600 border border-gray-300 dark:border-gray-500 rounded font-mono">?</kbd> to toggle this overlay
        </div>
      </div>
    </div>
  );
}

export default KeyboardShortcutsProvider;
