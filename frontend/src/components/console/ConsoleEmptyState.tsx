import type { LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';

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
    'inline-flex items-center font-mono text-xs sm:text-sm font-semibold uppercase tracking-[0.12em] rounded-oct-sm border border-oct-accent/60 text-oct-accent px-5 py-2.5 hover:bg-oct-accent hover:text-white hover:shadow-oct-glow-accent transition-all';
  return (
    <div className="flex items-center justify-center h-full p-6 bg-oct-bg">
      <div className="max-w-md text-center">
        <p className="oct-eyebrow tracking-[0.2em] mb-5">{eyebrow}</p>
        <div className="relative w-16 h-16 rounded-oct-lg border border-oct-accent/40 bg-gradient-to-b from-oct-flame to-oct-accent shadow-oct-glow-accent flex items-center justify-center mx-auto mb-6">
          <Icon size={28} className="text-white drop-shadow" strokeWidth={2} />
        </div>
        <h2 className="font-display text-2xl sm:text-3xl text-oct-text tracking-tight mb-3">{title}</h2>
        <p className="text-sm text-oct-muted mb-8 leading-relaxed">{description}</p>
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
          <p className="mt-5 font-mono text-xs text-oct-muted">
            <Link to={secondaryTo} className="text-oct-accent hover:underline">
              {secondaryLabel}
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}
