import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Copy, Check, Users, ChevronUp, ChevronDown, Eye, EyeOff } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useFomoHolderOverlap } from '../../hooks/useFomoHolderOverlap';
import SignalConvergenceBadge from '../SignalConvergenceBadge';
import {
  findConvergenceForAddress,
  getSignalConvergenceWindowMs,
} from '../../utils/signalConvergence';
import RadarSettings from './RadarSettings';
import {
  RADAR_COLUMN_LABELS,
  RADAR_COLUMN_ORDER,
  loadVisibleRadarColumns,
  saveVisibleRadarColumns,
  type RadarColumnId,
} from './radarColumns';
import { isHostedMode, getAccessToken } from '../../lib/supabase';
import { useCallerQuality, type CallerQuality } from '../../hooks/useCallerQuality';
import {
  BAND_DOT_CLASS,
  BAND_TEXT_CLASS,
  BAND_TITLE,
  BAND_BADGE_CLASS,
  BAND_NAME_COLOR,
  bandIsNotable,
} from '../../utils/callerBandStyle';
import { BAND_LABELS, type CallerBand } from '@oct/shared';
import type { ContractEntry } from '../../types';

const API_BASE = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/api`
  : '/api';

async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (isHostedMode) {
    const token = await getAccessToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }
  return fetch(input, { ...init, headers, credentials: 'include' });
}

interface RadarRow {
  address: string;
  chain: 'evm' | 'sol';
  evmChain?: string;
  symbol?: string;
  name?: string;
  mentions: number;
  callers: Set<string>;
  groups: Set<string>;
  firstCaller?: string;
  firstSeenAt: number;
  lastMentionAt: number;
  timestamps: number[];
  mcAtCall?: number;
  mcAtCallDisplay?: string;
  /** Best band among the callers who posted this token. */
  bestBand?: CallerBand;
  /**
   * Band of the first caller specifically — distinct from bestBand, which is the
   * best across everyone who posted it. The First caller column names one person,
   * so it must show that person's own band, not the row's best.
   */
  firstCallerBand?: CallerBand;
  bestRank: number;
  /** Every caller on this token is muted — the row is pure slop by your own rules. */
  allMuted: boolean;
}

interface LiveMc {
  mc: number;
  display: string;
  at: number;
}

const CHAIN_LABELS: Record<string, string> = {
  eth: 'ETH', bsc: 'BNB', base: 'BASE', arb: 'ARB', blast: 'BLAST',
  polygon: 'POLY', avax: 'AVAX', linea: 'LINEA', sonic: 'SONIC',
  hyperliquid: 'HL', robinhood: 'HOOD',
};

function formatCompact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

function timeAgoShort(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

function countWithin(timestamps: number[], windowMs: number): number {
  const cutoff = Date.now() - windowMs;
  let n = 0;
  for (const t of timestamps) if (t >= cutoff) n++;
  return n;
}

const CHAIN_DOTS: Record<string, string> = {
  robinhood: '#22C55E',
  base: '#2B4EFF',
  eth: '#627EEA',
  bsc: '#F0B90B',
  arb: '#28A0F0',
};

function platformMeta(chain: 'evm' | 'sol', evmChain?: string): { label: string; dot: string } {
  if (chain === 'sol') return { label: 'SOL', dot: '#9945FF' };
  const label = evmChain ? (CHAIN_LABELS[evmChain] ?? evmChain.toUpperCase()) : 'EVM';
  const dot = (evmChain && CHAIN_DOTS[evmChain]) ?? '#2B4EFF';
  return { label, dot };
}

function buildRadar(
  contracts: ContractEntry[],
  qualityForContract?: (entry: ContractEntry) => CallerQuality,
): RadarRow[] {
  const map = new Map<string, RadarRow>();
  for (const c of contracts) {
    const key = c.address.toLowerCase();
    const ts = new Date(c.timestamp).getTime();
    let row = map.get(key);
    if (!row) {
      row = {
        address: c.address,
        chain: c.chain,
        evmChain: c.evmChain,
        symbol: c.tokenSymbol,
        name: c.tokenName,
        mentions: 0,
        callers: new Set(),
        groups: new Set(),
        firstCaller: c.authorName,
        firstCallerBand: qualityForContract ? qualityForContract(c).band : undefined,
        firstSeenAt: ts,
        lastMentionAt: ts,
        timestamps: [],
        bestRank: -Infinity,
        allMuted: true,
      };
      map.set(key, row);
    }

    // A token is only as good as its best caller: one trusted name calling it
    // matters more than five muted ones also calling it.
    if (qualityForContract) {
      const q = qualityForContract(c);
      if (q.rank > row.bestRank) {
        row.bestRank = q.rank;
        row.bestBand = q.band;
      }
      if (q.tier !== 'muted') row.allMuted = false;
    } else {
      row.allMuted = false;
    }

    row.mentions += 1;
    row.timestamps.push(ts);
    row.callers.add(c.authorId);
    if (c.guildId) row.groups.add(c.guildId);
    else if (c.channelId) row.groups.add(c.channelId);
    if (ts < row.firstSeenAt) {
      row.firstSeenAt = ts;
      row.firstCaller = c.authorName;
      row.firstCallerBand = qualityForContract ? qualityForContract(c).band : undefined;
    }
    if (ts > row.lastMentionAt) row.lastMentionAt = ts;
    row.symbol = row.symbol ?? c.tokenSymbol;
    row.name = row.name ?? c.tokenName;
    row.evmChain = row.evmChain ?? c.evmChain;
  }

  for (const row of map.values()) {
    const group = contracts.filter((c) => c.address.toLowerCase() === row.address.toLowerCase());
    const sorted = [...group].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    // MC@call is the FIRST call's market cap. Take the earliest row that has an
    // FDV, but only if it was captured close to first-seen — otherwise a repeat
    // mention hours later (which now gets its own FDV) would have its live MC
    // stamped onto the original call, turning an honest blank into a wrong
    // denominator in the multiple. Missing beats wrong.
    const firstMs = new Date(sorted[0].timestamp).getTime();
    const withMc = sorted.find(
      (c) =>
        c.fdvAtCall != null &&
        c.fdvAtCall > 0 &&
        new Date(c.timestamp).getTime() - firstMs <= MC_AT_CALL_MAX_LAG_MS,
    );
    if (withMc) {
      row.mcAtCall = withMc.fdvAtCall;
      row.mcAtCallDisplay = withMc.fdvAtCallDisplay;
    }
  }

  return [...map.values()];
}

// An FDV counts as the group's MC@call only if captured within this of the
// first mention — the arrival burst of one call event, not a re-mention hours
// later. Beyond it, the group's MC@call stays blank rather than borrowing a
// later row's live market cap.
const MC_AT_CALL_MAX_LAG_MS = 900_000; // 15 min

type MentionWindow = '15m' | '1h' | '4h';

const MENTION_WINDOW_MS: Record<MentionWindow, number> = {
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
};

type SortKey =
  | 'token'
  | 'mentions'
  | 'callers'
  | 'fomo'
  | 'groups'
  | 'windowMentions'
  | 'firstCaller'
  | 'mcAtCall'
  | 'mcNow'
  | 'mult'
  | 'quality'
  | 'recent';

type SortDir = 'asc' | 'desc';

function WindowMentionsHeader({
  window: mentionWindow,
  sortKey,
  sortDir,
  onSort,
}: {
  window: MentionWindow;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  return (
    <SortHeader
      label={mentionWindow}
      sortKey="windowMentions"
      activeKey={sortKey}
      dir={sortDir}
      onSort={onSort}
      align="right"
    />
  );
}

function SortHeader({
  label,
  sortKey,
  activeKey,
  dir,
  onSort,
  align = 'left',
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
  align?: 'left' | 'right';
}) {
  const active = activeKey === sortKey;
  return (
    <th className={`px-3 py-2 font-medium ${align === 'right' ? 'text-right' : ''}`}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 uppercase tracking-wider transition-colors ${
          align === 'right' ? 'flex-row-reverse ml-auto' : ''
        } ${active ? 'text-oct-accent' : 'text-oct-muted hover:text-oct-text'}`}
      >
        <span>{label}</span>
        <span className={`inline-flex flex-col -space-y-1 shrink-0 ${active ? 'text-oct-accent' : 'text-oct-muted/60'}`}>
          <ChevronUp
            size={10}
            strokeWidth={2.5}
            className={active && dir === 'asc' ? 'opacity-100' : 'opacity-35'}
          />
          <ChevronDown
            size={10}
            strokeWidth={2.5}
            className={active && dir === 'desc' ? 'opacity-100' : 'opacity-35'}
          />
        </span>
      </button>
    </th>
  );
}

interface TokenMetadataResult {
  symbol?: string;
  name?: string;
  pair?: string;
  evmChain?: string;
  source?: ContractEntry['enrichmentSource'];
}

function resolveSnapshotChain(address: string, evmChain?: string, addressChains?: Record<string, string>): string {
  if (evmChain) return evmChain;
  const fromStore = addressChains?.[address.toLowerCase()];
  if (fromStore) return fromStore;
  return address.startsWith('0x') ? 'robinhood' : 'sol';
}

async function fetchMcNow(address: string): Promise<{ mc: number; display: string } | null> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(address)}`);
    if (!res.ok) return null;
    const data = await res.json() as {
      pairs?: { baseToken?: { address?: string }; fdv?: number; marketCap?: number; liquidity?: { usd?: number } }[];
    };
    const lower = address.toLowerCase();
    const pairs = (data.pairs ?? []).filter((p) =>
      p.baseToken?.address?.toLowerCase() === lower || p.baseToken?.address === address,
    );
    if (!pairs.length) return null;
    pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const mc = pairs[0].fdv ?? pairs[0].marketCap;
    if (mc == null) return null;
    return { mc, display: formatCompact(mc) };
  } catch {
    return null;
  }
}

async function fetchTokenMetadata(
  address: string,
  evmChain?: string,
  addressChains?: Record<string, string>,
): Promise<TokenMetadataResult | null> {
  try {
    const chain = resolveSnapshotChain(address, evmChain, addressChains);
    const res = await apiFetch(
      `${API_BASE}/tokens/${encodeURIComponent(chain)}/${encodeURIComponent(address)}/snapshot`,
    );
    if (!res.ok) return null;
    const data = await res.json() as {
      found?: boolean;
      symbol?: string;
      name?: string;
      pair?: string;
      evmChain?: string;
      source?: ContractEntry['enrichmentSource'];
    };
    if (!data.found || (!data.symbol && !data.name)) return null;
    return {
      symbol: data.symbol,
      name: data.name,
      pair: data.pair,
      evmChain: data.evmChain,
      source: data.source,
    };
  } catch {
    return null;
  }
}

function applyMetadataToStore(address: string, meta: TokenMetadataResult): void {
  if (!meta.symbol && !meta.name) return;
  useAppStore.getState().enrichContract({
    address,
    tokenSymbol: meta.symbol,
    tokenName: meta.name,
    tokenPair: meta.pair,
    enrichmentSource: meta.source,
    enrichedAt: new Date().toISOString(),
    evmChain: meta.evmChain,
  } as ContractEntry);
}

export default function RadarTable({ embedded: _embedded = false }: { embedded?: boolean }) {
  const contracts = useAppStore((s) => s.contracts);
  const fomoTrades = useAppStore((s) => s.fomoTrades);
  const config = useAppStore((s) => s.config);
  const convergenceWindowMs = getSignalConvergenceWindowMs(config);
  const convergenceWindowMinutes = config?.signalConvergenceWindowMinutes ?? 30;
  const fetchContracts = useAppStore((s) => s.fetchContracts);
  const addressChains = useAppStore((s) => s.addressChains);
  const { overlaps } = useFomoHolderOverlap(contracts);
  const [liveMc, setLiveMc] = useState<Record<string, LiveMc>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [refreshingRow, setRefreshingRow] = useState<string | null>(null);
  const [windowFilter, setWindowFilter] = useState<'1h' | '4h' | '24h' | 'all'>('24h');
  const [mentionWindow, setMentionWindow] = useState<MentionWindow>('15m');
  const [sortKey, setSortKey] = useState<SortKey>('recent');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [copiedAddr, setCopiedAddr] = useState<string | null>(null);
  const [visibleColumns, setVisibleColumns] = useState<Set<RadarColumnId>>(() => loadVisibleRadarColumns());
  const [revealMuted, setRevealMuted] = useState(false);
  // Global bands, not room-scoped: the Radar aggregates every room's calls
  // into one table, so a row's band must reflect the caller's whole record.
  const { qualityForContractGlobal, showMuted } = useCallerQuality();

  // One buildRadar pass per (contracts, quality) change; the muted counter and
  // the visible table both derive from it rather than each paying for their own.
  const radarRows = useMemo(
    () => buildRadar(contracts, qualityForContractGlobal),
    [contracts, qualityForContractGlobal],
  );

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

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      const ascFirst: SortKey[] = ['token', 'firstCaller'];
      setSortDir(ascFirst.includes(key) ? 'asc' : 'desc');
    }
  };

  const handleCopy = (address: string) => {
    navigator.clipboard.writeText(address);
    setCopiedAddr(address.toLowerCase());
    setTimeout(() => setCopiedAddr(null), 1500);
  };

  useEffect(() => {
    fetchContracts();
  }, [fetchContracts]);

  const rows = useMemo(() => {
    const all = radarRows.filter(
      // Mentions still count muted callers inside the row; what's dropped here is
      // a token *only* muted callers ever touched.
      (r) => !r.allMuted || !showMuted || revealMuted,
    );
    const filtered =
      windowFilter === 'all'
        ? all
        : all.filter((r) => {
            const windowMs =
              windowFilter === '1h' ? 3_600_000
                : windowFilter === '4h' ? 14_400_000
                  : 86_400_000;
            const cutoff = Date.now() - windowMs;
            return r.lastMentionAt >= cutoff;
          });

    const dir = sortDir === 'asc' ? 1 : -1;
    const cmpNum = (a: number | undefined | null, b: number | undefined | null) => {
      const av = a ?? -Infinity;
      const bv = b ?? -Infinity;
      if (av === bv) return 0;
      return av < bv ? -dir : dir;
    };
    const cmpStr = (a: string | undefined, b: string | undefined) => {
      const av = (a ?? '').toLowerCase();
      const bv = (b ?? '').toLowerCase();
      if (av === bv) return 0;
      return av < bv ? -dir : dir;
    };

    return [...filtered].sort((a, b) => {
      const fomoA = overlaps[a.address.toLowerCase()]?.trackedCount ?? 0;
      const fomoB = overlaps[b.address.toLowerCase()]?.trackedCount ?? 0;
      const liveA = liveMc[a.address.toLowerCase()];
      const liveB = liveMc[b.address.toLowerCase()];
      const mcNowA = liveA?.mc;
      const mcNowB = liveB?.mc;
      const multA = a.mcAtCall && mcNowA && a.mcAtCall > 0 ? mcNowA / a.mcAtCall : undefined;
      const multB = b.mcAtCall && mcNowB && b.mcAtCall > 0 ? mcNowB / b.mcAtCall : undefined;

      let result = 0;
      switch (sortKey) {
        case 'recent':
          result = cmpNum(a.lastMentionAt, b.lastMentionAt);
          break;
        case 'token':
          result = cmpStr(a.symbol ?? a.address, b.symbol ?? b.address);
          break;
        case 'mentions':
          result = cmpNum(a.mentions, b.mentions);
          break;
        case 'callers':
          result = cmpNum(a.callers.size, b.callers.size);
          break;
        case 'fomo':
          result = cmpNum(fomoA, fomoB);
          break;
        case 'groups':
          result = cmpNum(a.groups.size, b.groups.size);
          break;
        case 'windowMentions':
          result = cmpNum(
            countWithin(a.timestamps, MENTION_WINDOW_MS[mentionWindow]),
            countWithin(b.timestamps, MENTION_WINDOW_MS[mentionWindow]),
          );
          break;
        case 'firstCaller':
          result = cmpStr(a.firstCaller, b.firstCaller);
          break;
        case 'mcAtCall':
          result = cmpNum(a.mcAtCall, b.mcAtCall);
          break;
        case 'mcNow':
          result = cmpNum(mcNowA, mcNowB);
          break;
        case 'mult':
          result = cmpNum(multA, multB);
          break;
        case 'quality':
          result = cmpNum(a.bestRank, b.bestRank);
          break;
        default:
          result = 0;
      }
      if (result !== 0) return result;
      return b.lastMentionAt - a.lastMentionAt;
    });
  }, [
    radarRows, windowFilter, mentionWindow, sortKey, sortDir, liveMc, overlaps,
    showMuted, revealMuted,
  ]);

  const refreshOne = async (address: string, evmChain?: string) => {
    setRefreshingRow(address.toLowerCase());
    try {
      const [mc, meta] = await Promise.all([
        fetchMcNow(address),
        fetchTokenMetadata(address, evmChain, addressChains),
      ]);
      if (meta) applyMetadataToStore(address, meta);
      if (mc) {
        setLiveMc((prev) => ({
          ...prev,
          [address.toLowerCase()]: { ...mc, at: Date.now() },
        }));
      }
    } finally {
      setRefreshingRow(null);
    }
  };

  const refreshLiveMc = async () => {
    const top = rows.slice(0, 40);
    const results = await Promise.all(
      top.map(async (r) => [r.address.toLowerCase(), await fetchMcNow(r.address)] as const),
    );
    setLiveMc((prev) => {
      const next = { ...prev };
      for (const [key, result] of results) {
        if (result) next[key] = { ...result, at: Date.now() };
      }
      return next;
    });
  };

  const refreshTokenNames = async () => {
    const top = rows.slice(0, 40);
    const results = await Promise.all(
      top.map(async (r) => [r.address, await fetchTokenMetadata(r.address, r.evmChain, addressChains)] as const),
    );
    for (const [address, meta] of results) {
      if (meta) applyMetadataToStore(address, meta);
    }
  };

  const refreshAll = async () => {
    setRefreshing(true);
    try {
      await Promise.all([refreshLiveMc(), refreshTokenNames()]);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (rows.length === 0) return;
    refreshLiveMc();
    const id = setInterval(refreshLiveMc, 60_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length, windowFilter]);

  return (
    <div className="h-full flex flex-col min-h-0 bg-oct-bg overflow-hidden">
      <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b-2 border-black bg-oct-surface">
        <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-oct-muted">view: tokens</span>
        {(['1h', '4h', '24h', 'all'] as const).map((w) => (
          <button
            key={w}
            type="button"
            onClick={() => setWindowFilter(w)}
            className={`px-2 py-1 rounded-cockpit text-xs font-mono font-bold border-2 transition-all duration-100 ${
              windowFilter === w
                ? 'bg-oct-accent text-white border-black shadow-oct-hard-sm'
                : 'text-oct-muted border-transparent hover:text-oct-text hover:border-oct-border-bright'
            }`}
          >
            {w}
          </button>
        ))}
        <RadarSettings
          mentionWindow={mentionWindow}
          onMentionWindowChange={setMentionWindow}
          visibleColumns={visibleColumns}
          onVisibleColumnsChange={handleVisibleColumnsChange}
        />
        <div className="flex-1" />
        {showMuted && mutedOnlyCount > 0 && (
          <button
            type="button"
            onClick={() => setRevealMuted((v) => !v)}
            className={`flex items-center gap-1.5 px-2 py-1 rounded-cockpit text-xs font-bold uppercase border-2 transition-colors ${
              revealMuted
                ? 'bg-oct-accent text-white border-black'
                : 'text-oct-muted border-oct-border-bright hover:text-oct-text hover:border-oct-text'
            }`}
            title="Tokens only muted callers have posted"
          >
            {revealMuted ? <Eye size={12} /> : <EyeOff size={12} />}
            {mutedOnlyCount} muted
          </button>
        )}
        <span className="font-mono text-[11px] text-oct-muted">
          {rows.length} tokens
        </span>
        <button
          type="button"
          onClick={refreshAll}
          disabled={refreshing}
          className="flex items-center gap-1.5 px-2 py-1 rounded-cockpit text-xs font-bold uppercase text-oct-muted hover:text-oct-text border-2 border-oct-border-bright hover:border-oct-text transition-colors"
        >
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          refresh
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto overscroll-contain" style={{ overflowAnchor: 'none' }}>
        <table className="w-full text-left border-collapse min-w-[900px]">
          <thead className="sticky top-0 bg-oct-surface border-b-2 border-black z-10">
            <tr className="font-mono text-[10px] font-bold uppercase tracking-wider text-oct-muted">
              <SortHeader label="Token" sortKey="token" activeKey={sortKey} dir={sortDir} onSort={handleSort} />
              {activeColumns.map((col) =>
                col === 'windowMentions' ? (
                  <WindowMentionsHeader
                    key={col}
                    window={mentionWindow}
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onSort={handleSort}
                  />
                ) : (
                  <SortHeader
                    key={col}
                    label={RADAR_COLUMN_LABELS[col]}
                    sortKey={col}
                    activeKey={sortKey}
                    dir={sortDir}
                    onSort={handleSort}
                    align={col === 'firstCaller' ? 'left' : 'right'}
                  />
                ),
              )}
              <th className="px-3 py-2 font-medium w-8" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const key = r.address.toLowerCase();
              const live = liveMc[key];
              const mcNow = live?.mc;
              const mcNowDisplay = live?.display;
              const mult =
                r.mcAtCall && mcNow && r.mcAtCall > 0 ? mcNow / r.mcAtCall : undefined;
              const tag = r.mentions >= 5 ? 'crowded' : r.mentions === 1 ? 'early' : null;
              const plat = platformMeta(r.chain, r.evmChain);
              const convergenceTrade = findConvergenceForAddress(
                r.address,
                contracts,
                fomoTrades,
                convergenceWindowMs,
              );
              const shortAddr = `${r.address.slice(0, 6)}...${r.address.slice(-4)}`;
              const ticker = r.symbol ? `$${r.symbol}` : shortAddr;
              const subtitle = r.name ?? (r.symbol ? shortAddr : null);
              const isCopied = copiedAddr === key;
              const overlap = overlaps[key];
              const fomoHold = overlap?.trackedCount ?? 0;

              return (
                <tr
                  key={r.address}
                  className="border-b border-oct-border/50 hover:bg-oct-surface-raised/50 transition-colors"
                >
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2 min-w-0 max-w-[260px]">
                      <span
                        className="w-2.5 h-2.5 rounded-full shrink-0 ring-1 ring-black/20"
                        style={{ backgroundColor: plat.dot }}
                        title={plat.label}
                        aria-label={plat.label}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className="font-mono text-sm font-semibold text-oct-text truncate"
                            title={r.symbol ?? r.address}
                          >
                            {ticker}
                          </span>
                          {tag === 'crowded' && (
                            <span className="shrink-0 text-[9px] font-mono uppercase px-1.5 py-0.5 rounded-cockpit bg-oct-accent/15 text-oct-accent">
                              crowded
                            </span>
                          )}
                          {tag === 'early' && (
                            <span className="shrink-0 text-[9px] font-mono uppercase px-1.5 py-0.5 rounded-cockpit bg-green-500/15 text-green-400">
                              early
                            </span>
                          )}
                          {convergenceTrade && (
                            <SignalConvergenceBadge
                              trade={convergenceTrade}
                              windowMinutes={convergenceWindowMinutes}
                            />
                          )}
                        </div>
                        {subtitle && (
                          <div className="text-xs text-oct-muted truncate">{subtitle}</div>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => handleCopy(r.address)}
                        className="shrink-0 p-1 rounded hover:bg-oct-surface text-oct-muted hover:text-oct-text transition-colors"
                        title="Copy address"
                      >
                        {isCopied ? <Check size={13} className="text-green-400" /> : <Copy size={13} />}
                      </button>
                    </div>
                  </td>
                  {activeColumns.map((col) => {
                    switch (col) {
                      case 'mentions':
                        return (
                          <td key={col} className="px-3 py-2 text-right font-mono text-sm text-oct-text tabular-nums">
                            {r.mentions}
                          </td>
                        );
                      case 'callers':
                        return (
                          <td key={col} className="px-3 py-2 text-right font-mono text-sm text-oct-text tabular-nums">
                            {r.callers.size}
                          </td>
                        );
                      case 'fomo':
                        return (
                          <td key={col} className="px-3 py-2 text-right">
                            {fomoHold > 0 ? (
                              <span
                                className="inline-flex items-center gap-1 font-mono text-xs font-bold text-oct-accent"
                                title={overlap?.trackedHandles?.map((h) => `@${h}`).join(', ') ?? ''}
                              >
                                <Users size={12} />
                                {fomoHold}
                              </span>
                            ) : (
                              <span className="text-oct-muted">·</span>
                            )}
                          </td>
                        );
                      case 'groups':
                        return (
                          <td key={col} className="px-3 py-2 text-right font-mono text-sm text-oct-text tabular-nums">
                            {r.groups.size}
                          </td>
                        );
                      case 'windowMentions':
                        return (
                          <td key={col} className="px-3 py-2 text-right font-mono text-sm text-oct-text tabular-nums">
                            {countWithin(r.timestamps, MENTION_WINDOW_MS[mentionWindow]) || '·'}
                          </td>
                        );
                      case 'recent':
                        return (
                          <td key={col} className="px-3 py-2 text-right font-mono text-xs text-oct-muted tabular-nums whitespace-nowrap">
                            {timeAgoShort(r.lastMentionAt)}
                          </td>
                        );
                      case 'firstCaller':
                        return (
                          <td key={col} className="px-3 py-2 text-sm truncate max-w-[160px]">
                            {/* Same band colour + badge as the feed (Message.tsx). A name
                                is worth very different amounts depending on who it is, and
                                the radar was the one place that withheld that. */}
                            {r.firstCallerBand && bandIsNotable(r.firstCallerBand) && (
                              <span
                                className={`text-[9px] font-bold uppercase px-1 py-0.5 rounded-cockpit mr-1 align-middle ${BAND_BADGE_CLASS[r.firstCallerBand]}`}
                                title={BAND_TITLE[r.firstCallerBand]}
                              >
                                {BAND_LABELS[r.firstCallerBand]}
                              </span>
                            )}
                            <span
                              style={{ color: r.firstCallerBand ? BAND_NAME_COLOR[r.firstCallerBand] ?? undefined : undefined }}
                              className={r.firstCallerBand && BAND_NAME_COLOR[r.firstCallerBand] ? '' : 'text-oct-muted'}
                            >
                              {r.firstCaller}
                            </span>
                          </td>
                        );
                      case 'mcAtCall':
                        return (
                          <td key={col} className="px-3 py-2 text-right font-mono text-sm text-oct-muted tabular-nums">
                            {r.mcAtCallDisplay ?? '—'}
                          </td>
                        );
                      case 'mcNow':
                        return (
                          <td key={col} className="px-3 py-2 text-right font-mono text-sm text-oct-live tabular-nums whitespace-nowrap">
                            {mcNowDisplay ?? '—'}
                            {live && (
                              <span className="ml-1 text-[10px] text-oct-muted">{timeAgoShort(live.at)}</span>
                            )}
                          </td>
                        );
                      case 'mult':
                        return (
                          <td key={col} className="px-3 py-2 text-right font-mono text-sm tabular-nums">
                            {mult != null ? (
                              <span className={mult >= 1 ? 'text-green-400' : 'text-oct-accent'}>
                                {mult.toFixed(1)}x
                              </span>
                            ) : (
                              <span className="text-oct-muted">—</span>
                            )}
                          </td>
                        );
                      case 'quality':
                        return (
                          <td key={col} className="px-3 py-2 text-right whitespace-nowrap">
                            {r.bestBand && r.bestBand !== 'unrated' ? (
                              <span
                                className={`inline-flex items-center gap-1 text-[11px] font-bold uppercase ${BAND_TEXT_CLASS[r.bestBand]}`}
                                title={BAND_TITLE[r.bestBand]}
                              >
                                <span className={`w-1.5 h-1.5 rounded-full ${BAND_DOT_CLASS[r.bestBand]}`} />
                                {BAND_LABELS[r.bestBand]}
                              </span>
                            ) : (
                              <span className="text-oct-muted text-[11px]">—</span>
                            )}
                          </td>
                        );
                      default:
                        return null;
                    }
                  })}
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      onClick={() => refreshOne(r.address, r.evmChain)}
                      disabled={refreshingRow === key}
                      className="p-1 rounded hover:bg-oct-surface text-oct-muted hover:text-oct-text transition-colors"
                      title="Refresh market cap"
                    >
                      <RefreshCw size={12} className={refreshingRow === key ? 'animate-spin' : ''} />
                    </button>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={2 + activeColumns.length} className="px-4 py-16 text-center text-sm text-oct-muted">
                  No tokens in this window. Contracts from Feed will aggregate here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
