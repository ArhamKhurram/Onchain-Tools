import type { LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { EYEBROW_CLASS } from './eyebrow';

interface ConsoleEmptyStateProps {
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  description: string;
  actionLabel: string;
  /** Navigate on click. Ignored when onActionClick is given. */
  actionTo?: string;
  /** Handle the action in-page (e.g. open a modal) instead of navigating. */
  onActionClick?: () => void;
  secondaryLabel?: string;
  secondaryTo?: string;
}

// Shared by every console page's empty surface, so this is a token migration
// only — same props, same layout, sizes and spacing moved onto the ramp.
// Richer per-surface empty states are built on top of it in their own files.
export default function ConsoleEmptyState({
  icon: Icon,
  eyebrow,
  title,
  description,
  actionLabel,
  actionTo,
  onActionClick,
  secondaryLabel,
  secondaryTo,
}: ConsoleEmptyStateProps) {
  const actionClass =
    'inline-flex items-center type-label sm:text-sm font-mono uppercase tracking-[0.12em] rounded-oct-sm border border-oct-accent/60 text-oct-accent px-roomy py-cozy hover:bg-oct-accent hover:text-white hover:shadow-oct-glow-accent transition-all duration-fast';
  return (
    <div className="flex items-center justify-center h-full p-section bg-oct-bg">
      <div className="max-w-md text-center">
        <p className={`${EYEBROW_CLASS} tracking-[0.2em] mb-roomy`}>{eyebrow}</p>
        <div className="relative w-16 h-16 rounded-oct-lg border border-oct-accent/40 bg-gradient-to-b from-oct-flame to-oct-accent shadow-oct-glow-accent flex items-center justify-center mx-auto mb-roomy">
          <Icon size={28} className="text-white drop-shadow" strokeWidth={2} />
        </div>
        <h2 className="font-display type-heading sm:type-display text-oct-text tracking-tight mb-cozy">{title}</h2>
        <p className="type-body text-oct-muted mb-section leading-relaxed">{description}</p>
        {onActionClick ? (
          <button type="button" onClick={onActionClick} className={actionClass}>
            [ {actionLabel} ]
          </button>
        ) : actionTo ? (
          <Link to={actionTo} className={actionClass}>
            [ {actionLabel} ]
          </Link>
        ) : null}
        {secondaryLabel && secondaryTo && (
          <p className="mt-roomy type-data font-normal text-oct-muted">
            <Link to={secondaryTo} className="text-oct-accent hover:underline">
              {secondaryLabel}
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}
