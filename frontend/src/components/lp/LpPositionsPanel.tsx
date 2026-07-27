import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Download, Layers, Plus, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react';
import LpPositionRow from './LpPositionRow';
import LpPositionDetail from './LpPositionDetail';
import LpEnterForm from './LpEnterForm';
import LpInfoTip from './LpInfoTip';
import type { LpEnterPool } from './enter';
import { formatSignedUsd, formatUsdExact, shortAddress } from './format';
import { LP_BTN_GHOST, LP_BTN_PRIMARY, LP_MONEY_VALUE, LP_PANEL, LP_PANEL_HEADER, LP_PANEL_TITLE, LP_STAT, LP_STAT_MUTED } from './styles';
import type { RangeStrategy } from './types';
import {
  buildLineageGrid,
  findLineageTile,
  summarizePositions,
  type LpLineageLink,
  type LpLineagePnl,
  type LpPositionSkip,
  type LpPositionView,
} from './positions';
import { latestCommandFor, type LpCommandAction } from './commands';
import { useLpCommands } from '../../hooks/useLpCommands';
import { downloadLpTaxExport } from '../../hooks/useLpTaxExport';

/**
 * What is actually open, and — the reason this panel exists — whether the
 * automation is doing anything about it.
 *
 * One grid row per open position; closed rebalance predecessors collapse into
 * the detail drawer only. See LP_DASHBOARD_PLAN.md item 1.
 */

function formatFetchedAt(iso: string | null): string | null {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return null;
  return new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const INDICATIVE_VALUES_TIP =
  'Values, fees and current price are indicative — cached provider quotes, up to ~66 ticks off chain. The automation reads the chain directly and never trades on these numbers.';

const UNCOVERED_MECHANISM_TIP =
  'A pool that never met the TVL and volume filters will never appear in the Pools picker — admit it from the position detail instead. Ticked-but-unsaved pools change nothing until you Save the policy.';

const PORTFOLIO_PNL_TIP =
  'Net return sums audit-backed PnL for open positions where cost basis is known. Positions without a recorded basis are omitted from the total.';

function PortfolioStat({
  label,
  value,
  sub,
  signed = false,
  positive,
}: {
  label: string;
  value: string;
  sub?: string;
  signed?: boolean;
  positive?: boolean | null;
}) {
  const tone =
    signed && positive === true
      ? 'text-oct-green'
      : signed && positive === false
        ? 'text-oct-flame'
        : 'text-oct-text';

  return (
    <div className="min-w-0">
      <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-oct-muted">{label}</p>
      <p className={`${LP_MONEY_VALUE} text-lg leading-tight ${tone}`}>{value}</p>
      {sub && <p className="font-mono text-[10px] text-oct-muted leading-snug">{sub}</p>}
    </div>
  );
}

function PortfolioSummaryBanner({
  summary,
  auditLogAvailable,
}: {
  summary: ReturnType<typeof summarizePositions>;
  auditLogAvailable: boolean;
}) {
  const netPnlPartial =
    summary.netPnlKnownCount > 0 && summary.netPnlUnknownCount > 0;
  const netPnlValue =
    summary.netPnlUsd === null
      ? '—'
      : formatSignedUsd(summary.netPnlUsd);
  const netPnlSub =
    summary.netPnlUsd === null
      ? auditLogAvailable
        ? 'Pending audit basis'
        : 'Set LP_AUDIT_LOG_PATH'
      : netPnlPartial
        ? `${summary.netPnlKnownCount} of ${summary.open} positions`
        : undefined;

  return (
    <div className="px-4 py-3 border-b-2 border-oct-border bg-oct-surface grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3">
      <PortfolioStat label="Deployed" value={formatUsdExact(summary.valueUsd)} />
      <PortfolioStat label="Unclaimed fees" value={formatUsdExact(summary.unclaimedFeesUsd)} />
      <PortfolioStat
        label="Net return"
        value={netPnlValue}
        sub={netPnlSub}
        signed={summary.netPnlUsd !== null}
        positive={summary.netPnlUsd === null ? null : summary.netPnlUsd > 0 ? true : summary.netPnlUsd < 0 ? false : null}
      />
      <div className="min-w-0 flex items-start gap-1">
        <PortfolioStat
          label="Gas paid"
          value={summary.gasPaidUsd > 0 ? formatUsdExact(summary.gasPaidUsd) : '—'}
          sub={summary.gasPaidUsd > 0 ? 'Lifetime, open positions' : undefined}
        />
        {auditLogAvailable && (
          <LpInfoTip text={PORTFOLIO_PNL_TIP} label="About portfolio totals" />
        )}
      </div>
    </div>
  );
}

function SkippedNotice({ skipped }: { skipped: LpPositionSkip[] }) {
  return (
    <div className="px-4 py-2 border-b-2 border-oct-border font-mono text-[11px] text-oct-yellow leading-relaxed">
      {skipped.length} position{skipped.length === 1 ? '' : 's'} returned by the provider could not be read
      and {skipped.length === 1 ? 'is' : 'are'} not listed below.
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
  unavailable: boolean;
  configured: boolean;
  safeAddress: string | null;
  skipped: LpPositionSkip[];
  fetchedAt: string | null;
  draftAllowlist: string[];
  onSetPoolCoverage: (poolAddress: string, covered: boolean) => void;
  draftAutoCompound: boolean;
  draftAutoRebalance: boolean;
  savedAutoCompound: boolean;
  savedAutoRebalance: boolean;
  draftRangeStrategy: RangeStrategy;
  onSetAutoCompound: (enabled: boolean) => void;
  onSetAutoRebalance: (enabled: boolean) => void;
  onRefresh: () => void;
  onOpenSettings: () => void;
  /** Switch to the Pools tab — the enter form links here to allowlist a pool. */
  onOpenPools: () => void;
  /** Saved-allowlist pools with known token metadata, selectable in the enter form. */
  enterPools: LpEnterPool[];
  disabled?: boolean;
  policyReadFailed?: boolean;
  pnlByLineage?: Record<string, LpLineagePnl>;
  lineageLinks?: LpLineageLink[];
  auditLogAvailable?: boolean;
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
  draftAutoCompound,
  draftAutoRebalance,
  savedAutoCompound,
  savedAutoRebalance,
  draftRangeStrategy,
  onSetAutoCompound,
  onSetAutoRebalance,
  onRefresh,
  onOpenSettings,
  onOpenPools,
  enterPools,
  disabled = false,
  policyReadFailed = false,
  pnlByLineage = {},
  lineageLinks = [],
  auditLogAvailable = false,
}: LpPositionsPanelProps) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [closedFarmsOpen, setClosedFarmsOpen] = useState(false);
  const [showEnter, setShowEnter] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const summary = useMemo(
    () => summarizePositions(positions, draftAllowlist, policyReadFailed, pnlByLineage),
    [positions, draftAllowlist, policyReadFailed, pnlByLineage],
  );

  const { live, closedOnly } = useMemo(
    () => buildLineageGrid(positions, draftAllowlist, policyReadFailed, lineageLinks),
    [positions, draftAllowlist, policyReadFailed, lineageLinks],
  );

  const allTiles = useMemo(() => [...live, ...closedOnly], [live, closedOnly]);

  const selected = useMemo(
    () => findLineageTile(allTiles, selectedKey),
    [allTiles, selectedKey],
  );
  const selectedTokenId = selected?.tile.position.tokenId ?? null;

  const commands = useLpCommands(null, configured && !unavailable && !error, {
    onSettled: () => void onRefresh(),
  });

  const selectedCommands = useMemo(
    () =>
      selectedTokenId === null
        ? []
        : commands.commands.filter((command) => command.tokenId === selectedTokenId),
    [commands.commands, selectedTokenId],
  );

  const fetchedLabel = formatFetchedAt(fetchedAt);
  const showGrid = configured && !unavailable && !error && positions.length > 0;

  const submitAction = (action: LpCommandAction, tokenId?: string, poolAddress?: string) => {
    const target = selected ?? null;
    const id = tokenId ?? target?.tile.position.tokenId;
    const pool = poolAddress ?? target?.tile.position.poolAddress;
    if (!id || !pool) return;
    void commands.submit(id, action, pool);
  };

  const closeDetail = () => {
    setSelectedKey(null);
    commands.clearSubmitFeedback();
  };

  const handleExport = async () => {
    setExporting(true);
    setExportError(null);
    const result = await downloadLpTaxExport('csv');
    if (!result.ok) setExportError(result.error ?? 'Export failed');
    setExporting(false);
  };

  return (
    <section className={LP_PANEL}>
      <div className={LP_PANEL_HEADER}>
        <div className="flex items-center gap-2 min-w-0">
          <Layers size={14} strokeWidth={2} className="text-oct-accent shrink-0" />
          <h3 className={LP_PANEL_TITLE}>Open positions</h3>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {configured && !unavailable && (
            <p className={LP_STAT_MUTED}>
              <span className={LP_STAT}>{summary.open}</span> open
              <span className="mx-1.5">→</span>
              <span className={summary.uncovered > 0 ? 'text-oct-flame font-semibold' : 'text-oct-accent font-semibold'}>
                {summary.managed}
              </span>{' '}
              managed
              {summary.closed > 0 && <span className="ml-1.5">· {summary.closed} closed</span>}
            </p>
          )}
          {configured && !unavailable && (
            <button
              type="button"
              onClick={() => setShowEnter(true)}
              className={LP_BTN_PRIMARY}
              title="Open a new LP position from OCT"
            >
              <Plus size={12} strokeWidth={2.5} />
              Add position
            </button>
          )}
          {configured && !unavailable && auditLogAvailable && (
            <button
              type="button"
              onClick={() => void handleExport()}
              className={LP_BTN_GHOST}
              title="Download LP activity for tax/accounting"
              disabled={exporting}
            >
              <Download size={12} />
              {exporting ? 'Exporting…' : 'Export CSV'}
            </button>
          )}
          <button type="button" onClick={onRefresh} className={LP_BTN_GHOST} title="Re-read positions">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {exportError && (
        <p className="px-4 py-2 border-b-2 border-oct-border font-mono text-[11px] text-oct-flame">
          {exportError}
        </p>
      )}

      {configured && safeAddress && (
        <div className="px-4 py-2 border-b-2 border-oct-border flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <p className="font-mono text-[11px] text-oct-muted">
            Reading <span className="text-oct-text">{shortAddress(safeAddress)}</span>
            {' · '}
            <button
              type="button"
              onClick={onOpenSettings}
              className="text-oct-accent underline hover:no-underline"
            >
              change in Settings
            </button>
          </p>
          {fetchedLabel && (
            <span className="inline-flex items-center gap-1 font-mono text-[10px] text-oct-muted ml-auto">
              Last read {fetchedLabel} · refreshes every 30s
              <LpInfoTip text={INDICATIVE_VALUES_TIP} label="About displayed values" />
            </span>
          )}
        </div>
      )}

      {unavailable && (
        <p className="px-4 py-6 font-mono text-xs text-oct-muted text-center">
          The positions API is not available on this backend yet.
        </p>
      )}

      {!unavailable && !configured && !error && (
        <div className="px-4 py-8 text-center">
          <p className="font-mono text-sm text-oct-text">Tell us your Safe address to see your positions.</p>
          <button
            type="button"
            onClick={onOpenSettings}
            className="mt-3 font-mono text-[11px] uppercase tracking-[0.12em] text-oct-accent underline hover:no-underline"
          >
            Open Settings
          </button>
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

      {configured && !unavailable && !error && summary.open > 0 && (
        <PortfolioSummaryBanner summary={summary} auditLogAvailable={auditLogAvailable} />
      )}

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
              <p className="font-mono text-xs leading-relaxed text-oct-text flex items-start gap-1.5 min-w-0">
                <span>
                  <span className="text-oct-flame font-semibold uppercase tracking-[0.08em]">
                    {formatUsdExact(summary.uncoveredValueUsd)} is not being managed.
                  </span>{' '}
                  {summary.uncovered} of {summary.open} open position
                  {summary.open === 1 ? '' : 's'} — out of {formatUsdExact(summary.valueUsd)} total.
                  {summary.pending > 0 &&
                    ` ${summary.pending} ticked but not saved.`}
                </span>
                <LpInfoTip text={UNCOVERED_MECHANISM_TIP} label="Why a position may be uncovered" />
              </p>
            </div>
          ) : (
            <p className="font-mono text-xs leading-relaxed text-oct-text inline-flex items-start gap-2">
              <ShieldCheck size={14} strokeWidth={2} className="text-oct-accent shrink-0 mt-0.5" />
              <span>
                <span className="text-oct-accent font-semibold uppercase tracking-[0.08em]">
                  All {summary.open} open position{summary.open === 1 ? '' : 's'} managed.
                </span>{' '}
                {formatUsdExact(summary.valueUsd)} deployed · {formatUsdExact(summary.unclaimedFeesUsd)} unclaimed
              </span>
            </p>
          )}
        </div>
      )}

      {configured && summary.outOfRange > 0 && !unavailable && !error && (
        <p className="px-4 py-2 border-b-2 border-oct-border font-mono text-[11px] text-oct-yellow leading-relaxed">
          {summary.outOfRange} position{summary.outOfRange === 1 ? '' : 's'} holding{' '}
          {formatUsdExact(summary.outOfRangeValueUsd)} {summary.outOfRange === 1 ? 'is' : 'are'} out of range.
        </p>
      )}

      {skipped.length > 0 && !unavailable && <SkippedNotice skipped={skipped} />}

      {loading && positions.length === 0 && !error && configured && (
        <div className="px-4 py-4 space-y-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="h-16 border-2 border-oct-border bg-oct-surface-raised animate-pulse" />
          ))}
        </div>
      )}

      {configured && !loading && !error && !unavailable && positions.length === 0 && (
        <div className="px-4 py-8 text-center">
          <p className="font-mono text-sm text-oct-text">No LP positions in this Safe.</p>
          {safeAddress && (
            <p className="font-mono text-[11px] text-oct-muted mt-2">
              Read from {shortAddress(safeAddress)}.
            </p>
          )}
        </div>
      )}

      {showGrid && live.length > 0 && (
        <div className="px-4 py-3 space-y-2">
          {live.map((entry) => (
            <LpPositionRow
              key={entry.key}
              entry={entry}
              selected={entry.tile.key === selectedKey || entry.key === selectedKey}
              onSelect={() => setSelectedKey(entry.tile.key)}
              command={latestCommandFor(commands.commands, entry.tile.position.tokenId)}
              commands={commands.commands}
              pnl={pnlByLineage[entry.key] ?? null}
              auditLogAvailable={auditLogAvailable}
              submitting={commands.submitting}
              commandsUnavailable={commands.unavailable}
              onSubmitAction={(action) =>
                submitAction(action, entry.tile.position.tokenId, entry.tile.position.poolAddress)
              }
              autoCompound={draftAutoCompound}
              autoRebalance={draftAutoRebalance}
              rangeStrategy={draftRangeStrategy}
            />
          ))}
        </div>
      )}

      {showGrid && closedOnly.length > 0 && (
        <div className="border-t-2 border-oct-border">
          <button
            type="button"
            onClick={() => setClosedFarmsOpen((open) => !open)}
            className="w-full px-4 py-2.5 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.12em] text-oct-muted hover:text-oct-text hover:bg-oct-surface-raised transition-colors"
          >
            {closedFarmsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            Closed farms ({closedOnly.length})
          </button>
          {closedFarmsOpen && (
            <div className="px-4 pb-4 space-y-2">
              {closedOnly.map((entry) => (
                <LpPositionRow
                  key={entry.key}
                  entry={entry}
                  selected={entry.tile.key === selectedKey || entry.key === selectedKey}
                  onSelect={() => setSelectedKey(entry.tile.key)}
                  command={latestCommandFor(commands.commands, entry.tile.position.tokenId)}
                  commands={commands.commands}
                  pnl={pnlByLineage[entry.key] ?? null}
                  auditLogAvailable={auditLogAvailable}
                  submitting={commands.submitting}
                  commandsUnavailable={commands.unavailable}
                  onSubmitAction={(action) =>
                    submitAction(action, entry.tile.position.tokenId, entry.tile.position.poolAddress)
                  }
                  autoCompound={draftAutoCompound}
                  autoRebalance={draftAutoRebalance}
                  rangeStrategy={draftRangeStrategy}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {selected && (
        <LpPositionDetail
          tile={selected.tile}
          ancestors={selected.lineage.ancestors}
          pnl={pnlByLineage[selected.key] ?? null}
          auditLogAvailable={auditLogAvailable}
          draftAllowlist={draftAllowlist}
          onSetCoverage={onSetPoolCoverage}
          draftAutoCompound={draftAutoCompound}
          draftAutoRebalance={draftAutoRebalance}
          savedAutoCompound={savedAutoCompound}
          savedAutoRebalance={savedAutoRebalance}
          draftRangeStrategy={draftRangeStrategy}
          onSetAutoCompound={onSetAutoCompound}
          onSetAutoRebalance={onSetAutoRebalance}
          policyDisabled={disabled}
          commands={selectedCommands}
          submitting={commands.submitting}
          submitError={commands.submitError}
          conflict={commands.conflict}
          commandsUnavailable={commands.unavailable}
          commandsError={commands.error}
          onSubmitAction={(action) => submitAction(action)}
          onClose={closeDetail}
          onRefresh={onRefresh}
        />
      )}

      {showEnter && (
        <LpEnterForm
          pools={enterPools}
          defaultRangeStrategy={draftRangeStrategy}
          enabled={configured && !unavailable && !error}
          onClose={() => setShowEnter(false)}
          onSubmitted={onRefresh}
          onOpenPools={() => {
            setShowEnter(false);
            onOpenPools();
          }}
        />
      )}
    </section>
  );
}
