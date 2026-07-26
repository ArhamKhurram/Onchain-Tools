import type { ReactNode } from 'react';
import {
  Archive,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleSlash,
  Clock,
  ShieldCheck,
} from 'lucide-react';
import {
  describeRange,
  formatDriftPercent,
  formatPrice,
  type LpPositionStatus,
  type PositionCoverage,
  type RangeGeometry,
  type StatusPresentation,
  type StatusTone,
} from './positions';

/**
 * Shared position chrome — the two visual channels, and the range bar.
 *
 * Extracted out of the old single stacked card so the grid tile and the detail
 * view render the same facts the same way. A tile that coloured coverage
 * differently from the detail it opens would be worse than no tile at all.
 *
 *   STATUS   — in range vs out of range. A BADGE, top-right, plus the shape of
 *              the range bar. A fact about the market.
 *   COVERAGE — whether the automation acts on this position. A LEFT RAIL, plus
 *              the strip along the bottom. A fact about the policy.
 *
 * They are kept in separate geometry (pill vs rail) as well as separate copy,
 * because they fail in opposite directions: an out-of-range position that is
 * managed will be rebalanced, and an in-range position that is unmanaged looks
 * perfectly healthy while nothing tends it. Merge the channels and exactly one
 * of those gets misread.
 */

export const STATUS_TONE: Record<StatusTone, { badge: string; icon: ReactNode }> = {
  earning: {
    badge: 'border-oct-green text-oct-green bg-oct-surface-raised',
    icon: <CircleCheck size={10} strokeWidth={2.5} />,
  },
  idle: {
    badge: 'border-oct-yellow text-oct-yellow bg-oct-surface-raised',
    icon: <CircleSlash size={10} strokeWidth={2.5} />,
  },
  closed: {
    badge: 'border-oct-border-bright text-oct-muted bg-transparent',
    icon: <Archive size={10} strokeWidth={2.5} />,
  },
};

export interface CoverageMeta {
  label: string;
  /** Two or three words — the tile has no room for the full label. */
  short: string;
  /** Left rail on tile and detail alike — readable from across a grid. */
  rail: string;
  banner: string;
  /** Text colour for the coverage strip's own label. */
  text: string;
  icon: ReactNode;
  line: string;
}

/**
 * The wording here is the point of the whole panel. "Not allowlisted" describes
 * a config table; "nothing compounds these fees" describes what it costs.
 */
export const COVERAGE_META: Record<PositionCoverage, CoverageMeta> = {
  managed: {
    label: 'Managed by the automation',
    short: 'Managed',
    rail: 'border-l-oct-accent',
    banner: 'border-oct-accent bg-oct-accent-dim text-oct-text',
    text: 'text-oct-accent',
    icon: <ShieldCheck size={13} strokeWidth={2} className="text-oct-accent" />,
    line: 'This pool is allowlisted and saved — fees are compounded and the range is rebalanced under the active policy.',
  },
  allowlisted_not_managed: {
    label: 'Not managed',
    short: 'Not managed',
    rail: 'border-l-oct-yellow',
    banner: 'border-oct-yellow bg-oct-surface-raised text-oct-text',
    text: 'text-oct-yellow',
    icon: <AlertTriangle size={13} strokeWidth={2} className="text-oct-yellow" />,
    line: 'The pool is allowlisted, but the automation is not acting on this position. Its fees are not being compounded and its range is not being moved.',
  },
  pending_allowlist: {
    label: 'Ticked, not saved — still unmanaged',
    short: 'Ticked, unsaved',
    rail: 'border-l-oct-yellow',
    banner: 'border-oct-yellow bg-oct-surface-raised text-oct-text',
    text: 'text-oct-yellow',
    icon: <Clock size={13} strokeWidth={2} className="text-oct-yellow" />,
    line: 'The pool is in your unsaved allowlist. Nothing changes until you save — until then the automation still ignores this position.',
  },
  pending_removal: {
    label: 'Managed — unsaved removal',
    short: 'Removal unsaved',
    rail: 'border-l-oct-yellow',
    banner: 'border-oct-yellow bg-oct-surface-raised text-oct-text',
    text: 'text-oct-yellow',
    icon: <Clock size={13} strokeWidth={2} className="text-oct-yellow" />,
    line: 'Still managed right now. Saving removes this pool from the allowlist, after which the automation stops compounding and rebalancing this position.',
  },
  unmanaged: {
    label: 'Not managed — pool is not allowlisted',
    short: 'Unmanaged',
    rail: 'border-l-oct-flame',
    banner: 'border-oct-flame bg-oct-surface-raised text-oct-text',
    text: 'text-oct-flame',
    icon: <AlertTriangle size={13} strokeWidth={2} className="text-oct-flame" />,
    line: 'The automation will never touch this position while its pool is off the allowlist. Fees accrue unclaimed, and if price leaves the range nothing moves it back.',
  },
  // Deliberately NOT styled like `unmanaged`. Claiming a coverage gap we cannot
  // actually see would push the operator to "fix" something that may not be
  // broken. Muted, not alarming — the honest reading of a failed policy read is
  // "ask again", not "your money is exposed".
  unknown: {
    label: 'Coverage unknown',
    short: 'Unknown',
    rail: 'border-l-oct-border-bright',
    banner: 'border-oct-border bg-oct-surface-raised text-oct-muted',
    text: 'text-oct-muted',
    icon: <CircleSlash size={13} strokeWidth={2} className="text-oct-muted" />,
    line: 'The policy could not be read, so whether the automation covers this position is unknown — not confirmed missing. The position itself is unaffected. Refresh to try again.',
  },
  closed: {
    label: 'Closed',
    short: 'Closed',
    rail: 'border-l-oct-border-bright',
    banner: 'border-oct-border bg-oct-surface-raised text-oct-muted',
    text: 'text-oct-muted',
    icon: <Archive size={13} strokeWidth={2} className="text-oct-muted" />,
    line: 'Withdrawn. There is nothing left here for the automation to manage.',
  },
};

/** The market-fact channel. Always a pill, always top-right. */
export function StatusBadge({
  status,
  compact = false,
}: {
  status: StatusPresentation;
  /** Drops the consequence clause — the tile header has no room for it. */
  compact?: boolean;
}) {
  const tone = STATUS_TONE[status.tone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 border font-mono text-[9px] uppercase tracking-[0.1em] px-1.5 py-0.5 whitespace-nowrap ${tone.badge}`}
    >
      {tone.icon}
      {status.label}
      {!compact && <span className="text-oct-muted">· {status.consequence}</span>}
    </span>
  );
}

/**
 * The policy-fact channel, in its compact form: the strip along the bottom of a
 * tile. The full sentence lives in the detail view — see `CoverageBanner`.
 */
export function CoverageStrip({ coverage }: { coverage: PositionCoverage }) {
  const meta = COVERAGE_META[coverage];
  return (
    <div className={`px-3 py-1.5 border-t-2 flex items-center gap-1.5 min-w-0 ${meta.banner}`}>
      <span className="shrink-0">{meta.icon}</span>
      <p className={`font-mono text-[10px] uppercase tracking-[0.12em] font-semibold truncate ${meta.text}`}>
        {meta.short}
      </p>
    </div>
  );
}

export function CoverageBanner({
  coverage,
  children,
}: {
  coverage: PositionCoverage;
  /** The coverage switch, rendered inside the banner it explains. */
  children?: ReactNode;
}) {
  const meta = COVERAGE_META[coverage];
  return (
    <div className={`px-4 py-3 border-2 flex flex-wrap items-start justify-between gap-3 ${meta.banner}`}>
      <div className="flex items-start gap-2 min-w-0 flex-1">
        <span className="shrink-0 mt-0.5">{meta.icon}</span>
        <div className="min-w-0">
          <p className={`font-mono text-[11px] uppercase tracking-[0.12em] font-semibold ${meta.text}`}>
            {meta.label}
          </p>
          <p className="font-mono text-[11px] leading-relaxed mt-1 text-oct-muted">{meta.line}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

/** Money in a tile: display face and accent rail, one size down from the safety strip. */
export const CARD_MONEY_VALUE = 'font-display text-xl tracking-tight tabular-nums text-oct-text';

export function MoneyCell({
  label,
  value,
  sub,
  size = 'md',
}: {
  label: string;
  value: string;
  sub?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div className="border-l-2 border-oct-accent pl-3 min-w-0">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-oct-muted truncate">{label}</p>
      <p
        className={
          size === 'sm'
            ? 'font-display text-base tracking-tight tabular-nums text-oct-text'
            : CARD_MONEY_VALUE
        }
      >
        {value}
      </p>
      {sub && <p className="font-mono text-[10px] text-oct-muted mt-0.5 leading-snug">{sub}</p>}
    </div>
  );
}

/**
 * The bar IS the range. Price outside it renders hard against an end with a
 * caret pointing off the bar, so "out of range" is a shape rather than a word to
 * read.
 *
 * `compact` drops the min/now/max readout and the sentence, leaving only the
 * shape — which is exactly what a tile in a grid of ten needs.
 */
export function RangeBar({
  geometry,
  status,
  minPrice,
  maxPrice,
  currentPrice,
  compact = false,
}: {
  geometry: RangeGeometry;
  status: LpPositionStatus;
  minPrice: number;
  maxPrice: number;
  currentPrice: number;
  compact?: boolean;
}) {
  const closed = status === 'closed';
  const outside = geometry.placement === 'below' || geometry.placement === 'above';

  if (geometry.placement === 'unknown') {
    return (
      <p className="font-mono text-[10px] text-oct-muted leading-snug">
        {compact
          ? 'No usable range bounds.'
          : 'Price range unavailable for this position — the quote carried no usable bounds.'}
      </p>
    );
  }

  const percent = Math.round((geometry.fraction ?? 0) * 100);
  const markerColor = closed ? 'bg-oct-border-bright' : outside ? 'bg-oct-yellow' : 'bg-oct-accent';
  const barHeight = compact ? 'h-4' : 'h-6';

  return (
    <div>
      <div className="flex items-center gap-1">
        <span
          className={`w-3 shrink-0 ${geometry.placement === 'below' ? 'text-oct-yellow' : 'text-transparent'}`}
        >
          <ChevronLeft size={12} strokeWidth={3} />
        </span>

        <div className={`relative flex-1 ${barHeight}`}>
          <div
            className={`absolute inset-x-0 top-1/2 -translate-y-1/2 h-2 border-2 ${
              outside || closed ? 'border-oct-border-bright bg-oct-bg' : 'border-oct-accent bg-oct-accent-dim'
            }`}
          />
          <div
            className={`absolute top-0 ${barHeight} w-[3px] -translate-x-1/2 ${markerColor}`}
            style={{ left: `${percent}%` }}
            aria-hidden
          />
        </div>

        <span
          className={`w-3 shrink-0 ${geometry.placement === 'above' ? 'text-oct-yellow' : 'text-transparent'}`}
        >
          <ChevronRight size={12} strokeWidth={3} />
        </span>
      </div>

      <div className="flex items-baseline justify-between gap-2 mt-1 font-mono text-[10px] tabular-nums">
        <span className="text-oct-muted truncate">
          <span className="uppercase tracking-[0.1em]">min</span> {formatPrice(minPrice)}
        </span>
        <span className={`${outside && !closed ? 'text-oct-yellow' : 'text-oct-text'} truncate`}>
          <span className="uppercase tracking-[0.1em] text-oct-muted">now</span> {formatPrice(currentPrice)}
          {outside && geometry.driftPercent !== null && (
            <span className="text-oct-muted">
              {' '}
              ({formatDriftPercent(geometry.driftPercent)} {geometry.placement === 'above' ? 'over' : 'under'})
            </span>
          )}
        </span>
        <span className="text-oct-muted truncate">
          <span className="uppercase tracking-[0.1em]">max</span> {formatPrice(maxPrice)}
        </span>
      </div>

      {!compact && (
        <p className="font-mono text-[11px] text-oct-muted leading-relaxed mt-1.5">
          {describeRange(geometry, status)}
        </p>
      )}
    </div>
  );
}
