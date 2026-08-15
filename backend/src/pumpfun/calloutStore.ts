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
  notifyDiscord: boolean;
  createdAt: string;
}

/** One tracker of a caller, for reverse fan-out. */
export interface CallerTrackerRow {
  userId: string;
  notifyPushover: boolean;
  notifyDiscord: boolean;
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
  /** Absent entirely before the notify_discord migration is applied. */
  notify_discord?: boolean | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// notify_discord migration tolerance
// ---------------------------------------------------------------------------
//
// 20260816120000_pump_tracked_callers_notify_discord.sql is applied BY HAND, so
// until the operator runs it PostgREST rejects any read or write that names
// `notify_discord`. Detect exactly that failure, warn once, and retry without
// the column — follow/unfollow and the WS + Pushover fan-out must not break
// over a dormant delivery leg.
//
// HAZARD (see storage/supabase/contractsRepo.ts, same trap): PostgREST reports
// a missing COLUMN with the same "schema cache" wording it uses for a missing
// TABLE. This regex therefore NAMES the column, and any future generic
// missing-table check in this file must be ordered AFTER it — a broad
// /schema cache/ test placed first would swallow real table-level failures and
// silently kill every write.
const MISSING_NOTIFY_DISCORD_RE =
  /notify_discord.*(does not exist|schema cache)|(does not exist|schema cache).*notify_discord/i;

let notifyDiscordMissingWarned = false;

/**
 * True when this PostgREST error is specifically "the notify_discord COLUMN is
 * missing" — never a missing table, and never an unrelated failure.
 *
 * Exported so the discrimination is unit-tested directly: it is the whole
 * safety property of the tolerance path, and getting it wrong turns every
 * follow write into a silent no-op.
 */
export function isMissingNotifyDiscordError(error: { message?: string } | null | undefined): boolean {
  if (!error) return false;
  return MISSING_NOTIFY_DISCORD_RE.test(error.message ?? '');
}

/** True (and warns once) when this error means the notify_discord migration isn't applied. */
function tolerateMissingNotifyDiscord(error: { message?: string } | null | undefined): boolean {
  if (!isMissingNotifyDiscordError(error)) return false;
  if (!notifyDiscordMissingWarned) {
    notifyDiscordMissingWarned = true;
    console.warn(
      '[PumpCalloutStore] pump_tracked_callers.notify_discord is missing — apply migration ' +
        '20260816120000_pump_tracked_callers_notify_discord.sql. Callout DMs are off until then; ' +
        'WS and Pushover delivery are unaffected.',
    );
  }
  return true;
}

/** Test seam: reset the once-per-process warning latch. */
export function resetNotifyDiscordWarning(): void {
  notifyDiscordMissingWarned = false;
}

/** Column list for per-user reads, with and without the un-migrated column. */
const TRACKED_COLUMNS = 'user_id, caller_address, username, display_name, avatar, source, notify_pushover, notify_discord, created_at';
const TRACKED_COLUMNS_LEGACY = 'user_id, caller_address, username, display_name, avatar, source, notify_pushover, created_at';

function stripNotifyDiscord<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const rest = { ...row };
  delete rest.notify_discord;
  return rest;
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

  let result = await db
    .from('pump_tracked_callers')
    .select('user_id, caller_address, notify_pushover, notify_discord');
  if (result.error && tolerateMissingNotifyDiscord(result.error)) {
    result = await db.from('pump_tracked_callers').select('user_id, caller_address, notify_pushover');
  }
  if (result.error) throw result.error;

  type TrackerSelect = Pick<RawTrackedRow, 'user_id' | 'caller_address' | 'notify_pushover' | 'notify_discord'>;
  for (const raw of (result.data ?? []) as TrackerSelect[]) {
    if (!raw.caller_address || !raw.user_id) continue;
    const list = byAddress.get(raw.caller_address) ?? [];
    list.push({
      userId: raw.user_id,
      notifyPushover: raw.notify_pushover ?? true,
      // Absent column (pre-migration) reads as true, matching the column
      // default. The DM leg is still gated by the user's settings, which are
      // off by default — see the migration header.
      notifyDiscord: raw.notify_discord ?? true,
    });
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
    notifyDiscord: raw.notify_discord ?? true,
    createdAt: raw.created_at,
  };
}

export async function listTrackedCallers(userId: string): Promise<TrackedCaller[]> {
  const db = getPumpServiceClient();
  if (!db) return [];
  const read = (columns: string) =>
    db
      .from('pump_tracked_callers')
      .select(columns)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

  let result = await read(TRACKED_COLUMNS);
  if (result.error && tolerateMissingNotifyDiscord(result.error)) {
    result = await read(TRACKED_COLUMNS_LEGACY);
  }
  if (result.error) throw result.error;
  return ((result.data ?? []) as unknown as RawTrackedRow[]).map(toTrackedCaller);
}

export interface AddTrackedCallerInput {
  callerAddress: string;
  username: string | null;
  displayName: string | null;
  avatar: string | null;
  source?: string;
  notifyPushover?: boolean;
  notifyDiscord?: boolean;
}

export async function addTrackedCaller(userId: string, input: AddTrackedCallerInput): Promise<TrackedCaller> {
  const db = getPumpServiceClient();
  if (!db) throw new Error('Supabase not configured');
  const row = {
    user_id: userId,
    caller_address: input.callerAddress,
    username: input.username,
    display_name: input.displayName,
    avatar: input.avatar,
    source: input.source ?? 'follow',
    notify_pushover: input.notifyPushover ?? true,
    notify_discord: input.notifyDiscord ?? true,
  };
  const write = (payload: Record<string, unknown>, columns: string) =>
    db
      .from('pump_tracked_callers')
      .upsert(payload, { onConflict: 'user_id,caller_address' })
      .select(columns)
      .single();

  let result = await write(row, TRACKED_COLUMNS);
  if (result.error && tolerateMissingNotifyDiscord(result.error)) {
    result = await write(stripNotifyDiscord(row), TRACKED_COLUMNS_LEGACY);
  }
  if (result.error) throw result.error;
  invalidateTrackedCache();
  return toTrackedCaller(result.data as unknown as RawTrackedRow);
}

/**
 * Flip a follow's delivery switches (the per-caller mute). Only the keys given
 * are written, so a Pushover toggle can't clobber the Discord one. Returns null
 * when the user doesn't follow that caller.
 */
export async function updateTrackedCaller(
  userId: string,
  callerAddress: string,
  patch: { notifyPushover?: boolean; notifyDiscord?: boolean },
): Promise<TrackedCaller | null> {
  const db = getPumpServiceClient();
  if (!db) throw new Error('Supabase not configured');

  const row: Record<string, unknown> = {};
  if (patch.notifyPushover !== undefined) row.notify_pushover = patch.notifyPushover;
  if (patch.notifyDiscord !== undefined) row.notify_discord = patch.notifyDiscord;
  if (Object.keys(row).length === 0) return null;

  const write = (payload: Record<string, unknown>, columns: string) =>
    db
      .from('pump_tracked_callers')
      .update(payload)
      .eq('user_id', userId)
      .eq('caller_address', callerAddress)
      .select(columns)
      .maybeSingle();

  let result = await write(row, TRACKED_COLUMNS);
  if (result.error && tolerateMissingNotifyDiscord(result.error)) {
    const legacy = stripNotifyDiscord(row);
    // A Discord-only patch has nothing left to write pre-migration; report the
    // row unchanged rather than pretending the toggle stuck.
    if (Object.keys(legacy).length === 0) {
      return (await listTrackedCallers(userId)).find((c) => c.callerAddress === callerAddress) ?? null;
    }
    result = await write(legacy, TRACKED_COLUMNS_LEGACY);
  }
  if (result.error) throw result.error;
  invalidateTrackedCache();
  return result.data ? toTrackedCaller(result.data as unknown as RawTrackedRow) : null;
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
    notify_discord: input.notifyDiscord ?? true,
  }));
  const write = (payload: Record<string, unknown>[]) =>
    db.from('pump_tracked_callers').upsert(payload, { onConflict: 'user_id,caller_address', ignoreDuplicates: true });

  let result = await write(rows);
  if (result.error && tolerateMissingNotifyDiscord(result.error)) {
    result = await write(rows.map(stripNotifyDiscord));
  }
  if (result.error) throw result.error;
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
