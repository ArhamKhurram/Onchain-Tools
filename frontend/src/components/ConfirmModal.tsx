import { useEffect, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';

interface ConfirmModalProps {
  open: boolean;
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmModal({
  open,
  title = 'Are you sure?',
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = true,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) confirmRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80" onClick={onCancel}>
      <div
        className="bg-oct-surface border-2 border-black rounded-cockpit shadow-oct-hard-lg w-full max-w-md mx-4 overflow-hidden animate-in fade-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 pt-6 pb-4 flex flex-col items-center text-center gap-3">
          <div className={`p-3 rounded-cockpit border-2 border-black ${danger ? 'bg-oct-accent' : 'bg-oct-surface-raised'}`}>
            <AlertTriangle size={28} className={danger ? 'text-white' : 'text-oct-accent'} />
          </div>
          <h3 className="text-lg font-extrabold uppercase text-white">{title}</h3>
          <p className="text-sm text-discord-text-muted leading-relaxed">{message}</p>
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t-2 border-black bg-oct-bg">
          <button
            onClick={onCancel}
            className="brutal-btn-ghost px-4 py-2 text-sm"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            className={`brutal-btn px-4 py-2 text-sm ${danger ? '' : 'bg-oct-surface-raised text-oct-text border-oct-border-bright'}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
