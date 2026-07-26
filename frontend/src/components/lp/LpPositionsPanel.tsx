import { useMemo, useState } from 'react';
import { Info, Layers, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react';
import LpPositionTile from './LpPositionTile';
import LpPositionDetail from './LpPositionDetail';
import LpSafeAddressField, { type LpSafeAddressFieldProps } from './LpSafeAddressField';
import { formatUsdExact, shortAddress } from './format';
import { LP_BTN_GHOST, LP_PANEL, LP_PANEL_HEADER, LP_PANEL_TITLE } from './styles';
import {
  buildPositionGrid,
  findTile,
  summarizePositions,
  type LpPositionSkip,
  type LpPositionView,
} from './positions';
import { latestCommandFor, type LpCommandAction } from './commands';
import { useLpCommands } from '../../hooks/useLpCommands';

/**
 * What is actually open, and — the reason this panel exists — whether the
 * automation is doing anything about it.
 *
 * The pool picker answers "which pools may the automation enter". It cannot
 * answer "is the money I already have in here being looked after", because a
 * position can predate the policy, or sit in a pool that never cleared the
 * TVL/volume filters and so never appeared in the picker at all. On a chain a
 * few weeks old that second case is the common one, not the exotic one — which
 * is why every uncovered position can be admitted from its own detail panel
 * rather than sending the operator back to a table their pool may never show up
 * in.
 *
 * SHAPE: a dense grid of tiles, with a drawer for the one you click. The panel
 * used to render a full stacked card per position, which read beautifully for
 * one and became several screens of repeated prose at five. The grid is for
 * seeing ten at once; the drawer is where the sentences live.
 */

function formatFetchedAt(iso: string | null): string | null {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return null;
  return new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function SkippedNotice({ skipped }: { skipped: LpPositionSkip[] }) {
  return (
    <div className="px-4 py-2 border-b-2 border-oct-border font-mono text-[11px] text-oct-yellow leading-relaxed">
      {skipped.length} position{skipped.length === 1 ? '' : 's'} returned by the provider could not be read
      and {skipped.length === 1 ? 'is' : 'are'} not listed below. A shrinking list can mean upstream data
      changed shape rather than that a position closed.
      <span className="text-oct-muted">
        {' '}
        ({skipped.slice(0, 3).map((entry) => `${entry.identifier}: ${entry.reason}`).join(' · ')}
        {skipped.length > 3 ? ' …' : ''})
      </span>
    </div>
  );
}

export interface LpPositionsPanelProps {
  positions: LpPositionView[];
  loading: boolean;
  error: string | null;
  /** The backend has no positions route yet. */
  unavailable: boolean;
  /** False until a Safe address is saved — a setup step, not a fault. */
  configured: boolean;
  /** The Safe the server actually read. */
  safeAddress: string | null;
  skipped: LpPositionSkip[];
  fetchedAt: string | null;
  /** The allowlist being edited on the page, so unsaved ticks read as unsaved. */
  draftAllowlist: string[];
  /**
   * Adds or removes a pool in the policy draft. Uses the page's existing save
   * cycle — one draft, one Save, one meaning of "unsaved".
   */
  onSetPoolCoverage: (poolAddress: string, covered: boolean) => void;
  onRefresh: () => void;
  safeAddressField: LpSafeAddressFieldProps;
  /** True when the policy draft cannot be edited — gates the coverage switch only. */
  disabled?: boolean;
  /**
   * The policy could not be read, so coverage is unknown rather than absent.
   * See `PositionCoverage.unknown` — this must not render as a coverage gap.
   */
  policyReadFailed?: boolean;
}

export default function LpPositionsPanel({
  positions,
  loading,
  error,
  unavailable,
  configured,
  safeAddress,
  skipped,
  fetchedAt,
  draftAllowlist,
  onSetPoolCoverage,
  onRefresh,
  safeAddressField,
  disabled = false,
  policyReadFailed = false,
}: LpPositionsPanelProps) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const summary = useMemo(
    () => summarizePositions(positions, draftAllowlist, policyReadFailed),
    [positions, draftAllowlist, policyReadFailed],
  );

  // Order, coverage, status and range geometry, resolved once. See
  // `buildPositionGrid` for why status and coverage stay disjoint.
  const tiles = useMemo(
    () => buildPositionGrid(positions, draftAllowlist, policyReadFailed),
    [positions, draftAllowlist, policyReadFailed],
  );

  // Derived, not stored. A refresh that drops the selected position closes the
  // drawer by itself rather than leaving a panel open over data that is gone.
  const selected = useMemo(() => findTile(tiles, selectedKey), [tiles, selectedKey]);
  const selectedTokenId = selected?.position.tokenId ?? null;

  // Scoped to the open position when there is one — that is the request the
  // action buttons depend on, and it is the documented shape. With nothing
  // selected it reads the recent set so tiles can mark work already in flight.
  const commands = useLpCommands(selectedTokenId, configured && !unavailable && !error);

  const selectedCommands = useMemo(
    () =>
      selectedTokenId === null
        ? []
        : commands.commands.filter((command) => command.tokenId === selectedTokenId),
    [commands.commands, selectedTokenId],
  );

  const fetchedLabel = formatFetchedAt(fetchedAt);
  const showGrid = configured && !unavailable && !error && positions.length > 0;

  const submitAction = (action: LpCommandAction) => {
    if (!selected) return;
    void commands.submit(selected.position.tokenId, action, selected.position.poolAddress);
  };

  const closeDetail = () => {
    setSelectedKey(null);
    commands.clearSubmitFeedback();
  };

  return (
    <section className={LP_PANEL}>
      <div className={LP_PANEL_HEADER}>
        <div className="flex items-center gap-2 min-w-0">
          <Layers size={14} strokeWidth={2} className="text-oct-accent shrink-0" />
          <h3 className={LP_PANEL_TITLE}>Open positions</h3>
        </div>
        <div className="flex items-center gap-3">
          {configured && !unavailable && (
            <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-oct-muted">
              <span className="text-oct-text">{summary.open}</span> open
              <span className="mx-1.5">→</span>
              <span className={summary.uncovered > 0 ? 'text-oct-flame' : 'text-oct-accent'}>
                {summary.managed}
              </span>{' '}
              managed
              {summary.closed > 0 && <span className="ml-1.5">· {summary.closed} closed</span>}
            </p>
          )}
          <button type="button" onClick={onRefresh} className={LP_BTN_GHOST} title="Re-read positions">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {/* The Safe address is a settings row, not a policy field — it is gated by
          its own API's availability, never by whether the policy can be saved. */}
      <LpSafeAddressField {...safeAddressField} />

      {unavailable && (
        <p className="px-4 py-6 font-mono text-xs text-oct-muted text-center">
          The positions API is not available on this backend yet.
        </p>
      )}

      {/* Not configured is a setup step, deliberately not styled as an error:
          nothing has gone wrong, the page simply has not been told where to look. */}
      {!unavailable && !configured && !error && (
        <div className="px-4 py-8 text-center">
          <p className="font-mono text-sm text-oct-text">Tell us your Safe address to see your positions.</p>
          <p className="font-mono text-[11px] text-oct-muted mt-2 max-w-lg mx-auto leading-relaxed">
            Paste the Safe that holds your LP positions into the field above and save it. This page reads that
            account and nothing else — it does not grant the automation any access it does not already have
            through the on-chain Module.
          </p>
        </div>
      )}

      {error && !unavailable && (
        <div className="px-4 py-3 font-mono text-xs text-oct-flame flex items-center justify-between gap-3">
          <span>{error}</span>
          <button type="button" onClick={onRefresh} className="text-oct-accent underline hover:no-underline">
            Retry
          </button>
        </div>
      )}

      {/* The coverage headline. Stated in money, because "3 pools not
          allowlisted" is a config fact and "$1,240 nothing is tending" is the
          consequence — and the consequence is what gets acted on. */}
      {configured && !unavailable && !error && summary.open > 0 && (
        <div
          className={`px-4 py-3 border-b-2 ${
            summary.uncovered > 0
              ? 'border-oct-flame bg-oct-surface-raised'
              : 'border-oct-border bg-oct-accent-dim'
          }`}
        >
          {summary.uncovered > 0 ? (
            <div className="flex items-start gap-2">
              <TriangleAlert size={14} strokeWidth={2} className="text-oct-flame shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="font-mono text-[11px] leading-relaxed text-oct-text">
                  <span className="text-oct-flame font-semibold uppercase tracking-[0.1em]">
                    {formatUsdExact(summary.uncoveredValueUsd)} is not being managed.
                  </span>{' '}
                  {summary.uncovered} of {summary.open} open position
                  {summary.open === 1 ? '' : 's'} — out of {formatUsdExact(summary.valueUsd)} total — are not
                  compounded or rebalanced by the automation.
                </p>
                <p className="font-mono text-[11px] text-oct-muted leading-relaxed mt-1">
                  {summary.admittablePools.length > 0
                    ? `${summary.admittablePools.length} pool${
                        summary.admittablePools.length === 1 ? '' : 's'
                      } can be admitted by opening the position below and switching automation on — a pool that never met the TVL and volume filters will never appear in the picker, so this is the only place to reach it.`
                    : 'These pools are already allowlisted; the automation is not acting on the positions themselves.'}
                  {summary.pending > 0 &&
                    ` ${summary.pending} ticked but not yet saved — nothing changes until you save.`}
                </p>
              </div>
            </div>
          ) : (
            <p className="font-mono text-[11px] leading-relaxed text-oct-text inline-flex items-start gap-2">
              <ShieldCheck size={14} strokeWidth={2} className="text-oct-accent shrink-0 mt-0.5" />
              <span>
                <span className="text-oct-accent font-semibold uppercase tracking-[0.1em]">
                  All {summary.open} open position{summary.open === 1 ? '' : 's'} managed.
                </span>{' '}
                {formatUsdExact(summary.valueUsd)} deployed, {formatUsdExact(summary.unclaimedFeesUsd)} in
                unclaimed fees, every pool allowlisted and saved.
              </span>
            </p>
          )}
        </div>
      )}

      {configured && summary.outOfRange > 0 && !unavailable && !error && (
        <p className="px-4 py-2 border-b-2 border-oct-border font-mono text-[11px] text-oct-yellow leading-relaxed">
          {summary.outOfRange} position{summary.outOfRange === 1 ? '' : 's'} holding{' '}
          {formatUsdExact(summary.outOfRangeValueUsd)} {summary.outOfRange === 1 ? 'is' : 'are'} out of range
          and earning nothing.
        </p>
      )}

      {skipped.length > 0 && !unavailable && <SkippedNotice skipped={skipped} />}

      {loading && positions.length === 0 && !error && configured && (
        <div className="px-4 py-4 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-40 border-2 border-oct-border bg-oct-surface-raised animate-pulse" />
          ))}
        </div>
      )}

      {configured && !loading && !error && !unavailable && positions.length === 0 && (
        <div className="px-4 py-8 text-center">
          <p className="font-mono text-sm text-oct-text">No open LP positions in this Safe.</p>
          <p className="font-mono text-[11px] text-oct-muted mt-2 max-w-lg mx-auto leading-relaxed">
            {safeAddress ? `Read from ${shortAddress(safeAddress)}. ` : ''}
            Nothing is deployed, so nothing is at risk. Positions appear here once the automation opens one, or
            once you open one yourself from any wallet that controls this Safe.
          </p>
        </div>
      )}

      {showGrid && (
        <div className="px-4 py-4 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 items-stretch">
          {tiles.map((tile) => (
            <LpPositionTile
              key={tile.key}
              tile={tile}
              selected={tile.key === selectedKey}
              onSelect={() => setSelectedKey(tile.key)}
              command={latestCommandFor(commands.commands, tile.position.tokenId)}
            />
          ))}
        </div>
      )}

      {/* Display-grade, and said once, at the bottom. A banner would imply the
          numbers are untrustworthy; they are simply not the ones the automation
          trades on. See LP_AUTOMATION_PLAN.md §3. */}
      {configured && !unavailable && (
        <div className="px-4 py-2.5 border-t-2 border-oct-border flex items-start gap-2">
          <Info size={11} strokeWidth={2} className="text-oct-muted shrink-0 mt-0.5" />
          <p className="font-mono text-[10px] text-oct-muted leading-relaxed">
            Values, fees and current price are indicative — they come from cached provider quotes and the
            current price can sit up to 66 ticks off the pool's own state. The automation never trades on
            these; it reads the chain directly for every decision.
            {fetchedLabel && <span> Last read {fetchedLabel}.</span>}
          </p>
        </div>
      )}

      {selected && (
        <LpPositionDetail
          tile={selected}
          draftAllowlist={draftAllowlist}
          onSetCoverage={onSetPoolCoverage}
          policyDisabled={disabled}
          commands={selectedCommands}
          submitting={commands.submitting}
          submitError={commands.submitError}
          conflict={commands.conflict}
          commandsUnavailable={commands.unavailable}
          commandsError={commands.error}
          onSubmitAction={submitAction}
          onClose={closeDetail}
        />
      )}
    </section>
  );
}
