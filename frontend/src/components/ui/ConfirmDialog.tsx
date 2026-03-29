/**
 * ConfirmDialog — modal confirmation for destructive/important actions.
 * Uses native <dialog> for accessibility (focus trap, Escape to close).
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { cn } from '../../lib/utils';

type DialogVariant = 'danger' | 'warning' | 'info';

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: DialogVariant;
  loading?: boolean;
  icon?: ReactNode;
}

const variantStyles: Record<DialogVariant, { btn: string; icon: string; bg: string }> = {
  danger: {
    btn: 'bg-red-600 hover:bg-red-700 text-white',
    icon: 'text-red-600',
    bg: 'bg-red-50',
  },
  warning: {
    btn: 'bg-amber-600 hover:bg-amber-700 text-white',
    icon: 'text-amber-600',
    bg: 'bg-amber-50',
  },
  info: {
    btn: 'bg-[#1B3A5C] hover:bg-[#15304d] text-white',
    icon: 'text-[#1B3A5C]',
    bg: 'bg-blue-50',
  },
};

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'danger',
  loading = false,
  icon,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const styles = variantStyles[variant];

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Close on backdrop click
  const handleBackdropClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === dialogRef.current) onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={handleBackdropClick}
      className="backdrop:bg-black/40 backdrop:backdrop-blur-sm bg-transparent p-0 m-auto rounded-2xl open:animate-in open:fade-in open:zoom-in-95"
    >
      <div className="bg-white rounded-2xl shadow-2xl w-[400px] max-w-[90vw] p-0">
        {/* Header */}
        <div className="flex items-start gap-4 p-6 pb-0">
          <div className={cn('p-2 rounded-xl shrink-0', styles.bg)}>
            {icon ?? <AlertTriangle className={cn('h-5 w-5', styles.icon)} />}
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-bold text-gray-900">{title}</h3>
            {description && (
              <p className="text-sm text-gray-500 mt-1">{description}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 shrink-0 -mt-1 -mr-1"
            aria-label="Close dialog"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 p-6">
          <button
            onClick={onClose}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className={cn(
              'px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-50',
              styles.btn,
            )}
          >
            {loading ? 'Processing...' : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}

export default ConfirmDialog;
