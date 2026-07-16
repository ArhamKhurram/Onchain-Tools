import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Star, Copy, Check } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import type { ContractEntry } from '../../types';

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
  return [...map.values()].sort((a, b) => b.mentions - a.mentions || b.lastMentionAt - a.lastMentionAt);
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

export default function RadarTable() {
  const contracts = useAppStore((s) => s.contracts);
  const fetchContracts = useAppStore((s) => s.fetchContracts);
  const [liveMc, setLiveMc] = useState<Record<string, LiveMc>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [refreshingRow, setRefreshingRow] = useState<string | null>(null);
  const [windowFilter, setWindowFilter] = useState<'1h' | '4h' | '24h' | 'all'>('24h');
  const [copiedAddr, setCopiedAddr] = useState<string | null>(null);

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
    if (windowFilter === 'all') return all;
    const windowMs =
      windowFilter === '1h' ? 3_600_000
        : windowFilter === '4h' ? 14_400_000
          : 86_400_000;
    const cutoff = Date.now() - windowMs;
    return all.filter((r) => r.lastMentionAt >= cutoff);
  }, [contracts, windowFilter]);

  const refreshOne = async (address: string) => {
    setRefreshingRow(address.toLowerCase());
    try {
      const result = await fetchMcNow(address);
      if (result) {
        setLiveMc((prev) => ({ ...prev, [address.toLowerCase()]: { ...result, at: Date.now() } }));
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
        top.map(async (r) => [r.address.toLowerCase(), await fetchMcNow(r.address)] as const),
      );
      setLiveMc((prev) => {
        const next = { ...prev };
        for (const [key, result] of results) {
          if (result) next[key] = { ...result, at: Date.now() };
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
      <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-oct-border">
        <span className="font-mono text-[10px] uppercase tracking-widest text-oct-muted">view: tokens</span>
        {(['1h', '4h', '24h', 'all'] as const).map((w) => (
          <button
            key={w}
            type="button"
            onClick={() => setWindowFilter(w)}
            className={`px-2 py-1 rounded-cockpit text-xs font-mono transition-colors ${
              windowFilter === w
                ? 'bg-oct-live-dim text-oct-live'
                : 'text-oct-muted hover:text-oct-text'
            }`}
          >
            {w}
          </button>
        ))}
        <div className="flex-1" />
        <span className="font-mono text-[11px] text-oct-muted">
          {rows.length} tokens
        </span>
        <button
          type="button"
          onClick={refreshLiveMc}
          disabled={refreshing}
          className="flex items-center gap-1.5 px-2 py-1 rounded-cockpit text-xs text-oct-muted hover:text-oct-text border border-oct-border transition-colors"
        >
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          refresh
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        <table className="w-full text-left border-collapse min-w-[1040px]">
          <thead className="sticky top-0 bg-oct-surface border-b border-oct-border z-10">
            <tr className="font-mono text-[10px] uppercase tracking-wider text-oct-muted">
              <th className="px-3 py-2 font-medium w-8" />
              <th className="px-3 py-2 font-medium">Token</th>
              <th className="px-3 py-2 font-medium text-right">Mentions</th>
              <th className="px-3 py-2 font-medium text-right">Callers</th>
              <th className="px-3 py-2 font-medium text-right">Groups</th>
              <th className="px-3 py-2 font-medium">Plat</th>
              <th className="px-3 py-2 font-medium text-right">15m</th>
              <th className="px-3 py-2 font-medium text-right">1h</th>
              <th className="px-3 py-2 font-medium text-right">4h</th>
              <th className="px-3 py-2 font-medium">Spark</th>
              <th className="px-3 py-2 font-medium">First caller</th>
              <th className="px-3 py-2 font-medium text-right">MC@call</th>
              <th className="px-3 py-2 font-medium text-right">MC now</th>
              <th className="px-3 py-2 font-medium text-right">x</th>
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
              const shortAddr = `${r.address.slice(0, 6)}...${r.address.slice(-4)}`;
              const ticker = r.symbol ? `$${r.symbol}` : shortAddr;
              const subtitle = r.name ?? (r.symbol ? shortAddr : null);
              const isCopied = copiedAddr === key;

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
                      onClick={() => refreshOne(r.address)}
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
                <td colSpan={15} className="px-4 py-16 text-center text-sm text-oct-muted">
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
