/**
 * Token peak sampler.
 *
 * Walks tokens called recently and records their high-water market cap, which is
 * what caller scoring reads (see `tokenPeakStore.ts` for why peak and not spot).
 *
 * This is deliberately its own loop rather than a hook inside the missed-runner
 * poller: missed-runner only walks users who have that alert *enabled* and only
 * over their configured lookback, so piggybacking would silently make caller
 * scores depend on an unrelated alert setting. Same cadence, separate concerns —
 * consistent with the "keep the signals separate" principle — see docs/roadmap/.
 */

import { getFomoServiceClient } from '../fomo/store.js';
import { getStorageProvider, isHostedMode } from '../storage/index.js';
import { fetchLiveMarketCap } from '../utils/tokenEnrichment.js';
import { recordPeak } from './tokenPeakStore.js';
import type { ContractEntry } from '../utils/contractLog.js';

const DEFAULT_INTERVAL_MS = 180_000; // 3 min
const DEFAULT_LOOKBACK_HOURS = 72;
/** Ceiling per pass so a busy feed can't turn into an enrichment-API stampede. */
const MAX_TOKENS_PER_PASS = 120;
const LOCAL_USER_ID = 'local';
/**
 * How long the deduped target universe is reused before re-reading every
 * user's contract log (hosted mode only — local mode reads a JSON file and
 * stays per-pass fresh).
 *
 * The per-pass rebuild was the sampler's real cost: one user_configs read plus
 * one capped 500-row contracts read PER USER every 3 minutes, against a 72h
 * lookback that barely moves between passes. Measured in prod (2026-08-31):
 * 2,039 capped rows across 7 users ≈ 280KB per pass ≈ 4.0GB/month of Supabase
 * egress — on a free plan whose egress budget is the binding constraint.
 * At the 15-min default the same data costs ~0.8GB/month.
 *
 * A newly-called token waits at most one TTL before the SAMPLER first sees it
 * — but its peaks are not blind meanwhile: the fire-and-forget observation
 * hooks (Dex fallback, Radar snapshot refresh, missed-runner ride-along)
 * record fresh tokens the moment anything else fetches their MC. Caching also
 * makes the rotation cursor's coverage more coherent: the window walks one
 * stable list instead of a list that reshuffles every pass.
 */
const DEFAULT_TARGETS_TTL_MS = 900_000; // 15 min

export function resolveTargetsTtlMs(): number {
  const parsed = Number.parseInt(process.env.TOKEN_PEAK_TARGETS_TTL_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TARGETS_TTL_MS;
}

export interface SampleTarget {
  address: string;
  chain: 'evm' | 'sol';
  evmChain?: string;
}

/** Distinct tokens across a contract log, newest call first. */
export function collectSampleTargets(contracts: ContractEntry[]): SampleTarget[] {
  const seen = new Map<string, SampleTarget>();
  const sorted = [...contracts].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
  for (const c of sorted) {
    const key = c.address.toLowerCase();
    const existing = seen.get(key);
    if (existing) {
      // A later row may have resolved the EVM chain the first one lacked.
      if (!existing.evmChain && c.evmChain) existing.evmChain = c.evmChain;
      continue;
    }
    seen.set(key, { address: c.address, chain: c.chain, evmChain: c.evmChain });
  }
  return [...seen.values()];
}

class TokenPeakSampler {
  private timer: NodeJS.Timeout | null = null;
  private sampling = false;
  private started = false;
  /** Rotating offset so a feed with more tokens than the cap still gets full coverage. */
  private cursor = 0;

  start(): void {
    if (this.started) return;
    this.started = true;

    const interval =
      Number.parseInt(process.env.TOKEN_PEAK_SAMPLE_INTERVAL_MS ?? '', 10) || DEFAULT_INTERVAL_MS;
    console.log(`[TokenPeakSampler] Started (interval ${interval}ms).`);
    void this.sample().catch((err) =>
      console.error('[TokenPeakSampler] initial pass error:', (err as Error)?.message),
    );
    this.timer = setInterval(() => {
      void this.sample().catch((err) =>
        console.error('[TokenPeakSampler] pass error:', (err as Error)?.message),
      );
    }, interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.started = false;
  }

  private async userIds(): Promise<string[]> {
    if (!isHostedMode()) return [LOCAL_USER_ID];
    const db = getFomoServiceClient();
    if (!db) return [];
    const { data, error } = await db.from('user_configs').select('user_id');
    if (error) {
      console.warn('[TokenPeakSampler] Failed to load users:', error.message);
      return [];
    }
    return (data ?? []).map((row) => row.user_id as string);
  }

  /** Cached deduped target universe (hosted mode; see DEFAULT_TARGETS_TTL_MS). */
  private targetsCache: { targets: SampleTarget[]; at: number } | null = null;

  private async loadTargets(since: string): Promise<SampleTarget[]> {
    // Hosted-only cache: the per-pass rebuild costs a user_configs read plus a
    // capped 500-row contracts read per user, and the 72h universe barely moves
    // between 3-min passes. Local mode is a JSON file read — stays fresh.
    const ttl = isHostedMode() ? resolveTargetsTtlMs() : 0;
    if (ttl > 0 && this.targetsCache && Date.now() - this.targetsCache.at < ttl) {
      return this.targetsCache.targets;
    }

    const storage = getStorageProvider();
    // Tokens are a global fact, so dedupe across every user before sampling —
    // ten users watching the same caller shouldn't mean ten API calls.
    const targets = new Map<string, SampleTarget>();
    for (const userId of await this.userIds()) {
      try {
        // Column-scoped read: collectSampleTargets reads only address/chain/
        // evm_chain/timestamp, all of which getContractsForScoring returns.
        // getContracts' select('*') would drag every enrichment/display column
        // across the wire for up to 500 rows per user per pass — pure egress
        // waste on the hosted path (locally it's the same full read).
        const contracts = await storage.getContractsForScoring(userId, 500, since);
        for (const t of collectSampleTargets(contracts)) {
          const key = t.address.toLowerCase();
          const existing = targets.get(key);
          if (!existing) targets.set(key, t);
          else if (!existing.evmChain && t.evmChain) existing.evmChain = t.evmChain;
        }
      } catch (err) {
        console.error(
          `[TokenPeakSampler] Contract load failed for ${userId}:`,
          (err as Error)?.message,
        );
      }
    }

    const all = [...targets.values()];
    if (ttl > 0) this.targetsCache = { targets: all, at: Date.now() };
    return all;
  }

  private async sample(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    try {
      const lookbackHours =
        Number.parseInt(process.env.TOKEN_PEAK_LOOKBACK_HOURS ?? '', 10) || DEFAULT_LOOKBACK_HOURS;
      const since = new Date(Date.now() - lookbackHours * 3_600_000).toISOString();

      const all = await this.loadTargets(since);
      if (all.length === 0) return;

      if (this.cursor >= all.length) this.cursor = 0;
      const batch = all.slice(this.cursor, this.cursor + MAX_TOKENS_PER_PASS);
      this.cursor += batch.length;

      if (all.length > MAX_TOKENS_PER_PASS) {
        console.log(
          `[TokenPeakSampler] Sampling ${batch.length}/${all.length} tokens this pass (rotating).`,
        );
      }

      for (const target of batch) {
        try {
          const live = await fetchLiveMarketCap(target.address, target.evmChain ?? undefined);
          if (!live?.mcNow || live.mcNow <= 0) continue;
          await recordPeak({
            address: target.address,
            chain: target.chain,
            evmChain: target.evmChain,
            mcNow: live.mcNow,
          });
        } catch (err) {
          console.error(
            `[TokenPeakSampler] Sample failed for ${target.address}:`,
            (err as Error)?.message,
          );
        }
      }
    } finally {
      this.sampling = false;
    }
  }
}

let _sampler: TokenPeakSampler | null = null;

export function startTokenPeakSampler(): void {
  if (_sampler) return;
  _sampler = new TokenPeakSampler();
  _sampler.start();
}

export function stopTokenPeakSampler(): void {
  _sampler?.stop();
  _sampler = null;
}
