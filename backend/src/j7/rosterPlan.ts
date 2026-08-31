// The roster diff, as a pure function.
//
// j7 accounts have a hard cap (50 pump + 50 fomo each), OCT's users collectively
// want more than that — 121 distinct pump callers against 100 slots when this was
// measured — so "which targets does each account track" is a real allocation
// decision, not a set copy. It lives here, with no Supabase and no fetch, because
// it is the part that must be exactly right and is worth unit-testing hard
// (test/j7Roster.test.ts). roster.ts does the I/O around it.
//
// Three properties are load-bearing:
//
//  1. EXACTLY ONE ACCOUNT OWNS A TARGET. Two sockets subscribed to the same
//     caller would deliver every callout twice. The dedupers upstream would
//     swallow it, but the wasted slot would not come back — with demand over
//     capacity a duplicate literally costs a caller nobody hears.
//  2. OVER-CAPACITY IS RANKED, NOT ARBITRARY. Most-followed wins, ties broken by
//     who was followed first. Both halves matter: without the rank we'd drop
//     popular callers at random, and without the stable tie-break the tail would
//     reshuffle every cycle and churn subscriptions (each change costs a socket
//     reconnect).
//  3. THE PLAN IS A FUNCTION OF THE INPUT ALONE. Same demand + same live rows =
//     same plan, so a restart mid-cycle converges rather than oscillating.

/**
 * One target OCT users want tracked upstream — a pump caller or a fomo trader,
 * already folded across everyone who tracks it.
 */
export interface DesiredTarget {
  /**
   * Canonical identity: the caller wallet for pump, the handle for fomo. Also
   * the dedup key across users and what `dropped` reports.
   */
  key: string;
  /** The exact string handed to j7's `/add` (j7 takes a username, wallet or URL). */
  addAs: string;
  /**
   * Other identifiers a j7 list row may report for this same target — the pump
   * username against a wallet-keyed follow, mostly. Matching is what stops the
   * reconciler re-adding a caller it already tracks under j7's own spelling.
   */
  aliases: string[];
  /** How many OCT users track it. The over-capacity priority. */
  followerCount: number;
  /** Earliest follow time across those users, ISO. The stable tie-break. */
  addedAt: string;
}

/** One row j7 reports as currently tracked by an account. */
export interface ActualTarget {
  /** The string handed to j7's `/remove` — j7's own identifier for the row. */
  removeAs: string;
  /** Every identifier the row carries (wallet + username, or id + handle). */
  identifiers: string[];
}

/** One configured account and what it is tracking right now. */
export interface AccountCapacity {
  /** Display label, for logs only — assignment is by position. */
  username: string;
  /** Server-enforced slot cap for this tracker (j7 reports it on `/list`). */
  cap: number;
  actual: ActualTarget[];
}

/** What one account must do this cycle, plus the set it ends up owning. */
export interface AccountPlan {
  username: string;
  cap: number;
  /** `addAs` strings to POST to `/add`. */
  toAdd: string[];
  /** `removeAs` strings to POST to `/remove`. */
  toRemove: string[];
  /** Desired keys assigned to this account (its full target set after applying). */
  assigned: string[];
  /** True when the tracked set actually changes — the reconnect trigger. */
  changed: boolean;
}

/** A target nobody upstream will track, because we ran out of slots. */
export interface DroppedTarget {
  key: string;
  followerCount: number;
}

export interface RosterPlan {
  accounts: AccountPlan[];
  /** Ranked tail that did not fit. Empty whenever demand ≤ capacity. */
  dropped: DroppedTarget[];
  totalSlots: number;
  /** Distinct desired targets, before the cap was applied. */
  desiredCount: number;
}

/**
 * Identifier comparison key.
 *
 * Case-folded because the three identifier spaces disagree with themselves:
 * pump usernames and fomo handles round-trip with whatever casing the user
 * typed, and j7 echoes its own. Wallet addresses are the one case-sensitive
 * space, and two base58 pubkeys differing only in case is not a thing that
 * happens — folding them is safe and buys the other two spaces correctness.
 */
function norm(v: string): string {
  return v.trim().toLowerCase();
}

/**
 * Rank order for the over-capacity cut: most-followed first, then oldest follow,
 * then key. The third term exists only to make the order TOTAL — without it two
 * targets with equal followers and identical timestamps would sort
 * unpredictably and could swap places between cycles, which is exactly the
 * churn the tie-break is there to prevent.
 */
export function compareDesired(a: DesiredTarget, b: DesiredTarget): number {
  if (a.followerCount !== b.followerCount) return b.followerCount - a.followerCount;
  if (a.addedAt !== b.addedAt) return a.addedAt < b.addedAt ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Diff OCT's demand against what the accounts actually track.
 *
 * Targets are ranked, cut to total capacity, then dealt out by filling account 1
 * to its cap before account 2 — positional and therefore reproducible. Each
 * account is then diffed against only the slice it owns, so a target that moved
 * between accounts comes out as a remove on the old one and an add on the new.
 *
 * Note the deal is positional rather than sticky: a newly-popular caller
 * entering at the top shifts the account boundary by one, costing two accounts a
 * swap each. That is bounded (and only those accounts reconnect), and it buys
 * the property that two processes planning the same demand agree — which a
 * "keep it where it was" rule would not.
 */
export function planRoster(desired: DesiredTarget[], accounts: AccountCapacity[]): RosterPlan {
  const totalSlots = accounts.reduce((n, a) => n + Math.max(0, a.cap), 0);

  // Defensive dedup by canonical key: two users following the same caller must
  // never consume two slots. The loaders fold already; this makes the invariant
  // the planner's own, since violating it silently halves capacity.
  const byKey = new Map<string, DesiredTarget>();
  for (const t of desired) {
    if (!byKey.has(norm(t.key))) byKey.set(norm(t.key), t);
  }
  const ranked = [...byKey.values()].sort(compareDesired);

  const selected = ranked.slice(0, totalSlots);
  const dropped = ranked
    .slice(totalSlots)
    .map((t) => ({ key: t.key, followerCount: t.followerCount }));

  const plans: AccountPlan[] = [];
  let cursor = 0;
  for (const account of accounts) {
    const cap = Math.max(0, account.cap);
    const mine = selected.slice(cursor, cursor + cap);
    cursor += mine.length;

    // Every identifier that resolves to a target THIS account should own.
    const wanted = new Map<string, DesiredTarget>();
    for (const t of mine) {
      wanted.set(norm(t.key), t);
      for (const alias of t.aliases) {
        if (alias) wanted.set(norm(alias), t);
      }
    }

    const matched = new Set<string>();
    const toRemove: string[] = [];
    for (const row of account.actual) {
      let hit: DesiredTarget | undefined;
      for (const id of row.identifiers) {
        if (!id) continue;
        hit = wanted.get(norm(id));
        if (hit) break;
      }
      // Unwanted here, or a SECOND row for a target already matched (a j7-side
      // duplicate) — either way the row is holding a slot for nothing.
      if (!hit || matched.has(hit.key)) {
        toRemove.push(row.removeAs);
        continue;
      }
      matched.add(hit.key);
    }

    const toAdd = mine.filter((t) => !matched.has(t.key)).map((t) => t.addAs);

    plans.push({
      username: account.username,
      cap,
      toAdd,
      toRemove,
      assigned: mine.map((t) => t.key),
      changed: toAdd.length > 0 || toRemove.length > 0,
    });
  }

  return { accounts: plans, dropped, totalSlots, desiredCount: ranked.length };
}
