import { ChevronRight, ExternalLink, Loader } from 'lucide-react';
import LpInfoTip from './LpInfoTip';
import LpQuickActions from './LpQuickActions';
import {
  formatFeeTier,
  formatSignedPercent,
  formatSignedUsd,
  formatUsdExact,
  shortAddress,
} from './format';
import {
  COVERAGE_META,
  StatusBadge,
} from './positionChrome';
import {
  formatTokenId,
  positionPairLabel,
  resolveDisplayPnl,
  type DisplayPnl,
  type LineageTileModel,
  type LpLineagePnl,
} from './positions';
import { presentCommand, type LpCommand, type LpCommandAction } from './commands';
import type { RangeStrategy } from './types';

interface LpPositionRowProps {
  entry: LineageTileModel;
  selected: boolean;
  onSelect: () => void;
  command: LpCommand | null;
  commands: readonly LpCommand[];
  pnl: LpLineagePnl | null;
  auditLogAvailable: boolean;
  submitting: LpCommandAction | null;
  commandsUnavailable: boolean;
  onSubmitAction: (action: LpCommandAction) => void;
  autoCompound?: boolean;
  autoRebalance?: boolean;
  rangeStrategy?: RangeStrategy;
}

function PnlCell({ display }: { display: DisplayPnl }) {
  const signed = display.source === 'audit';
  return (
    <div className="min-w-[5.5rem]">
      <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-oct-muted flex items-center gap-1">
        {display.label}
        {display.hint && <LpInfoTip text={display.hint} label={display.label} />}
      </p>
      <p
        className={`font-display text-lg tabular-nums leading-tight ${
          signed && display.valueUsd < 0
            ? 'text-oct-flame'
            : signed && display.valueUsd > 0
              ? 'text-oct-green'
              : 'text-oct-text'
        }`}
      >
        {signed ? formatSignedUsd(display.valueUsd) : formatUsdExact(display.valueUsd)}
      </p>
      {display.percent !== null && (
        <p className="font-mono text-[10px] text-oct-muted tabular-nums">
          {formatSignedPercent(display.percent)}
        </p>
      )}
    </div>
  );
}

export default function LpPositionRow({
  entry,
  selected,
  onSelect,
  command,
  commands,
  pnl,
  auditLogAvailable,
  submitting,
  commandsUnavailable,
  onSubmitAction,
  autoCompound = true,
  autoRebalance = true,
  rangeStrategy = 'narrow',
}: LpPositionRowProps) {
  const { tile, ancestorCount } = entry;
  const { position, coverage, status } = tile;
  const closed = coverage === 'closed';
  const presentation = command ? presentCommand(command) : null;
  const displayPnl = resolveDisplayPnl(pnl, position, auditLogAvailable);
  const meta = COVERAGE_META[coverage];

  return (
    <div
      className={`border-2 border-l-4 bg-oct-surface flex flex-col sm:flex-row sm:items-center gap-3 px-3 py-2.5 min-w-0 transition-colors ${
        selected ? 'border-oct-accent border-l-oct-accent' : `border-oct-border ${meta.rail}`
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex-1 min-w-0 text-left flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className={`font-display text-base tracking-tight truncate ${closed ? 'text-oct-muted' : 'text-oct-text'}`}>
              {positionPairLabel(position)}
            </h4>
            <StatusBadge status={status} compact />
          </div>
          <p className="font-mono text-[10px] text-oct-muted mt-0.5 truncate">
            {formatFeeTier(position.feeTierBps)} · {formatTokenId(position.tokenId)} ·{' '}
            {shortAddress(position.poolAddress)}
            {ancestorCount > 0 && (
              <span className="ml-2">· {ancestorCount} earlier</span>
            )}
          </p>
          {!closed && (
            <p className="font-mono text-[10px] text-oct-muted mt-0.5 truncate">
              Auto compound {autoCompound ? 'on' : 'off'} · Auto rebalance {autoRebalance ? 'on' : 'off'}
              {autoRebalance ? ` (${rangeStrategy})` : ''}
            </p>
          )}
        </div>

        {!closed && (
          <div className="flex items-end gap-4 sm:gap-6 shrink-0 flex-wrap">
            <div className="min-w-[4.5rem]">
              <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-oct-muted">Value</p>
              <p className="font-display text-lg tabular-nums text-oct-text leading-tight">
                {formatUsdExact(position.valueUsd)}
              </p>
            </div>
            <div className="min-w-[4.5rem]">
              <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-oct-muted">Fees</p>
              <p className="font-display text-lg tabular-nums text-oct-text leading-tight">
                {formatUsdExact(position.unclaimedFeesUsd)}
              </p>
            </div>
            <PnlCell display={displayPnl} />
          </div>
        )}
      </button>

      {presentation?.inFlight ? (
        <div className="flex items-center gap-1.5 shrink-0 px-2 py-1 border-2 border-oct-accent bg-oct-accent-dim">
          <Loader size={11} className="text-oct-accent animate-spin" />
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-oct-accent truncate max-w-[8rem]">
            {presentation.headline}
          </span>
        </div>
      ) : !closed ? (
        <LpQuickActions
          tokenId={position.tokenId}
          coverage={coverage}
          commands={commands}
          submitting={submitting}
          apiUnavailable={commandsUnavailable}
          onSubmit={onSubmitAction}
        />
      ) : null}

      <button
        type="button"
        onClick={onSelect}
        className="shrink-0 inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.12em] text-oct-muted hover:text-oct-accent border-2 border-oct-border-bright px-2 py-1.5"
        title="Open position detail"
      >
        <ExternalLink size={11} />
        Detail
        <ChevronRight size={12} className={selected ? 'text-oct-accent' : ''} />
      </button>
    </div>
  );
}
