import { useCallback, useEffect, useState, useMemo, Fragment } from 'react';
import { Trash2, PanelLeftOpen } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { useCallerQuality } from '../hooks/useCallerQuality';
import { buildContractUrl } from '../utils/contractUrl';
import { openContractSource } from '../utils/contractSource';
import ConfirmModal from './ConfirmModal';
import ContractFeedToolbar, { type ContractViewMode, type ContractChainFilter } from './contract-feed/ContractFeedToolbar';
import { ContractRow, ContractCard } from './contract-feed/ContractFeedRows';
import TokenHoldersDrawer, { type HoldersTarget } from './fomo/TokenHoldersDrawer';
import type { ContractEntry } from '../types';
import { groupContractFeedByAddress } from '../utils/contractFeedGrouping';
import {
  filterGoodCallerRows,
  filterTopCallerRows,
  groupHistoryOldestFirst,
  groupSummaryItem,
  sortContractGroups,
  type ContractSortMode,
} from '../utils/contractFeedView';
import { buildFirstCallerIndex } from '../utils/firstCaller';

// Chains FOMO indexes. A detection on any other EVM chain still opens the
// drawer — we just omit the hint and let the backend probe.
const FOMO_EVM_CHAINS = new Set(['eth', 'bsc', 'base', 'robinhood']);

function holdersTargetFor(entry: ContractEntry): HoldersTarget {
  if (entry.chain === 'sol') return { address: entry.address, network: 'sol' };
  const slug = entry.evmChain?.toLowerCase();
  return { address: entry.address, network: slug && FOMO_EVM_CHAINS.has(slug) ? slug : null };
}

/** localStorage key for the "hide caller-band chips" preference (shared by every feed pane). */
const HIDE_BADGES_STORAGE_KEY = 'oct-contract-feed-hide-badges';

interface ContractDashboardProps {
  embedded?: boolean;
  /**
   * "Top Callers Feed" mode. Locks the feed to only the absolute best callers —
   * earned `elite` band or a manual `trusted` tier — and turns on the per-row
   * caller analytics readout. A deliberately low-volume, saved-pane variant of
   * the same feed, so a user can run it alongside their normal Contract Feed.
   */
  topOnly?: boolean;
}

export default function ContractDashboard({ embedded = false, topOnly = false }: ContractDashboardProps) {
  const contracts = useAppStore((s) => s.contracts);
  const fetchContracts = useAppStore((s) => s.fetchContracts);
  const deleteContract = useAppStore((s) => s.deleteContract);
  const deleteAllContracts = useAppStore((s) => s.deleteAllContracts);
  const config = useAppStore((s) => s.config);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const [search, setSearch] = useState('');
  const [chainFilter, setChainFilter] = useState<ContractChainFilter>('all');
  const [copiedAddr, setCopiedAddr] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ContractViewMode>('table');
  const [showDeleteAll, setShowDeleteAll] = useState(false);
  const [holdersTarget, setHoldersTarget] = useState<HoldersTarget | null>(null);
  const [revealMuted, setRevealMuted] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [goodOnly, setGoodOnly] = useState(false);
  // Persisted, unlike the other toolbar state: hiding the band chips is a lasting
  // taste choice about row density, not a per-session investigation like the
  // sort override or the muted reveal.
  const [hideBadges, setHideBadgesState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(HIDE_BADGES_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const setHideBadges = (value: boolean) => {
    setHideBadgesState(value);
    try {
      localStorage.setItem(HIDE_BADGES_STORAGE_KEY, value ? '1' : '0');
    } catch {
      // storage unavailable — the toggle still works for this session
    }
  };
  // `null` = follow the Settings toggle. A click here overrides it for this
  // session only, so flipping the sort to answer "is the feed broken?" doesn't
  // quietly rewrite a saved preference.
  const [sortOverride, setSortOverride] = useState<ContractSortMode | null>(null);
  const { qualityForContract, rankingEnabled, showMuted } = useCallerQuality();
  const sortMode: ContractSortMode = sortOverride ?? (rankingEnabled ? 'ranked' : 'recent');

  useEffect(() => {
    fetchContracts();
  }, [fetchContracts]);

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

  // Every row callback below is identity-stable (useCallback) so the memoized
  // rows can skip re-rendering on unrelated store churn — an enrichment frame
  // for one address must not re-paint the other few hundred rows.
  // Rows pass their own (mixed-case) address; group keys are lowercased.
  const toggleGroupExpanded = useCallback((address: string) => {
    const key = address.toLowerCase();
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleCopy = useCallback((addr: string) => {
    navigator.clipboard.writeText(addr);
    setCopiedAddr(addr);
    setTimeout(() => setCopiedAddr(null), 1500);
  }, []);

  const handleOpen = useCallback((addr: string, evmChain?: string) => {
    if (!config) return;
    const url = buildContractUrl(addr, config.contractLinkTemplates, evmChain);
    window.open(url, '_blank');
  }, [config]);

  const handleOpenDiscord = useCallback((entry: ContractEntry) => {
    openContractSource(entry, config);
  }, [config]);

  const handleDelete = useCallback((entry: ContractEntry) => {
    deleteContract(entry.messageId, entry.address);
  }, [deleteContract]);

  const handleShowHolders = useCallback((entry: ContractEntry) => {
    setHoldersTarget(holdersTargetFor(entry));
  }, []);

  // Relative timestamps ("5m ago") used to refresh as a side effect of the
  // constant full-feed re-renders. With rows memoized, refresh them on a
  // deliberate 30s tick instead — one bounded re-render sweep per tick.
  const [timeTick, setTimeTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTimeTick((t) => t + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  const handleDeleteAll = () => {
    setShowDeleteAll(true);
  };

  const showFull = config?.showFullContractAddress ?? false;
  const evmColor = config?.evmAddressColor ?? '#fee75c';
  const solColor = config?.solAddressColor ?? '#14f195';

  return (
    <div className="h-full flex flex-col min-h-0 bg-oct-bg overflow-hidden">
      {/* Header */}
      <div className="oct-headerbar shrink-0">
        {!embedded && (
        <div className="flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-3">
          {sidebarCollapsed && (
            <button
              onClick={toggleSidebar}
              className="oct-icon-btn p-1.5 shrink-0"
              title="Show sidebar"
            >
              <PanelLeftOpen size={18} />
            </button>
          )}
          <h2 className="oct-section-title uppercase tracking-wide text-base sm:text-lg">
            {topOnly ? 'Top Callers' : 'Contract Feed'}
          </h2>
          <span className="text-oct-muted text-[13px] font-mono font-semibold tabular-nums">{filteredEntries.length}</span>
          <div className="flex-1" />
          {contracts.length > 0 && (
            <button
              onClick={handleDeleteAll}
              className="flex items-center gap-1 px-2.5 py-1 rounded-oct-sm text-[11px] font-mono font-bold uppercase text-oct-accent hover:bg-oct-accent hover:text-white hover:shadow-oct-glow-accent transition-all border border-oct-accent/60 shrink-0"
              title="Delete all contracts"
            >
              <Trash2 size={12} />
              <span className="hidden sm:inline">Clear All</span>
            </button>
          )}
        </div>
        )}
        <ContractFeedToolbar
          viewMode={viewMode}
          onViewMode={setViewMode}
          chainFilter={chainFilter}
          onChainFilter={setChainFilter}
          search={search}
          onSearch={setSearch}
          sortMode={sortMode}
          onSortMode={setSortOverride}
          sortFromSettings={sortOverride === null && rankingEnabled}
          goodOnly={goodOnly}
          onGoodOnly={setGoodOnly}
          unratedShown={unratedShown}
          goodHidden={goodHidden}
          showMuted={showMuted}
          mutedCount={mutedCount}
          revealMuted={revealMuted}
          onRevealMuted={setRevealMuted}
          hideBadges={hideBadges}
          onHideBadges={setHideBadges}
          topOnly={topOnly}
        />
      </div>

      {/* Content */}
      <div
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain"
        style={{ overflowAnchor: 'none' }}
      >
        {filteredEntries.length === 0 ? (
          topOnly ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-6 max-w-md mx-auto">
              <p className="oct-eyebrow mb-2">Top Callers</p>
              <p className="text-sm text-oct-text/90 mb-1.5">
                Only your elite &amp; trusted callers show here — that&rsquo;s the point.
              </p>
              <p className="text-xs text-oct-muted leading-relaxed">
                {contracts.length === 0
                  ? 'Nothing detected yet. This feed stays quiet on purpose — a call only lands here once it comes from a caller with an earned Elite band or one you’ve marked Trusted.'
                  : topHidden > 0
                    ? `${topHidden} recent call${topHidden === 1 ? '' : 's'} came from callers who aren’t elite or trusted, so they’re held out. Mark a caller Trusted, or wait for one to earn an Elite band, to see them here.`
                    : 'No calls from your best callers right now.'}
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-center px-6">
              <p className="oct-eyebrow mb-2">Contracts</p>
              <p className="text-sm text-oct-muted">
                {contracts.length === 0
                  ? 'No contracts detected yet'
                  : goodOnly && goodHidden > 0
                    ? `Every match is from a mixed, slop or muted caller — ${goodHidden} hidden by the good-callers filter`
                    : mutedCount > 0
                      ? 'Every match is from a muted caller'
                      : 'No contracts match your filters'}
              </p>
            </div>
          )
        ) : viewMode === 'table' ? (
          <div className="divide-y divide-oct-border/50">
            {groupedRows.map((group) => {
              // The group's newest scan — what a collapsed row summarises.
              // Derived rather than taken as items[0] so the summary timestamp
              // is the newest scan under any sort mode.
              const head = groupSummaryItem(group);
              const scanCount = group.items.length;
              const isExpanded = scanCount > 1 && expandedGroups.has(group.address);
              // Chronological (oldest-first) history of everything folded into
              // this group, excluding the head row already shown above it.
              const history = scanCount > 1 ? groupHistoryOldestFirst(group) : [];
              return (
                <Fragment key={`group-${group.address}-${head.entry.messageId}`}>
                  <ContractRow
                    entry={head.entry}
                    quality={head.quality}
                    evmColor={evmColor}
                    solColor={solColor}
                    showFull={showFull}
                    isCopied={copiedAddr === head.entry.address}
                    onCopy={handleCopy}
                    onOpen={handleOpen}
                    onOpenDiscord={handleOpenDiscord}
                    onDelete={handleDelete}
                    onShowHolders={handleShowHolders}
                    forceIsNew={group.hasNew}
                    scanCount={scanCount}
                    isExpanded={isExpanded}
                    onToggleExpand={scanCount > 1 ? toggleGroupExpanded : undefined}
                    firstCall={firstCallerIndex.get(group.address)}
                    markUnrated={goodOnly}
                    hideBandBadge={hideBadges}
                    showStats={topOnly}
                    timeTick={timeTick}
                  />
                  {isExpanded && (
                    <div className="pl-3 sm:pl-6 border-l-2 border-oct-border/60 ml-3 sm:ml-6">
                      {history.map(({ entry, quality }) => (
                        <ContractRow
                          key={`${entry.messageId}-${entry.address}`}
                          entry={entry}
                          quality={quality}
                          evmColor={evmColor}
                          solColor={solColor}
                          showFull={showFull}
                          isCopied={copiedAddr === entry.address}
                          onCopy={handleCopy}
                          onOpen={handleOpen}
                          onOpenDiscord={handleOpenDiscord}
                          onDelete={handleDelete}
                          onShowHolders={handleShowHolders}
                          firstCall={firstCallerIndex.get(group.address)}
                          markUnrated={goodOnly}
                          hideBandBadge={hideBadges}
                          isSubRow
                          timeTick={timeTick}
                        />
                      ))}
                    </div>
                  )}
                </Fragment>
              );
            })}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2 sm:gap-3 p-3 sm:p-4">
            {groupedRows.map((group) => {
              const head = groupSummaryItem(group);
              const scanCount = group.items.length;
              return (
              <ContractCard
                key={`group-${group.address}-${head.entry.messageId}`}
                entry={head.entry}
                quality={head.quality}
                evmColor={evmColor}
                solColor={solColor}
                isCopied={copiedAddr === head.entry.address}
                onCopy={handleCopy}
                onOpen={handleOpen}
                onOpenDiscord={handleOpenDiscord}
                onDelete={handleDelete}
                onShowHolders={handleShowHolders}
                forceIsNew={group.hasNew}
                scanCount={scanCount}
                firstCall={firstCallerIndex.get(group.address)}
                markUnrated={goodOnly}
                hideBandBadge={hideBadges}
                showStats={topOnly}
                timeTick={timeTick}
              />
              );
            })}
          </div>
        )}
      </div>

      <ConfirmModal
        open={showDeleteAll}
        title="Delete All Contracts"
        message="This will permanently delete all contracts. This cannot be undone."
        confirmLabel="Delete All"
        onConfirm={() => {
          setShowDeleteAll(false);
          deleteAllContracts();
        }}
        onCancel={() => setShowDeleteAll(false)}
      />

      <TokenHoldersDrawer target={holdersTarget} onClose={() => setHoldersTarget(null)} />
    </div>
  );
}
