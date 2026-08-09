import { useEffect, useState, useMemo } from 'react';
import { Search, ExternalLink, Copy, Check, Trash2, LayoutGrid, List, X, MessageSquare, PanelLeftOpen, Send, Eye, EyeOff, Users } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { useCallerQuality, type CallerQuality } from '../hooks/useCallerQuality';
import { BAND_DOT_CLASS, BAND_TITLE, bandIsNotable } from '../utils/callerBandStyle';
import { buildContractUrl } from '../utils/contractUrl';
import { contractAttribution, isTelegramContract, openContractSource } from '../utils/contractSource';
import ConfirmModal from './ConfirmModal';
import SignalConvergenceBadge from './SignalConvergenceBadge';
import TokenHoldersDrawer, { type HoldersTarget } from './fomo/TokenHoldersDrawer';
import { useConvergenceForContract } from '../hooks/useSignalConvergence';
import type { ContractEntry } from '../types';
import { colorWithExtraAlpha } from './ColorPickerWithAlpha';

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

type ViewMode = 'table' | 'cards';

interface ContractDashboardProps {
  embedded?: boolean;
}

export default function ContractDashboard({ embedded = false }: ContractDashboardProps) {
  const contracts = useAppStore((s) => s.contracts);
  const fetchContracts = useAppStore((s) => s.fetchContracts);
  const deleteContract = useAppStore((s) => s.deleteContract);
  const deleteAllContracts = useAppStore((s) => s.deleteAllContracts);
  const config = useAppStore((s) => s.config);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const [search, setSearch] = useState('');
  const [chainFilter, setChainFilter] = useState<'all' | 'evm' | 'sol'>('all');
  const [copiedAddr, setCopiedAddr] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('table');
  const [showDeleteAll, setShowDeleteAll] = useState(false);
  const [holdersTarget, setHoldersTarget] = useState<HoldersTarget | null>(null);
  const [revealMuted, setRevealMuted] = useState(false);
  const { qualityForContract, rankingEnabled, showMuted } = useCallerQuality();

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

    if (rankingEnabled) {
      rows = [...rows].sort(
        (a, b) =>
          b.quality.rank - a.quality.rank ||
          new Date(b.entry.timestamp).getTime() - new Date(a.entry.timestamp).getTime(),
      );
    }
    return { visible: rows, mutedCount: muted.length };
  }, [filtered, qualityForContract, rankingEnabled, showMuted, revealMuted]);

  const filteredEntries = useMemo(() => visible.map((r) => r.entry), [visible]);

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
      <div className="border-b-2 border-black bg-oct-surface shrink-0">
        {!embedded && (
        <div className="flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-3">
          {sidebarCollapsed && (
            <button
              onClick={toggleSidebar}
              className="p-1.5 rounded-cockpit text-oct-muted hover:text-oct-text hover:bg-oct-surface-raised transition-colors shrink-0"
              title="Show sidebar"
            >
              <PanelLeftOpen size={18} />
            </button>
          )}
          <h2 className="text-oct-text font-extrabold uppercase text-base sm:text-lg">Contract Feed</h2>
          <span className="text-oct-muted text-xs sm:text-sm font-mono">{filteredEntries.length}</span>
          <div className="flex-1" />
          {contracts.length > 0 && (
            <button
              onClick={handleDeleteAll}
              className="flex items-center gap-1 px-2 py-1 rounded-cockpit text-xs font-bold uppercase text-oct-accent hover:bg-oct-accent hover:text-white transition-colors border-2 border-oct-accent shrink-0"
              title="Delete all contracts"
            >
              <Trash2 size={12} />
              <span className="hidden sm:inline">Clear All</span>
            </button>
          )}
        </div>
        )}
        <div className="flex items-center gap-2 px-3 sm:px-4 pb-3 overflow-x-auto scrollbar-none">
          <div className="flex rounded-cockpit overflow-hidden border-2 border-black text-xs shrink-0">
            <button
              onClick={() => setViewMode('table')}
              className={`px-2 py-1 transition-colors ${
                viewMode === 'table'
                  ? 'bg-oct-accent text-white'
                  : 'bg-oct-surface text-oct-muted hover:text-oct-text'
              }`}
              title="Table view"
            >
              <List size={14} />
            </button>
            <button
              onClick={() => setViewMode('cards')}
              className={`px-2 py-1 transition-colors ${
                viewMode === 'cards'
                  ? 'bg-oct-accent text-white'
                  : 'bg-oct-surface text-oct-muted hover:text-oct-text'
              }`}
              title="Card view"
            >
              <LayoutGrid size={14} />
            </button>
          </div>

          <div className="flex rounded-cockpit overflow-hidden border-2 border-black text-xs shrink-0">
            {(['all', 'evm', 'sol'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setChainFilter(f)}
                className={`px-2.5 py-1 font-bold uppercase transition-colors ${
                  chainFilter === f
                    ? 'bg-oct-accent text-white'
                    : 'bg-oct-surface text-oct-muted hover:text-oct-text'
                }`}
              >
                {f.toUpperCase()}
              </button>
            ))}
          </div>

          <div className="relative flex-1 min-w-[120px]">
            <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-oct-muted" />
            <input
              type="text"
              placeholder="Search..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-oct-surface border-2 border-oct-border rounded-cockpit pl-7 pr-3 py-1 text-sm text-oct-text placeholder-oct-muted w-full focus:outline-none focus:border-oct-accent"
            />
          </div>

          {showMuted && mutedCount > 0 && (
            <button
              onClick={() => setRevealMuted((v) => !v)}
              className={`flex items-center gap-1 px-2 py-1 rounded-cockpit text-xs font-bold uppercase border-2 transition-colors shrink-0 ${
                revealMuted
                  ? 'border-oct-accent bg-oct-accent text-white'
                  : 'border-oct-border text-oct-muted hover:text-oct-text'
              }`}
              title={revealMuted ? 'Hide muted callers again' : 'Show contracts from muted callers'}
            >
              {revealMuted ? <Eye size={12} /> : <EyeOff size={12} />}
              <span>{mutedCount} muted</span>
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain"
        style={{ overflowAnchor: 'none' }}
      >
        {filteredEntries.length === 0 ? (
          <div className="flex items-center justify-center h-full text-oct-muted text-sm">
            {contracts.length === 0
              ? 'No contracts detected yet'
              : mutedCount > 0
                ? 'Every match is from a muted caller'
                : 'No contracts match your filters'}
          </div>
        ) : viewMode === 'table' ? (
          <div className="divide-y divide-oct-border/50">
            {visible.map(({ entry, quality }, i) => (
              <ContractRow
                key={`${entry.messageId}-${entry.address}-${i}`}
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
              />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2 sm:gap-3 p-3 sm:p-4">
            {visible.map(({ entry }, i) => (
              <ContractCard
                key={`${entry.messageId}-${entry.address}-${i}`}
                entry={entry}
                evmColor={evmColor}
                solColor={solColor}
                isCopied={copiedAddr === entry.address}
                onCopy={handleCopy}
                onOpen={handleOpen}
                onOpenDiscord={handleOpenDiscord}
                onDelete={handleDelete}
                onShowHolders={(e) => setHoldersTarget(holdersTargetFor(e))}
              />
            ))}
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
}: ContractItemProps) {
  const color = entry.chain === 'evm' ? evmColor : solColor;
  const isMuted = quality?.tier === 'muted';
  const chainLabel = entry.chain === 'evm' && entry.evmChain
    ? (EVM_CHAIN_LABELS[entry.evmChain] ?? entry.evmChain.toUpperCase())
    : entry.chain.toUpperCase();

  const isNew = entry.firstSeen !== false;
  const { ticker, subtitle } = contractDisplay(entry, showFull);
  const { trade: convergenceTrade, windowMinutes } = useConvergenceForContract(entry);

  return (
    <div
      className={`flex flex-col gap-1 px-3 sm:px-4 py-2.5 hover:bg-oct-surface-raised/40 transition-colors group border-b border-oct-border/60 ${
        isMuted ? 'opacity-45 hover:opacity-100' : ''
      }`}
    >
      <div className="flex items-center gap-2 sm:gap-3 min-w-0">
        {quality && bandIsNotable(quality.band) && (
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${BAND_DOT_CLASS[quality.band]}`}
            title={BAND_TITLE[quality.band]}
          />
        )}
        <span
          className="text-[10px] font-bold px-1.5 py-0.5 rounded-cockpit shrink-0 uppercase font-mono"
          style={{ backgroundColor: colorWithExtraAlpha(color, 0.125), color }}
        >
          {chainLabel}
        </span>

        <span
          className={`text-[9px] font-bold px-1.5 py-0.5 rounded-cockpit shrink-0 uppercase hidden sm:inline font-mono ${
            isNew
              ? 'bg-green-500/15 text-green-400'
              : 'bg-orange-500/15 text-orange-400'
          }`}
        >
          {isNew ? 'NEW' : 'RESCAN'}
        </span>

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
              {isCopied ? <Check size={13} className="text-green-400" /> : <Copy size={13} />}
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
              title={isTelegramContract(entry) ? 'Open in Telegram' : 'Open in Discord'}
            >
              {isTelegramContract(entry) ? <Send size={13} className="text-[#2AABEE]" /> : <MessageSquare size={13} />}
            </button>
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

      {(subtitle || entry.fdvAtCallDisplay || entry.liquidityDisplay || entry.description) && (
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
            {entry.liquidityDisplay && (
              <span className="font-mono text-[11px] text-oct-muted">
                Liq {entry.liquidityDisplay}
              </span>
            )}
          </div>
          {(entry.description || (!isTelegramContract(entry) && entry.guildName)) && (
            <div className="text-xs text-oct-muted truncate mt-0.5">
              {entry.description ?? `${entry.guildName ?? ''} / #${entry.channelName}`}
            </div>
          )}
        </div>
      )}

      {!subtitle && !entry.fdvAtCallDisplay && !entry.liquidityDisplay && !entry.description && (
        <div className="pl-[4.5rem] sm:pl-24 text-xs text-oct-muted truncate">
          {contractAttribution(entry)}
        </div>
      )}
    </div>
  );
}

function ContractCard({
  entry,
  evmColor,
  solColor,
  isCopied,
  onCopy,
  onOpen,
  onOpenDiscord,
  onDelete,
  onShowHolders,
}: ContractItemProps) {
  const color = entry.chain === 'evm' ? evmColor : solColor;
  const chainLabel = entry.chain === 'evm' && entry.evmChain
    ? (EVM_CHAIN_LABELS[entry.evmChain] ?? entry.evmChain.toUpperCase())
    : entry.chain.toUpperCase();

  const isNew = entry.firstSeen !== false;
  const { ticker, subtitle } = contractDisplay(entry, false);
  const { trade: convergenceTrade, windowMinutes } = useConvergenceForContract(entry);

  return (
    <div className="bg-oct-surface rounded-cockpit border border-oct-border p-3 flex flex-col gap-2.5 hover:border-oct-muted/40 transition-colors group relative">
      <button
        onClick={() => onDelete(entry)}
        className="absolute top-2 right-2 p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-oct-accent/20 text-oct-muted hover:text-oct-accent transition-all"
        title="Delete"
      >
        <X size={13} />
      </button>

      <div className="flex items-center gap-2">
        <span
          className="text-[10px] font-bold px-1.5 py-0.5 rounded-cockpit uppercase font-mono"
          style={{ backgroundColor: colorWithExtraAlpha(color, 0.125), color }}
        >
          {chainLabel}
        </span>
        <span
          className={`text-[9px] font-bold px-1.5 py-0.5 rounded-cockpit uppercase font-mono ${
            isNew
              ? 'bg-green-500/20 text-green-400'
              : 'bg-orange-500/20 text-orange-400'
          }`}
        >
          {isNew ? 'NEW' : 'RESCAN'}
        </span>
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
          {entry.liquidityDisplay && (
            <span className="font-mono text-[11px] text-oct-muted">Liq {entry.liquidityDisplay}</span>
          )}
        </div>
      )}

      <div className="flex items-center gap-1.5">
        <button
          onClick={() => onCopy(entry.address)}
          className="flex items-center gap-1 px-2 py-1 rounded-cockpit text-xs bg-oct-bg hover:bg-oct-surface-raised transition-colors text-oct-muted hover:text-oct-text border border-oct-border"
          title="Copy address"
        >
          {isCopied ? <Check size={11} className="text-green-400" /> : <Copy size={11} />}
          <span>{isCopied ? 'Copied' : 'Copy CA'}</span>
        </button>
        <button
          onClick={() => onOpen(entry.address, entry.evmChain)}
          className="flex items-center gap-1 px-2 py-1 rounded-cockpit text-xs bg-oct-bg hover:bg-oct-surface-raised transition-colors text-oct-muted hover:text-oct-text border border-oct-border"
          title="Open chart"
        >
          <ExternalLink size={11} />
          <span>Chart</span>
        </button>
        <button
          onClick={() => onOpenDiscord(entry)}
          className="flex items-center gap-1 px-2 py-1 rounded-cockpit text-xs bg-oct-bg hover:bg-oct-surface-raised transition-colors text-oct-muted hover:text-oct-text border border-oct-border"
          title={isTelegramContract(entry) ? 'Open in Telegram' : 'Open in Discord'}
        >
          {isTelegramContract(entry) ? <Send size={11} className="text-[#2AABEE]" /> : <MessageSquare size={11} />}
          <span>{isTelegramContract(entry) ? 'Telegram' : 'Discord'}</span>
        </button>
        <button
          onClick={() => onShowHolders(entry)}
          className="flex items-center gap-1 px-2 py-1 rounded-cockpit text-xs bg-oct-bg hover:bg-oct-surface-raised transition-colors text-oct-muted hover:text-oct-text border border-oct-border"
          title="Top holders"
        >
          <Users size={11} />
          <span>Holders</span>
        </button>
      </div>

      <div className="flex items-center gap-2 text-xs text-oct-muted truncate">
        {contractAttribution(entry)}
      </div>
    </div>
  );
}
