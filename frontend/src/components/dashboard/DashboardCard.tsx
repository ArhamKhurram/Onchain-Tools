import type { LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { StatusVariant } from '../../styles/cockpit-tokens';

function StatusDot({ variant }: { variant: StatusVariant }) {
  if (variant === 'live') {
    return (
      <span
        className="inline-block w-1.5 h-1.5 rounded-full bg-oct-live animate-pulse-live shrink-0"
        aria-hidden
      />
    );
  }
  if (variant === 'pending') {
    return (
      <span
        className="inline-block w-1.5 h-1.5 rounded-full bg-oct-accent animate-pulse-pending shrink-0"
        aria-hidden
      />
    );
  }
  return (
    <span
      className="inline-block w-1.5 h-1.5 rounded-full bg-oct-muted/50 shrink-0"
      aria-hidden
    />
  );
}

export interface DashboardCardProps {
  title: string;
  description: string;
  icon: LucideIcon;
  /** Route target; omit for non-interactive panels */
  to?: string;
  /** 2px left edge in live blue — encodes real-time / connected modules only */
  liveEdge?: boolean;
  status?: {
    label: string;
    variant: StatusVariant;
    mono?: boolean;
  };
  children?: React.ReactNode;
}

function CardInner({
  title,
  description,
  icon: Icon,
  liveEdge,
  status,
  children,
  interactive,
}: DashboardCardProps & { interactive: boolean }) {
  return (
    <div
      className={[
        'relative h-full p-5 rounded-cockpit border-2 border-black bg-oct-surface shadow-oct-hard',
        'transition-all duration-100',
        liveEdge ? 'border-l-[6px] border-l-oct-accent pl-[calc(1.25rem-4px)]' : '',
        interactive
          ? 'hover:-translate-x-[2px] hover:-translate-y-[2px] hover:shadow-oct-hard-lg hover:bg-oct-surface-raised'
          : '',
      ].join(' ')}
    >
      <div className="flex items-start gap-3 mb-3">
        <Icon
          size={20}
          strokeWidth={1.5}
          className="text-oct-muted shrink-0 mt-0.5"
          aria-hidden
        />
        <h2 className="font-bold uppercase tracking-tight text-oct-text">{title}</h2>
      </div>

      <p className="text-sm text-oct-muted leading-relaxed mb-4 pl-8">{description}</p>

      {status && (
        <div className="flex items-center gap-2 pl-8 mb-3">
          <StatusDot variant={status.variant} />
          <span
            className={[
              'text-xs tracking-wide',
              status.mono ? 'font-mono text-oct-text/90' : 'font-medium text-oct-muted',
              status.variant === 'live' ? 'text-oct-live' : '',
              status.variant === 'pending' ? 'text-oct-accent' : '',
            ].join(' ')}
          >
            {status.label}
          </span>
        </div>
      )}

      {children}
    </div>
  );
}

export default function DashboardCard(props: DashboardCardProps) {
  if (props.to) {
    return (
      <Link to={props.to} className="block h-full outline-none focus-visible:ring-2 focus-visible:ring-oct-accent focus-visible:ring-offset-2 focus-visible:ring-offset-oct-bg rounded-cockpit">
        <CardInner {...props} interactive />
      </Link>
    );
  }

  return <CardInner {...props} interactive={false} />;
}
