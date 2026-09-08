// Pure narrowing for 985monitor.xyz's public live event stream.
//
// SCOPE — read this before wiring anything to it.
//
// `https://www.985monitor.xyz/api/events-stream` is a public, keyless
// Server-Sent Events firehose. It carries many unrelated event types (twitter,
// truth, news, square, wechat, pump-trade, …); the only one this module looks
// at is `event: fomo`, which mirrors fomo.family activity across every chain
// the site watches (measured live: Robinhood 4663, Solana, BSC/BNB, plus the
// occasional Base/Ethereum row).
//
// It is NOT OCT's own fomo.family feed and it is NOT the blocked service
// account coming back. It is a third party's re-broadcast, and it can be wrong,
// late, incomplete, or gone tomorrow. Every surface built on it says
// "985monitor.xyz" in its own words — see the scope note below, which travels
// with the data all the way to the console.
//
// It is also its own independently-labelled signal: nothing here is fused into
// OCT's convergence detector, the missed-runner poller, or the fomo.family
// trade rows (see "signals stay independent" in CLAUDE.md).
//
// This module is I/O-free so every shape assumption is unit-testable; the
// connection, reconnect policy and fan-out live in streamListener.ts.

import { httpUrl, isRecord, num, str } from '../utils/untrusted.js';

export const FOMO_STREAM_SOURCE = '985monitor-stream' as const;
export const FOMO_STREAM_SOURCE_LABEL = '985monitor.xyz';
export const FOMO_STREAM_SOURCE_URL = 'https://www.985monitor.xyz';
/** Shown verbatim in the console so the provenance travels with the data. */
export const FOMO_STREAM_SCOPE_NOTE =
  'Third-party re-broadcast of fomo.family activity by 985monitor.xyz — not OCT’s own fomo.family feed, and not part of OCT convergence.';

/** One normalized trade/thesis row off the stream. */
export interface FomoStreamTrade {
  /** Upstream `key` — globally unique and the dedupe key everywhere downstream. */
  id: string;
  /** Epoch ms of the trade itself, as published. Falls back to receive time. */
  ts: number;
  side: 'buy' | 'sell' | 'thesis' | null;
  handle: string | null;
  displayName: string | null;
  avatar: string | null;
  followers: number | null;
  usd: number | null;
  amount: number | null;
  tokenAddress: string | null;
  symbol: string | null;
  tokenImage: string | null;
  chainId: number | null;
  chainName: string | null;
  marketCap: number | null;
  priceUsd: number | null;
  /** The trader's own words on a thesis row; empty on a plain fill. */
  comment: string | null;
  txUrl: string | null;
}

/**
 * `side` arrives as FOMO_BUY / BUY / SELL / THESIS depending on which internal
 * lane produced the row. Anything unrecognised becomes null rather than being
 * guessed at — a mislabelled sell rendered as a buy is worse than a blank.
 */
export function normalizeSide(value: unknown): 'buy' | 'sell' | 'thesis' | null {
  const raw = str(value, 32)?.toLowerCase().replace(/^fomo_/, '');
  if (raw === 'buy' || raw === 'sell' || raw === 'thesis') return raw;
  return null;
}

/**
 * Reject timestamps that are not plausibly recent. The upstream mixes seconds
 * and milliseconds across lanes, and a bad value renders as "56 years ago".
 */
function normalizeTs(value: unknown): number | null {
  const raw = num(value);
  if (raw == null) return null;
  // Seconds-since-epoch, promoted.
  const ms = raw > 1_000_000_000 && raw < 10_000_000_000 ? raw * 1000 : raw;
  return ms > 1_000_000_000_000 && ms < 4_000_000_000_000 ? ms : null;
}

/**
 * Narrow one `event: fomo` payload.
 *
 * `raw` is the parsed `data:` line, whose shape is `{ source, event, seq,
 * broadcastAt }`. Returns null when the row carries no usable identity: without
 * a `key` there is no dedupe key, and without a handle there is no trader to
 * name, which is the entire point of the tape.
 */
export function normalizeStreamTrade(raw: unknown): FomoStreamTrade | null {
  if (!isRecord(raw)) return null;
  const event = isRecord(raw.event) ? raw.event : raw;

  const id = str(event.key, 256);
  if (!id) return null;
  const handle = str(event.handle, 64) ?? str(event.userName, 64);
  if (!handle) return null;

  const comment = str(event.comment, 500);

  return {
    id,
    ts: normalizeTs(event.ts) ?? normalizeTs(event.receivedAt) ?? normalizeTs(raw.broadcastAt) ?? Date.now(),
    side: normalizeSide(event.side) ?? normalizeSide(event.eventType),
    handle,
    displayName: str(event.userName, 128),
    avatar: httpUrl(event.avatar),
    followers: num(event.followers),
    // `usd: 0` is what a thesis row carries; keep it null rather than "$0.00".
    usd: num(event.usd) || null,
    amount: num(event.amount),
    tokenAddress: str(event.tokenAddress, 128),
    symbol: str(event.symbol, 32),
    tokenImage: httpUrl(event.tokenImage),
    chainId: num(event.networkId),
    chainName: str(event.chainName, 32),
    marketCap: num(event.marketCap),
    priceUsd: num(event.priceUsd),
    comment,
    txUrl: httpUrl(event.txUrl),
  };
}

// --- Dedupe -----------------------------------------------------------------
//
// The upstream fans one real-world event out across several internal "lanes"
// (`wind::fh`, `wind::oc`, `wind::ocp`, `ws`, …) and each lane mints its OWN
// key, so `id` alone does not deduplicate. Observed live on 2026-09-07: one
// thesis arrived twice as `fomo::ws::<uuid>` and `fomo::wind::th::<uuid>`, and
// one buy arrived twice with different tx-derived keys and USD values 248.07 vs
// 249.97. Both would have rendered as two trades in the tape.
//
// So a trade claims several keys and is new only if ALL of them are unseen:
//
//   1. the raw upstream `id`;
//   2. any UUID embedded in the key — this is what pairs the `ws` and `wind`
//      lanes, which agree on the identifier but not on the prefix;
//   3. handle + side + token + exact `ts` — this is what pairs the tx-derived
//      keys, which disagree on everything except the moment of the trade.
//
// (3) deliberately keys on the EXACT timestamp rather than a time bucket: the
// same trader really does buy the same token twice within seconds (seen live),
// and collapsing those would hide real activity. Lanes reporting one event
// agree on `ts` to the millisecond; two genuine trades do not.

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function streamDedupeKeys(trade: FomoStreamTrade): string[] {
  const keys = [`id:${trade.id}`];
  const uuid = UUID_RE.exec(trade.id)?.[0];
  if (uuid) keys.push(`uuid:${uuid.toLowerCase()}`);
  if (trade.tokenAddress) {
    keys.push(`ev:${trade.handle}|${trade.side}|${trade.tokenAddress.toLowerCase()}|${trade.ts}`);
  }
  return keys;
}

// --- SSE framing ------------------------------------------------------------
//
// Kept here (rather than in the listener) because it is pure and it is where a
// malformed upstream would first bite. Deliberately minimal: this consumes one
// known stream, not arbitrary SSE.

export interface SseFrame {
  event: string;
  data: string;
  id: string | null;
}

/**
 * Parse one `\n\n`-delimited SSE block.
 *
 * Returns null for anything without both an event name and a data line —
 * comments, `retry:` directives and heartbeats all land here and are dropped.
 * Multi-line `data:` fields are joined with newlines, per the SSE spec.
 */
export function parseSseFrame(block: string): SseFrame | null {
  if (!block) return null;
  let event: string | null = null;
  let id: string | null = null;
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const field = line.slice(0, colon);
    // One optional leading space after the colon is part of the framing.
    const value = line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'id') id = value;
    else if (field === 'data') data.push(value);
  }
  if (!event || data.length === 0) return null;
  return { event, data: data.join('\n'), id };
}

/**
 * Split a decoded chunk buffer into complete frames, returning the trailing
 * partial for the next read. The caller owns the leftover — an SSE chunk
 * boundary lands mid-frame constantly.
 */
export function splitSseBlocks(buffer: string): { blocks: string[]; rest: string } {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  return { blocks: parts, rest };
}
