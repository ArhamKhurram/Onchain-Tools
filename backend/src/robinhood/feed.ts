// In-memory ring buffer of recent Robinhood Chain fills.
//
// Deliberately NOT persisted. The tape is public, global, and reconstructable
// from upstream at any time, so storing it would buy nothing and cost Supabase
// egress on every read (see the egress notes in CLAUDE.md). The console seeds
// from this buffer on load and then follows the WebSocket; a backend restart
// simply starts the buffer empty and refills within one poll.
//
// If this ever does need to persist, it goes through StorageProvider — not
// straight to Supabase or the JSON store.

import type { RobinhoodFill } from './normalize.js';

const MAX_FILLS =
  Number.parseInt(process.env.OCT_ROBINHOOD_FEED_CAP ?? '', 10) || 300;

/** Newest first, capped, deduped by upstream id. */
let buffer: RobinhoodFill[] = [];
const seen = new Set<number>();

/** Append newly-seen fills (caller passes them oldest-first). */
export function recordFills(fills: RobinhoodFill[]): void {
  for (const fill of fills) {
    if (seen.has(fill.id)) continue;
    seen.add(fill.id);
    buffer.unshift(fill);
  }
  if (buffer.length > MAX_FILLS) {
    for (const dropped of buffer.slice(MAX_FILLS)) seen.delete(dropped.id);
    buffer = buffer.slice(0, MAX_FILLS);
  }
}

/** Most recent fills, newest first. */
export function getRecentFills(limit = 100): RobinhoodFill[] {
  const safe = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), MAX_FILLS) : 100;
  return buffer.slice(0, safe);
}

export function getFeedSize(): number {
  return buffer.length;
}

/** Test hook — module-level buffer otherwise leaks between specs. */
export function resetRobinhoodFeed(): void {
  buffer = [];
  seen.clear();
}
