/**
 * Toast provider + useToast hook built on @radix-ui/react-toast.
 * Supports success / error / warning / info variants with auto-dismiss progress bar.
 */
import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from 'react';
import * as ToastPrimitive from '@radix-ui/react-toast';
import { X, CheckCircle2, AlertCircle, AlertTriangle, Info } from 'lucide-react';
import { cn } from '../../lib/utils';

type ToastType = 'success' | 'error' | 'warning' | 'info';

interface ToastItem {
  id: string;
  title: string;
  description?: string;
  type: ToastType;
  duration: number;
}

interface ToastContextValue {
  toast: (title: string, description?: string, type?: ToastType) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  warning: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
}

const DURATION_MAP: Record<ToastType, number> = {
  success: 4000,
  error: 6000,
  warning: 5000,
  info: 4500,
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const addToast = useCallback(
    (title: string, description?: string, type: ToastType = 'info') => {
      const id = Math.random().toString(36).slice(2);
      const duration = DURATION_MAP[type];
      setToasts((prev) => [...prev, { id, title, description, type, duration }]);
    },
    [],
  );

  const remove = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const value: ToastContextValue = {
    toast: addToast,
    success: useCallback((t: string, d?: string) => addToast(t, d, 'success'), [addToast]),
    error: useCallback((t: string, d?: string) => addToast(t, d, 'error'), [addToast]),
    warning: useCallback((t: string, d?: string) => addToast(t, d, 'warning'), [addToast]),
    info: useCallback((t: string, d?: string) => addToast(t, d, 'info'), [addToast]),
  };

  const iconMap: Record<ToastType, ReactNode> = {
    success: <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />,
    error: <AlertCircle className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />,
    warning: <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />,
    info: <Info className="h-4 w-4 text-blue-600 shrink-0 mt-0.5" />,
  };

  const borderMap: Record<ToastType, string> = {
    success: 'border-l-emerald-500',
    error: 'border-l-red-500',
    warning: 'border-l-amber-500',
    info: 'border-l-blue-500',
  };

  const progressMap: Record<ToastType, string> = {
    success: 'bg-emerald-500',
    error: 'bg-red-500',
    warning: 'bg-amber-500',
    info: 'bg-blue-500',
  };

  return (
    <ToastContext.Provider value={value}>
      <ToastPrimitive.Provider swipeDirection="right">
        {children}
        {toasts.map((t) => (
          <ToastPrimitive.Root
            key={t.id}
            duration={t.duration}
            onOpenChange={(open) => {
              if (!open) remove(t.id);
            }}
            defaultOpen
            className={cn(
              'bg-white border border-gray-200 border-l-4 rounded-lg shadow-lg overflow-hidden',
              'max-w-sm w-full',
              'data-[state=open]:animate-in data-[state=closed]:animate-out',
              'data-[swipe=end]:animate-out data-[state=closed]:fade-out-0',
              'data-[state=open]:slide-in-from-right-5',
              borderMap[t.type],
            )}
          >
            <div className="flex items-start gap-3 p-4">
              {iconMap[t.type]}
              <div className="flex-1 min-w-0">
                <ToastPrimitive.Title className="text-sm font-semibold text-gray-900">
                  {t.title}
                </ToastPrimitive.Title>
                {t.description && (
                  <ToastPrimitive.Description className="text-xs text-gray-500 mt-0.5">
                    {t.description}
                  </ToastPrimitive.Description>
                )}
              </div>
              <ToastPrimitive.Close
                onClick={() => remove(t.id)}
                className="text-gray-400 hover:text-gray-600 ml-2 shrink-0"
                aria-label="Dismiss notification"
              >
                <X className="h-3.5 w-3.5" />
              </ToastPrimitive.Close>
            </div>
            {/* Auto-dismiss progress bar */}
            <div className="h-0.5 w-full bg-gray-100">
              <div
                className={cn('h-full', progressMap[t.type])}
                style={{
                  animation: `toast-progress ${t.duration}ms linear forwards`,
                }}
              />
            </div>
          </ToastPrimitive.Root>
        ))}
        <ToastPrimitive.Viewport className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2 w-auto max-w-sm" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
