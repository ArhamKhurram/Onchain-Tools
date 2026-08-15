// The one place OCT sends a Components V2 direct message.
//
// Four surfaces DM users — alert pings (alerts.ts), the daily digest
// (dailyDigest.ts), release notes (releaseNotes.ts) and pump.fun callouts
// (../pumpfun/calloutDm.ts). Each had, or was about to get, its own copy of
// `client.users.fetch(id)` + `user.send({ flags, components })` + the same
// `err.code === 50007` special case. This module is that shape, once.
//
// Two properties matter more than the deduplication:
//
//  1. IT NEVER THROWS. Every caller is a fan-out loop over many users, and one
//     closed DM inbox must not abort the rest. Failures come back as an
//     outcome value, so the caller decides what to count and what to log.
//  2. "BLOCKED" IS NOT "FAILED". Discord only permits a bot to DM someone who
//     shares a server with it (error 50007). That is the single most common
//     outcome for a user who linked Discord but never joined the OCT server —
//     it is a state to report, not an error to spam the log with.

import type { Client } from 'discord.js';

/** Discord's "Cannot send messages to this user" — closed DMs / no shared server. */
export const DISCORD_CANNOT_DM = 50007;

/** MessageFlags.IsComponentsV2, spelled out so callers don't repeat the shift. */
export const COMPONENTS_V2_FLAG = 1 << 15;

/**
 * What happened to one DM.
 *
 * `blocked` and `rate_limited` are deliberately distinct from `failed`: the
 * first is a user-side state the caller reports as a count, the second tells
 * the caller to back off (see `retryDelayMs` in releaseNotes.ts).
 */
export type DmOutcome = 'delivered' | 'blocked' | 'rate_limited' | 'failed';

export interface DmResult {
  outcome: DmOutcome;
  /** The raw rejection, so a caller that wants retry-after can read it. */
  error?: unknown;
}

/** True when this rejection is Discord's "can't DM that user". */
export function isCannotDmError(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === DISCORD_CANNOT_DM;
}

/** True when Discord asked us to slow down. */
export function isRateLimitError(err: unknown): boolean {
  const e = err as { status?: unknown; code?: unknown } | null;
  return e?.status === 429 || e?.code === 429;
}

/**
 * Send one Components V2 DM. Resolves with an outcome; never rejects.
 *
 * `components` is the array a `build*Components` function returns — this does
 * not render anything itself, so every surface keeps its own card design.
 */
export async function sendBotDm(
  client: Client,
  discordUserId: string,
  components: unknown[],
): Promise<DmResult> {
  try {
    const user = await client.users.fetch(discordUserId);
    await user.send({ flags: COMPONENTS_V2_FLAG, components } as never);
    return { outcome: 'delivered' };
  } catch (err) {
    if (isCannotDmError(err)) return { outcome: 'blocked', error: err };
    if (isRateLimitError(err)) return { outcome: 'rate_limited', error: err };
    return { outcome: 'failed', error: err };
  }
}
