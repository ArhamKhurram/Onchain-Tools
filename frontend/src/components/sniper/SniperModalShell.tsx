import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { AnimatePresence, m, MotionFeatures, useTransition } from '../../lib/motion';
import { cn } from '../../lib/utils';

/**
 * Backdrop + card for the three sniper modals (fire, rule form, wallet form).
 *
 * Chrome, not stream: a modal opens once per deliberate act and never
 * re-renders per WebSocket frame, which is exactly the surface lib/motion.ts
 * allows to animate. `MotionFeatures` is mounted HERE, per surface, so the
 * runtime rides in the lazily-loaded SniperPage chunk and stays off the boot
 * path.
 *
 * `AnimatePresence` needs the child to unmount on close rather than the parent
 * returning null, so callers render this unconditionally and pass `open`. The
 * exiting card keeps its last-rendered children, which is what lets
 * SniperFireModal's parent null out `rule` and `open` in the same state update
 * without the card going blank mid-fade.
 */
export default function SniperModalShell({
  open,
  onBackdropClick,
  className,
  children,
}: {
  open: boolean;
  /** Fired on backdrop click only; the caller decides whether it may close. */
  onBackdropClick: () => void;
  /** Width and anything else card-specific, e.g. `max-w-xl`. */
  className?: string;
  children: ReactNode;
}) {
  // Instant under prefers-reduced-motion; the wrapper handles that, not us.
  const transition = useTransition('snappy');

  return (
    <MotionFeatures>
      <AnimatePresence>
        {open && (
          <m.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={transition}
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-roomy"
            onClick={onBackdropClick}
          >
            <m.div
              initial={{ opacity: 0, y: 6, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.985 }}
              transition={transition}
              className={cn('w-full oct-card oct-card-flush shadow-oct-soft-lg overflow-hidden', className)}
              onClick={(e) => e.stopPropagation()}
            >
              {children}
            </m.div>
          </m.div>
        )}
      </AnimatePresence>
    </MotionFeatures>
  );
}

/** Title row shared by the three modals: `type-title`, close button on the right. */
export function SniperModalHeader({
  title,
  onClose,
  disabled,
}: {
  title: ReactNode;
  onClose: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="oct-headerbar flex items-center justify-between px-roomy py-comfy">
      <h3 className="type-title uppercase tracking-wide text-oct-text">{title}</h3>
      <button type="button" onClick={onClose} disabled={disabled} className="oct-icon-btn p-snug disabled:opacity-50">
        <X size={18} />
      </button>
    </div>
  );
}
