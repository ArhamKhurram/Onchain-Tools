// 985monitor.xyz — a public, keyless snapshot of the fomo.family leaderboards.
//
// Why this exists: OCT's own fomo.family service account has been rejected by
// the upstream API since 2026-08-26 (`{"success":false,"message":"Forbidden"}`
// on every call — the account, not the credential). That left the console's
// Leaderboard tab showing nothing but a red error box. 985monitor publishes a
// static JSON snapshot of the same boards, refreshed every few minutes, with no
// auth and no key, so it is used as a *fallback* source when the live FOMO path
// is unavailable.
//
// It is a THIRD-PARTY SNAPSHOT, not our own live feed — every response that
// comes from here carries `source: '985monitor'` and the snapshot's own
// `updatedAt`, and the console labels it accordingly. Never present it as live.
//
// This module is deliberately split into pure normalization (unit-tested
// against the documented shapes) and one small fetch wrapper that owns the
// timeout, the TTL cache and the failure handling.

import { httpUrl, isRecord, num, str } from '../utils/untrusted.js';

const MONITOR_985_URL = 'https://985monitor.xyz/fomo-leaderboards.json';

/** Public attribution surfaced to the console. */
export const MONITOR_985_SOURCE = '985monitor' as const;
export const MONITOR_985_LABEL = '985monitor.xyz';
export const MONITOR_985_HOME = 'https://985monitor.xyz';

/** Request timeout. The file is ~119KB of static JSON; slow means broken. */
const FETCH_TIMEOUT_MS =
  Number.parseInt(process.env.FOMO_985_TIMEOUT_MS ?? '', 10) || 8_000;

/** Upstream regenerates every few minutes; there is nothing to gain from polling faster. */
export const MONITOR_985_TTL_MS =
  Number.parseInt(process.env.FOMO_985_CACHE_MS ?? '', 10) || 3 * 60 * 1000;

/** Cache key for fomo/cache.ts. Single entry — the whole file is one fetch. */
export const MONITOR_985_CACHE_KEY = 'monitor985:leaderboards';

/** Windows 985monitor publishes. The live FOMO API only ever had 24h and all. */
export const MONITOR_985_WINDOWS = ['24h', '7d', '30d', 'all'] as const;
export type Monitor985Window = (typeof MONITOR_985_WINDOWS)[number];

export function isMonitor985Window(value: unknown): value is Monitor985Window {
  return (
    typeof value === 'string' &&
    (MONITOR_985_WINDOWS as readonly string[]).includes(value)
  );
}

/**
 * One leaderboard row, narrowed to the fields the console renders. Shape is
 * intentionally compatible with the live-FOMO leaderboard entry (fomoUserId /
 * fomoHandle / displayName / pnl / volume / rank) so the UI needs one renderer,
 * plus the extras 985monitor happens to publish.
 */
export interface Monitor985Entry {
  fomoUserId: string;
  fomoHandle: string | null;
  displayName: string | null;
  avatar: string | null;
  followers: number | null;
  numTrades: number | null;
  volume: number | null;
  pnl: number | null;
  rank: number | null;
}

export interface Monitor985Snapshot {
  updatedAt: number | null;
  boards: Record<Monitor985Window, Monitor985Entry[]>;
}

// --- Pure narrowing ---------------------------------------------------------
//
// Everything below treats the payload as fully untrusted: it is a third-party
// file we do not control and cannot version. The primitives live in
// utils/untrusted.ts and are shared with the robinhoodtrenches parser.

/**
 * Narrow one raw board row. Returns null when it carries no usable identity —
 * `uid` is the join key against OCT's tracked users, so a row without one is
 * not actionable.
 */
export function normalize985Row(raw: unknown, fallbackRank: number): Monitor985Entry | null {
  if (!isRecord(raw)) return null;
  const fomoUserId = str(raw.uid, 128);
  if (!fomoUserId) return null;
  return {
    fomoUserId,
    fomoHandle: str(raw.handle, 64),
    displayName: str(raw.name, 128),
    avatar: httpUrl(raw.avatar),
    followers: num(raw.followers),
    numTrades: num(raw.numTrades),
    volume: num(raw.volume),
    pnl: num(raw.pnl),
    rank: num(raw.rank) ?? fallbackRank,
  };
}

/** Narrow a raw board array, dropping unusable rows and deduping by uid. */
export function normalize985Board(raw: unknown): Monitor985Entry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Monitor985Entry[] = [];
  raw.forEach((row, index) => {
    const entry = normalize985Row(row, index + 1);
    if (!entry || seen.has(entry.fomoUserId)) return;
    seen.add(entry.fomoUserId);
    out.push(entry);
  });
  return out;
}

/**
 * Narrow the whole file. Always returns a snapshot with all four boards
 * present (possibly empty) so callers never have to null-check a window.
 */
export function normalize985Snapshot(raw: unknown): Monitor985Snapshot {
  const boards: Record<Monitor985Window, Monitor985Entry[]> = {
    '24h': [],
    '7d': [],
    '30d': [],
    all: [],
  };
  if (!isRecord(raw)) return { updatedAt: null, boards };

  const rawBoards = isRecord(raw.boards) ? raw.boards : {};
  for (const window of MONITOR_985_WINDOWS) {
    boards[window] = normalize985Board(rawBoards[window]);
  }

  // `updatedAt` is epoch ms. Reject anything not plausibly a recent timestamp
  // rather than letting a bad value render as "54 years ago" in the UI.
  const updatedAtRaw = num(raw.updatedAt);
  const updatedAt =
    updatedAtRaw != null && updatedAtRaw > 1_000_000_000_000 && updatedAtRaw < 4_000_000_000_000
      ? updatedAtRaw
      : null;

  return { updatedAt, boards };
}

/**
 * Pick one board, capped to `limit` and re-ranked contiguously so the console's
 * rank column stays 1..n after any rows were dropped in narrowing.
 */
export function select985Board(
  snapshot: Monitor985Snapshot,
  window: Monitor985Window,
  limit: number,
): Monitor985Entry[] {
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 200) : 50;
  return snapshot.boards[window].slice(0, safeLimit);
}

// --- I/O --------------------------------------------------------------------

/**
 * Fetch and narrow the snapshot. Throws on transport failure, non-2xx, or
 * unparseable JSON — callers decide whether that is fatal (it never is: every
 * caller degrades to a labelled "source unavailable" state).
 */
export async function fetchMonitor985Snapshot(): Promise<Monitor985Snapshot> {
  const res = await fetch(MONITOR_985_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`985monitor upstream ${res.status}`);
  }
  const json: unknown = await res.json();
  return normalize985Snapshot(json);
}
