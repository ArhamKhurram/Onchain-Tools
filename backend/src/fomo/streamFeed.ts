// In-memory ring buffer of recent 985monitor stream trades.
//
// Deliberately NOT persisted, for the same reason robinhood/feed.ts is not: the
// stream is public, global and reconstructable, so storing it would buy nothing
// and cost Supabase egress on every read (see the egress notes in CLAUDE.md).
// The console seeds from this buffer on load and then follows the WebSocket; a
// backend restart starts it empty and refills within a minute.
//
// This buffer also owns cross-lane dedupe — see streamDedupeKeys in
// streamNormalize.ts for why one upstream event arrives under several ids, and
// why a trade therefore claims several keys rather than one.
//
// If this ever does need to persist, it goes through StorageProvider — not
// straight to Supabase or the JSON store.

import { streamDedupeKeys, type FomoStreamTrade } from './streamNormalize.js';

const MAX_TRADES =
  Number.parseInt(process.env.OCT_FOMO_STREAM_FEED_CAP ?? '', 10) || 300;

/** Newest first, capped. */
let buffer: FomoStreamTrade[] = [];
/** Every dedupe key claimed by a trade still in the buffer. */
const seen = new Map<string, string>();

/**
 * Append a trade. Returns false when it was a duplicate, which is the signal
 * the listener uses to decide whether to broadcast.
 */
export function recordStreamTrade(trade: FomoStreamTrade): boolean {
  const keys = streamDedupeKeys(trade);
  if (keys.some((k) => seen.has(k))) return false;

  for (const key of keys) seen.set(key, trade.id);
  buffer.unshift(trade);

  if (buffer.length > MAX_TRADES) {
    for (const dropped of buffer.slice(MAX_TRADES)) {
      // Only release keys this trade still owns: a later trade may legitimately
      // have claimed one, and dropping it would let a duplicate back through.
      for (const key of streamDedupeKeys(dropped)) {
        if (seen.get(key) === dropped.id) seen.delete(key);
      }
    }
    buffer = buffer.slice(0, MAX_TRADES);
  }
  return true;
}

/** Most recent trades, newest first. */
export function getRecentStreamTrades(limit = 100): FomoStreamTrade[] {
  const safe = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), MAX_TRADES) : 100;
  return buffer.slice(0, safe);
}

export function getStreamFeedSize(): number {
  return buffer.length;
}

/** Test hook — module-level buffer otherwise leaks between specs. */
export function resetStreamFeed(): void {
  buffer = [];
  seen.clear();
}
