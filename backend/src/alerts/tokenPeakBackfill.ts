/**
 * Token peak backfill — seed `token_peaks` for tokens called before the
 * sampler's first pass.
 *
 * Caller scores only rate a call once its token has a peak row, and the peak
 * sampler only records peaks going forward. Anyone whose call history predates
 * the sampler therefore reads as thin/unrated until enough *new* calls land.
 * This walks the recent contract log once and records the current live market
 * cap as a peak observation for every token that doesn't have one yet.
 *
 * Two honesty notes, both deliberate:
 *
 * - The data source is `fetchLiveMarketCap` — GMGN when configured, DexScreener
 *   fallback — the exact path the sampler and missed-runner already use. No new
 *   provider, no Birdeye (that's portfolio-only by design).
 * - The seeded value is *today's* MC, not the token's true ATH since the call.
 *   Peaks are a high-water mark of observations, and this adds one observation.
 *   That understates dead runners' peaks, but a floor is strictly better than
 *   no rating at all, and every later sampler pass can only raise it.
 *
 * Idempotent by construction: tokens that already have a peak are skipped
 * (unless `force`), and `recordPeak` is a max-upsert, so re-running — even with
 * `force` — can never lower a peak or double-count anything.
 */

import { getFomoServiceClient } from '../fomo/store.js';
import { getStorageProvider, isHostedMode } from '../storage/index.js';
import { fetchLiveMarketCap } from '../utils/tokenEnrichment.js';
import { getPeaks, recordPeak } from './tokenPeakStore.js';
import { collectSampleTargets, type SampleTarget } from './tokenPeakSampler.js';

const DEFAULT_LOOKBACK_DAYS = 90; // matches MAX_WINDOW_DAYS on /callers/scores
const MAX_LOOKBACK_DAYS = 365;
const MAX_CONTRACTS_PER_USER = 2000;
/** Pause between upstream calls so a big backlog doesn't hammer the providers. */
const THROTTLE_MS = 250;
const LOCAL_USER_ID = 'local';

export interface BackfillStatus {
  state: 'idle' | 'running' | 'done' | 'failed';
  startedAt?: string;
  finishedAt?: string;
  lookbackDays?: number;
  force?: boolean;
  /** Distinct tokens found in the window. */
  candidates: number;
  /** Skipped because a peak row already existed (the idempotency path). */
  alreadySeeded: number;
  /** Peak observations recorded this run. */
  seeded: number;
  /** No usable live MC from GMGN or DexScreener (dead/unlisted tokens). */
  unpriced: number;
  /** Per-token fetch/record errors (run continues past them). */
  failed: number;
  error?: string;
}

export interface BackfillOptions {
  lookbackDays?: number;
  /** Re-sample tokens that already have a peak. Still max-upsert — never lowers. */
  force?: boolean;
}

/**
 * Which targets a run should actually fetch. Pure so the skip/force logic is
 * testable without providers: existing peaks are skipped unless forced.
 */
export function pickBackfillTargets(
  targets: SampleTarget[],
  existingPeaks: Map<string, number>,
  force: boolean,
): { toFetch: SampleTarget[]; alreadySeeded: number } {
  if (force) return { toFetch: targets, alreadySeeded: 0 };
  const toFetch: SampleTarget[] = [];
  let alreadySeeded = 0;
  for (const t of targets) {
    if (existingPeaks.has(t.address.toLowerCase())) alreadySeeded++;
    else toFetch.push(t);
  }
  return { toFetch, alreadySeeded };
}

export function clampLookbackDays(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LOOKBACK_DAYS;
  return Math.min(MAX_LOOKBACK_DAYS, Math.max(1, Math.floor(n)));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let status: BackfillStatus = {
  state: 'idle',
  candidates: 0,
  alreadySeeded: 0,
  seeded: 0,
  unpriced: 0,
  failed: 0,
};

export function getBackfillStatus(): BackfillStatus {
  return { ...status };
}

async function userIds(): Promise<string[]> {
  if (!isHostedMode()) return [LOCAL_USER_ID];
  const db = getFomoServiceClient();
  if (!db) return [];
  const { data, error } = await db.from('user_configs').select('user_id');
  if (error) {
    console.warn('[TokenPeakBackfill] Failed to load users:', error.message);
    return [];
  }
  return (data ?? []).map((row) => row.user_id as string);
}

async function run(lookbackDays: number, force: boolean): Promise<void> {
  const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();
  const storage = getStorageProvider();

  // Same global dedupe as the sampler: tokens are a shared fact, so N users
  // calling the same CA is one fetch, not N.
  const targets = new Map<string, SampleTarget>();
  for (const userId of await userIds()) {
    try {
      // Column-scoped read (same rationale as the live sampler): collectSampleTargets
      // reads only address/chain/evm_chain/timestamp. Avoids select('*') egress on the
      // hosted path for up to MAX_CONTRACTS_PER_USER rows per user.
      const contracts = await storage.getContractsForScoring(userId, MAX_CONTRACTS_PER_USER, since);
      for (const t of collectSampleTargets(contracts)) {
        const key = t.address.toLowerCase();
        const existing = targets.get(key);
        if (!existing) targets.set(key, t);
        else if (!existing.evmChain && t.evmChain) existing.evmChain = t.evmChain;
      }
    } catch (err) {
      console.error(
        `[TokenPeakBackfill] Contract load failed for ${userId}:`,
        (err as Error)?.message,
      );
    }
  }

  const all = [...targets.values()];
  status.candidates = all.length;

  const existing = await getPeaks(all.map((t) => t.address));
  const { toFetch, alreadySeeded } = pickBackfillTargets(all, existing, force);
  status.alreadySeeded = alreadySeeded;

  console.log(
    `[TokenPeakBackfill] ${all.length} tokens in window, ${alreadySeeded} already seeded, fetching ${toFetch.length}.`,
  );

  for (const target of toFetch) {
    try {
      const live = await fetchLiveMarketCap(target.address, target.evmChain ?? undefined);
      if (!live?.mcNow || live.mcNow <= 0) {
        status.unpriced++;
      } else {
        await recordPeak({
          address: target.address,
          chain: target.chain,
          evmChain: target.evmChain,
          mcNow: live.mcNow,
        });
        status.seeded++;
      }
    } catch (err) {
      status.failed++;
      console.error(
        `[TokenPeakBackfill] Failed for ${target.address}:`,
        (err as Error)?.message,
      );
    }
    if (THROTTLE_MS > 0) await sleep(THROTTLE_MS);
  }

  console.log(
    `[TokenPeakBackfill] Done: seeded ${status.seeded}, unpriced ${status.unpriced}, failed ${status.failed}.`,
  );
}

/**
 * Kick off a backfill in the background. Returns the fresh status, or the
 * in-flight one with `started: false` when a run is already going.
 */
export function startTokenPeakBackfill(
  opts: BackfillOptions = {},
): { started: boolean; status: BackfillStatus } {
  if (status.state === 'running') return { started: false, status: getBackfillStatus() };

  const lookbackDays = clampLookbackDays(opts.lookbackDays);
  const force = opts.force === true;
  status = {
    state: 'running',
    startedAt: new Date().toISOString(),
    lookbackDays,
    force,
    candidates: 0,
    alreadySeeded: 0,
    seeded: 0,
    unpriced: 0,
    failed: 0,
  };

  void run(lookbackDays, force)
    .then(() => {
      status.state = 'done';
      status.finishedAt = new Date().toISOString();
    })
    .catch((err) => {
      status.state = 'failed';
      status.finishedAt = new Date().toISOString();
      status.error = (err as Error)?.message ?? 'unknown error';
      console.error('[TokenPeakBackfill] Run failed:', err);
    });

  return { started: true, status: getBackfillStatus() };
}
