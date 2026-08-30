// Store-once / fan-out-many for FOMO trades.
//
// Each unique FOMO trader is polled once. New swaps are persisted to
// fomo_trade_events, then pushed to every OCT user tracking that trader via
// fomo_trade_deliveries (idempotent per subscriber).

import type { SupabaseClient } from '@supabase/supabase-js';
import type { WsServer } from '../ws/server.js';
import { getStorageProvider } from '../storage/index.js';
import { sendPushover } from '../utils/pushover.js';
import type { NormalizedTrade } from './store.js';
import { resolveTradeTokenInfo } from './tokenInfo.js';

export interface ActivityCursorRow {
  fomo_user_id: string;
  last_activity_id: string | null;
  cursor_seeded: boolean;
}

export interface FomoTrackerRow {
  user_id: string;
  notify_pushover: boolean;
}

export async function loadActivityCursors(
  db: SupabaseClient,
  fomoUserIds: string[],
): Promise<Map<string, ActivityCursorRow>> {
  const map = new Map<string, ActivityCursorRow>();
  if (fomoUserIds.length === 0) return map;

  const { data, error } = await db
    .from('fomo_activity_cursors')
    .select('fomo_user_id, last_activity_id, cursor_seeded')
    .in('fomo_user_id', fomoUserIds);
  if (error) throw error;

  for (const row of data ?? []) {
    map.set(row.fomo_user_id, row as ActivityCursorRow);
  }
  return map;
}

/**
 * Write-through cache over `fomo_activity_cursors` for the FOMO poller.
 *
 * The poller is the table's only reader and writer, so once a trader's cursor
 * has been read (or written) there is nothing a re-read can learn — yet the
 * poller used to re-SELECT every tracked cursor on every tick (~259k
 * queries/month at the pinned 10s prod interval). This cache makes the
 * steady-state tick cost zero DB reads: it only queries for trader ids it has
 * never seen, and `noteUpserted` keeps it in sync with the poller's own writes.
 *
 * Restart safety: the cache is in-memory, so a fresh process re-reads real
 * rows from the DB on its first tick — exactly the old behaviour.
 */
export class ActivityCursorCache {
  private rows = new Map<string, ActivityCursorRow>();
  // Ids we've already asked the DB about — including ones with no row (an
  // unseeded trader), so a trader whose seed upsert hasn't happened yet isn't
  // re-queried every tick.
  private known = new Set<string>();

  /** Cursors for `fomoUserIds`, querying the DB only for ids never seen before. */
  async load(db: SupabaseClient, fomoUserIds: string[]): Promise<Map<string, ActivityCursorRow>> {
    const missing = fomoUserIds.filter((id) => !this.known.has(id));
    if (missing.length > 0) {
      const fetched = await loadActivityCursors(db, missing);
      for (const id of missing) this.known.add(id);
      for (const [id, row] of fetched) this.rows.set(id, row);
    }
    const out = new Map<string, ActivityCursorRow>();
    for (const id of fomoUserIds) {
      const row = this.rows.get(id);
      if (row) out.set(id, row);
    }
    return out;
  }

  /** Mirror a successful `upsertActivityCursor` into the cache. */
  noteUpserted(fomoUserId: string, lastActivityId: string | null, cursorSeeded: boolean): void {
    this.known.add(fomoUserId);
    this.rows.set(fomoUserId, {
      fomo_user_id: fomoUserId,
      last_activity_id: lastActivityId,
      cursor_seeded: cursorSeeded,
    });
  }
}

export async function upsertActivityCursor(
  db: SupabaseClient,
  fomoUserId: string,
  lastActivityId: string | null,
  cursorSeeded: boolean,
): Promise<void> {
  const { error } = await db.from('fomo_activity_cursors').upsert(
    {
      fomo_user_id: fomoUserId,
      last_activity_id: lastActivityId,
      cursor_seeded: cursorSeeded,
    },
    { onConflict: 'fomo_user_id' },
  );
  if (error) throw error;
}

/** Persist a normalized trade once; returns the row id (new or existing). */
export async function ensureTradeEventStored(
  db: SupabaseClient,
  trade: NormalizedTrade,
): Promise<string | null> {
  if (!trade.tradeId) return null;

  const row = {
    fomo_user_id: trade.fomoUserId,
    fomo_handle: trade.fomoHandle,
    side: trade.side,
    token_address: trade.tokenAddress,
    token_symbol: trade.tokenSymbol,
    token_name: trade.tokenName,
    market_cap: trade.marketCap,
    market_cap_display: trade.marketCapDisplay,
    network_id: trade.networkId,
    usd_value: trade.usdValue,
    raw: trade.raw,
    trade_id: trade.tradeId,
  };

  const insert = await db.from('fomo_trade_events').insert(row).select('id').single();
  if (!insert.error) return insert.data?.id ?? null;

  if ((insert.error as { code?: string }).code !== '23505') {
    console.error('[FomoDispatch] Failed to store trade event:', insert.error.message);
    return null;
  }

  const existing = await db
    .from('fomo_trade_events')
    .select('id')
    .eq('trade_id', trade.tradeId)
    .maybeSingle();
  if (existing.error) {
    console.error('[FomoDispatch] Failed to load existing trade event:', existing.error.message);
    return null;
  }
  return existing.data?.id ?? null;
}

export function buildFomoTradePayload(
  trade: NormalizedTrade,
  options?: { notify?: boolean },
): Record<string, unknown> {
  return {
    type: 'fomo_trade',
    data: {
      fomoUserId: trade.fomoUserId,
      fomoHandle: trade.fomoHandle,
      displayName: trade.displayName,
      side: trade.side,
      tokenAddress: trade.tokenAddress,
      tokenSymbol: trade.tokenSymbol,
      tokenName: trade.tokenName,
      marketCap: trade.marketCap,
      marketCapDisplay: trade.marketCapDisplay,
      networkId: trade.networkId,
      usdValue: trade.usdValue,
      tradeId: trade.tradeId,
      // Only true for a genuinely live dispatch to a subscriber who opted in
      // (fanOutTradeEvent, below) — never set on backfill/replay, which can
      // deliver dozens of trades at once and must never toast/sound for them.
      notify: !!options?.notify,
    },
  };
}

export async function loadTrackersForFomoUser(
  db: SupabaseClient,
  fomoUserId: string,
): Promise<FomoTrackerRow[]> {
  const { data, error } = await db
    .from('fomo_tracked_users')
    .select('user_id, notify_pushover')
    .eq('fomo_user_id', fomoUserId);
  if (error) throw error;
  return (data ?? []) as FomoTrackerRow[];
}

/** Deliver a stored trade to subscribers who have not received it yet. */
export async function fanOutTradeEvent(
  db: SupabaseClient,
  wsServer: WsServer,
  trade: NormalizedTrade,
  tradeEventId: string,
  trackers?: FomoTrackerRow[],
): Promise<number> {
  const recipients = trackers ?? (trade.fomoUserId
    ? await loadTrackersForFomoUser(db, trade.fomoUserId)
    : []);
  if (recipients.length === 0) return 0;

  let delivered = 0;

  for (const tracker of recipients) {
    const delivery = await db
      .from('fomo_trade_deliveries')
      .insert({ trade_event_id: tradeEventId, user_id: tracker.user_id })
      .select('id')
      .single();

    if (delivery.error) {
      if ((delivery.error as { code?: string }).code === '23505') continue;
      console.error('[FomoDispatch] Delivery insert failed:', delivery.error.message);
      continue;
    }

    // notify_pushover is really "notify me about this trader" — it now also
    // gates the in-app toast/sound, not just Pushover, so there's one toggle
    // per tracked trader instead of two near-duplicate ones.
    wsServer.sendToUser(tracker.user_id, buildFomoTradePayload(trade, { notify: tracker.notify_pushover }));
    delivered++;
    if (tracker.notify_pushover) {
      await notifyPushover(tracker.user_id, trade);
    }
  }

  return delivered;
}

/** Store a trade (if needed) and fan out to all current trackers. */
export async function storeAndFanOutTrade(
  db: SupabaseClient,
  wsServer: WsServer,
  trade: NormalizedTrade,
): Promise<void> {
  if (!trade.fomoUserId) return;

  const tradeEventId = await ensureTradeEventStored(db, trade);
  if (!tradeEventId) return;

  await fanOutTradeEvent(db, wsServer, trade, tradeEventId);
}

const RECENT_TRADE_BACKFILL_LIMIT = 20;

/** When someone newly tracks a trader, deliver recent stored swaps they missed. */
export async function deliverRecentTradesToUser(
  db: SupabaseClient,
  wsServer: WsServer,
  fomoUserId: string,
  octUserId: string,
  limit = RECENT_TRADE_BACKFILL_LIMIT,
): Promise<number> {
  const { data: events, error } = await db
    .from('fomo_trade_events')
    .select('id, fomo_user_id, fomo_handle, side, token_address, token_symbol, token_name, market_cap, market_cap_display, network_id, usd_value, trade_id, raw')
    .eq('fomo_user_id', fomoUserId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('[FomoDispatch] Recent trade backfill query failed:', error.message);
    return 0;
  }
  if (!events?.length) return 0;

  let delivered = 0;
  for (const event of events.reverse()) {
    const trade: NormalizedTrade = {
      tradeId: event.trade_id,
      fomoUserId: event.fomo_user_id,
      fomoHandle: event.fomo_handle,
      displayName: null,
      side: event.side as NormalizedTrade['side'],
      tokenAddress: event.token_address,
      tokenSymbol: event.token_symbol,
      tokenName: event.token_name ?? null,
      marketCap: event.market_cap != null ? Number(event.market_cap) : null,
      marketCapDisplay: event.market_cap_display ?? null,
      networkId: event.network_id != null ? Number(event.network_id) : null,
      usdValue: event.usd_value != null ? Number(event.usd_value) : null,
      raw: event.raw,
    };

    const delivery = await db
      .from('fomo_trade_deliveries')
      .insert({ trade_event_id: event.id, user_id: octUserId })
      .select('id')
      .single();
    if (delivery.error) {
      if ((delivery.error as { code?: string }).code === '23505') continue;
      console.error('[FomoDispatch] Backfill delivery failed:', delivery.error.message);
      continue;
    }

    // Rows stored before this info was resolved (or whose lookup failed then)
    // still carry nulls — resolve on the way out so replayed trades read the
    // same as live ones. resolveTradeTokenInfo no-ops once all three fields
    // are already present, so this never overwrites a real trade-time snapshot.
    const enriched = await resolveTradeTokenInfo(trade);
    wsServer.sendToUser(octUserId, buildFomoTradePayload(enriched));
    delivered++;
  }

  return delivered;
}

/** A stored trade replayed to the client, carrying the time it actually happened. */
export interface DeliveredTrade {
  fomoUserId: string | null;
  fomoHandle: string | null;
  displayName: string | null;
  side: string | null;
  tokenAddress: string | null;
  tokenSymbol: string | null;
  tokenName: string | null;
  marketCap: number | null;
  marketCapDisplay: string | null;
  networkId: number | null;
  usdValue: number | null;
  tradeId: string | null;
  /** ms epoch of the trade event, not of this request. */
  occurredAt: number;
}

export const MAX_TRADE_HISTORY = 500;

/**
 * The user's own delivered trades, newest first.
 *
 * Reads the delivery log rather than the event table directly — a user should
 * only ever see trades that were actually fanned out to them, not every swap in
 * the shared store. Filtering and ordering stay on `delivered_at` because it is
 * the indexed column on this table; the event's `created_at` still comes back as
 * `occurredAt` so the row renders when the trade happened.
 */
export async function loadDeliveredTrades(
  db: SupabaseClient,
  userId: string,
  sinceIso: string,
  limit: number,
): Promise<DeliveredTrade[]> {
  const { data, error } = await db
    .from('fomo_trade_deliveries')
    .select(
      'delivered_at, fomo_trade_events!inner(fomo_user_id, fomo_handle, side, token_address, token_symbol, token_name, market_cap, market_cap_display, network_id, usd_value, trade_id, created_at)',
    )
    .eq('user_id', userId)
    .gte('delivered_at', sinceIso)
    .order('delivered_at', { ascending: false })
    .limit(Math.min(limit, MAX_TRADE_HISTORY));

  if (error) {
    console.error('[FomoDispatch] Trade history query failed:', error.message);
    return [];
  }

  const out: DeliveredTrade[] = [];
  for (const row of data ?? []) {
    // PostgREST types an embedded row as an array; !inner guarantees exactly one.
    const event = (Array.isArray(row.fomo_trade_events)
      ? row.fomo_trade_events[0]
      : row.fomo_trade_events) as Record<string, unknown> | undefined;
    if (!event) continue;

    out.push({
      fomoUserId: (event.fomo_user_id as string | null) ?? null,
      fomoHandle: (event.fomo_handle as string | null) ?? null,
      // Not stored on the event row — the client falls back to the handle.
      displayName: null,
      side: (event.side as string | null) ?? null,
      tokenAddress: (event.token_address as string | null) ?? null,
      tokenSymbol: (event.token_symbol as string | null) ?? null,
      tokenName: (event.token_name as string | null) ?? null,
      marketCap: event.market_cap != null ? Number(event.market_cap) : null,
      marketCapDisplay: (event.market_cap_display as string | null) ?? null,
      networkId: event.network_id != null ? Number(event.network_id) : null,
      usdValue: event.usd_value != null ? Number(event.usd_value) : null,
      tradeId: (event.trade_id as string | null) ?? null,
      occurredAt: new Date(
        (event.created_at as string | undefined) ?? (row.delivered_at as string),
      ).getTime(),
    });
  }
  return out;
}

/**
 * Drop trade events past the retention window. Deliveries cascade on the FK, so
 * this cleans both tables.
 *
 * Retention is deliberately longer than the window the console asks for. The
 * unique index on `trade_id` is what stops a trade being dispatched twice, so
 * deleting a row also drops its dedup guard — keeping a margin means a trader's
 * activity cursor would have to rewind by days before a stale trade could
 * re-deliver as new.
 */
export async function pruneTradeEvents(
  db: SupabaseClient,
  retentionDays: number,
): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const { data, error } = await db
    .from('fomo_trade_events')
    .delete()
    .lt('created_at', cutoff)
    .select('id');

  if (error) {
    console.error('[FomoDispatch] Retention sweep failed:', error.message);
    return 0;
  }
  return data?.length ?? 0;
}

async function notifyPushover(userId: string, trade: NormalizedTrade): Promise<void> {
  try {
    const config = await getStorageProvider().getConfig(userId);
    if (!config.pushover?.enabled) return;

    const who = trade.displayName || (trade.fomoHandle ? `@${trade.fomoHandle}` : 'A tracked trader');
    const sideLabel = trade.side ? trade.side.toUpperCase() : 'TRADE';
    const token = trade.tokenSymbol || trade.tokenAddress || 'a token';
    const usd = trade.usdValue != null ? ` ($${Math.round(trade.usdValue).toLocaleString()})` : '';

    await sendPushover(config.pushover, {
      title: `FOMO: ${who} ${sideLabel}`,
      message: `${who} ${sideLabel} ${token}${usd}`,
    });
  } catch (err) {
    console.error('[FomoDispatch] Pushover notify failed:', (err as Error)?.message);
  }
}
