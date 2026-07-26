import type { ReactNode } from 'react';
import {
  Archive,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleSlash,
  Clock,
  Plus,
  ShieldCheck,
} from 'lucide-react';
import { formatFeeTier, formatUsdExact, shortAddress } from './format';
import {
  canAdmitPool,
  describeRange,
  formatDriftPercent,
  formatPrice,
  formatTokenId,
  positionPairLabel,
  presentStatus,
  rangeGeometry,
  type LpPositionView,
  type PositionCoverage,
  type StatusTone,
} from './positions';

/**
 * One open position.
 *
 * The card carries two independent visual channels, deliberately not merged:
 *
 *   STATUS  — in range vs out of range. Badge, plus the range bar itself, where
 *             an out-of-range marker sits pinned against the edge with a caret
 *             pointing off it. That is a fact about the market.
 *   COVERAGE — whether the automation acts on this position at all. Left rail
 *             plus the footer banner. That is a fact about the policy.
 *
 * Keeping them apart matters because they fail in opposite directions: an
 * out-of-range position that is managed will be rebalanced, and an in-range
 * position that is unmanaged looks perfectly healthy while nothing tends it. If
 * both used the same colour channel, exactly one of those would be misread.
 */

/** Money in a card list: display face and accent rail, one size down from the
 *  safety strip so a column of cards does not shout over the page header. */
const CARD_MONEY_VALUE = 'font-display text-xl tracking-tight tabular-nums text-oct-text';

const STATUS_TONE: Record<StatusTone, { badge: string; icon: ReactNode }> = {
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

interface CoverageMeta {
  label: string;
  /** Left rail on the card — readable from across a scrolling list. */
  rail: string;
  banner: string;
  icon: ReactNode;
  line: string;
}

/**
 * The wording here is the point of the whole panel. "Not allowlisted" describes
 * a config table; "nothing compounds these fees" describes what it costs.
 */
const COVERAGE_META: Record<PositionCoverage, CoverageMeta> = {
  managed: {
    label: 'Managed by the automation',
    rail: 'border-l-oct-accent',
    banner: 'border-oct-accent bg-oct-accent-dim text-oct-text',
    icon: <ShieldCheck size={13} strokeWidth={2} className="text-oct-accent" />,
    line: 'This pool is allowlisted and saved — fees are compounded and the range is rebalanced under the active policy.',
  },
  allowlisted_not_managed: {
    label: 'Not managed',
    rail: 'border-l-oct-yellow',
    banner: 'border-oct-yellow bg-oct-surface-raised text-oct-text',
    icon: <AlertTriangle size={13} strokeWidth={2} className="text-oct-yellow" />,
    line: 'The pool is allowlisted, but the automation is not acting on this position. Its fees are not being compounded and its range is not being moved.',
  },
  pending_allowlist: {
    label: 'Ticked, not saved — still unmanaged',
    rail: 'border-l-oct-yellow',
    banner: 'border-oct-yellow bg-oct-surface-raised text-oct-text',
    icon: <Clock size={13} strokeWidth={2} className="text-oct-yellow" />,
    line: 'The pool is in your unsaved allowlist. Nothing changes until you save — until then the automation still ignores this position.',
  },
  pending_removal: {
    label: 'Managed — unsaved removal',
    rail: 'border-l-oct-yellow',
    banner: 'border-oct-yellow bg-oct-surface-raised text-oct-text',
    icon: <Clock size={13} strokeWidth={2} className="text-oct-yellow" />,
    line: 'Still managed right now. Saving removes this pool from the allowlist, after which the automation stops compounding and rebalancing this position.',
  },
  unmanaged: {
    label: 'Not managed — pool is not allowlisted',
    rail: 'border-l-oct-flame',
    banner: 'border-oct-flame bg-oct-surface-raised text-oct-text',
    icon: <AlertTriangle size={13} strokeWidth={2} className="text-oct-flame" />,
    line: 'The automation will never touch this position while its pool is off the allowlist. Fees accrue unclaimed, and if price leaves the range nothing moves it back.',
  },
  // Deliberately NOT styled like `unmanaged`. Claiming a coverage gap we cannot
  // actually see would push the operator to "fix" something that may not be
  // broken. Muted, not alarming — the honest reading of a failed policy read is
  // "ask again", not "your money is exposed".
  unknown: {
    label: 'Coverage unknown',
    rail: 'border-l-oct-border-bright',
    banner: 'border-oct-border bg-oct-surface-raised text-oct-muted',
    icon: <CircleSlash size={13} strokeWidth={2} className="text-oct-muted" />,
    line: 'The policy could not be read, so whether the automation covers this position is unknown — not confirmed missing. The position itself is unaffected. Refresh to try again.',
  },
  closed: {
    label: 'Closed',
    rail: 'border-l-oct-border-bright',
    banner: 'border-oct-border bg-oct-surface-raised text-oct-muted',
    icon: <Archive size={13} strokeWidth={2} className="text-oct-muted" />,
    line: 'Withdrawn. There is nothing left here for the automation to manage.',
  },
};

function MoneyCell({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="border-l-2 border-oct-accent pl-3 min-w-0">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-oct-muted">{label}</p>
      <p className={CARD_MONEY_VALUE}>{value}</p>
      {sub && <p className="font-mono text-[10px] text-oct-muted mt-0.5 leading-snug">{sub}</p>}
    </div>
  );
}

function RangeBar({ position }: { position: LpPositionView }) {
  const geometry = rangeGeometry(position.minPrice, position.maxPrice, position.currentPrice);
  const closed = position.status === 'closed';
  const outside = geometry.placement === 'below' || geometry.placement === 'above';

  if (geometry.placement === 'unknown') {
    return (
      <p className="font-mono text-[11px] text-oct-muted">
        Price range unavailable for this position — the quote carried no usable bounds.
      </p>
    );
  }

  const percent = Math.round((geometry.fraction ?? 0) * 100);
  const markerColor = closed
    ? 'bg-oct-border-bright'
    : outside
      ? 'bg-oct-yellow'
      : 'bg-oct-accent';

  return (
    <div>
      <div className="flex items-center gap-1">
        <span className={`w-3 shrink-0 ${geometry.placement === 'below' ? 'text-oct-yellow' : 'text-transparent'}`}>
          <ChevronLeft size={12} strokeWidth={3} />
        </span>

        <div className="relative flex-1 h-6">
          {/* The bar IS the range. Price outside it renders hard against an end
              with a caret pointing off the bar, so "out of range" is a shape
              rather than a word to read. */}
          <div
            className={`absolute inset-x-0 top-1/2 -translate-y-1/2 h-2 border-2 ${
              outside || closed ? 'border-oct-border-bright bg-oct-bg' : 'border-oct-accent bg-oct-accent-dim'
            }`}
          />
          <div
            className={`absolute top-0 h-6 w-[3px] -translate-x-1/2 ${markerColor}`}
            style={{ left: `${percent}%` }}
            aria-hidden
          />
        </div>

        <span className={`w-3 shrink-0 ${geometry.placement === 'above' ? 'text-oct-yellow' : 'text-transparent'}`}>
          <ChevronRight size={12} strokeWidth={3} />
        </span>
      </div>

      <div className="flex items-baseline justify-between gap-2 mt-1 font-mono text-[10px] tabular-nums">
        <span className="text-oct-muted">
          <span className="uppercase tracking-[0.1em]">min</span> {formatPrice(position.minPrice)}
        </span>
        <span className={outside && !closed ? 'text-oct-yellow' : 'text-oct-text'}>
          <span className="uppercase tracking-[0.1em] text-oct-muted">now</span>{' '}
          {formatPrice(position.currentPrice)}
          {outside && geometry.driftPercent !== null && (
            <span className="text-oct-muted">
              {' '}
              ({formatDriftPercent(geometry.driftPercent)} {geometry.placement === 'above' ? 'over' : 'under'})
            </span>
          )}
        </span>
        <span className="text-oct-muted">
          <span className="uppercase tracking-[0.1em]">max</span> {formatPrice(position.maxPrice)}
        </span>
      </div>

      <p className="font-mono text-[11px] text-oct-muted leading-relaxed mt-1.5">
        {describeRange(geometry, position.status)}
      </p>
    </div>
  );
}

interface LpPositionCardProps {
  position: LpPositionView;
  coverage: PositionCoverage;
  /** Adds this position's pool to the policy draft's allowlist. */
  onAdmitPool: (poolAddress: string) => void;
  disabled?: boolean;
}

export default function LpPositionCard({
  position,
  coverage,
  onAdmitPool,
  disabled = false,
}: LpPositionCardProps) {
  const status = presentStatus(position.status);
  const tone = STATUS_TONE[status.tone];
  const meta = COVERAGE_META[coverage];
  const closed = coverage === 'closed';

  return (
    <article className={`border-2 border-oct-border border-l-4 ${meta.rail} bg-oct-surface`}>
      <div className="px-4 py-3 border-b-2 border-oct-border flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <h4
            className={`font-display text-lg tracking-tight ${closed ? 'text-oct-muted' : 'text-oct-text'}`}
          >
            {positionPairLabel(position)}
          </h4>
          <p className="font-mono text-[10px] text-oct-muted mt-0.5 truncate">
            {position.platform || 'unknown dex'} · {formatFeeTier(position.feeTierBps)} fee tier ·{' '}
            {formatTokenId(position.tokenId)} · {shortAddress(position.poolAddress)}
          </p>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 border font-mono text-[9px] uppercase tracking-[0.1em] px-1.5 py-0.5 whitespace-nowrap ${tone.badge}`}
        >
          {tone.icon}
          {status.label}
          <span className="text-oct-muted">· {status.consequence}</span>
        </span>
      </div>

      {!closed && (
        <div className="px-4 py-3 border-b-2 border-oct-border grid grid-cols-1 sm:grid-cols-2 gap-4">
          <MoneyCell label="Position value" value={formatUsdExact(position.valueUsd)} />
          <MoneyCell
            label="Unclaimed fees"
            value={formatUsdExact(position.unclaimedFeesUsd)}
            sub={
              coverage === 'managed' || coverage === 'pending_removal'
                ? 'Compounded when the fees-vs-gas trigger fires.'
                : 'Sitting unclaimed — nothing is compounding these.'
            }
          />
        </div>
      )}

      <div className="px-4 py-3 border-b-2 border-oct-border">
        <RangeBar position={position} />
      </div>

      <div className={`px-4 py-3 border-t-2 flex flex-wrap items-start justify-between gap-3 ${meta.banner}`}>
        <div className="flex items-start gap-2 min-w-0 flex-1">
          <span className="shrink-0 mt-0.5">{meta.icon}</span>
          <div className="min-w-0">
            <p className="font-mono text-[11px] uppercase tracking-[0.12em] font-semibold">{meta.label}</p>
            <p className="font-mono text-[11px] leading-relaxed mt-1 text-oct-muted">{meta.line}</p>
          </div>
        </div>

        {canAdmitPool(coverage) && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onAdmitPool(position.poolAddress)}
            className="shrink-0 inline-flex items-center justify-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.12em] border-2 border-oct-accent bg-oct-accent text-white px-3 py-2 transition-colors hover:bg-oct-accent-hover hover:border-oct-accent-hover disabled:opacity-40 disabled:cursor-not-allowed"
            title="Adds this pool to the policy draft. It is not in force until you save."
          >
            <Plus size={12} strokeWidth={3} />
            Add pool to allowlist
          </button>
        )}
      </div>
    </article>
  );
}
