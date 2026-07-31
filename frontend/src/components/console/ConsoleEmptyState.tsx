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
    'inline-block font-mono text-xs sm:text-sm uppercase tracking-[0.12em] border-2 border-oct-accent text-oct-accent px-5 py-2.5 hover:bg-oct-accent hover:text-white transition-colors';
  return (
    <div className="flex items-center justify-center h-full p-6 bg-oct-bg">
      <div className="max-w-md text-center">
        <p className="font-mono text-xs tracking-[0.2em] text-oct-muted mb-5">{eyebrow}</p>
        <div className="w-14 h-14 border-2 border-black bg-oct-flame shadow-oct-hard flex items-center justify-center mx-auto mb-5">
          <Icon size={26} className="text-black" strokeWidth={2} />
        </div>
        <h2 className="font-display text-2xl sm:text-3xl text-oct-text tracking-tight mb-3">{title}</h2>
        <p className="font-mono text-xs sm:text-sm text-oct-muted mb-8 leading-relaxed">{description}</p>
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
          <p className="mt-5 font-mono text-[11px] text-oct-muted">
            <Link to={secondaryTo} className="text-oct-accent hover:underline">
              {secondaryLabel}
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}
