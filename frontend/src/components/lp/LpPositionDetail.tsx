import { useEffect } from 'react';
import { Info, ShieldCheck, ShieldOff, X } from 'lucide-react';
import { formatFeeTier, formatUsdExact } from './format';
import {
  formatTokenId,
  isPoolInDraft,
  positionPairLabel,
  type PositionTileModel,
} from './positions';
import { CoverageBanner, MoneyCell, RangeBar, StatusBadge } from './positionChrome';
import { describeFeeAccrual, feeAccrual, type LpCommand, type LpCommandAction } from './commands';
import LpPositionActions from './LpPositionActions';
import LpPositionHistorySlot from './LpPositionHistorySlot';
import { LP_PANEL_TITLE } from './styles';

/**
 * The position dashboard — one position, everything known about it, and the
 * controls that act on it.
 *
 * A drawer rather than an inline expansion: the grid exists to be scanned, and
 * an accordion that pushes half of it below the fold every time a tile is
 * opened defeats the thing the grid was rebuilt for. The drawer leaves the grid
 * intact underneath and closes back to exactly the same scroll position.
 *
 * The one thing it deliberately covers is the page's Save bar, so the coverage
 * switch below restates the unsaved state in place rather than relying on a
 * footer the operator cannot see while the drawer is open.
 */

function AddressRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-oct-muted">{label}</p>
      <p className="font-mono text-[10px] text-oct-text break-all leading-relaxed">{value || '—'}</p>
    </div>
  );
}

export interface LpPositionDetailProps {
  tile: PositionTileModel;
  /** The unsaved allowlist the page is editing. */
  draftAllowlist: readonly string[];
  /**
   * Writes the pool into (or out of) `draft.allowedPools` — the SAME draft the
   * pool picker edits, committed by the SAME Save. There is no second save path
   * here on purpose.
   */
  onSetCoverage: (poolAddress: string, covered: boolean) => void;
  /** True when the policy draft cannot be edited at all. Gates the switch only. */
  policyDisabled: boolean;
  commands: LpCommand[];
  submitting: LpCommandAction | null;
  submitError: string | null;
  conflict: string | null;
  commandsUnavailable: boolean;
  commandsError: string | null;
  onSubmitAction: (action: LpCommandAction) => void;
  onClose: () => void;
}

export default function LpPositionDetail({
  tile,
  draftAllowlist,
  onSetCoverage,
  policyDisabled,
  commands,
  submitting,
  submitError,
  conflict,
  commandsUnavailable,
  commandsError,
  onSubmitAction,
  onClose,
}: LpPositionDetailProps) {
  const { position, coverage, status, geometry } = tile;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const inDraft = isPoolInDraft(draftAllowlist, position.poolAddress);
  // `isAllowlisted` is the SAVED policy. The switch shows the draft; this is
  // what makes the gap between them visible instead of implied.
  const unsaved = inDraft !== position.isAllowlisted;
  const accrual = feeAccrual(position);
  const closed = coverage === 'closed';

  return (
    <div className="fixed inset-0 z-[100] flex" role="dialog" aria-modal="true" aria-label="Position detail">
      {/* Same scrim the console's other modals use — a token-derived one would
          be cream-on-cream in the light theme and read as no scrim at all. */}
      <button
        type="button"
        aria-label="Close position detail"
        onClick={onClose}
        className="flex-1 bg-black/70 cursor-default"
      />

      <aside className="w-full max-w-2xl h-full bg-oct-panel border-l-2 border-oct-accent flex flex-col min-h-0">
        <div className="shrink-0 px-4 py-3 border-b-2 border-oct-border bg-oct-surface-raised flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className={`font-display text-xl tracking-tight ${closed ? 'text-oct-muted' : 'text-oct-text'}`}>
                {positionPairLabel(position)}
              </h3>
              <StatusBadge status={status} />
            </div>
            <p className="font-mono text-[10px] text-oct-muted mt-1 truncate">
              {position.platform || 'unknown dex'} · {formatFeeTier(position.feeTierBps)} fee tier ·{' '}
              {formatTokenId(position.tokenId)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 p-1.5 border-2 border-oct-border-bright text-oct-muted hover:text-oct-text hover:border-oct-text transition-colors"
          >
            <X size={14} strokeWidth={2.5} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-4">
          {/* Coverage — the policy channel, with its switch inside the banner
              that explains it, so flipping it and reading what it now means are
              the same glance. */}
          <CoverageBanner coverage={coverage}>
            <div className="shrink-0 flex flex-col items-end gap-1">
              <button
                type="button"
                disabled={policyDisabled || closed}
                onClick={() => onSetCoverage(position.poolAddress, !inDraft)}
                aria-pressed={inDraft}
                className={`inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.12em] border-2 px-3 py-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  inDraft
                    ? 'border-oct-accent bg-oct-accent text-white hover:bg-oct-accent-hover hover:border-oct-accent-hover'
                    : 'border-oct-border-bright text-oct-muted hover:text-oct-text hover:border-oct-text'
                }`}
                title={
                  inDraft
                    ? 'Removes this pool from the policy draft. Not in force until you save.'
                    : 'Adds this pool to the policy draft. Not in force until you save.'
                }
              >
                {inDraft ? <ShieldCheck size={12} strokeWidth={2.5} /> : <ShieldOff size={12} strokeWidth={2.5} />}
                Automation {inDraft ? 'on' : 'off'}
              </button>
              {unsaved && (
                <p className="font-mono text-[10px] text-oct-yellow text-right max-w-[13rem] leading-snug">
                  Unsaved. Close this panel and Save the policy for it to take effect.
                </p>
              )}
            </div>
          </CoverageBanner>

          {!closed && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <MoneyCell
                label="Position value"
                value={formatUsdExact(position.valueUsd)}
                sub="Both tokens, at the provider's cached quote."
              />
              <MoneyCell
                label="Unclaimed fees"
                value={formatUsdExact(position.unclaimedFeesUsd)}
                sub={describeFeeAccrual(accrual, coverage)}
              />
            </div>
          )}

          <div className="border-2 border-oct-border bg-oct-surface px-4 py-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-oct-muted mb-2">Range</p>
            <RangeBar
              geometry={geometry}
              status={position.status}
              minPrice={position.minPrice}
              maxPrice={position.maxPrice}
              currentPrice={position.currentPrice}
            />
          </div>

          <LpPositionHistorySlot />

          <div className="border-2 border-oct-border bg-oct-surface px-4 py-3">
            {commandsUnavailable ? (
              <p className="font-mono text-[11px] text-oct-muted leading-relaxed">
                This backend has no manual-actions API yet, so there is nothing to queue against. The
                automation still acts on this position according to the policy.
              </p>
            ) : (
              <>
                {commandsError && (
                  <p className="font-mono text-[11px] text-oct-yellow leading-relaxed mb-3">
                    Could not read this position's action history: {commandsError}. Any action queued earlier may
                    still be running — check before queueing another.
                  </p>
                )}
                <LpPositionActions
                  position={position}
                  coverage={coverage}
                  commands={commands}
                  submitting={submitting}
                  submitError={submitError}
                  conflict={conflict}
                  apiUnavailable={commandsUnavailable}
                  onSubmit={onSubmitAction}
                />
              </>
            )}
          </div>

          <div className="border-2 border-oct-border bg-oct-surface">
            <div className="px-4 py-2 border-b-2 border-oct-border">
              <h4 className={LP_PANEL_TITLE}>Identity</h4>
            </div>
            <div className="px-4 py-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <AddressRow label={`Token 0 · ${position.token0?.symbol || '???'}`} value={position.token0?.address} />
              <AddressRow label={`Token 1 · ${position.token1?.symbol || '???'}`} value={position.token1?.address} />
              <AddressRow label="Pool" value={position.poolAddress} />
              <AddressRow label="Position token id" value={formatTokenId(position.tokenId)} />
              <AddressRow label="Platform" value={position.platform} />
              <AddressRow label="Fee tier" value={formatFeeTier(position.feeTierBps)} />
            </div>
          </div>

          {/* Said once, at the bottom, exactly as on the panel. See plan §3. */}
          <div className="flex items-start gap-2">
            <Info size={11} strokeWidth={2} className="text-oct-muted shrink-0 mt-0.5" />
            <p className="font-mono text-[10px] text-oct-muted leading-relaxed">
              Value, fees and current price come from cached provider quotes; the current price can sit up to 66
              ticks off the pool's own state. The automation reads the chain directly for every decision and never
              trades on these numbers — including for an action queued from this panel.
            </p>
          </div>
        </div>
      </aside>
    </div>
  );
}
