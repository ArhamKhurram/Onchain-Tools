import { BaseRepo, throwIfError } from './client.js';
import { HotCache } from '../hotCache.js';

/**
 * Display-name cache writes.
 *
 * This runs on EVERY inbound message — both `processDiscordMessage` and
 * `processTelegramMessage` call `ctx.cacheUserName(...)` unconditionally while
 * building the frontend message — and the call site does not await it. Before
 * this memo it therefore cost, per message and per user:
 *
 *   - one `user_configs` SELECT (unconditional: the only way it learned whether
 *     the name had changed was to read the stored blob), plus
 *   - one UPSERT whenever the name was new, plus
 *   - an `invalidateUser`, which threw away the whole config + rooms cache and
 *     forced the *next* message to redo ~8 queries.
 *
 * That made it the single biggest contributor to the 2026-09-06 pool
 * exhaustion, and the one read that no TTL cache could absorb, since it was a
 * write path. The JSON provider never had this problem — `configStore` already
 * keeps the name map in memory and debounces the flush by 5s.
 *
 * The fix mirrors that: keep the last name we wrote per (user, author) in
 * process, and skip the database entirely when it is unchanged. The cost is
 * that a name edited directly in Supabase can take up to `MEMO_TTL_MS` to be
 * re-written here — harmless, because the row we would write is the same value
 * this process already believes, and the memo expires on its own.
 */

/** 10 minutes. Long enough that a chatty room writes once, not per message. */
const MEMO_TTL_MS = 10 * 60 * 1000;

/**
 * Bounded independently of the storage cache: keys are per author, not per
 * user, so a busy tenant can hold thousands. Eviction just costs one extra
 * no-op write later.
 */
const nameMemo = new HotCache({ ttlMs: MEMO_TTL_MS, maxEntries: 20_000 });

/** Test hook — the memo is module-level and otherwise leaks between specs. */
export function resetUserNameMemo(): void {
  nameMemo.clear();
}

export class UserCacheRepo extends BaseRepo {
  async cacheUserName(userId: string, discordUserId: string, displayName: string): Promise<void> {
    const memoKey = `${userId}:${discordUserId}`;
    if (nameMemo.get<string>(memoKey) === displayName) return;

    const { data } = await this.supabase
      .from('user_configs')
      .select('settings')
      .eq('user_id', userId)
      .single();

    const settings = data?.settings ?? {};
    const cache = settings.userNameCache ?? {};
    if (cache[discordUserId] === displayName) {
      // Already stored — memoize so the next message for this author does not
      // repeat even this read.
      nameMemo.set(memoKey, displayName);
      return;
    }

    cache[discordUserId] = displayName;
    settings.userNameCache = cache;

    const result = await this.supabase
      .from('user_configs')
      .upsert({ user_id: userId, settings }, { onConflict: 'user_id' });
    throwIfError(result, 'Failed to cache user name');
    nameMemo.set(memoKey, displayName);
    this.invalidateUser(userId);
  }
}
