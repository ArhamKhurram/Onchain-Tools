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
  /**
   * The HIGHEST market cap this poller has ever observed for the token. Used to
   * suppress a re-cross of a token we already watched run well above the target
   * (see isWatermarkReCross). It is a strict running max, so it survives a
   * pullback the way `lastSeenMcap` does not.
   *
   * THE COLUMN MAY NOT EXIST YET. Its migration (20260908..._mcap_cross_watermark)
   * is applied by hand, so between the deploy and the apply this reads back as
   * the last-seen value (the safe floor: a token is at least as high as we last
   * saw it) and watermark suppression simply does nothing until the column is
   * there. See loadState/recordObservations for the column-absent handling.
   */
  highWatermarkMcap: number;
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
/**
 * Set once the high_watermark_mcap COLUMN (not the table) has been found
 * missing, so reads/writes drop it and the rest of the feature keeps working
 * until the migration is applied. Distinct from `hostedTableMissing`, which is
 * about the whole table.
 */
let watermarkColumnMissing = false;
/** In-memory fallback used when the table is absent (see the module header). */
const memoryFallback: Record<string, McapCrossRow> = {};

const COLS_WITH_WM = 'address, network, last_seen_mcap, last_seen_at, fired_at, high_watermark_mcap';
const COLS_NO_WM = 'address, network, last_seen_mcap, last_seen_at, fired_at';

function isMissingTable(message: string | undefined): boolean {
  return /does not exist|Could not find the table|schema cache/i.test(message ?? '');
}

/**
 * A missing-COLUMN error names the column. Checked BEFORE `isMissingTable`,
 * whose broad regex ("does not exist", "schema cache") would otherwise swallow
 * a missing-column error and wrongly disable the whole feature into memory.
 */
function mentionsWatermarkColumn(message: string | undefined): boolean {
  return /high_watermark_mcap/i.test(message ?? '');
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
  // Absent column (migration not yet applied) or null → fall back to the last
  // seen value: a token is at least as high as we last saw it, which makes
  // watermark suppression a no-op rather than a wrong answer.
  const watermark = Number(raw?.high_watermark_mcap);
  return {
    address,
    network: network as RevivalNetwork,
    lastSeenMcap: mcap,
    lastSeenAt: raw?.last_seen_at ?? new Date().toISOString(),
    firedAt: raw?.fired_at ? Date.parse(raw.fired_at) || 0 : 0,
    highWatermarkMcap: Number.isFinite(watermark) && watermark > 0 ? Math.max(watermark, mcap) : mcap,
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
    .select(watermarkColumnMissing ? COLS_NO_WM : COLS_WITH_WM)
    .in('address', addresses);

  if (error) {
    // The COLUMN is absent (migration not yet applied) but the table exists:
    // note it, retry without the column, and keep the feature running. Checked
    // first because isMissingTable's regex would otherwise claim it.
    if (!watermarkColumnMissing && mentionsWatermarkColumn(error.message)) {
      watermarkColumnMissing = true;
      console.warn(
        `[McapCross] Column ${TABLE}.high_watermark_mcap is absent — apply ` +
          'supabase/migrations/20260908120000_mcap_cross_watermark.sql. Watermark re-cross ' +
          'suppression is disabled until then; the rest of the feature is unaffected.',
      );
      const retry = await client.from(TABLE).select(COLS_NO_WM).in('address', addresses);
      if (!retry.error) {
        for (const raw of (retry.data ?? []) as any[]) {
          const row = rowFrom(raw);
          if (row) out.set(stateKey(row.network, row.address), row);
        }
      } else {
        console.warn('[McapCross] State load retry failed:', retry.error.message);
      }
      return out;
    }
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

  const payload = (includeWatermark: boolean) =>
    rows.map((row) => {
      const base: Record<string, unknown> = {
        address: row.address,
        network: row.network,
        last_seen_mcap: row.lastSeenMcap,
        last_seen_at: row.lastSeenAt,
        fired_at: row.firedAt > 0 ? new Date(row.firedAt).toISOString() : null,
      };
      if (includeWatermark) base.high_watermark_mcap = row.highWatermarkMcap;
      return base;
    });

  const { error } = await client
    .from(TABLE)
    .upsert(payload(!watermarkColumnMissing), { onConflict: 'address,network' });

  if (error) {
    // COLUMN absent but table present: drop the column and retry once. Checked
    // before isMissingTable, whose regex would otherwise route us to memory.
    if (!watermarkColumnMissing && mentionsWatermarkColumn(error.message)) {
      watermarkColumnMissing = true;
      const retry = await client
        .from(TABLE)
        .upsert(payload(false), { onConflict: 'address,network' });
      if (retry.error) {
        if (isMissingTable(retry.error.message)) {
          hostedTableMissing = true;
          for (const row of rows) memoryFallback[stateKey(row.network, row.address)] = row;
        } else {
          console.warn('[McapCross] State write retry failed:', retry.error.message);
        }
      }
      return;
    }
    if (isMissingTable(error.message)) {
      hostedTableMissing = true;
      for (const row of rows) memoryFallback[stateKey(row.network, row.address)] = row;
      return;
    }
    console.warn('[McapCross] State write failed:', error.message);
  }
}

/**
 * The tokens that most recently ALERTED, newest first.
 *
 * WHY THIS BELONGS HERE AND NOT IN A NEW TABLE. `fired_at` already records
 * exactly one fact — "this token produced a crossing alert at this moment" —
 * and the migration already carries `mcap_cross_state_fired_at_idx (fired_at
 * desc nulls last)` for the poller's own cooldown sweep. Reading the same
 * column the other way round is a history of crossings for free; a second table
 * to hold what one indexed column already holds would be two writes per alert
 * where there is currently one.
 *
 * IT IS NOT A DELIVERY LOG. It says what crossed, not what any particular chat
 * was sent — a chat that subscribed an hour ago will see entries older than its
 * subscription. That is the honest shape of the data, and the card that renders
 * it says "crossed", never "you missed".
 *
 * NO user_id, so there is nothing personal to leak: an address, a chain, a
 * number and a timestamp, identical for every reader (see the migration's
 * header). Column-scoped and `limit`ed for the reason every read in this file
 * is — prod is on Supabase's free plan where egress is the binding constraint.
 *
 * Best-effort like the rest of the module: any failure is an empty list, which
 * the caller renders as "nothing recorded yet" rather than as an error.
 */
export async function recentCrossings(limit: number): Promise<McapCrossRow[]> {
  const capped = Math.max(1, Math.min(Math.trunc(limit), 25));

  const fromMemory = (source: Record<string, McapCrossRow>): McapCrossRow[] =>
    Object.values(source)
      .filter((row) => row.firedAt > 0)
      .sort((a, b) => b.firedAt - a.firedAt)
      .slice(0, capped);

  if (!isHostedMode()) return fromMemory(loadLocal());

  const client = db();
  if (!client || hostedTableMissing) return fromMemory(memoryFallback);

  const { data, error } = await client
    .from(TABLE)
    .select('address, network, last_seen_mcap, last_seen_at, fired_at')
    .not('fired_at', 'is', null)
    .order('fired_at', { ascending: false })
    .limit(capped);

  if (error) {
    if (isMissingTable(error.message)) hostedTableMissing = true;
    else console.warn('[McapCross] Recent crossings read failed:', error.message);
    return fromMemory(memoryFallback);
  }

  const rows: McapCrossRow[] = [];
  for (const raw of (data ?? []) as any[]) {
    const row = rowFrom(raw);
    if (row && row.firedAt > 0) rows.push(row);
  }
  return rows;
}

/** Test seam: forget the local file cache and the hosted fallback. */
export function _resetStateForTest(): void {
  localCache = null;
  hostedTableMissing = false;
  watermarkColumnMissing = false;
  for (const key of Object.keys(memoryFallback)) delete memoryFallback[key];
}
