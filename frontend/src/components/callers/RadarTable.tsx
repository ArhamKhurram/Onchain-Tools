// The Radar: every contract the feed has seen, aggregated per token. This file
// is composition only — the pieces live beside it:
//
//   radarRows.ts       buildRadar + the pure row helpers
//   radarSort.ts       sort keys, the window filter and the comparator
//   radarApi.ts        DexScreener / token-snapshot fetches
//   useRadarLiveMc.ts  the refresh callbacks (the liveMc map itself lives here)
//   RadarToolbar.tsx   the header bar (window pills, settings, refresh)
//   RadarHeaderRow.tsx the <thead> row
//   RadarTableRow.tsx  one memoized row
//
// PERF CONTRACT (#268, #270): rows are React.memo'd and keyed by `r.address`;
// `buildRadar` is fed the previous build so unchanged rows keep their object
// identity; every callback handed to a row is reference-stable. Anything that
// hands a fresh object or closure to RadarTableRow per commit undoes both PRs.
// Rows are a live stream and are never animated.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { useSort } from '../../hooks/useSort';
import { useFomoHolderOverlap } from '../../hooks/useFomoHolderOverlap';
import {
  buildConvergenceIndex,
  getSignalConvergenceWindowMs,
} from '../../utils/signalConvergence';
import { type MentionWindow } from './RadarSettings';
import {
  RADAR_COLUMN_ORDER,
  loadVisibleRadarColumns,
  saveVisibleRadarColumns,
  type RadarColumnId,
} from './radarColumns';
import { useNetworkFirstScans } from '../../hooks/useNetworkFirstScans';
import { useCallerQuality } from '../../hooks/useCallerQuality';
import { buildRadar, type LiveMc, type RadarRow } from './radarRows';
import {
  RADAR_ASC_FIRST,
  filterRadarWindow,
  sortRadarRows,
  type RadarSortKey,
  type RadarWindowFilter,
} from './radarSort';
import { useRadarLiveMc } from './useRadarLiveMc';
import RadarToolbar from './RadarToolbar';
import RadarHeaderRow from './RadarHeaderRow';
import RadarTableRow from './RadarTableRow';
import { resolveRadarEmojiRules, type RadarMultipleEmojiRule } from '@oct/shared';

export default function RadarTable() {
  const contracts = useAppStore((s) => s.contracts);
  const fomoTrades = useAppStore((s) => s.fomoTrades);
  const config = useAppStore((s) => s.config);
  const convergenceWindowMs = getSignalConvergenceWindowMs(config);
  const convergenceWindowMinutes = config?.signalConvergenceWindowMinutes ?? 30;
  const updateConfig = useAppStore((s) => s.updateConfig);
  const fetchContracts = useAppStore((s) => s.fetchContracts);
  const { overlaps } = useFomoHolderOverlap(contracts);
  const [liveMc, setLiveMc] = useState<Record<string, LiveMc>>({});
  const [windowFilter, setWindowFilter] = useState<RadarWindowFilter>('24h');
  const [mentionWindow, setMentionWindow] = useState<MentionWindow>('15m');
  const { sortKey, sortDir, onSort: handleSort } = useSort<RadarSortKey>('recent', 'desc', RADAR_ASC_FIRST);
  const [copiedAddr, setCopiedAddr] = useState<string | null>(null);
  const [visibleColumns, setVisibleColumns] = useState<Set<RadarColumnId>>(() => loadVisibleRadarColumns());
  const [revealMuted, setRevealMuted] = useState(false);
  // Global bands, not room-scoped: the Radar aggregates every room's calls
  // into one table, so a row's band must reflect the caller's whole record.
  const { qualityForContractGlobal, showMuted } = useCallerQuality();

  // One buildRadar pass per (contracts, quality) change; the muted counter and
  // the visible table both derive from it rather than each paying for their own.
  // Feeding the previous build back in preserves row object identity for rows
  // whose visible data didn't change, so the memoized row components can skip
  // them — a single new contract re-renders one row, not the whole table.
  const prevRadarRows = useRef<RadarRow[]>([]);
  const radarRows = useMemo(() => {
    const next = buildRadar(contracts, qualityForContractGlobal, prevRadarRows.current);
    prevRadarRows.current = next;
    return next;
  }, [contracts, qualityForContractGlobal]);

  // One convergence pass per data change, O(1) per row at render time. The
  // old per-row findConvergenceForAddress rescanned every contract (and its
  // trades) for every row on every commit — liveMc ticks included.
  const convergenceByAddress = useMemo(
    () => buildConvergenceIndex(contracts, fomoTrades, convergenceWindowMs),
    [contracts, fomoTrades, convergenceWindowMs],
  );

  // Anonymous network pool first-seen for the tokens on the radar — one
  // debounced, batched call; inert outside hosted mode (the hook self-gates).
  // Sorted so a mere reorder of the table never changes the request set.
  const radarAddresses = useMemo(
    () => [...new Set(radarRows.map((r) => r.address))].sort().slice(0, 100),
    [radarRows],
  );
  const networkScans = useNetworkFirstScans(radarAddresses);

  // Counted off the unfiltered set so the toggle still shows a number once the
  // rows it refers to have been filtered out.
  const mutedOnlyCount = useMemo(
    () => radarRows.filter((r) => r.allMuted).length,
    [radarRows],
  );

  const activeColumns = useMemo(
    () => RADAR_COLUMN_ORDER.filter((col) => visibleColumns.has(col)),
    [visibleColumns],
  );

  const handleVisibleColumnsChange = (cols: Set<RadarColumnId>) => {
    setVisibleColumns(cols);
    saveVisibleRadarColumns(cols);
  };

  // Threshold→emoji markers for the × column. Unlike the column set (a
  // per-device localStorage preference) these live in AppConfig, so the ladder
  // follows the account across devices in hosted mode.
  const emojiRules = useMemo(
    () => resolveRadarEmojiRules(config?.radarMultipleEmojiRules),
    [config?.radarMultipleEmojiRules],
  );

  const handleEmojiRulesChange = (next: RadarMultipleEmojiRule[]) => {
    updateConfig({ radarMultipleEmojiRules: next }).catch(() => {
      /* config reload restores the last persisted ladder */
    });
  };

  // Stable references so memoized rows don't re-render when unrelated state
  // (spinners, copied flag, live MC) changes.
  const handleCopy = useCallback((address: string) => {
    navigator.clipboard.writeText(address);
    setCopiedAddr(address.toLowerCase());
    setTimeout(() => setCopiedAddr(null), 1500);
  }, []);

  useEffect(() => {
    fetchContracts();
  }, [fetchContracts]);

  const rows = useMemo(() => {
    const all = radarRows.filter(
      // Mentions still count muted callers inside the row; what's dropped here is
      // a token *only* muted callers ever touched.
      (r) => !r.allMuted || !showMuted || revealMuted,
    );
    return sortRadarRows(filterRadarWindow(all, windowFilter), {
      sortKey,
      sortDir,
      mentionWindow,
      liveMc,
      overlaps,
      networkScans,
    });
  }, [
    radarRows, windowFilter, mentionWindow, sortKey, sortDir, liveMc, overlaps,
    showMuted, revealMuted, networkScans,
  ]);

  const { refreshing, refreshingRow, agoTick, refreshOne, refreshAll } =
    useRadarLiveMc(rows, windowFilter, setLiveMc);

  return (
    <div className="h-full flex flex-col min-h-0 bg-oct-bg overflow-hidden">
      <RadarToolbar
        windowFilter={windowFilter}
        onWindowFilterChange={setWindowFilter}
        mentionWindow={mentionWindow}
        onMentionWindowChange={setMentionWindow}
        visibleColumns={visibleColumns}
        onVisibleColumnsChange={handleVisibleColumnsChange}
        emojiRules={emojiRules}
        onEmojiRulesChange={handleEmojiRulesChange}
        mutedOnlyCount={mutedOnlyCount}
        showMuted={showMuted}
        revealMuted={revealMuted}
        onRevealMutedToggle={() => setRevealMuted((v) => !v)}
        rowCount={rows.length}
        refreshing={refreshing}
        onRefreshAll={refreshAll}
      />

      <div className="flex-1 min-h-0 overflow-auto overscroll-contain" style={{ overflowAnchor: 'none' }}>
        <table className="w-full text-left border-collapse min-w-[900px]">
          <thead className="oct-thead sticky top-0 z-10">
            <RadarHeaderRow
              activeColumns={activeColumns}
              mentionWindow={mentionWindow}
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
            />
          </thead>
          <tbody>
            {rows.map((r) => {
              const key = r.address.toLowerCase();
              return (
                <RadarTableRow
                  key={r.address}
                  r={r}
                  live={liveMc[key]}
                  overlap={overlaps[key]}
                  netScan={networkScans[r.address]}
                  convergenceTrade={convergenceByAddress.get(key) ?? null}
                  convergenceWindowMinutes={convergenceWindowMinutes}
                  activeColumns={activeColumns}
                  mentionWindow={mentionWindow}
                  emojiRules={emojiRules}
                  isCopied={copiedAddr === key}
                  isRefreshing={refreshingRow === key}
                  agoTick={agoTick}
                  onCopy={handleCopy}
                  onRefresh={refreshOne}
                />
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={2 + activeColumns.length} className="px-roomy py-gutter text-center">
                  <p className="oct-eyebrow mb-cozy">Radar</p>
                  <p className="type-body text-oct-muted">No tokens in this window. Contracts from Feed will aggregate here.</p>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
