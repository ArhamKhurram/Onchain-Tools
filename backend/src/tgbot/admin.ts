// "Is this user an admin of this chat?" — one cached, fail-closed answer.
//
// WHY IT IS SHARED. The panel asks this on every write press, and now so does
// every command that writes (see permissions.ts). Two copies of a
// security-critical lookup is two places for the fail-closed rule to rot, and
// two independent caches asking Telegram the same question twice per action —
// getChatMember is a network round trip in the middle of somebody's tap.
//
// FAIL-CLOSED, AND A FAILURE IS NOT CACHED. A transport error, a 429, a chat
// the bot was just removed from: every one of them answers false, because "we
// could not check" and "not permitted" must have the same consequence for a
// control that changes what a whole room receives. But that false is NOT
// stored — caching it for a minute would lock a real admin out of their own
// chat over one blip, and the retry costs a single call.
//
// The map is pruned rather than bounded by an LRU: entries expire on a
// one-minute TTL, so a sweep past a threshold is enough to keep a multi-week
// uptime flat.

import type { TelegramBotApi } from './api.js';

/** How long a verdict is trusted before getChatMember is asked again. */
export const ADMIN_CACHE_MS = 60_000;

/** Beyond this many entries the map is swept for expired ones. */
const PRUNE_AT = 500;

/** The two chat-member statuses that mean "may change this chat's settings". */
function isAdminStatus(status: string | undefined): boolean {
  return status === 'creator' || status === 'administrator';
}

export class AdminCache {
  private readonly entries = new Map<string, { isAdmin: boolean; expiresAt: number }>();

  constructor(private readonly api: TelegramBotApi) {}

  /** Is this user a creator/administrator of this chat? Never rejects. */
  async isAdmin(chatId: number, userId: number, now: number = Date.now()): Promise<boolean> {
    const key = `${chatId}:${userId}`;
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > now) return cached.isAdmin;

    const result = await this.api.getChatMember(chatId, userId);
    if (!result.ok) {
      console.warn(
        `[TgBot] Could not resolve admin status on chat ${chatId} (${result.errorCode}); ` +
          'treating the actor as a non-admin.',
      );
      return false;
    }

    const isAdmin = isAdminStatus(result.result?.status);
    this.entries.set(key, { isAdmin, expiresAt: now + ADMIN_CACHE_MS });
    return isAdmin;
  }

  /** Drop expired entries once the map has grown past the sweep threshold. */
  prune(now: number = Date.now()): void {
    if (this.entries.size <= PRUNE_AT) return;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  /** Entries currently held. For tests and the boot log; not a public metric. */
  get size(): number {
    return this.entries.size;
  }
}
