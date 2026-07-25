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

export function buildFomoTradePayload(trade: NormalizedTrade): Record<string, unknown> {
  return {
    type: 'fomo_trade',
    data: {
      fomoUserId: trade.fomoUserId,
      fomoHandle: trade.fomoHandle,
      displayName: trade.displayName,
      side: trade.side,
      tokenAddress: trade.tokenAddress,
      tokenSymbol: trade.tokenSymbol,
      networkId: trade.networkId,
      usdValue: trade.usdValue,
      tradeId: trade.tradeId,
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

  const payload = buildFomoTradePayload(trade);
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

    wsServer.sendToUser(tracker.user_id, payload);
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
    .select('id, fomo_user_id, fomo_handle, side, token_address, token_symbol, network_id, usd_value, trade_id, raw')
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

    wsServer.sendToUser(octUserId, buildFomoTradePayload(trade));
    delivered++;
  }

  return delivered;
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
