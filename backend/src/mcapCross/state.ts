/**
 * Where `lastSeenMcap` lives.
 *
 * WHY NOT StorageProvider. Every method on `storage/interface.ts` takes a
 * `userId` first, because everything behind it is one user's data. A token's
 * market cap is not: "SOMECOIN crossed 750K" is a fact about the chain, true
 * for every user at once, and storing one copy per subscriber would multiply
 * both the rows and the DexScreener reads by the number of people watching —
 * for identical answers. This is global poller state, so it follows the
 * pattern the other GLOBAL stores already set: `alerts/tokenPeakStore.ts`
 * (peaks, keyed by address+chain, no user_id) and `network_scans`. JSON file in
 * local mode so the desktop app works, a service-role table in hosted mode.
 *
 * WHY IT IS PERSISTED AT ALL. Without it, every restart re-arms the whole
 * universe: `evaluateCrossing`'s first-observation rule records and stays
 * quiet, so a deploy during a token's run silently eats that token's alert.
 * With ~300 rows and a five-minute cadence, persistence is cheap insurance
 * against the most common cause of a missed alert — us.
 *
 * THE MIGRATION MAY NOT BE APPLIED. Same contract as `network_scans` (see
 * supabase/migrations/20260812160000_network_scans.sql): a missing table is
 * tolerated. The store warns ONCE and falls back to the in-memory map, which
 * degrades the feature to "crossings survive until the next deploy" rather
 * than breaking the poller. Silence on a missing table would be worse — that is
 * how you discover in three months that nothing has ever been persisted.
 *
 * FIRED-AT IS IN THE SAME ROW, on purpose. A crossing that already alerted must
 * not alert again when the token wobbles back under 750K and up through it an
 * hour later; the cooldown is a property of the token, exactly like the market
 * cap next to it, and a second table for one timestamp would be two writes
 * where one does.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { RevivalNetwork } from '@oct/shared';
import { isHostedMode } from '../storage/index.js';
import { getFomoServiceClient } from '../fomo/store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR =
  process.env.OCT_DATA_DIR || process.env.TRENCHCORD_DATA_DIR || join(__dirname, '../../data');
const LOCAL_PATH = join(DATA_DIR, 'mcap-cross-state.json');

const TABLE = 'mcap_cross_state';

export interface McapCrossRow {
  address: string;
  network: RevivalNetwork;
  /** Last real market-cap observation. Never written on an abstain. */
  lastSeenMcap: number;
  lastSeenAt: string;
  /** Epoch ms of the last alert for this token; 0 when it has never fired. */
  firedAt: number;
}

export type McapCrossState = Map<string, McapCrossRow>;

export function stateKey(network: RevivalNetwork, address: string): string {
  return `${network}:${address}`;
}

// --- local JSON backing ------------------------------------------------------

let localCache: Record<string, McapCrossRow> | null = null;

function loadLocal(): Record<string, McapCrossRow> {
  if (localCache) return localCache;
  try {
    localCache = existsSync(LOCAL_PATH)
      ? (JSON.parse(readFileSync(LOCAL_PATH, 'utf-8')) as Record<string, McapCrossRow>)
      : {};
  } catch (err) {
    console.error('[McapCross] Failed to load local state:', (err as Error).message);
    localCache = {};
  }
  return localCache;
}

function saveLocal(): void {
  try {
    writeFileSync(LOCAL_PATH, JSON.stringify(localCache ?? {}, null, 2), 'utf-8');
  } catch (err) {
    console.error('[McapCross] Failed to save local state:', (err as Error).message);
  }
}

// --- hosted backing ----------------------------------------------------------

/**
 * Set once the table has been found missing, so the warning is printed one time
 * rather than every cycle. A poller that logs the same schema complaint every
 * five minutes trains everyone to ignore its logs.
 */
let hostedTableMissing = false;
/** In-memory fallback used when the table is absent (see the module header). */
const memoryFallback: Record<string, McapCrossRow> = {};

function isMissingTable(message: string | undefined): boolean {
  return /does not exist|Could not find the table|schema cache/i.test(message ?? '');
}

function db(): SupabaseClient | null {
  return getFomoServiceClient();
}

function rowFrom(raw: any): McapCrossRow | null {
  const address = raw?.address;
  const network = raw?.network;
  if (typeof address !== 'string' || typeof network !== 'string') return null;
  const mcap = Number(raw?.last_seen_mcap);
  if (!Number.isFinite(mcap)) return null;
  return {
    address,
    network: network as RevivalNetwork,
    lastSeenMcap: mcap,
    lastSeenAt: raw?.last_seen_at ?? new Date().toISOString(),
    firedAt: raw?.fired_at ? Date.parse(raw.fired_at) || 0 : 0,
  };
}

/**
 * Load every stored row for the tokens we are about to poll.
 *
 * Column-scoped and address-filtered rather than `select('*')` on the table:
 * prod is on Supabase's free plan where EGRESS, not disk, is the binding
 * constraint (see the pattern in getContractsForScoring).
 */
export async function loadState(
  keys: { network: RevivalNetwork; address: string }[],
): Promise<McapCrossState> {
  const out: McapCrossState = new Map();
  if (keys.length === 0) return out;

  if (!isHostedMode()) {
    const local = loadLocal();
    for (const k of keys) {
      const row = local[stateKey(k.network, k.address)];
      if (row) out.set(stateKey(k.network, k.address), row);
    }
    return out;
  }

  const client = db();
  if (!client || hostedTableMissing) {
    for (const k of keys) {
      const row = memoryFallback[stateKey(k.network, k.address)];
      if (row) out.set(stateKey(k.network, k.address), row);
    }
    return out;
  }

  const addresses = [...new Set(keys.map((k) => k.address))];
  const { data, error } = await client
    .from(TABLE)
    .select('address, network, last_seen_mcap, last_seen_at, fired_at')
    .in('address', addresses);

  if (error) {
    if (isMissingTable(error.message)) {
      hostedTableMissing = true;
      console.warn(
        `[McapCross] Supabase table ${TABLE} is absent — apply ` +
          'supabase/migrations/20260905120000_mcap_cross_state.sql. Falling back to in-memory ' +
          'state: crossings will NOT survive a restart until it is applied.',
      );
    } else {
      console.warn('[McapCross] State load failed:', error.message);
    }
    return out;
  }

  for (const raw of (data ?? []) as any[]) {
    const row = rowFrom(raw);
    if (row) out.set(stateKey(row.network, row.address), row);
  }
  return out;
}

/**
 * Record a cycle's observations in ONE round trip.
 *
 * Best-effort by design: a failed write leaves the previous durable values in
 * place, so the next cycle compares the next real reading against the last real
 * one — the same abstain discipline the detector uses. It must never throw into
 * the poll loop.
 *
 * A cycle touches every token in the universe — a few hundred rows — and doing
 * that as a few hundred upserts would spend more requests on bookkeeping than
 * the entire feature spends on data. Prod is on Supabase's free plan where
 * egress and request count are the binding constraints, so the batch is not an
 * optimisation, it is the difference between viable and not.
 */
export async function recordObservations(rows: McapCrossRow[]): Promise<void> {
  if (rows.length === 0) return;

  if (!isHostedMode()) {
    const local = loadLocal();
    for (const row of rows) local[stateKey(row.network, row.address)] = row;
    saveLocal();
    return;
  }

  const client = db();
  if (!client || hostedTableMissing) {
    for (const row of rows) memoryFallback[stateKey(row.network, row.address)] = row;
    return;
  }

  const { error } = await client.from(TABLE).upsert(
    rows.map((row) => ({
      address: row.address,
      network: row.network,
      last_seen_mcap: row.lastSeenMcap,
      last_seen_at: row.lastSeenAt,
      fired_at: row.firedAt > 0 ? new Date(row.firedAt).toISOString() : null,
    })),
    { onConflict: 'address,network' },
  );

  if (error) {
    if (isMissingTable(error.message)) {
      hostedTableMissing = true;
      for (const row of rows) memoryFallback[stateKey(row.network, row.address)] = row;
      return;
    }
    console.warn('[McapCross] State write failed:', error.message);
  }
}

/** Test seam: forget the local file cache and the hosted fallback. */
export function _resetStateForTest(): void {
  localCache = null;
  hostedTableMissing = false;
  for (const key of Object.keys(memoryFallback)) delete memoryFallback[key];
}
