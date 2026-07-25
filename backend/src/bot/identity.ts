// Map a Discord user to their OCT account.
//
// Users who signed into OCT with Discord already have their Discord identity in
// Supabase (auth.identities), so there is no linking flow — the bot just passes
// the interaction's Discord user id and we resolve it here (DISCORD_BOT_PLAN §2c).
// PostgREST can't read the auth schema, so this goes through the
// oct_user_id_by_discord_id() SECURITY DEFINER function.
//
// Users who signed up with email/Google have no Discord identity and are
// gatekept: callers surface "link Discord on OCT to use this".

import { getFomoServiceClient } from '../fomo/store.js';

const TTL_MS = 10 * 60 * 1000; // identities effectively never change
const NEGATIVE_TTL_MS = 60 * 1000; // let a fresh link take effect quickly
const MAX_ENTRIES = 500;

const cache = new Map<string, { userId: string | null; expiresAt: number }>();

/** Test seam. */
export function clearIdentityCache(): void {
  cache.clear();
}

function readCache(discordUserId: string): { userId: string | null } | null {
  const hit = cache.get(discordUserId);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(discordUserId);
    return null;
  }
  return { userId: hit.userId };
}

function writeCache(discordUserId: string, userId: string | null): void {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(discordUserId, {
    userId,
    expiresAt: Date.now() + (userId ? TTL_MS : NEGATIVE_TTL_MS),
  });
}

/**
 * Resolve a Discord user id to an OCT user id, or null when that Discord
 * account isn't linked to one. Never throws — an infrastructure failure reads
 * as "not linked" to the caller, which degrades to the gatekeep message.
 */
export async function resolveOctUserByDiscordId(discordUserId: string): Promise<string | null> {
  const id = discordUserId?.trim();
  if (!id) return null;

  const cached = readCache(id);
  if (cached) return cached.userId;

  const db = getFomoServiceClient();
  if (!db) return null; // storage not configured (local mode) — nothing to resolve

  try {
    const { data, error } = await db.rpc('oct_user_id_by_discord_id', { p_discord_id: id });
    if (error) {
      console.error('[BotIdentity] Lookup failed:', error.message);
      return null;
    }
    const userId = typeof data === 'string' && data.length > 0 ? data : null;
    writeCache(id, userId);
    return userId;
  } catch (err) {
    console.error('[BotIdentity] Lookup threw:', (err as Error)?.message ?? err);
    return null;
  }
}
