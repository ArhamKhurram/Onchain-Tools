// The j7 "dropped roster" — picks OCT users made that j7 could NOT take
// upstream, because its 50-slot-per-account cap was exceeded.
//
// Backend: GET /api/pumpfun/roster/dropped (backend/src/j7/roster.ts
// getDroppedRoster). Pure helpers live here, separate from the fetching hook,
// so the lookup — the thing the "not live" badge depends on — is unit-testable
// without React or a network.
//
// KEY SPACES. `pump` keys are caller WALLET addresses (== TrackedCaller
// .callerAddress); `fomo` keys are trader HANDLES (== FomoTrackedUser
// .fomo_handle). Both are compared case-folded and trimmed, mirroring the
// backend planner's `norm` (j7/rosterPlan.ts): handles round-trip with whatever
// casing the user typed, and two base58 pubkeys differing only in case is not a
// thing that happens, so folding wallets too is safe and buys the handles
// correctness.

export interface DroppedTarget {
  key: string;
  /** Distinct OCT users who follow this target. */
  followerCount: number;
}

/** The endpoint payload, one-for-one with the backend's DroppedRoster. */
export interface DroppedRosterPayload {
  pump: DroppedTarget[];
  fomo: DroppedTarget[];
  /** ISO time of the reconcile that produced this, or null if none has run. */
  at: string | null;
}

export type DroppedTracker = 'pump' | 'fomo';

/** Case-folded index over the payload, built once per fetch. */
export interface DroppedLookup {
  pump: ReadonlyMap<string, DroppedTarget>;
  fomo: ReadonlyMap<string, DroppedTarget>;
  at: string | null;
}

export const EMPTY_DROPPED_LOOKUP: DroppedLookup = { pump: new Map(), fomo: new Map(), at: null };

/** Identifier comparison key — must stay in step with backend rosterPlan.ts `norm`. */
export function normDroppedKey(v: string): string {
  return v.trim().toLowerCase();
}

function index(list: DroppedTarget[] | undefined): Map<string, DroppedTarget> {
  const out = new Map<string, DroppedTarget>();
  for (const t of list ?? []) {
    if (!t || typeof t.key !== 'string' || t.key.trim() === '') continue;
    const k = normDroppedKey(t.key);
    // First wins: the backend already dedups, so a repeat can only be the same target.
    if (!out.has(k)) out.set(k, t);
  }
  return out;
}

/**
 * Build the lookup from a payload. Tolerant of a partial/absent body (an older
 * backend without the route answers 404 → the hook hands in null) so the badge
 * simply never shows rather than the tab crashing.
 */
export function buildDroppedLookup(payload: Partial<DroppedRosterPayload> | null | undefined): DroppedLookup {
  if (!payload) return EMPTY_DROPPED_LOOKUP;
  return {
    pump: index(payload.pump),
    fomo: index(payload.fomo),
    at: typeof payload.at === 'string' ? payload.at : null,
  };
}

/** Is this pick in the dropped set for its tracker? Null/empty keys are never dropped. */
export function isDropped(lookup: DroppedLookup, tracker: DroppedTracker, key: string | null | undefined): boolean {
  if (!key) return false;
  return lookup[tracker].has(normDroppedKey(key));
}

/** Total dropped picks across both trackers — the number the notice leads with. */
export function droppedCount(lookup: DroppedLookup, tracker?: DroppedTracker): number {
  if (tracker) return lookup[tracker].size;
  return lookup.pump.size + lookup.fomo.size;
}

/**
 * The subset of the user's own picks that are not live — what the expanded
 * notice lists. Keeps the caller's ordering so the list reads like the roster
 * it annotates.
 */
export function droppedAmong<T>(
  lookup: DroppedLookup,
  tracker: DroppedTracker,
  items: readonly T[],
  keyOf: (item: T) => string | null | undefined,
): T[] {
  return items.filter((item) => isDropped(lookup, tracker, keyOf(item)));
}
