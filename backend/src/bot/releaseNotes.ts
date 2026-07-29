/**
 * Release-note DMs — opt-in only.
 *
 * The rule this module exists to enforce: **nobody is DMed a release note
 * unless they asked for release notes specifically.** Turning on bot DMs for
 * contract scans is not consent to receive changelog posts, so `releaseNotes`
 * is its own trigger, defaulting off, resolved through the same
 * `discordBotDm.triggers` shape the alert path already uses.
 *
 * Broadcasting to a list is also the one place in this codebase where getting
 * pacing wrong has a consequence beyond a failed request: Discord treats a burst
 * of unsolicited DMs as spam and can restrict the bot, which would take the
 * alert DMs down with it. Hence the sequential send with a floor delay, the
 * 429 retry-after handling, and the hard recipient cap.
 */

import type { Client } from 'discord.js';
import { getFomoServiceClient } from '../fomo/store.js';
import { resolveDiscordIdByOctUser } from './identity.js';
import { buildAnnouncementComponents, type AnnouncePayload } from './announce.js';

/** Discord's "cannot send messages to this user". */
const DISCORD_CANNOT_DM = 50007;

/** Floor gap between DMs. Well inside Discord's limits and deliberately dull. */
export const DM_INTERVAL_MS = 600;

/** A broadcast bigger than this means something is wrong; refuse rather than spray. */
export const MAX_RECIPIENTS = 2000;

export interface ReleaseNoteResult {
  eligible: number;
  delivered: number;
  /** Users who can't be DMed (closed DMs / no shared server). Not a failure. */
  blocked: number;
  failed: number;
  /** True when the recipient list was cut at MAX_RECIPIENTS. */
  truncated: boolean;
}

interface UserConfigRow {
  user_id: string;
  settings: unknown;
}

/**
 * Has this user opted into release notes?
 *
 * Both gates must pass: the DM master switch AND the specific trigger. Written
 * defensively because `settings` is an untyped JSON blob — anything unexpected
 * reads as "no".
 */
export function isReleaseNotesOptIn(settings: unknown): boolean {
  if (!settings || typeof settings !== 'object') return false;
  const dm = (settings as Record<string, unknown>).discordBotDm;
  if (!dm || typeof dm !== 'object') return false;
  const prefs = dm as { enabled?: unknown; triggers?: unknown };
  if (prefs.enabled !== true) return false;
  if (!prefs.triggers || typeof prefs.triggers !== 'object') return false;
  return (prefs.triggers as Record<string, unknown>).releaseNotes === true;
}

/** OCT user ids that opted in, capped. */
export function selectOptInUserIds(rows: UserConfigRow[]): { userIds: string[]; truncated: boolean } {
  const all = rows.filter((r) => isReleaseNotesOptIn(r.settings)).map((r) => r.user_id);
  return { userIds: all.slice(0, MAX_RECIPIENTS), truncated: all.length > MAX_RECIPIENTS };
}

/** Honour Discord's retry-after (seconds) when present, else the floor delay. */
export function retryDelayMs(err: unknown): number {
  const retryAfter = (err as { retry_after?: number; retryAfter?: number })?.retry_after
    ?? (err as { retryAfter?: number })?.retryAfter;
  if (typeof retryAfter === 'number' && retryAfter > 0) {
    return Math.min(Math.ceil(retryAfter * 1000), 60_000);
  }
  return DM_INTERVAL_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadOptInUserIds(): Promise<{ userIds: string[]; truncated: boolean }> {
  const db = getFomoServiceClient();
  if (!db) return { userIds: [], truncated: false };

  const { data, error } = await db.from('user_configs').select('user_id, settings');
  if (error) {
    console.warn('[ReleaseNotes] Failed to load user configs:', error.message);
    return { userIds: [], truncated: false };
  }
  return selectOptInUserIds((data ?? []) as UserConfigRow[]);
}

/**
 * DM a release note to everyone who opted in.
 *
 * Never throws: a broadcast is best-effort per recipient, and one closed DM
 * inbox must not abort the rest. Returns counts so the caller can report what
 * actually happened rather than assuming success.
 */
export async function deliverReleaseNotes(
  client: Client | null,
  payload: AnnouncePayload,
): Promise<ReleaseNoteResult> {
  const result: ReleaseNoteResult = {
    eligible: 0, delivered: 0, blocked: 0, failed: 0, truncated: false,
  };
  if (!client) return result;

  const { userIds, truncated } = await loadOptInUserIds();
  result.eligible = userIds.length;
  result.truncated = truncated;
  if (truncated) {
    console.warn(`[ReleaseNotes] Recipient list capped at ${MAX_RECIPIENTS}; some opt-ins were skipped.`);
  }
  if (userIds.length === 0) return result;

  const components = buildAnnouncementComponents(payload);

  for (const userId of userIds) {
    try {
      const discordId = await resolveDiscordIdByOctUser(userId);
      if (!discordId) continue; // opted in but never linked Discord

      const user = await client.users.fetch(discordId);
      await user.send({ flags: 1 << 15 /* IsComponentsV2 */, components } as any);
      result.delivered++;
    } catch (err: any) {
      if (err?.code === DISCORD_CANNOT_DM) {
        result.blocked++;
      } else if (err?.status === 429 || err?.code === 429) {
        await sleep(retryDelayMs(err));
        result.failed++;
      } else {
        result.failed++;
        console.error('[ReleaseNotes] DM failed:', err?.message ?? err);
      }
    }
    await sleep(DM_INTERVAL_MS);
  }

  console.log(
    `[ReleaseNotes] Sent to ${result.delivered}/${result.eligible} opt-ins ` +
      `(${result.blocked} blocked, ${result.failed} failed).`,
  );
  return result;
}
