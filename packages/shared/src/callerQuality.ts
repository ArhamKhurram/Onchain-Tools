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
  return isExcludedCallerKey(
    contractCallerKey(entry as ContractEntry),
    entry.authorName ?? '',
    exclusions,
  );
}

/**
 * The same exclusion test, expressed over an already-resolved caller key and
 * display name rather than a contract row.
 *
 * The persistent board never sees contract rows — it reads per-caller
 * aggregates back out of storage — but the operator can add an exclusion at any
 * time, long after those rows were folded away. Filtering the aggregate on read
 * means a new exclusion takes effect immediately and reversibly, with no
 * rewrite of stored history, and it keeps one definition of "excluded" shared
 * between the derive-on-read path and the persistent one.
 */
export function isExcludedCallerKey(
  key: string,
  displayName: string,
  exclusions: readonly string[] = DEFAULT_EXCLUDED_CALLERS,
): boolean {
  if (exclusions.length === 0) return false;
  const name = normalizeCallerName(displayName ?? '');

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
  const byCaller = new Map<string, { displayName: string; calls: CallerCall[] }>();
  for (const call of foldCallerCalls(contracts, options)) {
    let acc = byCaller.get(call.callerKey);
    if (!acc) {
      acc = { displayName: call.displayName, calls: [] };
      byCaller.set(call.callerKey, acc);
    }
    if (call.displayName) acc.displayName = call.displayName;
    acc.calls.push(call);
  }

  const out: CallerScore[] = [];
  for (const [key, acc] of byCaller) {
    const ratedCalls: RatedCall[] = [];
    for (const call of acc.calls) {
      const rated = rateCall(call, peakFor(call.address.toLowerCase()));
      if (rated) ratedCalls.push(rated);
    }
    out.push(scoreCaller(key, acc.displayName, acc.calls.length, ratedCalls, windowDays));
  }

  return sortCallerScores(out);
}

/** The board's ordering: deepest scoring sample first, then raw volume. */
export function sortCallerScores(scores: CallerScore[]): CallerScore[] {
  return scores.sort((a, b) => b.rated - a.rated || b.calls - a.calls);
}

// ---------------------------------------------------------------------------
// Persistence primitives
//
// Scores used to be derived on read, every time, straight off the contract log.
// That made a caller's record only as long as the log — roll the log and the
// caller disappears, which on a real feed meant a board claiming 30 days while
// scoring barely one. The durable unit is the *call*, not the log row: one
// record per (caller, token), written once and kept. Everything below is the
// pure half of that — the fold that turns log rows into call records, and the
// fold that turns stored per-caller counts back into a CallerScore. The storage
// itself lives in backend/src/callers/.
// ---------------------------------------------------------------------------

/**
 * One durable call: a caller's EARLIEST post of one token, and the market cap
 * it was posted at.
 *
 * `fdvAtCall` is that row's own MC@call and nothing else. It is deliberately
 * NOT filled in from a later repost of the same address — MC@call is a
 * point-in-time reading (see `enrichmentMerge.ts`), so borrowing a later one
 * would silently score the caller against a moment they didn't call.
 */
export interface CallerCall {
  callerKey: string;
  displayName: string;
  /** As posted, original case. Dedupe and peak lookup use the lowercased form. */
  address: string;
  chain?: 'evm' | 'sol';
  evmChain?: string;
  fdvAtCall?: number;
  timestamp: string;
  /** Union of every room this caller's posts of this token landed in. */
  roomIds: string[];
}

/**
 * Collapse a contract log into one record per (caller, token).
 *
 * This is the attribution rule that used to live inside `buildCallerScores`,
 * lifted out so the persist path and the derive path can never drift:
 *
 * - **Earliest row wins.** Posting the same CA ten times is one call, otherwise
 *   spamming inflates the sample it's judged on.
 * - **Their own MC@call.** Five people calling one CA called it at five
 *   different caps; each is scored against their own row, never the token's
 *   earliest.
 * - **Excluded authors are dropped.** Enrichment bots repost everything;
 *   scoring them measures the room, not a caller.
 *
 * Rooms are the one thing merged across rows rather than taken from the
 * earliest: a caller's post of a token can land in several rooms over several
 * messages, and the record is of the call, not of one delivery of it.
 */
export function foldCallerCalls(
  contracts: ContractEntry[],
  options: { exclude?: readonly string[] } = {},
): CallerCall[] {
  const exclude = options.exclude ?? DEFAULT_EXCLUDED_CALLERS;
  const byPair = new Map<string, CallerCall>();

  for (const entry of contracts) {
    if (!entry.authorId) continue;
    if (!entry.address) continue;
    if (isExcludedCaller(entry, exclude)) continue;

    const callerKey = contractCallerKey(entry);
    const addr = entry.address.toLowerCase();
    const pairKey = `${callerKey}\u0000${addr}`;
    const at = new Date(entry.timestamp).getTime();
    const prior = byPair.get(pairKey);

    if (!prior) {
      byPair.set(pairKey, {
        callerKey,
        displayName: entry.authorName ?? '',
        address: entry.address,
        chain: entry.chain,
        evmChain: entry.evmChain,
        fdvAtCall: entry.fdvAtCall,
        timestamp: entry.timestamp,
        roomIds: [...new Set(entry.roomIds ?? [])],
      });
      continue;
    }

    // Rooms and the resolved EVM chain accumulate across every row for the
    // pair; the call itself (timestamp + MC@call) only ever moves earlier.
    for (const roomId of entry.roomIds ?? []) {
      if (!prior.roomIds.includes(roomId)) prior.roomIds.push(roomId);
    }
    if (!prior.evmChain && entry.evmChain) prior.evmChain = entry.evmChain;
    if (entry.authorName) prior.displayName = entry.authorName;

    if (at < new Date(prior.timestamp).getTime()) {
      prior.address = entry.address;
      prior.timestamp = entry.timestamp;
      prior.fdvAtCall = entry.fdvAtCall;
      prior.chain = entry.chain;
    }
  }

  return [...byPair.values()];
}

/**
 * Score one call against a peak, or `null` when either half is missing.
 *
 * A peak below the call is possible when the call itself was the top; floor at
 * the call so a flat token reads as 1x rather than as a negative signal.
 */
export function rateCall(call: CallerCall, peak: number | undefined): RatedCall | null {
  const mcAtCall = call.fdvAtCall;
  if (mcAtCall == null || mcAtCall <= 0) return null;
  if (peak == null || peak <= 0) return null;
  return {
    address: call.address,
    multiple: Math.max(peak, mcAtCall) / mcAtCall,
    timestamp: call.timestamp,
  };
}

/**
 * A caller's stored counts, as the persistent store hands them back.
 *
 * Counts rather than rates, because the ratios and the band must be derived by
 * `bandFromRates` — the one place that decision is made — and not recomputed in
 * SQL where it would quietly fork. `roomId` null/absent marks the global
 * (all-rooms) aggregate for that caller.
 */
export interface CallerAggregateRow {
  key: string;
  displayName: string;
  roomId?: string | null;
  /** Distinct (caller, token) pairs — the call count, not the row count. */
  calls: number;
  /** Of those, the ones with both an MC@call and a peak. */
  rated: number;
  medianMultiple?: number;
  bestMultiple?: number;
  hits2x: number;
  hits5x: number;
  slopCount: number;
  firstCallAt?: string;
  lastCallAt?: string;
}

/** Counts can only ever be a subset of the rated sample; a bad row is clamped, not trusted. */
function clampCount(n: number | undefined, rated: number): number {
  if (!Number.isFinite(n as number)) return 0;
  return Math.min(Math.max(Math.trunc(n as number), 0), rated);
}

/**
 * Turn stored counts into a `CallerScore`.
 *
 * Deliberately mirrors `scoreCaller` field for field — same `callsPerDay`, same
 * `bandFromRates` call — so a caller's band cannot depend on which path
 * produced it. `scoreCaller` folds a list of multiples it holds in memory; this
 * folds the same statistics after Postgres has already counted them.
 */
export function scoreFromAggregate(row: CallerAggregateRow, windowDays: number): CallerScore {
  const calls = Math.max(0, Math.trunc(row.calls));
  const rated = Math.min(Math.max(0, Math.trunc(row.rated)), calls);
  const base: CallerScore = { key: row.key, displayName: row.displayName, calls, rated, band: 'unrated' };
  if (windowDays > 0) base.callsPerDay = calls / windowDays;
  if (rated === 0) return base;

  const hits2x = clampCount(row.hits2x, rated) / rated;
  const hits5x = clampCount(row.hits5x, rated) / rated;
  const slop = clampCount(row.slopCount, rated) / rated;

  return {
    ...base,
    medianMultiple: Number.isFinite(row.medianMultiple as number) ? row.medianMultiple : undefined,
    bestMultiple: Number.isFinite(row.bestMultiple as number) ? row.bestMultiple : undefined,
    hitRate2x: hits2x,
    hitRate5x: hits5x,
    slopRate: slop,
    band: bandFromRates(rated, hits2x, slop),
  };
}

/**
 * Split one flat list of stored aggregates into the payload the console reads:
 * the global board, the per-room boards, and how far back the record reaches.
 *
 * Exclusions are applied here rather than in storage so that adding one takes
 * effect on the next read without rewriting history — see `isExcludedCallerKey`.
 */
export function splitCallerAggregates(
  rows: CallerAggregateRow[],
  windowDays: number,
  options: { exclude?: readonly string[] } = {},
): { scores: CallerScore[]; roomScores: RoomCallerScores; coversFrom?: string; callers: number } {
  const exclude = options.exclude ?? DEFAULT_EXCLUDED_CALLERS;
  const scores: CallerScore[] = [];
  const roomBuckets = new Map<string, CallerScore[]>();
  const callerKeys = new Set<string>();
  let coversFrom: string | undefined;
  let coversFromMs = Number.POSITIVE_INFINITY;

  for (const row of rows) {
    if (!row?.key) continue;
    if (isExcludedCallerKey(row.key, row.displayName ?? '', exclude)) continue;

    const score = scoreFromAggregate(row, windowDays);
    if (row.roomId == null || row.roomId === '') {
      callerKeys.add(row.key);
      scores.push(score);
      // Only the global rows are consulted for coverage: a room row is a slice
      // of the same calls, so including them could not move the minimum but
      // would make the scan proportional to rooms for nothing.
      const ms = row.firstCallAt ? new Date(row.firstCallAt).getTime() : NaN;
      if (Number.isFinite(ms) && ms < coversFromMs) {
        coversFromMs = ms;
        coversFrom = row.firstCallAt;
      }
      continue;
    }
    let bucket = roomBuckets.get(row.roomId);
    if (!bucket) {
      bucket = [];
      roomBuckets.set(row.roomId, bucket);
    }
    bucket.push(score);
  }

  const roomScores: RoomCallerScores = {};
  for (const [roomId, bucket] of roomBuckets) roomScores[roomId] = sortCallerScores(bucket);

  return { scores: sortCallerScores(scores), roomScores, coversFrom, callers: callerKeys.size };
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
