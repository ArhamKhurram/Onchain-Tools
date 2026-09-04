import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { AnimatePresence, m, MotionFeatures, useTransition } from '../../lib/motion';
import { cn } from '../../lib/utils';

// ── Modal shell shared by the two wallet forms ────────────────────────────────
// WalletFormModal (tracked wallets) and HoldingWalletFormModal (portfolio
// buy-wallets) used to carry byte-identical overlay/card/header markup and the
// same Escape-to-close effect. One shell keeps the two from drifting and gives
// them a single place for the entrance animation.
//
// Motion here is chrome-only and allowed by the rule in lib/motion.ts: a modal
// opens on a click, not on a WebSocket frame. The backdrop fades and the card
// fades + rises 8px; on close both run in reverse via AnimatePresence, which is
// why the caller renders this unconditionally and passes `open` rather than
// short-circuiting with `if (!open) return null` — the exit needs the element
// still mounted for one more frame.
//
// `MotionFeatures` is mounted per surface. Both consumers live behind lazy
// routes (Directory, Portfolio), so the animation runtime stays off the boot
// path.

// ── Field shells shared by both forms ────────────────────────────────────────
// Static class strings rather than components: the fields are plain inputs and
// the forms differ only in which fields they show.

export const LABEL_CLASS = 'type-label block text-oct-muted mb-tight uppercase tracking-wide';
export const FIELD_CLASS = 'oct-input w-full px-comfy py-snug type-body';
/** The chain picker is a segmented control; the active segment carries the brand accent. */
export const chainButtonClass = (active: boolean) =>
  cn(
    'px-comfy py-snug rounded-oct-sm type-caption font-bold uppercase border transition-all duration-fast',
    active
      ? 'border-oct-accent/50 bg-oct-accent text-white shadow-oct-glow-accent'
      : 'border-oct-border text-oct-muted hover:border-oct-border-bright hover:text-oct-text',
  );
/** Validation/submit failures are `oct-critical`, never the accent (which is itself red in dark). */
export const FIELD_ERROR_CLASS =
  'type-body text-oct-critical bg-oct-critical-dim border border-oct-critical/50 rounded-oct px-comfy py-snug';

interface WalletModalShellProps {
  open: boolean;
  title: string;
  /** Blocks backdrop/Escape/close-button dismissal while a submit is in flight. */
  busy: boolean;
  onClose: () => void;
  children: ReactNode;
}

const backdrop = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
};

const card = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 8 },
};

export default function WalletModalShell({
  open,
  title,
  busy,
  onClose,
  children,
}: WalletModalShellProps) {
  const fade = useTransition('fade');

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, busy, onClose]);

  return (
    <MotionFeatures>
      <AnimatePresence>
        {open && (
          <m.div
            key="backdrop"
            {...backdrop}
            transition={fade}
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-roomy"
            onClick={() => !busy && onClose()}
          >
            <m.div
              {...card}
              transition={fade}
              role="dialog"
              aria-modal="true"
              aria-label={title}
              className="w-full max-w-lg oct-card oct-card-flush shadow-oct-soft-lg overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="oct-headerbar flex items-center justify-between px-roomy py-comfy">
                <h3 className="type-title uppercase tracking-wide text-oct-text">{title}</h3>
                <button
                  type="button"
                  onClick={onClose}
                  disabled={busy}
                  className="oct-icon-btn p-snug disabled:opacity-50"
                  aria-label="Close"
                >
                  <X size={16} />
                </button>
              </div>
              {children}
            </m.div>
          </m.div>
        )}
      </AnimatePresence>
    </MotionFeatures>
  );
}
