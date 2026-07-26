import { ChevronRight, Loader } from 'lucide-react';
import { formatFeeTier, formatUsdExact, shortAddress } from './format';
import { formatTokenId, positionPairLabel, type PositionTileModel } from './positions';
import { COVERAGE_META, CoverageStrip, MoneyCell, RangeBar, StatusBadge } from './positionChrome';
import { presentCommand, type LpCommand } from './commands';

/**
 * One position, compressed to the five things worth scanning ten of at once:
 * pair, fee tier, value, unclaimed fees, and the two channels — status badge
 * (market) and coverage rail plus strip (policy).
 *
 * Everything else moved to the detail view. The old stacked card put the full
 * coverage sentence on every row, which read well for one position and became a
 * wall of prose at five.
 *
 * The whole tile is one button. A card with a "view" affordance in the corner
 * invites a hunt for the hit target; the target is the card.
 */

interface LpPositionTileProps {
  tile: PositionTileModel;
  selected: boolean;
  onSelect: () => void;
  /** Newest command for this position, if the commands API returned one. */
  command: LpCommand | null;
}

export default function LpPositionTile({ tile, selected, onSelect, command }: LpPositionTileProps) {
  const { position, coverage, status, geometry } = tile;
  const closed = coverage === 'closed';
  const presentation = command ? presentCommand(command) : null;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-haspopup="dialog"
      aria-expanded={selected}
      className={`group text-left border-2 border-l-4 bg-oct-surface flex flex-col min-w-0 transition-colors ${
        selected
          ? 'border-oct-accent border-l-oct-accent'
          : // The rail is the coverage channel and is set from the same map the
            // detail view reads, so the two can never disagree. `hover:` only
            // touches the other three sides — a hover that recoloured the rail
            // would briefly restate the policy fact as something it is not.
            `border-oct-border hover:border-oct-border-bright ${COVERAGE_META[coverage].rail}`
      }`}
    >
      <div className="px-3 pt-2.5 pb-2 flex items-start justify-between gap-2 min-w-0">
        <div className="min-w-0">
          <h4
            className={`font-display text-base leading-tight tracking-tight truncate ${
              closed ? 'text-oct-muted' : 'text-oct-text'
            }`}
          >
            {positionPairLabel(position)}
          </h4>
          <p className="font-mono text-[10px] text-oct-muted mt-0.5 truncate">
            {formatFeeTier(position.feeTierBps)} · {formatTokenId(position.tokenId)} ·{' '}
            {shortAddress(position.poolAddress)}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <StatusBadge status={status} compact />
          <ChevronRight
            size={13}
            strokeWidth={2.5}
            className={selected ? 'text-oct-accent' : 'text-oct-muted group-hover:text-oct-text'}
          />
        </div>
      </div>

      {!closed && (
        <div className="px-3 pb-2 grid grid-cols-2 gap-2 min-w-0">
          <MoneyCell label="Value" value={formatUsdExact(position.valueUsd)} size="sm" />
          <MoneyCell label="Unclaimed" value={formatUsdExact(position.unclaimedFeesUsd)} size="sm" />
        </div>
      )}

      <div className="px-3 pb-2 mt-auto">
        <RangeBar
          geometry={geometry}
          status={position.status}
          minPrice={position.minPrice}
          maxPrice={position.maxPrice}
          currentPrice={position.currentPrice}
          compact
        />
      </div>

      {/* An in-flight action outranks the coverage strip for this one tile:
          "something is happening to this position right now" is the more urgent
          of the two, and it is temporary. Coverage returns when it settles. */}
      {presentation?.inFlight ? (
        <div className="px-3 py-1.5 border-t-2 border-oct-accent bg-oct-accent-dim flex items-center gap-1.5 min-w-0">
          <Loader size={11} strokeWidth={2.5} className="text-oct-accent shrink-0 animate-spin" />
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] font-semibold text-oct-accent truncate">
            {presentation.headline}
          </p>
        </div>
      ) : (
        <CoverageStrip coverage={coverage} />
      )}
    </button>
  );
}
