import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Star, Copy, Check, Users, ChevronUp, ChevronDown } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useFomoHolderOverlap } from '../../hooks/useFomoHolderOverlap';
import SignalConvergenceBadge from '../SignalConvergenceBadge';
import {
  findConvergenceForAddress,
  getSignalConvergenceWindowMs,
} from '../../utils/signalConvergence';
import type { ContractEntry } from '../../types';
import { isHostedMode, getAccessToken } from '../../lib/supabase';

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

function Sparkline({ timestamps, firstSeenAt }: { timestamps: number[]; firstSeenAt: number }) {
  const points = useMemo(() => {
    const BUCKETS = 14;
    const now = Date.now();
    const span = Math.max(now - firstSeenAt, 60_000);
    const bins = new Array(BUCKETS).fill(0);
    for (const t of timestamps) {
      const idx = Math.min(BUCKETS - 1, Math.max(0, Math.floor(((t - firstSeenAt) / span) * BUCKETS)));
      bins[idx]++;
    }
    const max = Math.max(1, ...bins);
    const w = 52;
    const h = 16;
    const step = w / (BUCKETS - 1);
    return bins
      .map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`)
      .join(' ');
  }, [timestamps, firstSeenAt]);

  return (
    <svg width={52} height={16} className="overflow-visible">
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.25}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function buildRadar(contracts: ContractEntry[]): RadarRow[] {
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
        firstSeenAt: ts,
        lastMentionAt: ts,
        timestamps: [],
        mcAtCall: c.fdvAtCall,
        mcAtCallDisplay: c.fdvAtCallDisplay,
      };
      map.set(key, row);
    }
    row.mentions += 1;
    row.timestamps.push(ts);
    row.callers.add(c.authorId);
    if (c.guildId) row.groups.add(c.guildId);
    else if (c.channelId) row.groups.add(c.channelId);
    if (ts < row.firstSeenAt) {
      row.firstSeenAt = ts;
      row.firstCaller = c.authorName;
      row.mcAtCall = c.fdvAtCall ?? row.mcAtCall;
      row.mcAtCallDisplay = c.fdvAtCallDisplay ?? row.mcAtCallDisplay;
    }
    if (ts > row.lastMentionAt) row.lastMentionAt = ts;
    row.symbol = row.symbol ?? c.tokenSymbol;
    row.name = row.name ?? c.tokenName;
    row.evmChain = row.evmChain ?? c.evmChain;
  }
  return [...map.values()];
}

type SortKey =
  | 'token'
  | 'mentions'
  | 'callers'
  | 'fomo'
  | 'groups'
  | 'plat'
  | 'm15'
  | 'h1'
  | 'h4'
  | 'firstCaller'
  | 'mcAtCall'
  | 'mcNow'
  | 'mult'
  | 'recent';

type SortDir = 'asc' | 'desc';

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

interface TokenSnapshotResult {
  mc?: number;
  display?: string;
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

async function fetchTokenSnapshot(
  address: string,
  evmChain?: string,
  addressChains?: Record<string, string>,
): Promise<TokenSnapshotResult | null> {
  try {
    const chain = resolveSnapshotChain(address, evmChain, addressChains);
    const res = await apiFetch(
      `${API_BASE}/tokens/${encodeURIComponent(chain)}/${encodeURIComponent(address)}/snapshot`,
    );
    if (!res.ok) return null;
    const data = await res.json() as {
      found?: boolean;
      mc?: number;
      mcDisplay?: string;
      symbol?: string;
      name?: string;
      pair?: string;
      evmChain?: string;
      source?: ContractEntry['enrichmentSource'];
    };
    if (!data.found) return null;
    return {
      mc: data.mc,
      display: data.mcDisplay,
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

function applySnapshotToStore(address: string, snap: TokenSnapshotResult): void {
  if (!snap.symbol && !snap.name && snap.mc == null) return;
  useAppStore.getState().enrichContract({
    address,
    tokenSymbol: snap.symbol,
    tokenName: snap.name,
    tokenPair: snap.pair,
    fdvAtCall: snap.mc,
    fdvAtCallDisplay: snap.display,
    enrichmentSource: snap.source,
    enrichedAt: new Date().toISOString(),
    evmChain: snap.evmChain,
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
  const [sortKey, setSortKey] = useState<SortKey>('recent');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [copiedAddr, setCopiedAddr] = useState<string | null>(null);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      const ascFirst: SortKey[] = ['token', 'firstCaller', 'plat'];
      setSortDir(ascFirst.includes(key) ? 'asc' : 'desc');
    }
  };

  const applyLatestSort = () => {
    if (sortKey === 'recent') {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortKey('recent');
      setSortDir('desc');
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
    const all = buildRadar(contracts);
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
      const mcNowA = liveA?.mc ?? a.mcAtCall;
      const mcNowB = liveB?.mc ?? b.mcAtCall;
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
        case 'plat':
          result = cmpStr(
            platformMeta(a.chain, a.evmChain).label,
            platformMeta(b.chain, b.evmChain).label,
          );
          break;
        case 'm15':
          result = cmpNum(countWithin(a.timestamps, 900_000), countWithin(b.timestamps, 900_000));
          break;
        case 'h1':
          result = cmpNum(countWithin(a.timestamps, 3_600_000), countWithin(b.timestamps, 3_600_000));
          break;
        case 'h4':
          result = cmpNum(countWithin(a.timestamps, 14_400_000), countWithin(b.timestamps, 14_400_000));
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
        default:
          result = 0;
      }
      if (result !== 0) return result;
      return b.lastMentionAt - a.lastMentionAt;
    });
  }, [contracts, windowFilter, sortKey, sortDir, liveMc, overlaps]);

  const refreshOne = async (address: string, evmChain?: string) => {
    setRefreshingRow(address.toLowerCase());
    try {
      const result = await fetchTokenSnapshot(address, evmChain, addressChains);
      if (result) {
        applySnapshotToStore(address, result);
        if (result.mc != null) {
          setLiveMc((prev) => ({
            ...prev,
            [address.toLowerCase()]: {
              mc: result.mc!,
              display: result.display ?? String(result.mc),
              at: Date.now(),
            },
          }));
        }
      }
    } finally {
      setRefreshingRow(null);
    }
  };

  const refreshLiveMc = async () => {
    setRefreshing(true);
    try {
      const top = rows.slice(0, 40);
      const results = await Promise.all(
        top.map(async (r) => [r.address.toLowerCase(), r.address, await fetchTokenSnapshot(r.address, r.evmChain, addressChains)] as const),
      );
      for (const [, address, result] of results) {
        if (result) applySnapshotToStore(address, result);
      }
      setLiveMc((prev) => {
        const next = { ...prev };
        for (const [key, , result] of results) {
          if (result?.mc != null) {
            next[key] = { mc: result.mc, display: result.display ?? String(result.mc), at: Date.now() };
          }
        }
        return next;
      });
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
    <div className="flex-1 flex flex-col min-h-0 bg-oct-bg">
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
        <span className="w-px h-4 bg-oct-border-bright mx-0.5" aria-hidden />
        <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-oct-muted">sort:</span>
        <button
          type="button"
          onClick={applyLatestSort}
          title={sortKey === 'recent' && sortDir === 'asc' ? 'Oldest mention first' : 'Newest mention first'}
          className={`px-2 py-1 rounded-cockpit text-xs font-mono font-bold border-2 transition-all duration-100 ${
            sortKey === 'recent'
              ? 'bg-oct-accent text-white border-black shadow-oct-hard-sm'
              : 'text-oct-muted border-transparent hover:text-oct-text hover:border-oct-border-bright'
          }`}
        >
          latest{sortKey === 'recent' ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''}
        </button>
        <div className="flex-1" />
        <span className="font-mono text-[11px] text-oct-muted">
          {rows.length} tokens
        </span>
        <button
          type="button"
          onClick={refreshLiveMc}
          disabled={refreshing}
          className="flex items-center gap-1.5 px-2 py-1 rounded-cockpit text-xs font-bold uppercase text-oct-muted hover:text-oct-text border-2 border-oct-border-bright hover:border-oct-text transition-colors"
        >
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          refresh
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        <table className="w-full text-left border-collapse min-w-[1100px]">
          <thead className="sticky top-0 bg-oct-surface border-b-2 border-black z-10">
            <tr className="font-mono text-[10px] font-bold uppercase tracking-wider text-oct-muted">
              <th className="px-3 py-2 font-medium w-8" />
              <SortHeader label="Token" sortKey="token" activeKey={sortKey} dir={sortDir} onSort={handleSort} />
              <SortHeader label="Mentions" sortKey="mentions" activeKey={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <SortHeader label="Callers" sortKey="callers" activeKey={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <SortHeader label="FOMO" sortKey="fomo" activeKey={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <SortHeader label="Groups" sortKey="groups" activeKey={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <SortHeader label="Plat" sortKey="plat" activeKey={sortKey} dir={sortDir} onSort={handleSort} />
              <SortHeader label="15m" sortKey="m15" activeKey={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <SortHeader label="1h" sortKey="h1" activeKey={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <SortHeader label="4h" sortKey="h4" activeKey={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <th className="px-3 py-2 font-medium">Spark</th>
              <SortHeader label="Latest" sortKey="recent" activeKey={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <SortHeader label="First caller" sortKey="firstCaller" activeKey={sortKey} dir={sortDir} onSort={handleSort} />
              <SortHeader label="MC@call" sortKey="mcAtCall" activeKey={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <SortHeader label="MC now" sortKey="mcNow" activeKey={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <SortHeader label="x" sortKey="mult" activeKey={sortKey} dir={sortDir} onSort={handleSort} align="right" />
              <th className="px-3 py-2 font-medium w-8" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const key = r.address.toLowerCase();
              const live = liveMc[key];
              const mcNow = live?.mc ?? r.mcAtCall;
              const mcNowDisplay = live?.display ?? r.mcAtCallDisplay;
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
                  <td className="px-3 py-2 text-oct-muted">
                    <Star size={12} strokeWidth={1.5} />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2 min-w-0 max-w-[240px]">
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
                  <td className="px-3 py-2 text-right font-mono text-sm text-oct-text tabular-nums">{r.mentions}</td>
                  <td className="px-3 py-2 text-right font-mono text-sm text-oct-text tabular-nums">{r.callers.size}</td>
                  <td className="px-3 py-2 text-right">
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
                  <td className="px-3 py-2 text-right font-mono text-sm text-oct-text tabular-nums">{r.groups.size}</td>
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-1.5 font-mono text-xs text-oct-muted" title={plat.label}>
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: plat.dot }} />
                      {plat.label}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-sm text-oct-text tabular-nums">
                    {countWithin(r.timestamps, 900_000) || '·'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-sm text-oct-text tabular-nums">
                    {countWithin(r.timestamps, 3_600_000) || '·'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-sm text-oct-text tabular-nums">
                    {countWithin(r.timestamps, 14_400_000) || '·'}
                  </td>
                  <td className="px-3 py-2 text-oct-live">
                    <Sparkline timestamps={r.timestamps} firstSeenAt={r.firstSeenAt} />
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-oct-muted tabular-nums whitespace-nowrap">
                    {timeAgoShort(r.lastMentionAt)}
                  </td>
                  <td className="px-3 py-2 text-sm text-oct-muted truncate max-w-[120px]">{r.firstCaller}</td>
                  <td className="px-3 py-2 text-right font-mono text-sm text-oct-muted tabular-nums">
                    {r.mcAtCallDisplay ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-sm text-oct-live tabular-nums whitespace-nowrap">
                    {mcNowDisplay ?? '—'}
                    {live && (
                      <span className="ml-1 text-[10px] text-oct-muted">{timeAgoShort(live.at)}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-sm tabular-nums">
                    {mult != null ? (
                      <span className={mult >= 1 ? 'text-green-400' : 'text-oct-accent'}>
                        {mult.toFixed(1)}x
                      </span>
                    ) : (
                      <span className="text-oct-muted">—</span>
                    )}
                  </td>
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
                <td colSpan={17} className="px-4 py-16 text-center text-sm text-oct-muted">
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
