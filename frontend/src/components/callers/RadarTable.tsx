import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Eye, EyeOff } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { SortHeader } from '../common/SortHeader';
import { useSort } from '../../hooks/useSort';
import { compareNumeric, compareText, type SortDir } from '../../lib/sort';
import { useFomoHolderOverlap } from '../../hooks/useFomoHolderOverlap';
import {
  buildConvergenceIndex,
  getSignalConvergenceWindowMs,
} from '../../utils/signalConvergence';
import RadarSettings, { type MentionWindow } from './RadarSettings';
import {
  RADAR_COLUMN_LABELS,
  RADAR_COLUMN_ORDER,
  loadVisibleRadarColumns,
  saveVisibleRadarColumns,
  type RadarColumnId,
} from './radarColumns';
import { isHostedMode, getAccessToken } from '../../lib/supabase';
import { useNetworkFirstScans } from '../../hooks/useNetworkFirstScans';
import { useCallerQuality, refreshTokenPeak } from '../../hooks/useCallerQuality';
import {
  buildRadar,
  countWithin,
  formatCompact,
  pickGlobalFirst,
  MENTION_WINDOW_MS,
  type LiveMc,
  type RadarRow,
} from './radarRows';
import RadarTableRow, { MULT_TITLE } from './RadarTableRow';
import { resolveRadarEmojiRules, type RadarMultipleEmojiRule } from '@oct/shared';
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
  const [refreshing, setRefreshing] = useState(false);
  const [refreshingRow, setRefreshingRow] = useState<string | null>(null);
  const [windowFilter, setWindowFilter] = useState<'1h' | '4h' | '24h' | 'all'>('24h');
  const [mentionWindow, setMentionWindow] = useState<MentionWindow>('15m');
  const { sortKey, sortDir, onSort: handleSort } = useSort<SortKey>('recent', 'desc', RADAR_ASC_FIRST);
  const [copiedAddr, setCopiedAddr] = useState<string | null>(null);
  // Bumped once a minute so memoized rows refresh their relative "ago" text
  // even when nothing else about them changed.
  const [agoTick, setAgoTick] = useState(0);
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

  const refreshOne = useCallback(async (address: string, evmChain?: string) => {
    setRefreshingRow(address.toLowerCase());
    try {
      const [mc, meta] = await Promise.all([
        fetchMcNow(address),
        // Chains read at call time (not closed over) so this callback stays
        // reference-stable and memoized rows never re-render because of it.
        fetchTokenMetadata(address, evmChain, useAppStore.getState().addressChains),
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
  }, []);

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
      top.map(async (r) => [r.address, await fetchTokenMetadata(r.address, r.evmChain, useAppStore.getState().addressChains)] as const),
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
    const id = setInterval(() => {
      refreshLiveMc();
      setAgoTick((t) => t + 1);
    }, 60_000);
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
