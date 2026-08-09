// Data access for the tracked-wallet on-chain movement alerter.
//
// Like the fomo_* and pump_* fan-out tables, wallet_movement_cursors is
// hosted-only and service-role-only, so this talks to Supabase through a shared
// service client rather than the generic StorageProvider. The client is
// deliberately UNTYPED (SupabaseClient, not <Database>): wallet_movement_cursors
// is not in the generated shared types, so string table names + explicit row
// casts keep it compiling without a types regen (mirrors calloutStore).
//
// The tracked wallets themselves live in user_tracked_wallets (RLS'd, client CRUD
// via useTrackedWallets); this module only READS them under the service role to
// build the poll set, deduped across users into address -> trackers.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let _client: SupabaseClient | null = null;

function resolveServiceConfig(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL?.trim();
  const key = (process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY)?.trim();
  if (!url || !key) return null;
  return { url, key };
}

/** Process-wide service client for the wallet-movement tables; null in local mode. */
export function getWalletServiceClient(): SupabaseClient | null {
  if (_client) return _client;
  const cfg = resolveServiceConfig();
  if (!cfg) return null;
  _client = createClient(cfg.url, cfg.key, { auth: { persistSession: false } });
  return _client;
}

/**
 * One user tracking a wallet, for reverse fan-out. Carries the per-wallet alert
 * toggles from user_tracked_wallets (which gate delivery) plus the display
 * metadata a ping renders (name/emoji/sound).
 */
export interface WalletTrackerRow {
  userId: string;
  alertsOnToast: boolean;
  alertsOnFeed: boolean;
  alertsOnBubble: boolean;
  name: string;
  emoji: string;
  sound: string;
}

export interface MovementCursorRow {
  wallet_address: string;
  last_tx_hash: string | null;
  cursor_seeded: boolean;
}

interface RawTrackedWalletRow {
  user_id: string;
  address: string;
  alerts_on_toast: boolean | null;
  alerts_on_feed: boolean | null;
  alerts_on_bubble: boolean | null;
  name: string | null;
  emoji: string | null;
  sound: string | null;
}

let _trackedCache: { byAddress: Map<string, WalletTrackerRow[]>; at: number } | null = null;

/**
 * Every tracked SOLANA wallet as address -> trackers, deduped across users. Only
 * rows with at least one alert toggle enabled are included: a wallet nobody wants
 * a ping for should not cost an upstream poll. Memoised briefly (like the FOMO /
 * callout tracked caches) so the hot poll loop does not re-read the whole table
 * each cycle; a newly-tracked wallet joins within the TTL.
 */
export async function loadTrackedSolanaWallets(): Promise<Map<string, WalletTrackerRow[]>> {
  const ttl = Number.parseInt(process.env.WALLET_MOVEMENT_TRACKED_CACHE_MS ?? '', 10) || 60_000;
  if (_trackedCache && Date.now() - _trackedCache.at < ttl) return _trackedCache.byAddress;

  const db = getWalletServiceClient();
  const byAddress = new Map<string, WalletTrackerRow[]>();
  if (!db) {
    _trackedCache = { byAddress, at: Date.now() };
    return byAddress;
  }

  const { data, error } = await db
    .from('user_tracked_wallets')
    .select('user_id, address, alerts_on_toast, alerts_on_feed, alerts_on_bubble, name, emoji, sound')
    .eq('chain', 'solana');
  if (error) throw error;

  for (const raw of (data ?? []) as RawTrackedWalletRow[]) {
    if (!raw.address || !raw.user_id) continue;
    const alertsOnToast = raw.alerts_on_toast ?? true;
    const alertsOnFeed = raw.alerts_on_feed ?? true;
    const alertsOnBubble = raw.alerts_on_bubble ?? true;
    // A wallet with every alert channel off is a passive hold — skip it entirely
    // so it never enters the poll set.
    if (!alertsOnToast && !alertsOnFeed && !alertsOnBubble) continue;

    const list = byAddress.get(raw.address) ?? [];
    list.push({
      userId: raw.user_id,
      alertsOnToast,
      alertsOnFeed,
      alertsOnBubble,
      name: raw.name ?? '',
      emoji: raw.emoji ?? '',
      sound: raw.sound ?? 'default',
    });
    byAddress.set(raw.address, list);
  }

  _trackedCache = { byAddress, at: Date.now() };
  return byAddress;
}

/** Drop the tracked-wallet memo so a fresh track/untrack is seen next poll. */
export function invalidateTrackedWalletCache(): void {
  _trackedCache = null;
}

/** Load poll cursors for a set of wallet addresses. */
export async function loadMovementCursors(
  db: SupabaseClient,
  addresses: string[],
): Promise<Map<string, MovementCursorRow>> {
  const map = new Map<string, MovementCursorRow>();
  if (addresses.length === 0) return map;

  const { data, error } = await db
    .from('wallet_movement_cursors')
    .select('wallet_address, last_tx_hash, cursor_seeded')
    .in('wallet_address', addresses);
  if (error) throw error;

  for (const row of (data ?? []) as MovementCursorRow[]) {
    map.set(row.wallet_address, row);
  }
  return map;
}

/** Persist a wallet's poll progress (newest seen tx_hash + seeded flag). */
export async function upsertMovementCursor(
  db: SupabaseClient,
  walletAddress: string,
  lastTxHash: string | null,
  cursorSeeded: boolean,
): Promise<void> {
  const { error } = await db.from('wallet_movement_cursors').upsert(
    {
      wallet_address: walletAddress,
      last_tx_hash: lastTxHash,
      cursor_seeded: cursorSeeded,
      last_polled_at: new Date().toISOString(),
    },
    { onConflict: 'wallet_address' },
  );
  if (error) throw error;
}
