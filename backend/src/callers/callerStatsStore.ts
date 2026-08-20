// Persistent caller quality — storage.
//
// A sibling of StorageProvider rather than an extension of it, on the
// SniperStore precedent (see CLAUDE.md): same `userId`-first convention,
// different shape, chosen by the SAME `isHostedMode()` so there is never a
// second answer to "which mode is this".
//
// The problem it solves: caller scores used to be derived on read from the
// contract log, which is a rolling window. A caller's record therefore only
// lasted as long as the log — about a day on a real feed, against a board that
// claimed thirty. `caller_calls` keeps one durable row per (user, caller,
// token): once someone scans, they stay ranked, and every later scan updates
// the record. See supabase/migrations/20260820120000_caller_calls.sql for why
// the multiple and the band are deliberately NOT stored.
//
// Local mode has no Supabase, so it gets `NullCallerStatsStore` and the scores
// route falls back to the original derive-on-read path. That fallback is not a
// stub for later: it is how the desktop app scores callers, and it must keep
// working.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SLOP_MULTIPLE, type CallerAggregateRow, type CallerCall } from '@oct/shared';
import { isHostedMode } from '../storage/index.js';

/** One call as the write path hands it to storage. */
export type CallerCallRecord = CallerCall;

export interface CallerStatsStore {
  /** True when this store actually persists — false selects the derive-on-read path. */
  readonly persistent: boolean;
  /**
   * Fold a batch of call records in. The batch must already be deduped to one
   * entry per (callerKey, address) — `foldCallerCalls` does that — so the
   * upsert's ON CONFLICT never touches a row twice in one statement.
   */
  recordCalls(userId: string, calls: CallerCallRecord[]): Promise<void>;
  /**
   * Per-caller aggregates: one row per caller plus one per caller per room.
   * `since` omitted means all time, which is the normal case — the whole point
   * is that a caller stays ranked. Returns null when this store cannot answer,
   * which is the signal to fall back to deriving from the contract log.
   */
  loadAggregates(userId: string, since?: string): Promise<CallerAggregateRow[] | null>;
  /**
   * Distinct tokens on the record, and how many of those have a peak. Counted
   * separately from the aggregates because these are per-TOKEN: five callers
   * calling one mint is five calls but one token, so summing the per-caller
   * rows would over-count.
   */
  loadTokenCounts(userId: string, since?: string): Promise<{ tokens: number; priced: number }>;
}

// --- local -------------------------------------------------------------------

/**
 * Local mode: no persistence, no error. Writes are dropped and reads decline to
 * answer, so `/callers/scores` derives from the contract log exactly as it did
 * before this feature existed.
 */
export class NullCallerStatsStore implements CallerStatsStore {
  readonly persistent = false;
  async recordCalls(): Promise<void> {
    /* no-op */
  }
  async loadAggregates(): Promise<CallerAggregateRow[] | null> {
    return null;
  }
  async loadTokenCounts(): Promise<{ tokens: number; priced: number }> {
    return { tokens: 0, priced: 0 };
  }
}

// --- hosted ------------------------------------------------------------------

let _client: SupabaseClient | null = null;

/**
 * Process-wide service client for `caller_calls`; null when Supabase isn't
 * configured. Untyped on purpose (`SupabaseClient`, not `<Database>`): the
 * table and its RPCs are not in the generated shared types, so string names
 * plus explicit row casts keep this compiling without a types regen — the same
 * choice calloutStore and pumpSessionRepo already made.
 */
function serviceClient(): SupabaseClient | null {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL?.trim();
  const key = (process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY)?.trim();
  if (!url || !key) return null;
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

/** Bounded so one reconciler pass can't build a multi-megabyte JSON body. */
const UPSERT_CHUNK = 500;

interface RawAggregateRow {
  caller_key: string | null;
  room_id: string | null;
  display_name: string | null;
  calls: number | string | null;
  rated: number | string | null;
  median_multiple: number | string | null;
  best_multiple: number | string | null;
  hits_2x: number | string | null;
  hits_5x: number | string | null;
  slop_count: number | string | null;
  first_call_at: string | null;
  last_call_at: string | null;
}

/** Postgres bigint arrives as a string over PostgREST; numeric may too. */
function num(v: number | string | null | undefined): number | undefined {
  if (v == null) return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export class SupabaseCallerStatsStore implements CallerStatsStore {
  readonly persistent = true;

  async recordCalls(userId: string, calls: CallerCallRecord[]): Promise<void> {
    const db = serviceClient();
    if (!db || calls.length === 0) return;

    for (let i = 0; i < calls.length; i += UPSERT_CHUNK) {
      const rows = calls.slice(i, i + UPSERT_CHUNK).map((c) => ({
        caller_key: c.callerKey,
        address: c.address.toLowerCase(),
        chain: c.chain ?? null,
        evm_chain: c.evmChain ?? null,
        display_name: c.displayName || null,
        // Sent as a string so the RPC's `nullif(...,'')::double precision` reads
        // it uniformly; an absent MC@call must arrive as null, not as 0.
        fdv_at_call: c.fdvAtCall != null && c.fdvAtCall > 0 ? String(c.fdvAtCall) : null,
        called_at: c.timestamp,
        room_ids: c.roomIds ?? [],
      }));
      const { error } = await db.rpc('caller_calls_upsert', { p_user_id: userId, p_rows: rows });
      if (error) throw error;
    }
  }

  async loadAggregates(userId: string, since?: string): Promise<CallerAggregateRow[] | null> {
    const db = serviceClient();
    if (!db) return null;

    const { data, error } = await db.rpc('caller_quality_aggregate', {
      p_user_id: userId,
      p_since: since ?? null,
      // Passed in rather than hardcoded in SQL so the slop threshold keeps one
      // definition, in packages/shared.
      p_slop_multiple: SLOP_MULTIPLE,
    });
    if (error) throw error;

    return ((data ?? []) as RawAggregateRow[]).flatMap((r) => {
      if (!r.caller_key) return [];
      const row: CallerAggregateRow = {
        key: r.caller_key,
        displayName: r.display_name ?? '',
        roomId: r.room_id,
        calls: num(r.calls) ?? 0,
        rated: num(r.rated) ?? 0,
        medianMultiple: num(r.median_multiple),
        bestMultiple: num(r.best_multiple),
        hits2x: num(r.hits_2x) ?? 0,
        hits5x: num(r.hits_5x) ?? 0,
        slopCount: num(r.slop_count) ?? 0,
        firstCallAt: r.first_call_at ?? undefined,
        lastCallAt: r.last_call_at ?? undefined,
      };
      return [row];
    });
  }

  async loadTokenCounts(userId: string, since?: string): Promise<{ tokens: number; priced: number }> {
    const db = serviceClient();
    if (!db) return { tokens: 0, priced: 0 };

    const { data, error } = await db.rpc('caller_quality_token_counts', {
      p_user_id: userId,
      p_since: since ?? null,
    });
    if (error) throw error;

    const row = ((data ?? []) as { tokens: number | string | null; priced_tokens: number | string | null }[])[0];
    return { tokens: num(row?.tokens) ?? 0, priced: num(row?.priced_tokens) ?? 0 };
  }
}

// --- selection ---------------------------------------------------------------

let _store: CallerStatsStore | null = null;

export function getCallerStatsStore(): CallerStatsStore {
  if (_store) return _store;
  _store = isHostedMode() ? new SupabaseCallerStatsStore() : new NullCallerStatsStore();
  return _store;
}

/** Test seam, and the hook a desktop shell would use to inject a real backing. */
export function setCallerStatsStore(store: CallerStatsStore | null): void {
  _store = store;
}
