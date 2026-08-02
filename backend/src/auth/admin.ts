import type { Request, Response, NextFunction } from 'express';
import { isHostedMode } from '../storage/index.js';
import { resolveDiscordIdByOctUser } from '../bot/identity.js';

/**
 * Admin gating for the operator-only stats surface.
 *
 * `OCT_ADMIN_IDS` is a comma-separated allow-list that accepts EITHER form of
 * identity, because the two are both legitimate ways to name yourself here:
 *
 *   - a Supabase user UUID, which is what `req.userId` actually is in hosted mode
 *   - a Discord user ID, resolved through the same `oct_user_id_by_discord_id`
 *     link the bot already relies on
 *
 * Accepting both matters in practice: the Discord ID is the one an operator
 * knows by heart, while the Supabase UUID is the one the request carries.
 *
 * Local mode is single-user and binds to loopback with no auth at all, so there
 * is no meaningful admin boundary to enforce — the only caller is the person at
 * the machine. Gating there would lock the operator out of their own console.
 */
function allowList(): string[] {
  const raw = process.env.OCT_ADMIN_IDS ?? process.env.TRENCHCORD_ADMIN_IDS ?? '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function adminGatingConfigured(): boolean {
  return allowList().length > 0;
}

export async function isAdminUser(userId: string | undefined): Promise<boolean> {
  if (!isHostedMode()) return true;
  if (!userId) return false;

  const allowed = allowList();
  if (allowed.length === 0) return false; // fail closed: no list means no admins

  if (allowed.includes(userId)) return true;

  // Fall back to the linked Discord identity so a Discord ID in the list works.
  // Cached in identity.ts, so this is not a per-request round trip.
  const discordId = await resolveDiscordIdByOctUser(userId);
  return !!discordId && allowed.includes(discordId);
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (await isAdminUser(req.userId)) {
    next();
    return;
  }
  // Temporary diagnostic for the initial rollout: denials are rare (in practice
  // only the operator hitting this before their account is recognised), so one
  // log line per denial is cheap and lets us see exactly which identity the
  // gate saw without guessing. Remove once access is confirmed working.
  const discordId = await resolveDiscordIdByOctUser(req.userId ?? '').catch(() => 'lookup-threw');
  console.warn(
    `[Admin] denied — userId=${req.userId ?? 'none'} resolvedDiscordId=${discordId ?? 'none'} allowListLen=${allowList().length}`,
  );
  // 404 rather than 403: an unauthorised caller should not learn the surface exists.
  res.status(404).json({ error: 'Not found' });
}
