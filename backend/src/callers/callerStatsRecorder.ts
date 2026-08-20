// Persistent caller quality — the write path.
//
// Two halves, because neither alone is enough:
//
//   recordScannedContract()  — fires on every scan, the moment a contract is
//     logged. This is what "once someone scans, they are ranked" means
//     literally: the caller exists in the board within milliseconds, not on the
//     next sweep.
//
//   the reconciler           — a periodic sweep of the recent contract log that
//     re-folds and re-upserts. It is not redundant. A row is logged BEFORE
//     enrichment has priced it, so the scan-time write almost always carries a
//     null MC@call; the sweep re-reads the same row minutes later, once
//     DexScreener or Rick has filled `fdvAtCall` in, and the upsert's
//     same-instant rule folds that price onto the existing call. It also picks
//     up rows written by paths that don't go through the ingest hook (the
//     browser gateway posting to /api/contracts) and covers any fire-and-forget
//     write that failed.
//
// Both go through `foldCallerCalls` in packages/shared, so the attribution
// rules — earliest row wins, own MC@call, one row per caller/token pair,
// excluded authors dropped — are enforced in exactly one place.
//
// Everything here is a no-op when the store isn't persistent (local mode), and
// nothing here is ever awaited by the ingest path.

import { DEFAULT_EXCLUDED_CALLERS, foldCallerCalls, type ContractEntry } from '@oct/shared';
import { getFomoServiceClient } from '../fomo/store.js';
import { getStorageProvider, isHostedMode } from '../storage/index.js';
import { getCallerStatsStore } from './callerStatsStore.js';
import { refreshTokenPeakOnRescan } from './tokenPeakRefresh.js';

const LOCAL_USER_ID = 'local';
const DEFAULT_INTERVAL_MS = 300_000; // 5 min
/** Wide enough that a row is re-folded many times before it leaves the window. */
const DEFAULT_LOOKBACK_HOURS = 12;
const MAX_CONTRACTS_PER_USER = 5_000;

/**
 * The scoring exclusion list for a user: the known enrichment bots, plus
 * whatever the operator has added.
 *
 * Exported because the ingest path already holds the config and shouldn't
 * re-read it per contract, and because the merge order (defaults first, config
 * layered on) has to match what `/callers/scores` does — an author excluded on
 * read but recorded on write is just wasted rows.
 */
export function scoringExclusions(
  config: { callerScoreExclusions?: string[] } | null | undefined,
): readonly string[] {
  const extra = config?.callerScoreExclusions;
  return extra?.length ? [...DEFAULT_EXCLUDED_CALLERS, ...extra] : DEFAULT_EXCLUDED_CALLERS;
}

/**
 * Record one just-logged contract as a call, and refresh that token's peak.
 *
 * Fire-and-forget by contract: ingest must not slow down or fail because a
 * board write did. The peak refresh is debounced per address inside
 * `refreshTokenPeakOnRescan`, so a token spammed across a room costs one fetch.
 */
export function recordScannedContract(
  userId: string,
  entry: ContractEntry,
  options: { exclude?: readonly string[] } = {},
): void {
  const store = getCallerStatsStore();
  // Local mode returns here, peak refresh included. Not an oversight: local
  // scores derive from the contract log, and the 3-minute sampler already walks
  // every token called in the last 72 hours — on a single-user desktop feed
  // that is full coverage, so a second fetch per scan would buy nothing.
  if (!store.persistent) return;

  const [call] = foldCallerCalls([entry], options);
  // No call means an excluded author (an enrichment bot reposting) or a row
  // with no author at all — neither is somebody's call.
  if (call) {
    void store
      .recordCalls(userId, [call])
      .catch((err) => console.error('[CallerStats] scan write failed:', (err as Error)?.message));
  }

  refreshTokenPeakOnRescan({
    address: entry.address,
    chain: entry.chain,
    evmChain: entry.evmChain,
  });
}

async function userIds(): Promise<string[]> {
  if (!isHostedMode()) return [LOCAL_USER_ID];
  const db = getFomoServiceClient();
  if (!db) return [];
  const { data, error } = await db.from('user_configs').select('user_id');
  if (error) {
    console.warn('[CallerStats] Failed to load users:', error.message);
    return [];
  }
  return (data ?? []).map((row) => row.user_id as string);
}

class CallerStatsReconciler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private started = false;

  start(): void {
    if (this.started) return;
    const store = getCallerStatsStore();
    if (!store.persistent) {
      console.log('[CallerStats] Reconciler idle — scores derive on read in this mode.');
      return;
    }
    this.started = true;

    const interval =
      Number.parseInt(process.env.CALLER_STATS_INTERVAL_MS ?? '', 10) || DEFAULT_INTERVAL_MS;
    console.log(`[CallerStats] Reconciler started (interval ${interval}ms).`);
    void this.pass().catch((err) =>
      console.error('[CallerStats] initial pass error:', (err as Error)?.message),
    );
    this.timer = setInterval(() => {
      void this.pass().catch((err) =>
        console.error('[CallerStats] pass error:', (err as Error)?.message),
      );
    }, interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.started = false;
  }

  private async pass(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const lookbackHours =
        Number.parseInt(process.env.CALLER_STATS_LOOKBACK_HOURS ?? '', 10) ||
        DEFAULT_LOOKBACK_HOURS;
      const since = new Date(Date.now() - lookbackHours * 3_600_000).toISOString();
      const storage = getStorageProvider();
      const store = getCallerStatsStore();

      for (const userId of await userIds()) {
        try {
          // Exclusions are re-read per user per pass rather than cached: they
          // are a handful of strings and an operator who excludes a bot expects
          // it to stop accruing rows, not to stop on the next restart. They are
          // ALSO applied on read (see `splitCallerAggregates`), so an exclusion
          // added after the fact still hides rows already stored.
          const config = await storage.getConfig(userId).catch(() => null);
          const exclude = scoringExclusions(config);
          const contracts = await storage.getContracts(userId, MAX_CONTRACTS_PER_USER, since);
          if (contracts.length === 0) continue;
          const calls = foldCallerCalls(contracts, { exclude });
          if (calls.length === 0) continue;
          await store.recordCalls(userId, calls);
        } catch (err) {
          console.error(
            `[CallerStats] Reconcile failed for ${userId}:`,
            (err as Error)?.message,
          );
        }
      }
    } finally {
      this.running = false;
    }
  }
}

let _reconciler: CallerStatsReconciler | null = null;

export function startCallerStatsReconciler(): void {
  if (_reconciler) return;
  _reconciler = new CallerStatsReconciler();
  _reconciler.start();
}

export function stopCallerStatsReconciler(): void {
  _reconciler?.stop();
  _reconciler = null;
}
