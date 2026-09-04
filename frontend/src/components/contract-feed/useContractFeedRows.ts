// The Contract Feed's derivation pipeline, lifted verbatim out of
// ContractDashboard.tsx: text/chain filter → muted collapse → good/top caller
// filter → same-address grouping + sort → first-caller index. Each stage is
// its own memo so a keystroke in the search box re-runs the cheap head of the
// chain and not the grouping behind it.
import { useMemo } from 'react';
import type { ContractEntry } from '../../types';
import type { CallerQuality } from '../../hooks/useCallerQuality';
import { groupContractFeedByAddress } from '../../utils/contractFeedGrouping';
import {
  filterGoodCallerRows,
  filterTopCallerRows,
  sortContractGroups,
  type ContractSortMode,
} from '../../utils/contractFeedView';
import { buildFirstCallerIndex } from '../../utils/firstCaller';
import type { ContractChainFilter } from './ContractFeedToolbar';

export interface ContractFeedRowsInput {
  contracts: ContractEntry[];
  chainFilter: ContractChainFilter;
  search: string;
  qualityForContract: (entry: ContractEntry) => CallerQuality;
  /** Settings › show muted callers. */
  showMuted: boolean;
  /** This pane's session-only "reveal muted" toggle. */
  revealMuted: boolean;
  goodOnly: boolean;
  topOnly: boolean;
  sortMode: ContractSortMode;
}

export function useContractFeedRows({
  contracts,
  chainFilter,
  search,
  qualityForContract,
  showMuted,
  revealMuted,
  goodOnly,
  topOnly,
  sortMode,
}: ContractFeedRowsInput) {
  const filtered = useMemo(() => {
    let result = contracts;
    if (chainFilter !== 'all') {
      result = result.filter((c) => c.chain === chainFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (c) =>
          c.address.toLowerCase().includes(q) ||
          c.authorName.toLowerCase().includes(q) ||
          c.channelName.toLowerCase().includes(q) ||
          (c.guildName?.toLowerCase().includes(q) ?? false) ||
          (c.tokenName?.toLowerCase().includes(q) ?? false) ||
          (c.tokenSymbol?.toLowerCase().includes(q) ?? false),
      );
    }
    return result;
  }, [contracts, chainFilter, search]);

  const { visible, mutedCount } = useMemo(() => {
    const withQuality = filtered.map((entry) => ({ entry, quality: qualityForContract(entry) }));
    const muted = withQuality.filter((r) => r.quality.tier === 'muted');

    // A muted caller can still be first on a runner, so the default is to collapse
    // them behind a counter rather than drop them — you can always look. Muted rows
    // ride along only when the setting keeps them AND this pane's reveal is on;
    // every other combination hides them.
    const rows = showMuted && revealMuted
      ? withQuality
      : withQuality.filter((r) => r.quality.tier !== 'muted');

    // NOTE: rank ordering deliberately does NOT happen here any more. Sorting
    // rows by rank before grouping shuffled same-address scans out of time
    // order, so a collapsed group's head — the row whose symbol, FDV and
    // timestamp the group is summarised by — stopped being its newest scan.
    // Ranking is applied to the finished groups instead (see `groupedRows`).
    return { visible: rows, mutedCount: muted.length };
  }, [filtered, qualityForContract, showMuted, revealMuted]);

  const {
    rows: qualifiedRows,
    unratedShown,
    hidden: goodHidden,
    topHidden,
  } = useMemo(() => {
    // Top Callers Feed applies its own, far stricter filter (elite + trusted
    // only) that subsumes both the good-callers filter and the muted collapse —
    // a muted or unrated caller can never be "the absolute best".
    if (topOnly) {
      const { rows, hidden } = filterTopCallerRows(visible);
      return { rows, unratedShown: 0, hidden: 0, topHidden: hidden };
    }
    return { ...filterGoodCallerRows(visible, goodOnly), topHidden: 0 };
  }, [visible, goodOnly, topOnly]);

  const filteredEntries = useMemo(() => qualifiedRows.map((r) => r.entry), [qualifiedRows]);

  // Same-address rescans flood the feed (scheduleDexFallback re-broadcasts
  // every ~15s), so collapse consecutive scans of one address into a single
  // group. Grouping runs on the newest-first list, which is what the grouping
  // function expects; the chosen sort is applied to the groups afterwards.
  // See contractFeedGrouping.ts for the window rationale.
  const groupedRows = useMemo(
    () => sortContractGroups(groupContractFeedByAddress(qualifiedRows), sortMode),
    [qualifiedRows, sortMode],
  );

  // Built once over the whole loaded log rather than per row: "who called this
  // first" has to look past the 20-minute rescan group the row belongs to.
  const firstCallerIndex = useMemo(() => buildFirstCallerIndex(contracts), [contracts]);

  return {
    /** Entries that survived every filter, ungrouped — drives the header count. */
    filteredEntries,
    groupedRows,
    firstCallerIndex,
    mutedCount,
    unratedShown,
    goodHidden,
    topHidden,
  };
}
