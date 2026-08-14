// Data access for the pump.fun callout-tracking feature.
//
// The pump_* callout tables are hosted-only and partly service-role-only, so —
// exactly like the fomo_* tables — both the REST routes and the fan-out poller
// talk to Supabase through a shared service client rather than the generic
// StorageProvider. The client is deliberately UNTYPED (SupabaseClient, not
// <Database>): these tables are not in the generated shared types, so string
// table names + explicit row casts keep it compiling without a types regen,
// mirroring pumpSessionRepo.
//
// Routes run under the service role (which bypasses RLS), so every per-user
// query scopes by user_id explicitly — the same discipline the FOMO routes use.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let _client: SupabaseClient | null = null;

function resolveServiceConfig(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL?.trim();
  const key = (process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY)?.trim();
  if (!url || !key) return null;
  return { url, key };
}

/** Process-wide service client for pump_* callout tables; null in local mode. */
export function getPumpServiceClient(): SupabaseClient | null {
  if (_client) return _client;
  const cfg = resolveServiceConfig();
  if (!cfg) return null;
  _client = createClient(cfg.url, cfg.key, { auth: { persistSession: false } });
  return _client;
}

/** A caller a user follows, as the client sees it. */
export interface TrackedCaller {
  callerAddress: string;
  username: string | null;
  displayName: string | null;
  avatar: string | null;
  source: string;
  notifyPushover: boolean;
  createdAt: string;
}

/** One tracker of a caller, for reverse fan-out. */
export interface CallerTrackerRow {
  userId: string;
  notifyPushover: boolean;
}

export interface CalloutPollState {
  lastCalloutId: string | null;
  seeded: boolean;
}

interface RawTrackedRow {
  user_id: string;
  caller_address: string;
  username: string | null;
  display_name: string | null;
  avatar: string | null;
  source: string | null;
  notify_pushover: boolean | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Poller-facing reads (all callers across all users).
// ---------------------------------------------------------------------------

let _trackedCache: { byAddress: Map<string, CallerTrackerRow[]>; at: number } | null = null;

/**
 * Every followed caller as address → trackers, deduped across users. Memoised
 * briefly (like the FOMO tracked cache) so the hot poll loop does not re-read
 * the whole table each cycle; a newly-followed caller joins within the TTL.
 */
export async function loadTrackersByAddress(): Promise<Map<string, CallerTrackerRow[]>> {
  const ttl = Number.parseInt(process.env.PUMP_TRACKED_CACHE_MS ?? '', 10) || 60_000;
  if (_trackedCache && Date.now() - _trackedCache.at < ttl) return _trackedCache.byAddress;

  const db = getPumpServiceClient();
  const byAddress = new Map<string, CallerTrackerRow[]>();
  if (!db) {
    _trackedCache = { byAddress, at: Date.now() };
    return byAddress;
  }

  const { data, error } = await db
    .from('pump_tracked_callers')
    .select('user_id, caller_address, notify_pushover');
  if (error) throw error;

  for (const raw of (data ?? []) as Pick<RawTrackedRow, 'user_id' | 'caller_address' | 'notify_pushover'>[]) {
    if (!raw.caller_address || !raw.user_id) continue;
    const list = byAddress.get(raw.caller_address) ?? [];
    list.push({ userId: raw.user_id, notifyPushover: raw.notify_pushover ?? true });
    byAddress.set(raw.caller_address, list);
  }
  _trackedCache = { byAddress, at: Date.now() };
  return byAddress;
}

/** Drop the tracked-caller memo so a fresh follow/unfollow is seen next poll. */
export function invalidateTrackedCache(): void {
  _trackedCache = null;
}

export async function getCalloutPollState(): Promise<CalloutPollState | null> {
  const db = getPumpServiceClient();
  if (!db) return null;
  const { data, error } = await db
    .from('pump_callout_poll_state')
    .select('last_callout_id, seeded')
    .eq('id', true)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as { last_callout_id: string | null; seeded: boolean | null };
  return { lastCalloutId: row.last_callout_id, seeded: row.seeded ?? false };
}

export async function setCalloutPollState(lastCalloutId: string | null, seeded: boolean): Promise<void> {
  const db = getPumpServiceClient();
  if (!db) return;
  const { error } = await db.from('pump_callout_poll_state').upsert(
    { id: true, last_callout_id: lastCalloutId, seeded, last_polled_at: new Date().toISOString() },
    { onConflict: 'id' },
  );
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Route-facing per-user CRUD (scoped by user_id under the service role).
// ---------------------------------------------------------------------------

function toTrackedCaller(raw: RawTrackedRow): TrackedCaller {
  return {
    callerAddress: raw.caller_address,
    username: raw.username,
    displayName: raw.display_name,
    avatar: raw.avatar,
    source: raw.source ?? 'follow',
    notifyPushover: raw.notify_pushover ?? true,
    createdAt: raw.created_at,
  };
}

export async function listTrackedCallers(userId: string): Promise<TrackedCaller[]> {
  const db = getPumpServiceClient();
  if (!db) return [];
  const { data, error } = await db
    .from('pump_tracked_callers')
    .select('user_id, caller_address, username, display_name, avatar, source, notify_pushover, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return ((data ?? []) as RawTrackedRow[]).map(toTrackedCaller);
}

export interface AddTrackedCallerInput {
  callerAddress: string;
  username: string | null;
  displayName: string | null;
  avatar: string | null;
  source?: string;
  notifyPushover?: boolean;
}

export async function addTrackedCaller(userId: string, input: AddTrackedCallerInput): Promise<TrackedCaller> {
  const db = getPumpServiceClient();
  if (!db) throw new Error('Supabase not configured');
  const { data, error } = await db
    .from('pump_tracked_callers')
    .upsert(
      {
        user_id: userId,
        caller_address: input.callerAddress,
        username: input.username,
        display_name: input.displayName,
        avatar: input.avatar,
        source: input.source ?? 'follow',
        notify_pushover: input.notifyPushover ?? true,
      },
      { onConflict: 'user_id,caller_address' },
    )
    .select('user_id, caller_address, username, display_name, avatar, source, notify_pushover, created_at')
    .single();
  if (error) throw error;
  invalidateTrackedCache();
  return toTrackedCaller(data as RawTrackedRow);
}

/**
 * Follow several callers at once (the leaderboard / "popular callers" on-ramps).
 * A single upsert so N follows cost one round-trip; conflicts on
 * (user_id, caller_address) are ignored (re-following is a no-op). Returns the
 * user's full follow list after the insert so the client can reconcile state.
 */
export async function addTrackedCallersBulk(
  userId: string,
  inputs: AddTrackedCallerInput[],
): Promise<TrackedCaller[]> {
  const db = getPumpServiceClient();
  if (!db) throw new Error('Supabase not configured');
  if (inputs.length === 0) return listTrackedCallers(userId);

  const rows = inputs.map((input) => ({
    user_id: userId,
    caller_address: input.callerAddress,
    username: input.username,
    display_name: input.displayName,
    avatar: input.avatar,
    source: input.source ?? 'leaderboard',
    notify_pushover: input.notifyPushover ?? true,
  }));
  const { error } = await db
    .from('pump_tracked_callers')
    .upsert(rows, { onConflict: 'user_id,caller_address', ignoreDuplicates: true });
  if (error) throw error;
  invalidateTrackedCache();
  return listTrackedCallers(userId);
}

export async function removeTrackedCaller(userId: string, callerAddress: string): Promise<void> {
  const db = getPumpServiceClient();
  if (!db) return;
  const { error } = await db
    .from('pump_tracked_callers')
    .delete()
    .eq('user_id', userId)
    .eq('caller_address', callerAddress);
  if (error) throw error;
  invalidateTrackedCache();
}
