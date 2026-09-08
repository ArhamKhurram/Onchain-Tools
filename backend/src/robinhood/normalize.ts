// Pure narrowing for robinhoodtrenches.com's public API.
//
// SCOPE — read this before wiring anything to it. robinhoodtrenches indexes
// **Robinhood Chain only** (chain_id 4663) by reading the chain directly. It is
// NOT a fomo.family proxy: it has no Solana and no BSC data, and it cannot see
// a trade that did not settle on Robinhood Chain. Every surface built on it has
// to say so, or it reads as all-chain FOMO coverage that it is not.
//
// It is also a distinct, independently-labelled signal. Its `/api/flow`
// lead/follower analysis is NOT fused into OCT's own convergence detector —
// see the "signals stay independent" rule in CLAUDE.md.
//
// This module is I/O-free so every shape assumption is unit-testable; the
// fetching, caching and polling live in client.ts and poller.ts.

import { bool, isRecord, httpUrl, num, str } from '../utils/untrusted.js';

/** The one chain this source can ever see. */
export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_SOURCE = 'robinhoodtrenches' as const;
export const ROBINHOOD_SOURCE_LABEL = 'robinhoodtrenches.com';
export const ROBINHOOD_SOURCE_URL = 'https://robinhoodtrenches.com';
/** Shown verbatim in the console so the scope limit travels with the data. */
export const ROBINHOOD_SCOPE_NOTE =
  'Robinhood Chain only (chain 4663) — no Solana or BSC coverage.';

// --- Fills (/api/tape) ------------------------------------------------------

/** One settled fill from the live tape. */
export interface RobinhoodFill {
  /** Upstream row id — monotonic, and the dedupe key for the poller. */
  id: number;
  /** Seconds since epoch, as published. */
  ts: number;
  tx: string | null;
  side: 'buy' | 'sell' | null;
  usd: number | null;
  amount: number | null;
  price: number | null;
  handle: string | null;
  displayName: string | null;
  followers: number | null;
  wallet: string | null;
  token: string | null;
  symbol: string | null;
  name: string | null;
  mark: number | null;
  liquidity: number | null;
  pairUrl: string | null;
  isStock: boolean | null;
  newPosition: boolean | null;
}

function side(value: unknown): 'buy' | 'sell' | null {
  const raw = str(value, 8)?.toLowerCase();
  return raw === 'buy' || raw === 'sell' ? raw : null;
}

/**
 * Narrow one tape row. Returns null without a numeric `id` — that is both the
 * dedupe key and the ordering key, so a row without one is unusable.
 */
export function normalizeFill(raw: unknown): RobinhoodFill | null {
  if (!isRecord(raw)) return null;
  const id = num(raw.id);
  if (id == null) return null;
  return {
    id,
    ts: num(raw.ts) ?? 0,
    tx: str(raw.tx, 100),
    side: side(raw.side),
    usd: num(raw.usd),
    amount: num(raw.amount),
    price: num(raw.price),
    handle: str(raw.handle, 64),
    displayName: str(raw.display_name, 128),
    followers: num(raw.followers),
    wallet: str(raw.wallet, 64),
    token: str(raw.token, 64),
    symbol: str(raw.symbol, 32),
    name: str(raw.name, 128),
    mark: num(raw.mark),
    liquidity: num(raw.liquidity),
    pairUrl: httpUrl(raw.pair_url),
    isStock: bool(raw.is_stock),
    newPosition: bool(raw.new_position),
  };
}

/** Narrow a tape response, dropping unusable rows and deduping by id. */
export function normalizeFills(raw: unknown): RobinhoodFill[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  const out: RobinhoodFill[] = [];
  for (const row of raw) {
    const fill = normalizeFill(row);
    if (!fill || seen.has(fill.id)) continue;
    seen.add(fill.id);
    out.push(fill);
  }
  return out;
}

/**
 * Fills newer than `cursor`, oldest-first — the order the console's feed wants
 * to receive them in. A null cursor means cold start: nothing is emitted, so a
 * restart never replays the whole tape as "live" alerts.
 */
export function selectNewFills(fills: RobinhoodFill[], cursor: number | null): RobinhoodFill[] {
  if (cursor == null) return [];
  return fills.filter((f) => f.id > cursor).sort((a, b) => a.id - b.id);
}

/** Highest id in a batch, for advancing the poller cursor. */
export function highestFillId(fills: RobinhoodFill[], current: number | null = null): number | null {
  let max = current;
  for (const f of fills) {
    if (max == null || f.id > max) max = f.id;
  }
  return max;
}

// --- Status (/api/status) ---------------------------------------------------

export interface RobinhoodStatus {
  ok: boolean;
  chainId: number | null;
  wallets: number | null;
  trades: number | null;
  lastTs: number | null;
  lagSeconds: number | null;
  lastBlock: number | null;
  source: string | null;
}

export function normalizeStatus(raw: unknown): RobinhoodStatus | null {
  if (!isRecord(raw)) return null;
  return {
    ok: bool(raw.ok) ?? false,
    chainId: num(raw.chain_id),
    wallets: num(raw.wallets),
    trades: num(raw.trades),
    lastTs: num(raw.last_ts),
    lagSeconds: num(raw.lag_seconds),
    lastBlock: num(raw.last_block),
    source: str(raw.source, 32),
  };
}

// --- Radar (/api/radar) -----------------------------------------------------

/** A fresh token ranked by how many distinct tracked traders bought it. */
export interface RobinhoodRadarRow {
  token: string;
  symbol: string | null;
  name: string | null;
  buyers: number | null;
  usdIn: number | null;
  mark: number | null;
  liquidity: number | null;
  pairCreatedAt: number | null;
  pairUrl: string | null;
  change24: number | null;
  firstTs: number | null;
  fresh: boolean | null;
  isStock: boolean | null;
  firstBuyer: { handle: string | null; followers: number | null; ts: number | null } | null;
}

export function normalizeRadarRow(raw: unknown): RobinhoodRadarRow | null {
  if (!isRecord(raw)) return null;
  const token = str(raw.token, 64);
  if (!token) return null;
  const fb = isRecord(raw.first_buyer) ? raw.first_buyer : null;
  return {
    token,
    symbol: str(raw.symbol, 32),
    name: str(raw.name, 128),
    buyers: num(raw.buyers),
    usdIn: num(raw.usd_in),
    mark: num(raw.mark),
    liquidity: num(raw.liquidity),
    pairCreatedAt: num(raw.pair_created_at),
    pairUrl: httpUrl(raw.pair_url),
    change24: num(raw.change24),
    firstTs: num(raw.first_ts),
    fresh: bool(raw.fresh),
    isStock: bool(raw.is_stock),
    firstBuyer: fb
      ? { handle: str(fb.handle, 64), followers: num(fb.followers), ts: num(fb.ts) }
      : null,
  };
}

export function normalizeRadar(raw: unknown): RobinhoodRadarRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeRadarRow).filter((r): r is RobinhoodRadarRow => r != null);
}

// --- Traders (/api/traders, /api/trader/{handle}) ---------------------------

export interface RobinhoodTraderRow {
  address: string | null;
  handle: string;
  displayName: string | null;
  followers: number | null;
  profileUrl: string | null;
  volume: number | null;
  fills: number | null;
  lastTs: number | null;
  realizedPnl: number | null;
  unrealizedPnl: number | null;
  netPnl: number | null;
  winRate: number | null;
  openBags: number | null;
  active: boolean | null;
}

export function normalizeTraderRow(raw: unknown): RobinhoodTraderRow | null {
  if (!isRecord(raw)) return null;
  const handle = str(raw.handle, 64);
  if (!handle) return null;
  return {
    address: str(raw.address, 64),
    handle,
    displayName: str(raw.display_name, 128),
    followers: num(raw.followers),
    profileUrl: httpUrl(raw.profile_url),
    volume: num(raw.volume),
    fills: num(raw.fills),
    lastTs: num(raw.last_ts),
    realizedPnl: num(raw.realized_pnl),
    unrealizedPnl: num(raw.unrealized_pnl),
    netPnl: num(raw.net_pnl),
    winRate: num(raw.win_rate),
    openBags: num(raw.open_bags),
    active: bool(raw.active),
  };
}

export function normalizeTraders(raw: unknown): RobinhoodTraderRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeTraderRow).filter((r): r is RobinhoodTraderRow => r != null);
}

export interface RobinhoodBag {
  token: string;
  symbol: string | null;
  name: string | null;
  amount: number | null;
  costUsd: number | null;
  avgPrice: number | null;
  mark: number | null;
  value: number | null;
  pnl: number | null;
  pnlPct: number | null;
  liquidity: number | null;
  pairUrl: string | null;
  openedTs: number | null;
  priced: boolean | null;
}

export function normalizeBag(raw: unknown): RobinhoodBag | null {
  if (!isRecord(raw)) return null;
  const token = str(raw.token, 64);
  if (!token) return null;
  return {
    token,
    symbol: str(raw.symbol, 32),
    name: str(raw.name, 128),
    amount: num(raw.amount),
    costUsd: num(raw.cost_usd),
    avgPrice: num(raw.avg_price),
    mark: num(raw.mark),
    value: num(raw.value),
    pnl: num(raw.pnl),
    pnlPct: num(raw.pnl_pct),
    liquidity: num(raw.liquidity),
    pairUrl: httpUrl(raw.pair_url),
    openedTs: num(raw.opened_ts),
    priced: bool(raw.priced),
  };
}

export interface RobinhoodTraderProfile {
  handle: string;
  address: string | null;
  displayName: string | null;
  followers: number | null;
  /** The trader's Solana address as published — informational only; this source has no Solana data. */
  solanaAddress: string | null;
  profileUrl: string | null;
  numTrades: number | null;
  volumeUsd: number | null;
  streak: number | null;
  bags: RobinhoodBag[];
}

export function normalizeTraderProfile(raw: unknown): RobinhoodTraderProfile | null {
  if (!isRecord(raw)) return null;
  const handle = str(raw.handle, 64);
  if (!handle) return null;
  return {
    handle,
    address: str(raw.address, 64),
    displayName: str(raw.display_name, 128),
    followers: num(raw.followers),
    solanaAddress: str(raw.solana_address, 64),
    profileUrl: httpUrl(raw.profile_url),
    numTrades: num(raw.num_trades),
    volumeUsd: num(raw.volume_usd),
    streak: num(raw.streak),
    bags: Array.isArray(raw.bags)
      ? raw.bags.map(normalizeBag).filter((b): b is RobinhoodBag => b != null).slice(0, 200)
      : [],
  };
}

// --- Overview (/api/overview) ----------------------------------------------

export interface RobinhoodOverview {
  window: string | null;
  fills: number | null;
  buys: number | null;
  sells: number | null;
  activeTraders: number | null;
  tokens: number | null;
  volume: number | null;
  realizedPnl: number | null;
  unrealizedPnl: number | null;
  netPnl: number | null;
  winRate: number | null;
  closedTrades: number | null;
}

export function normalizeOverview(raw: unknown): RobinhoodOverview | null {
  if (!isRecord(raw)) return null;
  return {
    window: str(raw.window, 16),
    fills: num(raw.fills),
    buys: num(raw.buys),
    sells: num(raw.sells),
    activeTraders: num(raw.active_traders),
    tokens: num(raw.tokens),
    volume: num(raw.volume),
    realizedPnl: num(raw.realized_pnl),
    unrealizedPnl: num(raw.unrealized_pnl),
    netPnl: num(raw.net_pnl),
    winRate: num(raw.win_rate),
    closedTrades: num(raw.closed_trades),
  };
}

// --- Flow (/api/flow) -------------------------------------------------------
//
// This is robinhoodtrenches' OWN lead/follower read, surfaced under its own
// label. It is deliberately not merged into OCT's convergence detector.

export interface RobinhoodFlowActor {
  handle: string | null;
  ts: number | null;
  usd: number | null;
  price: number | null;
  followers: number | null;
  wallet: string | null;
  profileUrl: string | null;
  lagSeconds: number | null;
}

export interface RobinhoodFlowRow {
  token: string;
  symbol: string | null;
  name: string | null;
  lead: RobinhoodFlowActor | null;
  followers: RobinhoodFlowActor[];
}

export function normalizeFlowActor(raw: unknown): RobinhoodFlowActor | null {
  if (!isRecord(raw)) return null;
  return {
    handle: str(raw.handle, 64),
    ts: num(raw.ts),
    usd: num(raw.usd),
    price: num(raw.price),
    followers: num(raw.followers),
    wallet: str(raw.wallet, 64),
    profileUrl: httpUrl(raw.profile_url),
    lagSeconds: num(raw.lag_seconds),
  };
}

export function normalizeFlowRow(raw: unknown): RobinhoodFlowRow | null {
  if (!isRecord(raw)) return null;
  const token = str(raw.token, 64);
  if (!token) return null;
  return {
    token,
    symbol: str(raw.symbol, 32),
    name: str(raw.name, 128),
    lead: normalizeFlowActor(raw.lead),
    followers: Array.isArray(raw.followers)
      ? raw.followers
          .map(normalizeFlowActor)
          .filter((a): a is RobinhoodFlowActor => a != null)
          .slice(0, 100)
      : [],
  };
}

export function normalizeFlow(raw: unknown): RobinhoodFlowRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeFlowRow).filter((r): r is RobinhoodFlowRow => r != null);
}
