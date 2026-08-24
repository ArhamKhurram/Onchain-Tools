import { useEffect, useState, useMemo, Fragment } from 'react';
import { ExternalLink, Copy, Check, Trash2, X, MessageSquare, PanelLeftOpen, Send, Users, ChevronDown, ChevronRight, Flag } from 'lucide-react';
import { BAND_LABELS } from '@oct/shared';
import { useAppStore } from '../stores/appStore';
import { useCallerQuality, type CallerQuality } from '../hooks/useCallerQuality';
import {
  BAND_BADGE_CLASS,
  BAND_REACH_NOTE,
  BAND_TITLE,
  callerStatChips,
} from '../utils/callerBandStyle';
import { contractPeakView } from '../utils/contractPeak';
import { buildContractUrl } from '../utils/contractUrl';
import { contractAttribution, isTelegramContract, openContractSource } from '../utils/contractSource';
import { stripDiscordCustomEmoji } from '../utils/discordText';
import ConfirmModal from './ConfirmModal';
import ContractFeedToolbar, { type ContractViewMode, type ContractChainFilter } from './contract-feed/ContractFeedToolbar';
import SignalConvergenceBadge from './SignalConvergenceBadge';
import TokenHoldersDrawer, { type HoldersTarget } from './fomo/TokenHoldersDrawer';
import { useConvergenceForContract } from '../hooks/useSignalConvergence';
import type { ContractEntry } from '../types';
import { colorWithExtraAlpha } from './ColorPickerWithAlpha';
import { groupContractFeedByAddress } from '../utils/contractFeedGrouping';
import {
  filterGoodCallerRows,
  filterTopCallerRows,
  groupHistoryOldestFirst,
  groupSummaryItem,
  sortContractGroups,
  type ContractSortMode,
} from '../utils/contractFeedView';
import {
  buildFirstCallerIndex,
  firstCallerIsElsewhere,
  type FirstCallerResolution,
} from '../utils/firstCaller';

// Chains FOMO indexes. A detection on any other EVM chain still opens the
// drawer — we just omit the hint and let the backend probe.
const FOMO_EVM_CHAINS = new Set(['eth', 'bsc', 'base', 'robinhood']);

function holdersTargetFor(entry: ContractEntry): HoldersTarget {
  if (entry.chain === 'sol') return { address: entry.address, network: 'sol' };
  const slug = entry.evmChain?.toLowerCase();
  return { address: entry.address, network: slug && FOMO_EVM_CHAINS.has(slug) ? slug : null };
}

const EVM_CHAIN_LABELS: Record<string, string> = {
  eth: 'ETH', bsc: 'BNB', base: 'BASE', arb: 'ARB',
  blast: 'BLAST', polygon: 'POLY', avax: 'AVAX', fantom: 'FTM',
  linea: 'LINEA', mantle: 'MANTLE', scroll: 'SCROLL', zksync: 'ZKSYNC',
  sonic: 'SONIC', abstract: 'ABS', berachain: 'BERA',
  pulsechain: 'PLS', tron: 'TRON', hyperliquid: 'HL',
  robinhood: 'HOOD',
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

function contractDisplay(entry: ContractEntry, showFull: boolean) {
  const shortAddr = showFull
    ? entry.address
    : `${entry.address.slice(0, 6)}...${entry.address.slice(-4)}`;
  const ticker = entry.tokenSymbol ? `$${entry.tokenSymbol}` : shortAddr;
  const subtitle = entry.tokenName ?? (entry.tokenSymbol ? shortAddr : null);
  return { shortAddr, ticker, subtitle };
}

/**
 * Tooltip for the "jump to the first caller" action.
 *
 * Deliberately says which of the two claims it can make. `isFirstLogged` means
 * the target really is the address's first detection in this install's log;
 * anything else is only the earliest row still loaded, and says so.
 */
function firstCallerTitle(resolution: FirstCallerResolution): string {
  const { entry, isFirstLogged, skippedUnlinkable } = resolution;
  const where = isTelegramContract(entry) ? 'Telegram' : 'Discord';
  const lead = isFirstLogged
    ? `Open the first call of this CA — ${entry.authorName} on ${where}, ${timeAgo(entry.timestamp)}`
    : `Open the earliest call of this CA still in view — ${entry.authorName} on ${where}, ${timeAgo(entry.timestamp)} (earlier calls may exist outside the loaded feed)`;
  const skipped = skippedUnlinkable
    ? ' An earlier row has no shareable link, so this is the earliest one that can be opened.'
    : '';
  const rickName = entry.firstCallerName ?? resolution.earliest.firstCallerName;
  const rick =
    rickName && rickName !== entry.authorName
      ? ` Rick reports ${rickName} called it first globally — there is no message to open for that.`
      : '';
  return `${lead}.${skipped}${rick}`;
}

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
    // them behind a counter rather than drop them — you can always look.
    let rows = showMuted && !revealMuted
      ? withQuality.filter((r) => r.quality.tier !== 'muted')
      : withQuality;
    if (!showMuted) rows = withQuality.filter((r) => r.quality.tier !== 'muted');

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

  const toggleGroupExpanded = (address: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(address)) next.delete(address);
      else next.add(address);
      return next;
    });
  };

  const handleCopy = (addr: string) => {
    navigator.clipboard.writeText(addr);
    setCopiedAddr(addr);
    setTimeout(() => setCopiedAddr(null), 1500);
  };

  const handleOpen = (addr: string, evmChain?: string) => {
    if (!config) return;
    const url = buildContractUrl(addr, config.contractLinkTemplates, evmChain);
    window.open(url, '_blank');
  };

  const handleOpenDiscord = (entry: ContractEntry) => {
    openContractSource(entry, config);
  };

  const handleDelete = (entry: ContractEntry) => {
    deleteContract(entry.messageId, entry.address);
  };

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
                    onShowHolders={(e) => setHoldersTarget(holdersTargetFor(e))}
                    forceIsNew={group.hasNew}
                    scanCount={scanCount}
                    isExpanded={isExpanded}
                    onToggleExpand={scanCount > 1 ? () => toggleGroupExpanded(group.address) : undefined}
                    firstCall={firstCallerIndex.get(group.address)}
                    markUnrated={goodOnly}
                    showStats={topOnly}
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
                          onShowHolders={(e) => setHoldersTarget(holdersTargetFor(e))}
                          firstCall={firstCallerIndex.get(group.address)}
                          markUnrated={goodOnly}
                          isSubRow
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
                onShowHolders={(e) => setHoldersTarget(holdersTargetFor(e))}
                forceIsNew={group.hasNew}
                scanCount={scanCount}
                firstCall={firstCallerIndex.get(group.address)}
                markUnrated={goodOnly}
                showStats={topOnly}
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

interface ContractItemProps {
  entry: ContractEntry;
  quality?: CallerQuality;
  evmColor: string;
  solColor: string;
  showFull?: boolean;
  isCopied: boolean;
  onCopy: (addr: string) => void;
  onOpen: (addr: string, evmChain?: string) => void;
  onOpenDiscord: (entry: ContractEntry) => void;
  onDelete: (entry: ContractEntry) => void;
  onShowHolders: (entry: ContractEntry) => void;
  /**
   * Overrides the NEW/RESCAN badge computed from `entry.firstSeen`. Used
   * when this row is the head of a collapsed rescan group: the group should
   * keep showing NEW if any scan folded into it was the original
   * detection, even though the head item itself (the latest scan) is a
   * rescan.
   */
  forceIsNew?: boolean;
  /** Total scans collapsed into this row, when it's a group head (>1). */
  scanCount?: number;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  /**
   * Earliest openable call of this address across the whole loaded log, when
   * one exists. Renders the "jump to the first caller" action — see
   * `firstCaller.ts` for what "first" is allowed to mean.
   */
  firstCall?: FirstCallerResolution;
  /**
   * Tag unrated callers explicitly. On while the good-callers filter is
   * active: that filter keeps unrated callers on purpose, so the rows it let
   * through unvouched-for have to look different from the vetted ones.
   */
  markUnrated?: boolean;
  /** Renders as a condensed history row nested under a group's head. */
  isSubRow?: boolean;
  /**
   * Show the caller's inline analytics readout (hit rates, scored-call count,
   * median reach). On in the Top Callers Feed — the "see analytics" half of the
   * ask — so each row says *why* the caller earned a place in the pane.
   */
  showStats?: boolean;
}

/** Small pill shared by the chain / NEW / band markers on a feed row. */
const ROW_PILL = 'text-[10px] font-bold px-1.5 py-0.5 rounded-full shrink-0 uppercase font-mono';

/**
 * The caller's band, always rendered — the CA feed's whole point is telling a
 * strong caller's scan from a random one at a glance, so every row wears a
 * label, including an honest dashed UNRATED for callers without enough scored
 * history (never a fake neutral score). Bands are *reach*, not realized
 * profit — peak vs MC@call over sampled peaks — and the tooltips keep saying
 * so. The chat feed keeps its quieter notable-bands-only markers; this feed is
 * where every row has to answer "who called this, and are they any good?".
 */
function CallerBandBadge({ quality, markUnrated }: { quality?: CallerQuality; markUnrated?: boolean }) {
  if (!quality) return null;
  if (quality.band === 'unrated') {
    const filterNote = markUnrated
      ? ' Kept in the filtered feed on purpose — a new caller with a real edge starts here — but unproven, not vetted.'
      : '';
    return (
      <span
        className={`${ROW_PILL} border border-dashed border-oct-border-bright text-oct-muted`}
        title={`${BAND_TITLE.unrated}${filterNote}`}
      >
        {BAND_LABELS.unrated}
      </span>
    );
  }
  // The caller's own numbers ride along in the tooltip, so "how strong?" is
  // one hover away without costing the row any width.
  const stats = callerStatChips(quality.score)
    .map((chip) => chip.label)
    .join(' · ');
  const title = `${BAND_TITLE[quality.band]}${stats ? `\n\nThis caller: ${stats}` : ''}`;
  return (
    <span className={`${ROW_PILL} ${BAND_BADGE_CLASS[quality.band]}`} title={title}>
      {BAND_LABELS[quality.band]}
    </span>
  );
}

/**
 * "MC@call → peak · X" readout for a feed row — what the token did after the
 * call. Everything here is an observed floor (peaks are sampled), and the
 * multiple only appears when the peak was seen at-or-after this row's call —
 * a run that predates the call is never attributed to it (see
 * `contractPeakView`). Renders nothing when there's nothing honest to say.
 */
function PeakReadout({ entry }: { entry: ContractEntry }) {
  const view = contractPeakView(entry);
  if (!view) return null;
  const title = view.belowCall
    ? 'Highest market cap observed since this call is below the MC at call — as far as sampling saw, it has only bled. Peaks are sampled every few minutes, so this is a floor, not an exact ATH.'
    : 'Peak market cap observed since this call, against the MC at call. Peaks are sampled every few minutes, so both figures are floors — the true high may be higher, never lower.';
  return (
    <span className="font-mono text-[12px] shrink-0 tabular-nums" title={title}>
      <span className="text-oct-muted">→ </span>
      <span className={view.belowCall ? 'text-oct-muted' : 'text-oct-green font-semibold'}>
        {view.peakDisplay}
      </span>
      {view.multipleDisplay && (
        <span
          className={`ml-1.5 ${
            view.multiple != null && view.multiple >= 2 ? 'text-oct-green font-bold' : 'text-oct-text/80'
          }`}
        >
          {view.multipleDisplay}
        </span>
      )}
    </span>
  );
}

/**
 * Inline caller analytics for a feed row — the numbers behind the band.
 *
 * Reads straight off the persisted `CallerScore` that `useCallerQuality` already
 * threads onto every row's `quality`, so it needs no extra fetch. A manually
 * trusted caller with no scored history shows the trust itself rather than a row
 * of dashes. Every figure is reach, not realized profit — see `BAND_REACH_NOTE`.
 */
function CallerStatsReadout({ quality }: { quality?: CallerQuality }) {
  if (!quality) return null;
  const chips = callerStatChips(quality.score);

  if (chips.length === 0) {
    if (quality.tier === 'trusted') {
      return (
        <span
          className="font-mono text-[10px] text-oct-live/90"
          title="You marked this caller Trusted — shown here by your own choice, not an earned band yet."
        >
          Trusted · manual
        </span>
      );
    }
    return null;
  }

  return (
    <span
      className="flex items-center flex-wrap gap-x-1.5 gap-y-0.5 font-mono text-[10px] text-oct-muted tabular-nums"
      title={BAND_REACH_NOTE}
    >
      {chips.map((chip, i) => (
        <span key={chip.label} className="flex items-center gap-1.5" title={chip.title}>
          {i > 0 && <span className="text-oct-border-bright">·</span>}
          <span>{chip.label}</span>
        </span>
      ))}
    </span>
  );
}

function ContractRow({
  entry,
  quality,
  evmColor,
  solColor,
  showFull = false,
  isCopied,
  onCopy,
  onOpen,
  onOpenDiscord,
  onDelete,
  onShowHolders,
  forceIsNew,
  scanCount,
  isExpanded,
  onToggleExpand,
  firstCall,
  markUnrated,
  isSubRow = false,
  showStats = false,
}: ContractItemProps) {
  const color = entry.chain === 'evm' ? evmColor : solColor;
  const isMuted = quality?.tier === 'muted';
  const jumpToFirst = firstCallerIsElsewhere(firstCall, entry) ? firstCall : undefined;
  const chainLabel = entry.chain === 'evm' && entry.evmChain
    ? (EVM_CHAIN_LABELS[entry.evmChain] ?? entry.evmChain.toUpperCase())
    : entry.chain.toUpperCase();

  const isNew = forceIsNew ?? (entry.firstSeen !== false);
  const { ticker, subtitle } = contractDisplay(entry, showFull);
  // Rick embed descriptions carry raw Discord custom-emoji markup
  // (`<:sol:941653282420576296> Solana @ Pump`); strip it for this plain-text
  // line. Empty after stripping (emoji-only) falls back to the source label.
  const desc = entry.description ? stripDiscordCustomEmoji(entry.description) : '';
  const { trade: convergenceTrade, windowMinutes } = useConvergenceForContract(entry);

  return (
    <div
      className={`flex flex-col gap-1 px-3 sm:px-4 oct-row-hover group border-b border-oct-border/60 ${
        isSubRow ? 'py-1.5 opacity-90' : 'py-2.5'
      } ${isMuted ? 'opacity-45 hover:opacity-100' : ''}`}
    >
      <div className="flex items-center gap-2 sm:gap-3 min-w-0">
        {onToggleExpand && (
          <button
            onClick={onToggleExpand}
            className="p-0.5 rounded hover:bg-oct-surface text-oct-muted hover:text-oct-text transition-colors shrink-0"
            title={isExpanded ? 'Collapse scan history' : 'Show scan history'}
          >
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        )}
        <CallerBandBadge quality={quality} markUnrated={markUnrated} />
        <span
          className={ROW_PILL}
          style={{ backgroundColor: colorWithExtraAlpha(color, 0.125), color }}
        >
          {chainLabel}
        </span>

        <span
          className={`${ROW_PILL} hidden sm:inline ${
            isNew
              ? 'bg-oct-green/15 text-oct-green'
              : 'bg-orange-500/15 text-orange-400'
          }`}
        >
          {isNew ? 'NEW' : 'RESCAN'}
        </span>

        {scanCount != null && scanCount > 1 && (
          <span
            className={`${ROW_PILL} bg-oct-accent/15 text-oct-accent`}
            title={`${scanCount} scans of this address, latest ${timeAgo(entry.timestamp)}`}
          >
            ×{scanCount} scans
          </span>
        )}

        {convergenceTrade && (
          <SignalConvergenceBadge trade={convergenceTrade} windowMinutes={windowMinutes} />
        )}

        <div className="flex items-center gap-1.5 min-w-0 flex-1 sm:flex-none">
          <span
            className={`font-mono text-sm font-semibold truncate ${entry.tokenSymbol ? 'text-oct-text' : ''}`}
            style={entry.tokenSymbol ? undefined : { color }}
            title={entry.address}
          >
            {ticker}
          </span>

          <div className="flex items-center gap-0.5 shrink-0">
            <button
              onClick={() => onCopy(entry.address)}
              className="p-1 rounded hover:bg-oct-surface text-oct-muted hover:text-oct-text transition-colors"
              title="Copy address"
            >
              {isCopied ? <Check size={13} className="text-oct-green" /> : <Copy size={13} />}
            </button>
            <button
              onClick={() => onOpen(entry.address, entry.evmChain)}
              className="p-1 rounded hover:bg-oct-surface text-oct-muted hover:text-oct-text transition-colors"
              title="Open chart"
            >
              <ExternalLink size={13} />
            </button>
            <button
              onClick={() => onOpenDiscord(entry)}
              className="p-1 rounded hover:bg-oct-surface text-oct-muted hover:text-oct-text transition-colors hidden sm:block"
              title={isTelegramContract(entry) ? 'Open this message in Telegram' : 'Open this message in Discord'}
            >
              {isTelegramContract(entry) ? <Send size={13} className="text-[#2AABEE]" /> : <MessageSquare size={13} />}
            </button>
            {jumpToFirst && (
              <button
                onClick={() => onOpenDiscord(jumpToFirst.entry)}
                className={`p-1 rounded hover:bg-oct-surface transition-colors hidden sm:block ${
                  jumpToFirst.isFirstLogged
                    ? 'text-oct-green/70 hover:text-oct-green'
                    : 'text-oct-muted hover:text-oct-text'
                }`}
                title={firstCallerTitle(jumpToFirst)}
              >
                <Flag size={13} />
              </button>
            )}
            <button
              onClick={() => onShowHolders(entry)}
              className="p-1 rounded hover:bg-oct-surface text-oct-muted hover:text-oct-text transition-colors"
              title="Top holders"
            >
              <Users size={13} />
            </button>
          </div>
        </div>

        <div className="flex-1 min-w-0 hidden sm:block" />

        <span className="text-xs text-oct-muted font-mono shrink-0 tabular-nums">
          {timeAgo(entry.timestamp)}
        </span>

        <button
          onClick={() => onDelete(entry)}
          className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-oct-accent/10 text-oct-muted hover:text-oct-accent transition-all shrink-0"
          title="Delete"
        >
          <Trash2 size={13} />
        </button>
      </div>

      {(subtitle || entry.fdvAtCallDisplay || entry.liquidityDisplay || desc) && (
        <div className="pl-[4.5rem] sm:pl-24 min-w-0">
          <div className="flex items-baseline gap-2 min-w-0 flex-wrap">
            {subtitle && (
              <span className="text-sm text-oct-text/90 truncate">{subtitle}</span>
            )}
            {entry.fdvAtCallDisplay && (
              <span className="font-mono text-[11px] text-oct-live">
                FDV {entry.fdvAtCallDisplay}
              </span>
            )}
            <PeakReadout entry={entry} />
            {entry.liquidityDisplay && (
              <span className="font-mono text-[11px] text-oct-muted">
                Liq {entry.liquidityDisplay}
              </span>
            )}
          </div>
          {(desc || (!isTelegramContract(entry) && entry.guildName)) && (
            <div className="text-xs text-oct-muted truncate mt-0.5">
              {desc || `${entry.guildName ?? ''} / #${entry.channelName}`}
            </div>
          )}
        </div>
      )}

      {!subtitle && !entry.fdvAtCallDisplay && !entry.liquidityDisplay && !desc && (
        <div className="pl-[4.5rem] sm:pl-24 text-xs text-oct-muted truncate">
          {contractAttribution(entry)}
        </div>
      )}

      {showStats && (
        <div className="pl-[4.5rem] sm:pl-24 min-w-0 flex items-center gap-2 flex-wrap">
          <span className="text-[11px] text-oct-text/80 font-mono truncate max-w-[10rem]" title={entry.authorName}>
            {entry.authorName}
          </span>
          <CallerStatsReadout quality={quality} />
        </div>
      )}
    </div>
  );
}

function ContractCard({
  entry,
  quality,
  evmColor,
  solColor,
  isCopied,
  onCopy,
  onOpen,
  onOpenDiscord,
  onDelete,
  onShowHolders,
  forceIsNew,
  scanCount,
  firstCall,
  markUnrated,
  showStats = false,
}: ContractItemProps) {
  const color = entry.chain === 'evm' ? evmColor : solColor;
  const jumpToFirst = firstCallerIsElsewhere(firstCall, entry) ? firstCall : undefined;
  const chainLabel = entry.chain === 'evm' && entry.evmChain
    ? (EVM_CHAIN_LABELS[entry.evmChain] ?? entry.evmChain.toUpperCase())
    : entry.chain.toUpperCase();

  const isNew = forceIsNew ?? (entry.firstSeen !== false);
  const { ticker, subtitle } = contractDisplay(entry, false);
  const { trade: convergenceTrade, windowMinutes } = useConvergenceForContract(entry);

  return (
    <div className="oct-card p-3 flex flex-col gap-2.5 transition-all hover:-translate-y-0.5 hover:shadow-oct-soft-lg hover:border-oct-border-bright group relative">
      <button
        onClick={() => onDelete(entry)}
        className="absolute top-2 right-2 p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-oct-accent/20 text-oct-muted hover:text-oct-accent transition-all"
        title="Delete"
      >
        <X size={13} />
      </button>

      <div className="flex items-center gap-2 flex-wrap">
        <CallerBandBadge quality={quality} markUnrated={markUnrated} />
        <span
          className={ROW_PILL}
          style={{ backgroundColor: colorWithExtraAlpha(color, 0.125), color }}
        >
          {chainLabel}
        </span>
        <span
          className={`${ROW_PILL} ${
            isNew
              ? 'bg-oct-green/20 text-oct-green'
              : 'bg-orange-500/20 text-orange-400'
          }`}
        >
          {isNew ? 'NEW' : 'RESCAN'}
        </span>
        {scanCount != null && scanCount > 1 && (
          <span
            className={`${ROW_PILL} bg-oct-accent/20 text-oct-accent`}
            title={`${scanCount} scans of this address collapsed into this card`}
          >
            ×{scanCount}
          </span>
        )}
        {convergenceTrade && (
          <SignalConvergenceBadge trade={convergenceTrade} windowMinutes={windowMinutes} />
        )}
        <span className="text-xs text-oct-muted ml-auto pr-5 font-mono">{timeAgo(entry.timestamp)}</span>
      </div>

      <div className="min-w-0">
        <div
          className={`font-mono text-sm font-semibold truncate ${entry.tokenSymbol ? 'text-oct-text' : ''}`}
          style={entry.tokenSymbol ? undefined : { color }}
          title={entry.address}
        >
          {ticker}
        </div>
        {subtitle && (
          <div className="text-xs text-oct-muted truncate mt-0.5">{subtitle}</div>
        )}
      </div>

      {(entry.fdvAtCallDisplay || entry.liquidityDisplay) && (
        <div className="flex items-baseline gap-2 min-w-0 flex-wrap">
          {entry.fdvAtCallDisplay && (
            <span className="font-mono text-[11px] text-oct-live">FDV {entry.fdvAtCallDisplay}</span>
          )}
          <PeakReadout entry={entry} />
          {entry.liquidityDisplay && (
            <span className="font-mono text-[11px] text-oct-muted">Liq {entry.liquidityDisplay}</span>
          )}
        </div>
      )}

      <div className="flex items-center gap-1.5">
        <button
          onClick={() => onCopy(entry.address)}
          className="flex items-center gap-1 px-2 py-1 rounded-oct-sm text-xs bg-oct-bg hover:bg-oct-surface-raised transition-colors text-oct-muted hover:text-oct-text border border-oct-border"
          title="Copy address"
        >
          {isCopied ? <Check size={11} className="text-green-400" /> : <Copy size={11} />}
          <span>{isCopied ? 'Copied' : 'Copy CA'}</span>
        </button>
        <button
          onClick={() => onOpen(entry.address, entry.evmChain)}
          className="flex items-center gap-1 px-2 py-1 rounded-oct-sm text-xs bg-oct-bg hover:bg-oct-surface-raised transition-colors text-oct-muted hover:text-oct-text border border-oct-border"
          title="Open chart"
        >
          <ExternalLink size={11} />
          <span>Chart</span>
        </button>
        <button
          onClick={() => onOpenDiscord(entry)}
          className="flex items-center gap-1 px-2 py-1 rounded-oct-sm text-xs bg-oct-bg hover:bg-oct-surface-raised transition-colors text-oct-muted hover:text-oct-text border border-oct-border"
          title={isTelegramContract(entry) ? 'Open this message in Telegram' : 'Open this message in Discord'}
        >
          {isTelegramContract(entry) ? <Send size={11} className="text-[#2AABEE]" /> : <MessageSquare size={11} />}
          <span>{isTelegramContract(entry) ? 'Telegram' : 'Discord'}</span>
        </button>
        {jumpToFirst && (
          <button
            onClick={() => onOpenDiscord(jumpToFirst.entry)}
            className="flex items-center gap-1 px-2 py-1 rounded-oct-sm text-xs bg-oct-bg hover:bg-oct-surface-raised transition-colors text-oct-muted hover:text-oct-text border border-oct-border"
            title={firstCallerTitle(jumpToFirst)}
          >
            <Flag size={11} className={jumpToFirst.isFirstLogged ? 'text-oct-green' : undefined} />
            <span>{jumpToFirst.isFirstLogged ? '1st' : 'Earliest'}</span>
          </button>
        )}
        <button
          onClick={() => onShowHolders(entry)}
          className="flex items-center gap-1 px-2 py-1 rounded-oct-sm text-xs bg-oct-bg hover:bg-oct-surface-raised transition-colors text-oct-muted hover:text-oct-text border border-oct-border"
          title="Top holders"
        >
          <Users size={11} />
          <span>Holders</span>
        </button>
      </div>

      {showStats && (
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-[11px] text-oct-text/80 font-mono truncate" title={entry.authorName}>
            {entry.authorName}
          </span>
          <CallerStatsReadout quality={quality} />
        </div>
      )}

      <div className="flex items-center gap-2 text-xs text-oct-muted truncate">
        {contractAttribution(entry)}
      </div>
    </div>
  );
}
