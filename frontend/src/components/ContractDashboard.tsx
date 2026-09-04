// The Contract Feed (Callers › Contracts, and the Workspace's feed panes).
// This file is state + composition only — the pieces live in contract-feed/:
//
//   ContractFeedToolbar.tsx   filters, search, sort, view mode
//   useContractFeedRows.ts    the filter → group → sort pipeline
//   ContractFeedList.tsx      the grouped rows / cards
//   ContractFeedEmpty.tsx     the two empty states
//   ContractFeedRows.tsx      ContractRow / ContractCard (memoized)
//
// PERF CONTRACT: every callback handed to a row is identity-stable
// (useCallback) so the memoized rows can skip re-rendering on unrelated store
// churn — an enrichment frame for one address must not re-paint the other few
// hundred rows. Rows are a live stream and are never animated.
import { useCallback, useEffect, useState } from 'react';
import { Trash2, PanelLeftOpen } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { useCallerQuality } from '../hooks/useCallerQuality';
import { buildContractUrl } from '../utils/contractUrl';
import { openContractSource } from '../utils/contractSource';
import ConfirmModal from './ConfirmModal';
import ContractFeedToolbar, { type ContractViewMode, type ContractChainFilter } from './contract-feed/ContractFeedToolbar';
import ContractFeedList from './contract-feed/ContractFeedList';
import ContractFeedEmpty from './contract-feed/ContractFeedEmpty';
import { useContractFeedRows } from './contract-feed/useContractFeedRows';
import TokenHoldersDrawer, { type HoldersTarget } from './fomo/TokenHoldersDrawer';
import type { ContractEntry } from '../types';
import type { ContractSortMode } from '../utils/contractFeedView';

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

  const {
    filteredEntries,
    groupedRows,
    firstCallerIndex,
    mutedCount,
    unratedShown,
    goodHidden,
    topHidden,
  } = useContractFeedRows({
    contracts,
    chainFilter,
    search,
    qualityForContract,
    showMuted,
    revealMuted,
    goodOnly,
    topOnly,
    sortMode,
  });

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
        <div className="flex items-center gap-cozy sm:gap-comfy px-comfy sm:px-roomy py-cozy">
          {sidebarCollapsed && (
            <button
              onClick={toggleSidebar}
              className="oct-icon-btn p-snug shrink-0"
              title="Show sidebar"
            >
              <PanelLeftOpen size={18} />
            </button>
          )}
          <h2 className="type-title sm:type-heading uppercase tracking-wide text-oct-text">
            {topOnly ? 'Top Callers' : 'Contract Feed'}
          </h2>
          <span className="type-data text-oct-muted">{filteredEntries.length}</span>
          <div className="flex-1" />
          {contracts.length > 0 && (
            // Destructive, so `oct-critical` rather than the brand accent —
            // in the dark theme the two used to be the same red.
            <button
              onClick={handleDeleteAll}
              className="flex items-center gap-tight px-cozy py-tight rounded-oct-sm font-mono text-2xs font-bold uppercase text-oct-critical hover:bg-oct-critical hover:text-white transition-all duration-fast border border-oct-critical/60 shrink-0"
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
          <ContractFeedEmpty
            topOnly={topOnly}
            totalCount={contracts.length}
            goodOnly={goodOnly}
            goodHidden={goodHidden}
            mutedCount={mutedCount}
            topHidden={topHidden}
          />
        ) : (
          <ContractFeedList
            viewMode={viewMode}
            groups={groupedRows}
            firstCallerIndex={firstCallerIndex}
            expandedGroups={expandedGroups}
            evmColor={evmColor}
            solColor={solColor}
            showFull={showFull}
            copiedAddr={copiedAddr}
            markUnrated={goodOnly}
            hideBadges={hideBadges}
            showStats={topOnly}
            timeTick={timeTick}
            onCopy={handleCopy}
            onOpen={handleOpen}
            onOpenDiscord={handleOpenDiscord}
            onDelete={handleDelete}
            onShowHolders={handleShowHolders}
            onToggleExpand={toggleGroupExpanded}
          />
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
