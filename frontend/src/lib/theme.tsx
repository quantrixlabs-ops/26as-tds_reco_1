/**
 * Theme context — system / light / dark mode toggle.
 * Stores preference in localStorage, defaults to system preference.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

type ThemeMode = 'system' | 'light' | 'dark';

interface ThemeContextValue {
  mode: ThemeMode;
  /** Resolved actual theme (never 'system') */
  resolved: 'light' | 'dark';
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
}

const STORAGE_KEY = 'tds_theme_mode';

function getSystemPreference(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') return getSystemPreference();
  return mode;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
    return 'light';
  });

  const [resolved, setResolved] = useState<'light' | 'dark'>(() => resolveTheme(mode));

  const setMode = useCallback((newMode: ThemeMode) => {
    setModeState(newMode);
    localStorage.setItem(STORAGE_KEY, newMode);
  }, []);

  const toggle = useCallback(() => {
    setMode(resolved === 'light' ? 'dark' : 'light');
  }, [resolved, setMode]);

  // Update resolved when mode or system preference changes
  useEffect(() => {
    setResolved(resolveTheme(mode));

    if (mode === 'system') {
      const mql = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => setResolved(getSystemPreference());
      mql.addEventListener('change', handler);
      return () => mql.removeEventListener('change', handler);
    }
  }, [mode]);

  // Apply `dark` class on <html>
  useEffect(() => {
    const root = document.documentElement;
    if (resolved === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [resolved]);

  return (
    <ThemeContext.Provider value={{ mode, resolved, setMode, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
