// Data access for the auto-discovered "Top Callers" board.
//
// A sibling of calloutStore.ts (it reuses that module's untyped service client):
// the pump_caller_stats / pump_callout_observations tables are hosted-only and
// service-role-only, so — like pump_callout_poll_state — they are read and
// written through the shared service client rather than the generic
// StorageProvider, with string table/RPC names since they are not in the
// generated shared types.
//
// Two write paths, both driven by the callout poller:
//   recordCallerStats(...)     -> pump_record_caller_stats RPC (running aggregate)
//   recordCalloutObservations  -> bulk upsert into the bounded observations table
// and two read paths, both driven by GET /api/pumpfun/top-callers:
//   topCallersAllTime(...)     -> the running aggregate, ordered by an indexed col
//   topCallersWindowed(...)    -> pump_top_callers_window RPC over observations

import { getPumpServiceClient } from './calloutStore.js';

export type BoardMetric = 'count' | 'avg' | 'max';

/** One ranked caller as the /top-callers route serves it. */
export interface BoardCaller {
  callerAddress: string;
  username: string | null;
  avatar: string | null;
  calloutCount: number;
  avgMultiple: number | null;
  maxMultiple: number | null;
  lastCalloutAt: string | null;
}

/** A per-caller aggregate for one poll batch (pre-folded so the RPC's ON CONFLICT
 *  never touches a caller's row twice in one statement). */
export interface CallerStatDelta {
  callerAddress: string;
  addCount: number;
  addSum: number;
  maxMultiple: number | null;
  lastCalloutAt: string | null; // ISO
  username: string | null;
  avatar: string | null;
}

/** One callout row for the bounded observations table (windowed board source). */
export interface CalloutObservation {
  calloutId: string;
  callerAddress: string;
  multiple: number | null;
  createdAt: string; // ISO
}

// The column each metric orders the ALL-TIME board by. avg_multiple is a stored
// generated column, so all three are plain indexed columns.
const METRIC_COLUMN: Record<BoardMetric, string> = {
  count: 'callout_count',
  avg: 'avg_multiple',
  max: 'max_multiple',
};

interface RawStatRow {
  caller_address: string;
  callout_count: number | null;
  avg_multiple: number | null;
  max_multiple: number | null;
  last_callout_at: string | null;
  username: string | null;
  avatar: string | null;
}

function toBoardCaller(r: RawStatRow): BoardCaller {
  return {
    callerAddress: r.caller_address,
    username: r.username,
    avatar: r.avatar,
    calloutCount: Number(r.callout_count ?? 0),
    avgMultiple: r.avg_multiple == null ? null : Number(r.avg_multiple),
    maxMultiple: r.max_multiple == null ? null : Number(r.max_multiple),
    lastCalloutAt: r.last_callout_at,
  };
}

/**
 * Fold a batch of per-caller deltas into pump_caller_stats via the increment RPC.
 * A no-op when the batch is empty or Supabase is absent (local mode).
 */
export async function recordCallerStats(deltas: CallerStatDelta[]): Promise<void> {
  const db = getPumpServiceClient();
  if (!db || deltas.length === 0) return;
  const rows = deltas.map((d) => ({
    caller_address: d.callerAddress,
    add_count: d.addCount,
    add_sum: d.addSum,
    max_multiple: d.maxMultiple ?? 0,
    last_callout_at: d.lastCalloutAt,
    username: d.username,
    avatar: d.avatar,
  }));
  const { error } = await db.rpc('pump_record_caller_stats', { p_rows: rows });
  if (error) throw error;
}

/**
 * Bulk-insert per-callout observations, ignoring replays (ON CONFLICT on the
 * callout id). A no-op when empty or Supabase is absent.
 */
export async function recordCalloutObservations(rows: CalloutObservation[]): Promise<void> {
  const db = getPumpServiceClient();
  if (!db || rows.length === 0) return;
  const payload = rows.map((r) => ({
    callout_id: r.calloutId,
    caller_address: r.callerAddress,
    multiple: r.multiple,
    created_at: r.createdAt,
  }));
  const { error } = await db
    .from('pump_callout_observations')
    .upsert(payload, { onConflict: 'callout_id', ignoreDuplicates: true });
  if (error) throw error;
}

/** Delete observations older than the retention cutoff. Returns silently in local mode. */
export async function pruneCalloutObservations(olderThanMs: number): Promise<void> {
  const db = getPumpServiceClient();
  if (!db) return;
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const { error } = await db.from('pump_callout_observations').delete().lt('created_at', cutoff);
  if (error) throw error;
}

/**
 * The ALL-TIME board: the running aggregate ordered by the requested metric and
 * filtered to callers with at least `minCalls` calls (which keeps a single lucky
 * call from topping the avg/max boards). Reads an indexed column directly.
 */
export async function topCallersAllTime(
  metric: BoardMetric,
  minCalls: number,
  limit: number,
): Promise<BoardCaller[]> {
  const db = getPumpServiceClient();
  if (!db) return [];
  const { data, error } = await db
    .from('pump_caller_stats')
    .select('caller_address, callout_count, avg_multiple, max_multiple, last_callout_at, username, avatar')
    .gte('callout_count', Math.max(minCalls, 1))
    .order(METRIC_COLUMN[metric], { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as RawStatRow[]).map(toBoardCaller);
}

/**
 * The WINDOWED board: group observations since `sinceMs` ago via the
 * pump_top_callers_window RPC (grouping + ranking happen in Postgres so only the
 * ranked slice crosses the wire).
 */
export async function topCallersWindowed(
  sinceMs: number,
  metric: BoardMetric,
  minCalls: number,
  limit: number,
): Promise<BoardCaller[]> {
  const db = getPumpServiceClient();
  if (!db) return [];
  const since = new Date(Date.now() - sinceMs).toISOString();
  const { data, error } = await db.rpc('pump_top_callers_window', {
    p_since: since,
    p_metric: metric,
    p_min_calls: Math.max(minCalls, 1),
    p_limit: limit,
  });
  if (error) throw error;
  return ((data ?? []) as RawStatRow[]).map(toBoardCaller);
}
