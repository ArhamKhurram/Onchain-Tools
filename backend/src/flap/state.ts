// Where the Flap watcher's per-chain memory lives: the set of RWA asset
// addresses it has already seen, plus the last block it scanned.
//
// WHY NOT StorageProvider. Every method on `storage/interface.ts` takes a
// `userId` first, because everything behind it is one user's data. "This RWA
// stock has been listed on BNB" is not: it is a fact about the chain, identical
// for every subscriber, so storing one copy per user would multiply the rows
// and the RPC reads by the number of people watching for identical answers.
// This is global poller state, so it follows the pattern the other GLOBAL
// stores set — `mcap_cross_state`, `network_scans`, token peaks: a JSON file in
// local mode (so the desktop app works) and a service-role table in hosted
// mode, keyed by chain, no user_id.
//
// COMPACT BY DESIGN (CLAUDE.md egress rule). ONE row per chain — two rows total
// — holding the known-asset SET and the block cursor. There is no per-event and
// no per-asset row: a listing is dozens a year, and the whole point of deduping
// on the asset is that the durable state stays tiny. Each poll reads and writes
// one row per chain.
//
// THE MIGRATION MAY NOT BE APPLIED. Same contract as `mcap_cross_state`: a
// missing table is tolerated. The store warns ONCE and falls back to an
// in-memory map, degrading the feature to "the seed re-runs after a restart"
// rather than breaking the poller. Since a re-seed only re-marks existing
// assets WITHOUT alerting, the worst case of a missing table is silence, never
// a false alert.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isHostedMode } from '../storage/index.js';
import { getFomoServiceClient } from '../fomo/store.js';
import type { FlapChain } from './detect.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR =
  process.env.OCT_DATA_DIR || process.env.TRENCHCORD_DATA_DIR || join(__dirname, '../../data');
const LOCAL_PATH = join(DATA_DIR, 'flap-state.json');
const TABLE = 'flap_chain_state';

/** One chain's durable state. */
export interface FlapChainState {
  /** Highest block scanned so far (the poll resumes at +1). 0 = never scanned. */
  lastScannedBlock: number;
  /** Has the initial history seed run? Until it has, nothing alerts. */
  seeded: boolean;
  /** Lowercased RWA asset addresses already seen — the dedupe set. */
  knownAssets: string[];
}

/** The persistence seam the poller depends on. Injected so tests supply a fake. */
export interface FlapStateStore {
  load(chain: FlapChain): Promise<FlapChainState>;
  save(chain: FlapChain, state: FlapChainState): Promise<void>;
}

const emptyState = (): FlapChainState => ({ lastScannedBlock: 0, seeded: false, knownAssets: [] });

/** Narrow an untrusted stored blob into a state, defaulting every absent field. */
function normalizeState(raw: unknown): FlapChainState {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const block = Number(obj.lastScannedBlock);
  const assets = Array.isArray(obj.knownAssets)
    ? obj.knownAssets.filter((a): a is string => typeof a === 'string').map((a) => a.toLowerCase())
    : [];
  return {
    lastScannedBlock: Number.isSafeInteger(block) && block >= 0 ? block : 0,
    seeded: obj.seeded === true,
    knownAssets: [...new Set(assets)],
  };
}

// --- local JSON backing ------------------------------------------------------

let localCache: Record<string, unknown> | null = null;

function loadLocal(): Record<string, unknown> {
  if (localCache) return localCache;
  try {
    localCache = existsSync(LOCAL_PATH)
      ? (JSON.parse(readFileSync(LOCAL_PATH, 'utf-8')) as Record<string, unknown>)
      : {};
  } catch (err) {
    console.error('[Flap] Failed to load local state:', (err as Error).message);
    localCache = {};
  }
  return localCache;
}

function saveLocal(): void {
  try {
    writeFileSync(LOCAL_PATH, JSON.stringify(localCache ?? {}, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Flap] Failed to save local state:', (err as Error).message);
  }
}

// --- hosted backing ----------------------------------------------------------

let hostedTableMissing = false;
const memoryFallback: Record<string, FlapChainState> = {};

function isMissingTable(message: string | undefined): boolean {
  return /does not exist|Could not find the table|schema cache/i.test(message ?? '');
}

function db(): SupabaseClient | null {
  return getFomoServiceClient();
}

/**
 * The production store. Best-effort throughout: a failed read is an empty state
 * (so the chain re-seeds without alerting), and a failed write leaves the last
 * durable values in place. It must never throw into the poll loop.
 */
export const flapStateStore: FlapStateStore = {
  async load(chain: FlapChain): Promise<FlapChainState> {
    if (!isHostedMode()) {
      return normalizeState(loadLocal()[chain]);
    }

    const client = db();
    if (!client || hostedTableMissing) return normalizeState(memoryFallback[chain]);

    const { data, error } = await client
      .from(TABLE)
      .select('chain, last_scanned_block, seeded, known_assets')
      .eq('chain', chain)
      .maybeSingle();

    if (error) {
      if (isMissingTable(error.message)) {
        hostedTableMissing = true;
        console.warn(
          `[Flap] Supabase table ${TABLE} is absent — apply ` +
            'supabase/migrations/20260908130000_flap_chain_state.sql. Falling back to in-memory ' +
            'state: the history seed re-runs (without alerting) after a restart until it is applied.',
        );
      } else {
        console.warn('[Flap] State load failed:', error.message);
      }
      return normalizeState(memoryFallback[chain]);
    }

    if (!data) return emptyState();
    return normalizeState({
      lastScannedBlock: data.last_scanned_block,
      seeded: data.seeded,
      knownAssets: data.known_assets,
    });
  },

  async save(chain: FlapChain, state: FlapChainState): Promise<void> {
    const normalized = normalizeState(state);

    if (!isHostedMode()) {
      const local = loadLocal();
      local[chain] = normalized;
      saveLocal();
      return;
    }

    const client = db();
    if (!client || hostedTableMissing) {
      memoryFallback[chain] = normalized;
      return;
    }

    const { error } = await client.from(TABLE).upsert(
      {
        chain,
        last_scanned_block: normalized.lastScannedBlock,
        seeded: normalized.seeded,
        known_assets: normalized.knownAssets,
      },
      { onConflict: 'chain' },
    );

    if (error) {
      if (isMissingTable(error.message)) {
        hostedTableMissing = true;
        memoryFallback[chain] = normalized;
      } else {
        console.warn('[Flap] State write failed:', error.message);
      }
    }
  },
};

/** Test seam: forget the local file cache and the hosted fallback. */
export function _resetFlapStateForTest(): void {
  localCache = null;
  hostedTableMissing = false;
  for (const key of Object.keys(memoryFallback)) delete memoryFallback[key];
}
