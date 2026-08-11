// Negative cache for tracked FOMO users the upstream API says do not exist.
//
// Incident 2026-08-11: a dead tracked user 404'd ("User not found") on every
// poll — one warn every ~30s, for hours, because nothing remembered the
// answer. Repeated consecutive 404s now park the user for a long interval
// (default 6h) with a single warn instead of an infinite retry loop.
//
// This is deliberately NOT unfollow automation: the row stays in
// fomo_tracked_users and polling resumes after the skip window — the account
// could come back, and one probe per window is cheap.
//
// Pure decision functions; the poller owns the Map that holds the entries.

/** Consecutive "User not found" 404s before a user is parked. */
export const DEAD_USER_MISS_THRESHOLD = 3;

export const DEFAULT_DEAD_USER_SKIP_MS = 6 * 60 * 60 * 1000; // 6h

export function deadUserSkipMs(): number {
  const raw = Number.parseInt(process.env.FOMO_DEAD_USER_SKIP_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DEAD_USER_SKIP_MS;
}

export interface DeadUserEntry {
  consecutiveMisses: number;
  /** Epoch ms until which the user is skipped; null while below threshold. */
  skipUntil: number | null;
}

/** Only a 404 whose body says the user is gone counts — other 404s (bad path, upstream flap) do not. */
export function isUserNotFound(status: number, text: string | null | undefined): boolean {
  return status === 404 && /user not found/i.test(text ?? '');
}

/**
 * Record one "User not found" miss. At DEAD_USER_MISS_THRESHOLD consecutive
 * misses the entry gets an active skip window. After a window expires, the
 * count is already past the threshold, so a single failed probe re-parks the
 * user for another window — one retry per window, not one per poll.
 */
export function recordNotFound(
  entry: DeadUserEntry | undefined,
  now: number,
  skipMs: number,
): DeadUserEntry {
  const consecutiveMisses = (entry?.consecutiveMisses ?? 0) + 1;
  return {
    consecutiveMisses,
    skipUntil: consecutiveMisses >= DEAD_USER_MISS_THRESHOLD ? now + skipMs : null,
  };
}

export function shouldSkipUser(entry: DeadUserEntry | undefined, now: number): boolean {
  return !!entry && entry.skipUntil !== null && now < entry.skipUntil;
}
