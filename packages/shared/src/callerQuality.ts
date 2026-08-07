/**
 * Caller quality — the slop filter (docs/roadmap/ "Caller quality").
 *
 * Two independent layers, both resolved here so backend and frontend can never
 * disagree about what a caller is worth:
 *
 *  1. **Manual tier** — you mark a caller muted / normal / trusted, globally or
 *     per room. Always wins, because it's a deliberate statement.
 *  2. **Earned band** — derived from how that caller's own past calls actually
 *     performed. Only shown once there's enough history to mean anything.
 *
 * This module stays a *display and filter* input. It must never be folded into
 * the convergence score — see the design-principle note in docs/roadmap/. Two
 * independent signals agreeing is only meaningful while they stay independent.
 */

import type { ContractEntry, CallerTier, CallerTierEntry } from './types.js';

export type { CallerTier, CallerTierEntry };

export type CallerPlatform = 'discord' | 'telegram';

/** Earned quality, derived from call history. `unrated` = not enough history. */
export type CallerBand = 'unrated' | 'slop' | 'mixed' | 'solid' | 'elite';

/** Below this many rated calls a caller stays `unrated` rather than showing noise. */
export const MIN_RATED_CALLS = 10;

/** A call that never cleared this multiple counts as slop. */
export const SLOP_MULTIPLE = 1.2;

export function callerKey(platform: CallerPlatform, authorId: string): string {
  return `${platform}:${authorId}`;
}

/** Comparable form of a display name — case and decoration stripped. */
export function normalizeCallerName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Authors excluded from scoring by default.
 *
 * Rick is an enrichment bot: it re-posts an embed for every contract that
 * crosses the feed, so its rows are *scans*, not calls. Left in, it accumulates
 * one "call" per token in the room and lands mid-leaderboard on the average of
 * everything anyone called — a number that describes the room, not a caller.
 *
 * Matched by name rather than snowflake on purpose. Discord's `bot` flag never
 * reaches the contract log (see `DiscordUser` in `types.ts` — the gateway
 * payload is narrowed before it gets here), and Rick's user id appears nowhere
 * in this repo, so a hardcoded id would be a guess that silently excludes
 * nobody. The name is the identity the pipeline already keys off:
 * `looksLikeRick` in `backend/src/utils/rickEmbedParser.ts` recognises the same
 * author username when deciding whether an embed is worth parsing.
 *
 * Exclusion is scoring-only. Rick's messages, embeds, and the enrichment
 * derived from them are untouched — this is not a mute.
 */
export const DEFAULT_EXCLUDED_CALLERS: readonly string[] = ['rick'];

/**
 * Does this row belong to an author excluded from scoring?
 *
 * An exclusion is either a full caller key (`discord:12345`), matched exactly,
 * or a display name, matched on the normalized form. Name matching is exact
 * rather than substring so "Patrick" doesn't get swept up with "Rick".
 */
export function isExcludedCaller(
  entry: Pick<ContractEntry, 'authorId' | 'authorName' | 'source' | 'messageId'>,
  exclusions: readonly string[] = DEFAULT_EXCLUDED_CALLERS,
): boolean {
  if (exclusions.length === 0) return false;
  const key = contractCallerKey(entry as ContractEntry);
  const name = normalizeCallerName(entry.authorName ?? '');

  for (const raw of exclusions) {
    const candidate = raw?.trim();
    if (!candidate) continue;
    if (parseCallerKey(candidate)) {
      if (candidate === key) return true;
      continue;
    }
    if (name && normalizeCallerName(candidate) === name) return true;
  }
  return false;
}

export function parseCallerKey(key: string): { platform: CallerPlatform; authorId: string } | null {
  const idx = key.indexOf(':');
  if (idx <= 0) return null;
  const platform = key.slice(0, idx);
  const authorId = key.slice(idx + 1);
  if (platform !== 'discord' && platform !== 'telegram') return null;
  if (!authorId) return null;
  return { platform, authorId };
}

/**
 * Resolve the manual tier for a caller in a given context.
 *
 * A room-scoped entry beats a global one, so "slop in #prosp, fine elsewhere"
 * is expressible. `roomIds` is the set of rooms the message/contract landed in —
 * a contract can belong to several, and any room-scoped mute applies.
 */
export function resolveCallerTier(
  entries: CallerTierEntry[] | undefined,
  key: string,
  roomIds: string[] = [],
): CallerTier {
  if (!entries?.length) return 'normal';

  const forCaller = entries.filter((e) => e.key === key);
  if (forCaller.length === 0) return 'normal';

  const roomSet = new Set(roomIds);
  const scoped = forCaller.filter((e) => e.roomId && roomSet.has(e.roomId));
  if (scoped.length > 0) {
    // Several rooms can match at once; the most restrictive wins so a mute is
    // never silently overridden by a trust in another room.
    return scoped.some((e) => e.tier === 'muted')
      ? 'muted'
      : scoped.some((e) => e.tier === 'trusted')
        ? 'trusted'
        : 'normal';
  }

  const global = forCaller.find((e) => !e.roomId);
  return global?.tier ?? 'normal';
}

// ---------------------------------------------------------------------------
// Earned score
// ---------------------------------------------------------------------------

/** One scored call: the caller's own MC@call against the token's peak since. */
export interface RatedCall {
  address: string;
  /** peakMc / mcAtCall. Only present when both numbers are usable. */
  multiple: number;
  timestamp: string;
}

export interface CallerScore {
  key: string;
  displayName: string;
  /** Every call we have, including ones we couldn't rate. */
  calls: number;
  /** Calls with a usable MC@call *and* a peak — the scoring sample. */
  rated: number;
  medianMultiple?: number;
  bestMultiple?: number;
  hitRate2x?: number;
  hitRate5x?: number;
  /** Share of rated calls that never cleared SLOP_MULTIPLE. */
  slopRate?: number;
  callsPerDay?: number;
  band: CallerBand;
}

export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Band a caller from their rates.
 *
 * Hit rate leads because it answers the question that matters — did their calls
 * actually run — and slop rate demotes, so someone who lands one 50x in a sea of
 * zeros doesn't read as elite off the median alone.
 */
export function bandFromRates(rated: number, hitRate2x: number, slopRate: number): CallerBand {
  if (rated < MIN_RATED_CALLS) return 'unrated';
  if (slopRate >= 0.8 || hitRate2x < 0.05) return 'slop';
  if (hitRate2x >= 0.4 && slopRate <= 0.4) return 'elite';
  if (hitRate2x >= 0.2 && slopRate <= 0.6) return 'solid';
  return 'mixed';
}

export function scoreCaller(
  key: string,
  displayName: string,
  calls: number,
  ratedCalls: RatedCall[],
  windowDays: number,
): CallerScore {
  const rated = ratedCalls.length;
  const base: CallerScore = { key, displayName, calls, rated, band: 'unrated' };
  if (windowDays > 0) base.callsPerDay = calls / windowDays;
  if (rated === 0) return base;

  const multiples = ratedCalls.map((c) => c.multiple);
  const hits2x = multiples.filter((m) => m >= 2).length / rated;
  const hits5x = multiples.filter((m) => m >= 5).length / rated;
  const slop = multiples.filter((m) => m < SLOP_MULTIPLE).length / rated;

  return {
    ...base,
    medianMultiple: median(multiples),
    bestMultiple: Math.max(...multiples),
    hitRate2x: hits2x,
    hitRate5x: hits5x,
    slopRate: slop,
    band: bandFromRates(rated, hits2x, slop),
  };
}

export function contractCallerKey(entry: ContractEntry): string {
  const platform: CallerPlatform =
    entry.source === 'telegram' || entry.messageId.startsWith('tg_') ? 'telegram' : 'discord';
  return callerKey(platform, entry.authorId);
}

/** Peak MC seen for an address since it was first called, keyed lowercase. */
export type PeakLookup = (address: string) => number | undefined;

/**
 * Turn a user's contract log into per-caller scores.
 *
 * Two things this deliberately does:
 *
 * - **Attributes per row, not per token.** Five people calling the same CA
 *   called it at five different market caps; each is scored against their own
 *   row's `fdvAtCall`, never the token's earliest. (Telegram rows only started
 *   carrying `fdvAtCall` with the Jul 29 MC@call fix — before that every TG
 *   caller scored as unrated.)
 * - **Counts a caller/token pair once.** Posting the same CA ten times is one
 *   call, otherwise spamming inflates the sample it's judged on.
 * - **Skips excluded authors.** Enrichment bots repost everything; scoring them
 *   measures the room, not a caller. See `DEFAULT_EXCLUDED_CALLERS`.
 */
export function buildCallerScores(
  contracts: ContractEntry[],
  peakFor: PeakLookup,
  windowDays: number,
  options: { exclude?: readonly string[] } = {},
): CallerScore[] {
  const exclude = options.exclude ?? DEFAULT_EXCLUDED_CALLERS;
  interface Acc {
    displayName: string;
    /** address -> that caller's earliest row for it */
    firstByAddress: Map<string, ContractEntry>;
  }
  const byCaller = new Map<string, Acc>();

  for (const entry of contracts) {
    if (!entry.authorId) continue;
    if (isExcludedCaller(entry, exclude)) continue;
    const key = contractCallerKey(entry);
    let acc = byCaller.get(key);
    if (!acc) {
      acc = { displayName: entry.authorName, firstByAddress: new Map() };
      byCaller.set(key, acc);
    }
    if (entry.authorName) acc.displayName = entry.authorName;

    const addr = entry.address.toLowerCase();
    const prior = acc.firstByAddress.get(addr);
    if (!prior || new Date(entry.timestamp).getTime() < new Date(prior.timestamp).getTime()) {
      acc.firstByAddress.set(addr, entry);
    }
  }

  const out: CallerScore[] = [];
  for (const [key, acc] of byCaller) {
    const ratedCalls: RatedCall[] = [];
    for (const [addr, entry] of acc.firstByAddress) {
      const mcAtCall = entry.fdvAtCall;
      if (mcAtCall == null || mcAtCall <= 0) continue;
      const peak = peakFor(addr);
      if (peak == null || peak <= 0) continue;
      ratedCalls.push({
        address: entry.address,
        // A peak below the call is possible when the call itself was the top;
        // floor at the call so a flat token reads as 1x, not a negative signal.
        multiple: Math.max(peak, mcAtCall) / mcAtCall,
        timestamp: entry.timestamp,
      });
    }
    out.push(scoreCaller(key, acc.displayName, acc.firstByAddress.size, ratedCalls, windowDays));
  }

  return out.sort((a, b) => b.rated - a.rated || b.calls - a.calls);
}

// ---------------------------------------------------------------------------
// Per-room scores
// ---------------------------------------------------------------------------

/** Room-scoped scores: roomId -> that room's caller scores. */
export type RoomCallerScores = Record<string, CallerScore[]>;

/**
 * Score each caller within each room separately.
 *
 * A caller can be sharp in one room and noise in another; a single global band
 * averages that away. This reuses `buildCallerScores` per room, so every
 * attribution rule (own MC@call, one caller/token pair per room, MIN_RATED_CALLS
 * before showing a band) holds inside the room exactly as it does globally.
 *
 * A contract row can land in several rooms at once and counts in each — the
 * question a room score answers is "what has this caller's record *in here*
 * been", and a call posted here is part of that record regardless of where
 * else it also landed.
 */
export function buildRoomCallerScores(
  contracts: ContractEntry[],
  peakFor: PeakLookup,
  windowDays: number,
  options: { exclude?: readonly string[] } = {},
): RoomCallerScores {
  const byRoom = new Map<string, ContractEntry[]>();
  for (const entry of contracts) {
    for (const roomId of entry.roomIds ?? []) {
      let list = byRoom.get(roomId);
      if (!list) {
        list = [];
        byRoom.set(roomId, list);
      }
      list.push(entry);
    }
  }

  const out: RoomCallerScores = {};
  for (const [roomId, group] of byRoom) {
    out[roomId] = buildCallerScores(group, peakFor, windowDays, options);
  }
  return out;
}

/**
 * Which earned score a room-scoped surface should show.
 *
 * Prefer the caller's record in the room(s) the message/contract actually
 * landed in — but only once that record is *rated*. A caller with 3 calls in
 * this room and 40 globally should show their global band, not flash unrated;
 * MIN_RATED_CALLS exists precisely so thin samples don't display as signal.
 * When several rooms match, the largest rated sample wins. Falls back to the
 * global score otherwise, and says which one it picked so the UI can label it.
 */
export function pickRoomScore(
  roomIds: string[],
  roomScoreFor: (roomId: string) => CallerScore | undefined,
  globalScore: CallerScore | undefined,
): { score?: CallerScore; scope: 'room' | 'global' } {
  let best: CallerScore | undefined;
  for (const roomId of roomIds) {
    const s = roomScoreFor(roomId);
    if (!s || s.band === 'unrated') continue;
    if (!best || s.rated > best.rated) best = s;
  }
  if (best) return { score: best, scope: 'room' };
  return { score: globalScore, scope: 'global' };
}

// ---------------------------------------------------------------------------
// Display + ordering
// ---------------------------------------------------------------------------

/**
 * What a row should actually show, once the manual tier has had its say.
 * A manual tier is a deliberate statement and overrides the earned band.
 */
export function effectiveBand(tier: CallerTier, band: CallerBand | undefined): CallerBand {
  if (tier === 'muted') return 'slop';
  if (tier === 'trusted') return 'elite';
  return band ?? 'unrated';
}

const BAND_RANK: Record<CallerBand, number> = {
  elite: 4,
  solid: 3,
  mixed: 2,
  unrated: 1,
  slop: 0,
};

/**
 * Sort weight for the contract feed and Radar. Higher floats up.
 * A manual tier pins the extremes so an explicit trust always outranks an
 * earned band, and a mute always sinks.
 */
export function callerRank(tier: CallerTier, band: CallerBand | undefined): number {
  if (tier === 'trusted') return 100;
  if (tier === 'muted') return -100;
  return BAND_RANK[band ?? 'unrated'];
}

/** Tailwind-agnostic colour tokens; the console maps these to its palette. */
export const BAND_LABELS: Record<CallerBand, string> = {
  elite: 'Elite',
  solid: 'Solid',
  mixed: 'Mixed',
  unrated: 'Unrated',
  slop: 'Slop',
};
