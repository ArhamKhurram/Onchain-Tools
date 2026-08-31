// What OCT's users actually want tracked — read from the two existing tracking
// tables, folded across users, in the shape the roster planner and the fan-out
// need.
//
// There is no new table here and no new source of truth: `pump_tracked_callers`
// and `fomo_tracked_users` already hold "who follows whom", written by the
// console's existing follow controls. This module only reads them, so a user
// following a caller is the ONE action that both drives the upstream
// subscription and earns them the events.
//
// Egress discipline (this project is on Supabase's free plan, where egress is
// the binding cap): every read here is column-scoped — never `select('*')` —
// and memoised behind a TTL, because both callers are hot. The fomo table is
// read ONCE and serves both the roster's demand set and the fan-out's
// handle→subscriber map, rather than being queried twice for the same rows.

import { getPumpServiceClient } from '../pumpfun/calloutStore.js';
import { getFomoServiceClient } from '../fomo/store.js';
import type { DesiredTarget } from './rosterPlan.js';

/** How long a tracking-table read is reused. Mirrors PUMP_TRACKED_CACHE_MS. */
const TRACKED_CACHE_MS = Number.parseInt(process.env.J7_TRACKED_CACHE_MS ?? '', 10) || 60_000;

/** One OCT user subscribed to a fomo handle. */
export interface FomoHandleTracker {
  userId: string;
  /**
   * "Notify me about this trader" — gates the console toast/sound as well as
   * Pushover (see the note in fomo/dispatch.ts).
   */
  notifyPushover: boolean;
}

interface FomoTrackingRow {
  user_id: string;
  fomo_handle: string | null;
  notify_pushover: boolean | null;
  created_at: string;
}

let _fomoCache: { rows: FomoTrackingRow[]; at: number } | null = null;

/**
 * Every `fomo_tracked_users` row, column-scoped and memoised.
 *
 * Shared by both consumers on purpose — see the egress note in the header.
 * Returns [] (rather than throwing) when Supabase is unconfigured, which is
 * local mode: no demand, so the reconciler idles and the fan-out finds nobody.
 */
async function loadFomoTracking(): Promise<FomoTrackingRow[]> {
  if (_fomoCache && Date.now() - _fomoCache.at < TRACKED_CACHE_MS) return _fomoCache.rows;

  const db = getFomoServiceClient();
  if (!db) {
    _fomoCache = { rows: [], at: Date.now() };
    return [];
  }

  const { data, error } = await db
    .from('fomo_tracked_users')
    .select('user_id, fomo_handle, notify_pushover, created_at');
  if (error) throw error;

  const rows = (data ?? []) as FomoTrackingRow[];
  _fomoCache = { rows, at: Date.now() };
  return rows;
}

/** Drop the fomo memo so a fresh track/untrack is seen on the next read. */
export function invalidateJ7DemandCache(): void {
  _fomoCache = null;
}

/**
 * Fold rows into one desired target per key.
 *
 * `followerCount` counts DISTINCT users, not rows: `fomo_tracked_users` is
 * unique on (user_id, fomo_user_id), so one user can legitimately hold two rows
 * for the same handle if a trader's id ever changed, and counting both would
 * inflate their weight in the over-capacity ranking.
 */
function fold(
  entries: { key: string; addAs: string; alias?: string | null; userId: string; addedAt: string }[],
): DesiredTarget[] {
  const byKey = new Map<string, DesiredTarget & { users: Set<string> }>();
  for (const e of entries) {
    const k = e.key.toLowerCase();
    const existing = byKey.get(k);
    if (!existing) {
      byKey.set(k, {
        key: e.key,
        addAs: e.addAs,
        aliases: e.alias ? [e.alias] : [],
        followerCount: 1,
        addedAt: e.addedAt,
        users: new Set([e.userId]),
      });
      continue;
    }
    existing.users.add(e.userId);
    existing.followerCount = existing.users.size;
    if (e.addedAt < existing.addedAt) existing.addedAt = e.addedAt;
    if (e.alias && !existing.aliases.includes(e.alias)) existing.aliases.push(e.alias);
  }
  return [...byKey.values()].map(({ users: _users, ...t }) => t);
}

/**
 * Pump demand: every followed caller, keyed by WALLET.
 *
 * `caller_address` is the wallet pubkey the callout feed matches on, so it is
 * both the canonical key and what we hand j7's `/add` (which accepts a wallet,
 * a pump.fun username or a profile URL). The stored `username` rides along as
 * an alias because j7 lists a pump row back BY username — without it the diff
 * would never recognise its own subscriptions.
 */
export async function loadPumpDemand(): Promise<DesiredTarget[]> {
  const db = getPumpServiceClient();
  if (!db) return [];

  const { data, error } = await db
    .from('pump_tracked_callers')
    .select('user_id, caller_address, username, created_at');
  if (error) throw error;

  type Row = { user_id: string; caller_address: string; username: string | null; created_at: string };
  const entries = ((data ?? []) as Row[])
    .filter((r) => r.caller_address && r.user_id)
    .map((r) => ({
      key: r.caller_address,
      addAs: r.caller_address,
      alias: r.username,
      userId: r.user_id,
      addedAt: r.created_at ?? new Date().toISOString(),
    }));
  return fold(entries);
}

/**
 * Fomo demand: every tracked trader, keyed by HANDLE — the identifier j7's
 * `/fomo/add` takes and the one its events carry back.
 */
export async function loadFomoDemand(): Promise<DesiredTarget[]> {
  const rows = await loadFomoTracking();
  const entries = rows
    .filter((r): r is FomoTrackingRow & { fomo_handle: string } => !!r.fomo_handle && !!r.user_id)
    .map((r) => ({
      key: r.fomo_handle,
      addAs: r.fomo_handle,
      userId: r.user_id,
      addedAt: r.created_at ?? new Date().toISOString(),
    }));
  return fold(entries);
}

/**
 * handle → subscribers, for the trade fan-out. Case-folded keys, because a
 * handle's casing round-trips differently through OCT's follow control, j7 and
 * fomo.family itself.
 */
export async function loadFomoTrackersByHandle(): Promise<Map<string, FomoHandleTracker[]>> {
  const rows = await loadFomoTracking();
  const byHandle = new Map<string, FomoHandleTracker[]>();
  for (const r of rows) {
    if (!r.fomo_handle || !r.user_id) continue;
    const k = r.fomo_handle.trim().toLowerCase();
    const list = byHandle.get(k) ?? [];
    // One row per user per handle: a duplicate would double-send the trade.
    if (list.some((t) => t.userId === r.user_id)) continue;
    list.push({ userId: r.user_id, notifyPushover: r.notify_pushover ?? true });
    byHandle.set(k, list);
  }
  return byHandle;
}
