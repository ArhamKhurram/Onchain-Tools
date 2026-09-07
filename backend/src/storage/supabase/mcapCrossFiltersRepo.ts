import { sanitizeStoredFilters, type McapCrossFilters } from '../../mcapCross/filters.js';
import { BaseRepo, throwIfError } from './client.js';

/**
 * Per-user market-cap-crossing filters, stored inside the existing
 * `user_configs.settings` JSONB blob.
 *
 * WHY NO NEW TABLE. Four optional numbers per user, read a handful of times an
 * hour, written by hand. A dedicated table would need a migration, an RLS
 * policy and a second round-trip on a Free-plan project whose binding
 * constraint is egress — for a payload smaller than the row overhead. It also
 * means a NEW filter key costs no migration at all: the blob's shape is
 * enforced by `sanitizeStoredFilters`, not by Postgres. The blob
 * already exists, is already per-user, and is already RLS-scoped by
 * `user_id`.
 *
 * WHY NOT JUST CALL `getConfig`. Because that is the expensive read: on a cache
 * miss it fans out to five concurrent loads (tokens, rooms bundle, telegram
 * creds, telegram sessions, settings) and returns the whole config. This
 * selects the ONE column it needs. Same rule `getContractsForScoring` follows.
 *
 * SANITIZED ON READ, not only on write. `settings` is a JSON blob that other
 * code paths (config import, a future migration, a manual fix) can also touch.
 * A value that is out of range or the wrong type is dropped here so the gate
 * falls back to the operator baseline rather than running with a threshold
 * nobody vetted.
 */
export class McapCrossFiltersRepo extends BaseRepo {
  private key(userId: string): string {
    return `${userId}:mcapCrossFilters`;
  }

  /**
   * Never throws. The poller calls this once per firing crossing, and an alert
   * that a transient Supabase error can silence is worse than one delivered at
   * the operator's own thresholds — so a failed read degrades to "no
   * overrides", which is exactly today's behaviour.
   */
  async getMcapCrossFilters(userId: string): Promise<McapCrossFilters> {
    try {
      return await this.cached(this.key(userId), async () => {
        const { data, error } = await this.supabase
          .from('user_configs')
          .select('settings')
          .eq('user_id', userId)
          .maybeSingle();
        if (error) throw error;
        const settings = (data?.settings ?? {}) as Record<string, unknown>;
        return sanitizeStoredFilters(settings.mcapCrossFilters);
      });
    } catch (err) {
      console.warn(
        `[McapCross] Filter read failed for ${userId}; using operator defaults:`,
        (err as Error)?.message,
      );
      return {};
    }
  }

  /**
   * Read-modify-write of the settings blob, the same shape `updateConfig` uses.
   * The whole-user cache is invalidated afterwards because `getConfig` also
   * caches this blob and would otherwise serve a stale copy for its TTL.
   */
  async setMcapCrossFilters(
    userId: string,
    filters: McapCrossFilters,
  ): Promise<McapCrossFilters> {
    const clean = sanitizeStoredFilters(filters);

    const { data: existing, error: readError } = await this.supabase
      .from('user_configs')
      .select('settings')
      .eq('user_id', userId)
      .maybeSingle();
    if (readError) throwIfError({ error: readError }, 'Failed to read config settings');

    const settings = { ...((existing?.settings ?? {}) as Record<string, unknown>) };
    // An empty override set is stored as an absent key, not as `{}` — "I have
    // set nothing" and "I have set nothing back" must round-trip identically.
    if (Object.keys(clean).length === 0) delete settings.mcapCrossFilters;
    else settings.mcapCrossFilters = clean;

    const result = await this.supabase
      .from('user_configs')
      .upsert({ user_id: userId, settings }, { onConflict: 'user_id' });
    throwIfError(result, 'Failed to update market-cap alert filters');

    this.invalidateUser(userId);
    return clean;
  }
}
