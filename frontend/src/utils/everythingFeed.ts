// ── Everything feed: pure normalise / merge / sort / cap / filter ────────────
//
// The Everything workspace panel interleaves four ALREADY-DETECTED live streams
// into one chronological view:
//
//   - FOMO tracked-trader buys/sells (`fomo_trade`)      -> kind buy | sell
//   - the all-chain 985monitor FOMO tape (`fomo_stream`) -> kind tape
//   - pump.fun caller callouts (`pump_callout`)          -> kind callout
//   - Robinhood Chain fills (`robinhood_fill`)           -> kind rh
//
// This module does DISPLAY interleaving only. It reads events the slices already
// hold, normalises each into one row shape, and orders them by time. It adds NO
// detection, fuses NO signals, and calls NO API — the "Signals stay independent"
// rule in CLAUDE.md forbids merging the underlying detections, and nothing here
// does: a normalised row always keeps its `kind`/`source`, so a 985monitor tape
// row can never be re-presented as an OCT fomo.family trade, a callout, or a
// Robinhood fill. It is the unit-tested core of WorkspaceEverythingFeed.
//
// Kept pure (no React, no store access) so the merge is testable in isolation:
// feed it sample events, assert order, cap and filtering.

import type { FomoTrade } from '../types/fomo';
import type { FomoStreamTradeEntry } from '../types/fomoStream';
import type { PumpCalloutFeedEntry } from '../types/pumpfun';
import type { RobinhoodFillEntry } from '../types/robinhood';
import { truncateAddress } from '../types/pumpfun';
import type { EverythingFeedKind } from '@oct/shared';

export type { EverythingFeedKind } from '@oct/shared';

/** All kinds, in chip display order — buys/sells first, then the tapes. */
export const EVERYTHING_KINDS: readonly EverythingFeedKind[] = [
  'buy',
  'sell',
  'callout',
  'tape',
  'rh',
] as const;

/** Which slice a row came from — kept so a row's origin is never lost in the merge. */
export type EverythingSource = 'fomo' | 'fomo-stream' | 'pump' | 'robinhood';

/**
 * One normalised feed row. A superset shape: every source fills what it has and
 * leaves the rest null, so the renderer branches on `kind` for anything
 * source-specific (the thesis is only ever present on `callout` rows).
 */
export interface EverythingItem {
  /** Stable React key, taken from the source entry's own key. */
  id: string;
  /** Event time, epoch ms — the sole sort key. */
  ts: number;
  kind: EverythingFeedKind;
  source: EverythingSource;
  /** Trader/caller display label, already resolved (`@handle`, name, or short address). */
  handle: string | null;
  symbol: string | null;
  address: string | null;
  usd: number | null;
  /** Raw buy/sell direction for arrow/colour; null when unknown or not applicable. */
  side: 'buy' | 'sell' | null;
  /** Chain display name/slug when known ('sol', 'Base', 'Robinhood Chain', …). */
  chain: string | null;
  /** FOMO network id, for the ChainIcon glyph; null for the other sources. */
  networkId: number | null;
  /** Callout thesis, or the 985monitor tape comment — free text, rendered as text only. */
  text: string | null;
  /** Block-explorer / pair link when the source supplies one. */
  txUrl: string | null;
  /** Multiplier since a call (callouts only). */
  multiple: number | null;
  /** Market cap at the event, when the source carries one. */
  marketCap: number | null;
}

export interface EverythingSources {
  fomoTrades: FomoTrade[];
  fomoStreamTrades: FomoStreamTradeEntry[];
  pumpCallouts: PumpCalloutFeedEntry[];
  robinhoodFills: RobinhoodFillEntry[];
}

export interface MergeEverythingOptions {
  /**
   * Kinds to keep. Omit to include every kind (the default). An explicit list —
   * including an empty one — is honoured exactly, so "all chips off" yields an
   * empty feed rather than silently falling back to everything.
   */
  enabled?: Iterable<EverythingFeedKind>;
  /** Max rows to retain after sorting (newest kept). */
  cap?: number;
}

/** Mirrors the per-slice caps; a merged view of four ~300-500 windows fits well under this. */
export const EVERYTHING_CAP = 500;

function fomoHandle(trade: FomoTrade): string | null {
  if (trade.displayName) return trade.displayName;
  if (trade.fomoHandle) return `@${trade.fomoHandle}`;
  return null;
}

function streamHandle(trade: FomoStreamTradeEntry): string | null {
  if (trade.displayName) return trade.displayName;
  if (trade.handle) return `@${trade.handle}`;
  return null;
}

function rhHandle(fill: RobinhoodFillEntry): string | null {
  if (fill.displayName) return fill.displayName;
  if (fill.handle) return `@${fill.handle}`;
  if (fill.wallet) return truncateAddress(fill.wallet);
  return null;
}

function calloutHandle(c: PumpCalloutFeedEntry): string | null {
  return c.username ? `@${c.username}` : truncateAddress(c.callerAddress);
}

function normalizeFomoTrade(trade: FomoTrade): EverythingItem {
  // A FOMO trade splits into the buy/sell chips. `side` is authoritative when
  // present; an unlabeled trade degrades to the buy bucket (the poller nearly
  // always labels it) rather than being dropped from the feed.
  const side: 'buy' | 'sell' | null =
    trade.side === 'sell' ? 'sell' : trade.side === 'buy' ? 'buy' : null;
  return {
    id: trade.key,
    ts: trade.occurredAt,
    kind: side === 'sell' ? 'sell' : 'buy',
    source: 'fomo',
    handle: fomoHandle(trade),
    symbol: trade.tokenSymbol?.trim() || null,
    address: trade.tokenAddress?.trim() || null,
    usd: trade.usdValue,
    side,
    chain: null,
    networkId: trade.networkId,
    text: null,
    txUrl: null,
    multiple: null,
    marketCap: trade.marketCap,
  };
}

function normalizeStreamTrade(trade: FomoStreamTradeEntry): EverythingItem {
  // 985monitor rows are all one kind (tape); side only tints the row. A thesis
  // post on the tape carries side:'thesis' upstream — surfaced as its comment
  // text, with no buy/sell direction.
  const side: 'buy' | 'sell' | null =
    trade.side === 'buy' ? 'buy' : trade.side === 'sell' ? 'sell' : null;
  return {
    id: trade.key,
    ts: trade.ts,
    kind: 'tape',
    source: 'fomo-stream',
    handle: streamHandle(trade),
    symbol: trade.symbol,
    address: trade.tokenAddress,
    usd: trade.usd,
    side,
    chain: trade.chainName,
    networkId: null,
    text: trade.comment,
    txUrl: trade.txUrl,
    multiple: null,
    marketCap: trade.marketCap,
  };
}

function normalizeCallout(c: PumpCalloutFeedEntry): EverythingItem {
  // The only source with a thesis — surfaced through `text`. pump.fun is Solana.
  return {
    id: c.key,
    ts: c.occurredAt,
    kind: 'callout',
    source: 'pump',
    handle: calloutHandle(c),
    symbol: c.symbol ? `$${c.symbol.replace(/^\$/, '')}` : null,
    address: c.coinMint,
    usd: null,
    side: null,
    chain: 'sol',
    networkId: null,
    text: c.thesis,
    txUrl: null,
    multiple: c.multiple,
    marketCap: c.marketCapUsd,
  };
}

function normalizeRobinhoodFill(fill: RobinhoodFillEntry): EverythingItem {
  // robinhoodtrenches publishes `ts` in SECONDS; scale to ms so it interleaves
  // correctly against the ms-based FOMO/pump timestamps. Robinhood fills are
  // their own chip (rh); side only tints the row.
  return {
    id: fill.key,
    ts: fill.ts * 1000,
    kind: 'rh',
    source: 'robinhood',
    handle: rhHandle(fill),
    symbol: fill.symbol,
    address: fill.token,
    usd: fill.usd,
    side: fill.side ?? null,
    chain: 'robinhood',
    networkId: null,
    text: null,
    txUrl: fill.pairUrl,
    multiple: null,
    marketCap: null,
  };
}

/**
 * Normalise, merge, filter, sort (time DESC) and cap the four streams into one
 * feed. Pure: same inputs → same output, no side effects.
 *
 * Order of operations matters for the cap: filtering happens BEFORE the cap, so
 * narrowing to one chip shows that chip's newest 500 rather than whatever
 * survived a mixed-stream cap.
 */
export function mergeEverythingFeed(
  sources: EverythingSources,
  options: MergeEverythingOptions = {},
): EverythingItem[] {
  const enabled = options.enabled ? new Set(options.enabled) : null;
  const cap = options.cap ?? EVERYTHING_CAP;

  const rows: EverythingItem[] = [
    ...sources.fomoTrades.map(normalizeFomoTrade),
    ...sources.fomoStreamTrades.map(normalizeStreamTrade),
    ...sources.pumpCallouts.map(normalizeCallout),
    ...sources.robinhoodFills.map(normalizeRobinhoodFill),
  ];

  const filtered = enabled ? rows.filter((r) => enabled.has(r.kind)) : rows;
  // Newest first. Ties break on id so the order is deterministic across renders
  // (and across test runs) rather than depending on concat order.
  filtered.sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  if (filtered.length > cap) filtered.length = cap;
  return filtered;
}

/**
 * Resolve the persisted chip config into the enabled-kind set. `undefined`
 * (never toggled) means every kind is on; an explicit list — empty included —
 * is used verbatim, with unknown entries dropped so a stale config can't smuggle
 * in a kind the feed no longer renders.
 */
export function resolveEnabledKinds(
  saved: EverythingFeedKind[] | undefined,
): EverythingFeedKind[] {
  if (saved === undefined) return [...EVERYTHING_KINDS];
  const allowed = new Set<EverythingFeedKind>(EVERYTHING_KINDS);
  return saved.filter((k) => allowed.has(k));
}
