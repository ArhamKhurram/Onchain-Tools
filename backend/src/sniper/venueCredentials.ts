// Where a venue API token (Slotshark bearer, GMGN key) lives, per mode. See
// docs/architecture/sniper-security.md and
// supabase/migrations/20260730170000_sniper_venue_credentials.sql.
//
// Hosted: Supabase Vault. The token is WRITTEN by the user's own authenticated
// client directly to Supabase (`sniper_store_venue_credential`) — this backend
// never sees it at connect time, mirroring the direct RLS-scoped write pattern
// frontend/src already uses for useTrackedWallets/useHoldingWallets. This
// module only ever READS, via the service-role-only `sniper_get_venue_secret`
// RPC, and only at the moment executeFire is about to send. Callers must not
// cache the result past that call.
//
// Local: single operator, single machine, no Supabase. Plaintext env, matching
// the existing local-mode convention for Discord tokens (ADR-008: loopback +
// single tenant, so there is no multi-tenant secret store to defend here).

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { isHostedMode } from '../storage/index.js';
import type { Venue } from './types.js';

let _client: SupabaseClient | null = null;

function resolveServiceConfig(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL?.trim();
  const key = (process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY)?.trim();
  if (!url || !key) return null;
  return { url, key };
}

function getServiceClient(): SupabaseClient | null {
  if (_client) return _client;
  const cfg = resolveServiceConfig();
  if (!cfg) return null;
  _client = createClient(cfg.url, cfg.key, { auth: { persistSession: false } });
  return _client;
}

// Local-mode credential sources. Slotshark only.
//
// GMGN is deliberately absent. `GMGN_API_KEY` exists in this backend's env for
// enrichment/market data (utils/gmgnClient.ts) and is the OPERATOR's key —
// wiring it here would make every snipe trade on the operator's own GMGN
// account. GMGN trading, when it lands, is a per-user connected credential
// resolved from Vault (ADR-012), never a shared env key.
const LOCAL_ENV_VAR: Record<Exclude<Venue, 'dryrun'>, string> = {
  slotshark: 'SLOTSHARK_API_TOKEN',
};

/**
 * Resolve the credential to fire with. Returns null if none is connected/set —
 * callers must treat that as "cannot fire", never as an empty-string token.
 */
export async function getVenueSecret(userId: string, venue: Venue): Promise<string | null> {
  if (venue === 'dryrun') return null;

  if (!isHostedMode()) {
    return process.env[LOCAL_ENV_VAR[venue]]?.trim() || null;
  }

  const client = getServiceClient();
  if (!client) return null;

  const { data, error } = await client.rpc('sniper_get_venue_secret', {
    p_user_id: userId,
    p_venue: venue,
  });
  if (error) {
    console.error(`[sniper] vault read failed for venue "${venue}":`, error.message);
    return null;
  }
  return (data as string | null) ?? null;
}

/**
 * Hosted-mode, backend-initiated connect/rotate. Exists for admin/testing use
 * before a connect-account UI ships (M12) — the intended production path is
 * the user's own client calling `sniper_store_venue_credential` directly, so
 * the plaintext token never reaches this process at all.
 */
export async function storeVenueSecretAsService(params: {
  userId: string;
  venue: Exclude<Venue, 'dryrun'>;
  secret: string;
  walletAddress?: string;
  region?: string;
  label?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = getServiceClient();
  if (!client) return { ok: false, error: 'Supabase not configured' };

  const { error } = await client.rpc('sniper_store_venue_credential', {
    p_venue: params.venue,
    p_secret: params.secret,
    p_wallet_address: params.walletAddress ?? null,
    p_region: params.region ?? null,
    p_label: params.label ?? null,
    p_user_id: params.userId,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
