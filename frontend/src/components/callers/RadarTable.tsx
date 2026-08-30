import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Copy, Check, Users, Eye, EyeOff } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { SortHeader } from '../common/SortHeader';
import { useSort } from '../../hooks/useSort';
import { compareNumeric, compareText, type SortDir } from '../../lib/sort';
import { useFomoHolderOverlap } from '../../hooks/useFomoHolderOverlap';
import SignalConvergenceBadge from '../SignalConvergenceBadge';
import {
  buildConvergenceIndex,
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
import { useNetworkFirstScans, type NetworkFirstScan } from '../../hooks/useNetworkFirstScans';
import { useCallerQuality, refreshTokenPeak, type CallerQuality } from '../../hooks/useCallerQuality';
import {
  BAND_DOT_CLASS,
  BAND_TEXT_CLASS,
  BAND_TITLE,
  BAND_BADGE_CLASS,
  BAND_NAME_COLOR,
  bandIsNotable,
} from '../../utils/callerBandStyle';
import {
  BAND_LABELS,
  radarEmojiForMultiple,
  resolveRadarEmojiRules,
  type CallerBand,
  type RadarMultipleEmojiRule,
} from '@oct/shared';
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
  // Rick's cross-server first-caller footer, earliest reading across this
  // token's rows ("espadabtw @ 49.3K · 86x · 10h" → name, mcap, absolute ms).
  rickFirstCallerName?: string;
  rickFirstCallMcapUsd?: number;
  rickFirstCallAtMs?: number;
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

    // Rick's global-first footer is token-level; keep the earliest reading.
    // A timestamped reading beats an untimestamped one, an earlier timestamp
    // beats a later one, and the first untimestamped reading otherwise sticks.
    if (c.firstCallerName != null || c.firstCallMcapUsd != null || c.firstCallAt != null) {
      const atMs = c.firstCallAt ? new Date(c.firstCallAt).getTime() : NaN;
      const hasAt = Number.isFinite(atMs);
      const rowHasAt = row.rickFirstCallAtMs != null;
      const rowHasAny =
        row.rickFirstCallerName != null || row.rickFirstCallMcapUsd != null || rowHasAt;
      const wins =
        !rowHasAny || (hasAt && (!rowHasAt || atMs < (row.rickFirstCallAtMs as number)));
      if (wins) {
        row.rickFirstCallerName = c.firstCallerName;
        row.rickFirstCallMcapUsd = c.firstCallMcapUsd;
        row.rickFirstCallAtMs = hasAt ? atMs : undefined;
      }
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

interface GlobalFirstPick {
  /** Who saw it first — a Rick-named caller, or the anonymous pool. */
  label: string;
  mcapUsd?: number;
  atMs?: number;
}

/**
 * Best available global-first info, most-informative first: Rick's
 * cross-server footer (names the caller), else the anonymous network pool.
 * When both exist the EARLIER sighting wins; a Rick reading without a
 * timestamp can't be compared, so Rick's richer data is preferred.
 */
function pickGlobalFirst(r: RadarRow, net?: NetworkFirstScan): GlobalFirstPick | null {
  const rickHas =
    r.rickFirstCallerName != null || r.rickFirstCallMcapUsd != null || r.rickFirstCallAtMs != null;
  const rick: GlobalFirstPick | null = rickHas
    ? {
        label: r.rickFirstCallerName ?? 'rick',
        mcapUsd: r.rickFirstCallMcapUsd,
        atMs: r.rickFirstCallAtMs,
      }
    : null;

  const netAtMs = net ? new Date(net.firstSeenAt).getTime() : NaN;
  const network: GlobalFirstPick | null =
    net && Number.isFinite(netAtMs)
      ? { label: 'network', mcapUsd: net.fdvAtFirst ?? undefined, atMs: netAtMs }
      : null;

  if (rick && network) {
    if (rick.atMs != null && network.atMs != null) {
      return network.atMs < rick.atMs ? network : rick;
    }
    return rick;
  }
  return rick ?? network;
}

const GLOBAL_FIRST_TITLE =
  "Earliest known call/scan: from Rick's cross-server data or the anonymous OCT network pool. Never reveals which group or user saw it.";

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
  | 'globalFirst'
  | 'mcAtCall'
  | 'mcNow'
  | 'mult'
  | 'quality'
  | 'recent';

// The × column is live MC ÷ MC at the first call. Two things it is NOT, both of
// which the emoji markers make it tempting to read as: it is not a realised
// return (nobody bought at MC@call and sold now), and it is not a peak — it
// tracks the live quote and falls back down when the token does. MC@call itself
// is the earliest FDV captured near the first mention, so the ratio is an
// approximation on both ends. Settings › Caller Quality carries the matching
// caveat for the peak-based caller multiples ("floors, not exact ATHs"); this
// one is a different number and gets its own wording.
const MULT_TITLE =
  'Live market cap ÷ market cap at the first call. A live, unrealised quote that falls as well as rises — not profit, and not a peak. MC@call is the earliest FDV captured near that first mention, so treat the ratio as approximate. Emoji markers just flag the level the × has reached; configure them under columns.';

// Text columns read better opened A→Z; every numeric column opens descending
// (biggest on top). Module-level so useSort's memoised handler stays stable.
const RADAR_ASC_FIRST: readonly SortKey[] = ['token', 'firstCaller'];

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
    <SortHeader<SortKey>
      label={mentionWindow}
      sortKey="windowMentions"
      activeKey={sortKey}
      dir={sortDir}
      onSort={onSort}
      align="right"
    />
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
  const updateConfig = useAppStore((s) => s.updateConfig);
  const fetchContracts = useAppStore((s) => s.fetchContracts);
  const addressChains = useAppStore((s) => s.addressChains);
  const { overlaps } = useFomoHolderOverlap(contracts);
  const [liveMc, setLiveMc] = useState<Record<string, LiveMc>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [refreshingRow, setRefreshingRow] = useState<string | null>(null);
  const [windowFilter, setWindowFilter] = useState<'1h' | '4h' | '24h' | 'all'>('24h');
  const [mentionWindow, setMentionWindow] = useState<MentionWindow>('15m');
  const { sortKey, sortDir, onSort: handleSort } = useSort<SortKey>('recent', 'desc', RADAR_ASC_FIRST);
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

    const cmpNum = (a: number | undefined | null, b: number | undefined | null) =>
      compareNumeric(a, b, sortDir);
    const cmpStr = (a: string | undefined, b: string | undefined) =>
      compareText(a, b, sortDir);

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
        case 'globalFirst':
          result = cmpNum(
            pickGlobalFirst(a, networkScans[a.address])?.atMs,
            pickGlobalFirst(b, networkScans[b.address])?.atMs,
          );
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
    showMuted, revealMuted, networkScans,
  ]);

  const refreshOne = async (address: string, evmChain?: string) => {
    setRefreshingRow(address.toLowerCase());
    try {
      const [mc, meta] = await Promise.all([
        fetchMcNow(address),
        fetchTokenMetadata(address, evmChain, addressChains),
      ]);
      // The row refresh is also the on-demand peak backfill. `fetchMcNow` above
      // asks DexScreener straight from the browser, so that observation never
      // reaches the peak store; this asks the backend to re-observe and fold
      // the result in, which re-derives every caller who called this token.
      // Not awaited — a slow provider must not hold the spinner.
      void refreshTokenPeak(address, { evmChain });
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
      <div className="oct-headerbar shrink-0 flex items-center gap-2 px-4 py-2.5">
        <span className="oct-eyebrow">view: tokens</span>
        <div className="flex gap-1">
          {(['1h', '4h', '24h', 'all'] as const).map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setWindowFilter(w)}
              className={`px-2.5 py-1 rounded-oct-sm text-[11px] font-mono font-bold border transition-all ${
                windowFilter === w
                  ? 'bg-oct-accent text-white border-oct-accent/50 shadow-oct-glow-accent'
                  : 'text-oct-muted border-transparent hover:text-oct-text hover:border-oct-border-bright'
              }`}
            >
              {w}
            </button>
          ))}
        </div>
        <RadarSettings
          mentionWindow={mentionWindow}
          onMentionWindowChange={setMentionWindow}
          visibleColumns={visibleColumns}
          onVisibleColumnsChange={handleVisibleColumnsChange}
          emojiRules={emojiRules}
          onEmojiRulesChange={handleEmojiRulesChange}
        />
        <div className="flex-1" />
        {showMuted && mutedOnlyCount > 0 && (
          <button
            type="button"
            onClick={() => setRevealMuted((v) => !v)}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-oct-sm text-[11px] font-mono font-bold uppercase border transition-all ${
              revealMuted
                ? 'bg-oct-accent text-white border-oct-accent/50 shadow-oct-glow-accent'
                : 'text-oct-muted border-oct-border-bright hover:text-oct-text hover:border-oct-text'
            }`}
            title="Tokens only muted callers have posted"
          >
            {revealMuted ? <Eye size={12} /> : <EyeOff size={12} />}
            {mutedOnlyCount} muted
          </button>
        )}
        <span className="font-mono text-[11px] font-semibold text-oct-muted tabular-nums">
          {rows.length} tokens
        </span>
        <button
          type="button"
          onClick={refreshAll}
          disabled={refreshing}
          className="oct-icon-btn px-2.5 py-1.5 text-[11px] font-mono font-bold uppercase"
        >
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          refresh
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto overscroll-contain" style={{ overflowAnchor: 'none' }}>
        <table className="w-full text-left border-collapse min-w-[900px]">
          <thead className="oct-thead sticky top-0 z-10">
            <tr className="font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-oct-muted">
              <SortHeader<SortKey> label="Token" sortKey="token" activeKey={sortKey} dir={sortDir} onSort={handleSort} />
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
                  <SortHeader<SortKey>
                    key={col}
                    label={RADAR_COLUMN_LABELS[col]}
                    sortKey={col}
                    activeKey={sortKey}
                    dir={sortDir}
                    onSort={handleSort}
                    align={col === 'firstCaller' || col === 'globalFirst' ? 'left' : 'right'}
                    title={col === 'mult' ? MULT_TITLE : undefined}
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
              const convergenceTrade = convergenceByAddress.get(key) ?? null;
              const shortAddr = `${r.address.slice(0, 6)}...${r.address.slice(-4)}`;
              const ticker = r.symbol ? `$${r.symbol}` : shortAddr;
              const subtitle = r.name ?? (r.symbol ? shortAddr : null);
              const isCopied = copiedAddr === key;
              const overlap = overlaps[key];
              const fomoHold = overlap?.trackedCount ?? 0;

              return (
                <tr
                  key={r.address}
                  className="border-b border-oct-border/50 oct-row-hover"
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
                            <span className="shrink-0 text-[10px] font-mono font-semibold uppercase px-1.5 py-0.5 rounded-full bg-oct-accent/15 text-oct-accent">
                              crowded
                            </span>
                          )}
                          {tag === 'early' && (
                            <span className="shrink-0 text-[10px] font-mono font-semibold uppercase px-1.5 py-0.5 rounded-full bg-oct-green/15 text-oct-green">
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
                        {isCopied ? <Check size={13} className="text-oct-green" /> : <Copy size={13} />}
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
                                className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full mr-1 align-middle ${BAND_BADGE_CLASS[r.firstCallerBand]}`}
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
                      case 'globalFirst': {
                        const gf = pickGlobalFirst(r, networkScans[r.address]);
                        return (
                          <td
                            key={col}
                            className="px-3 py-2 font-mono text-xs whitespace-nowrap max-w-[200px] truncate"
                            title={GLOBAL_FIRST_TITLE}
                          >
                            {gf ? (
                              <>
                                <span className={gf.label === 'network' ? 'text-oct-muted' : 'text-oct-text'}>
                                  {gf.label}
                                </span>
                                {gf.mcapUsd != null && gf.mcapUsd > 0 && (
                                  <span className="text-oct-muted"> @ {formatCompact(gf.mcapUsd)}</span>
                                )}
                                {gf.atMs != null && (
                                  <span className="text-oct-muted tabular-nums"> · {timeAgoShort(gf.atMs)}</span>
                                )}
                              </>
                            ) : (
                              <span className="text-oct-muted">—</span>
                            )}
                          </td>
                        );
                      }
                      case 'mcNow':
                        return (
                          <td key={col} className="px-3 py-2 text-right font-mono text-sm text-oct-live tabular-nums whitespace-nowrap">
                            {mcNowDisplay ?? '—'}
                            {live && (
                              <span className="ml-1 text-[10px] text-oct-muted">{timeAgoShort(live.at)}</span>
                            )}
                          </td>
                        );
                      case 'mult': {
                        // One marker only: `radarEmojiForMultiple` returns the
                        // highest matching rung, never the set of rungs passed.
                        // Fixed-width and outside the tabular-nums span so a
                        // wide glyph can't push the digits out of column.
                        const emoji = radarEmojiForMultiple(mult, emojiRules);
                        return (
                          <td key={col} className="px-3 py-2 text-right font-mono text-sm" title={MULT_TITLE}>
                            <span className="inline-flex items-center justify-end gap-1 whitespace-nowrap">
                              <span className="w-4 text-center leading-none" aria-hidden={!emoji}>
                                {emoji ?? ''}
                              </span>
                              {mult != null ? (
                                <span className={`tabular-nums ${mult >= 1 ? 'text-oct-green' : 'text-oct-accent'}`}>
                                  {mult.toFixed(1)}x
                                </span>
                              ) : (
                                <span className="text-oct-muted">—</span>
                              )}
                            </span>
                          </td>
                        );
                      }
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
                <td colSpan={2 + activeColumns.length} className="px-4 py-20 text-center">
                  <p className="oct-eyebrow mb-2">Radar</p>
                  <p className="text-sm text-oct-muted">No tokens in this window. Contracts from Feed will aggregate here.</p>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
