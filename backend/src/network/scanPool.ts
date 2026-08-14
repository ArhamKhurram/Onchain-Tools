import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { isHostedMode } from '../storage/index.js';
import { normalizeContractAddress } from '../utils/contract.js';

/**
 * Anonymous OCT network scan pool (hosted mode only).
 *
 * A cross-user record of when the network FIRST saw a token, so every hosted
 * user benefits from everyone else's room coverage on the radar's
 * "Global first" column.
 *
 * PRIVACY IS STRUCTURAL, NON-NEGOTIABLE — this module is the only writer and
 * it accepts nothing that could link a row to a person or a group:
 *   - inputs are token address + chain + timestamp + optional mcap, full stop;
 *   - no userId parameter exists on any function in this file;
 *   - no room/channel/guild/server id, caller name, or message text is ever
 *     accepted, stored, or logged here.
 * Keep it that way: never widen these signatures with identifying context,
 * and never log user/room identifiers next to pool writes.
 *
 * Semantics mirror MC@call's "missing beats wrong" principle:
 *   - first writer wins (insert-if-absent; on conflict do nothing);
 *   - fdv_at_first is filled at most once, and only by an enrichment landing
 *     within FDV_BACKFILL_WINDOW_MS of first_seen_at — a later market cap is
 *     never backfilled.
 *
 * MIGRATION TOLERANCE (journalRepo pattern): the table ships in
 * 20260812160000_network_scans.sql, applied by hand. Until then every call
 * warns once and no-ops — the pool idles, nothing crashes.
 */

const FDV_BACKFILL_WINDOW_MS = 2 * 60_000;

/** Pool chain bucket. Coarse on purpose — the pool keys by address. */
export function poolChainFor(address: string): 'solana' | 'evm' {
  return address.startsWith('0x') ? 'evm' : 'solana';
}

const MISSING_TABLE_RE =
  /relation .*network_scans.* does not exist|Could not find the table .*network_scans|schema cache/i;

let client: SupabaseClient | null | undefined;
let missingTableWarned = false;

function getClient(): SupabaseClient | null {
  if (client !== undefined) return client;
  if (!isHostedMode()) {
    client = null;
    return client;
  }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  client = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
  return client;
}

/** Test seam. */
export function resetNetworkScanPoolForTests(): void {
  client = undefined;
  missingTableWarned = false;
}

function tolerateMissingTable(error: { message?: string } | null | undefined): boolean {
  if (!error || !MISSING_TABLE_RE.test(error.message ?? '')) return false;
  if (!missingTableWarned) {
    missingTableWarned = true;
    console.warn(
      '[NetworkScans] network_scans table is missing — apply migration 20260812160000_network_scans.sql. The pool idles until then.',
    );
  }
  return true;
}

/**
 * Record a first sighting. First writer wins; every later call for the same
 * (address, chain) is a no-op. Fire-and-forget safe: never throws.
 */
export async function recordNetworkScan(input: {
  address: string;
  timestamp: string;
  fdvUsd?: number;
}): Promise<void> {
  const supabase = getClient();
  if (!supabase) return;
  const seenMs = new Date(input.timestamp).getTime();
  if (!Number.isFinite(seenMs)) return;

  try {
    const { error } = await supabase.from('network_scans').upsert(
      {
        address: normalizeContractAddress(input.address),
        chain: poolChainFor(input.address),
        first_seen_at: new Date(seenMs).toISOString(),
        fdv_at_first: input.fdvUsd ?? null,
      },
      { onConflict: 'address,chain', ignoreDuplicates: true },
    );
    if (error && !tolerateMissingTable(error)) {
      console.warn('[NetworkScans] pool write failed:', error.message);
    }
  } catch (err) {
    console.warn('[NetworkScans] pool write failed:', (err as Error).message);
  }
}

/**
 * Fill fdv_at_first once, and only when the reading lands within
 * ~2 minutes of the pool's first sighting. The WHERE clause carries both
 * guards, so a late or repeat reading updates zero rows. Never throws.
 */
export async function recordNetworkScanFdv(address: string, fdvUsd: number): Promise<void> {
  const supabase = getClient();
  if (!supabase) return;
  if (!Number.isFinite(fdvUsd) || fdvUsd <= 0) return;

  try {
    const { error } = await supabase
      .from('network_scans')
      .update({ fdv_at_first: fdvUsd })
      .eq('address', normalizeContractAddress(address))
      .eq('chain', poolChainFor(address))
      .is('fdv_at_first', null)
      .gte('first_seen_at', new Date(Date.now() - FDV_BACKFILL_WINDOW_MS).toISOString());
    if (error && !tolerateMissingTable(error)) {
      console.warn('[NetworkScans] pool fdv update failed:', error.message);
    }
  } catch (err) {
    console.warn('[NetworkScans] pool fdv update failed:', (err as Error).message);
  }
}

export interface NetworkScanHit {
  firstSeenAt: string;
  fdvAtFirst: number | null;
}

/**
 * Batched read for the radar. Keys the result by the address exactly as the
 * caller passed it (base58 is case-sensitive; EVM is normalized internally).
 */
export async function lookupNetworkScans(
  addresses: string[],
): Promise<Record<string, NetworkScanHit>> {
  const supabase = getClient();
  if (!supabase || addresses.length === 0) return {};

  const normalizedToRequested = new Map<string, string>();
  for (const addr of addresses) {
    normalizedToRequested.set(normalizeContractAddress(addr), addr);
  }

  try {
    const { data, error } = await supabase
      .from('network_scans')
      .select('address, first_seen_at, fdv_at_first')
      .in('address', [...normalizedToRequested.keys()]);
    if (error) {
      if (!tolerateMissingTable(error)) {
        console.warn('[NetworkScans] pool read failed:', error.message);
      }
      return {};
    }

    const result: Record<string, NetworkScanHit> = {};
    for (const row of data ?? []) {
      const requested = normalizedToRequested.get(String(row.address));
      if (!requested) continue;
      result[requested] = {
        firstSeenAt: String(row.first_seen_at),
        fdvAtFirst: row.fdv_at_first != null ? Number(row.fdv_at_first) : null,
      };
    }
    return result;
  } catch (err) {
    console.warn('[NetworkScans] pool read failed:', (err as Error).message);
    return {};
  }
}
