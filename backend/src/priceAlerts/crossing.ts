/**
 * Price alerts — the pure half: crossing detection and DexScreener batch
 * bookkeeping. No I/O, no storage, no clock. Unit-tested in
 * backend/test/priceAlertCrossing.test.ts.
 *
 * WHY THIS EXISTS. The operator planned to buy a token in a 100-150K mcap band
 * and missed the fill twice: once because the token was never watchlisted, once
 * because they were not looking at the screen. Revival/breakout structurally
 * cannot cover that — they scan a universe built from contracts detected in the
 * user's own FEED and gate on dormancy vs the token's prior 72h peak, so a
 * token nobody in their rooms posted is invisible to them BY DESIGN. This is the
 * opposite shape: operator-chosen token + operator-chosen level → alert on
 * crossing. No detection, no scoring, no discovery, and per CLAUDE.md it stays
 * its own signal — never fused with revival, breakout, convergence, FOMO or
 * missed-runner.
 *
 * CROSSING, NOT LEVEL-TESTING. An 'above' alert fires on the transition from
 * "at or below the target" to "strictly above it" — not merely on observing a
 * value above the target. That distinction is the whole feature: a level test
 * would fire the instant you armed an alert on a token already trading past it,
 * which is exactly the alert the operator cannot act on.
 *
 * FIRST-OBSERVATION RULE (deliberate, and the one judgement call here). The
 * first time the poller sees an alert's token it RECORDS the value and arms;
 * it never fires on that observation. Reasoning:
 *   - There is no prior observation, so there is no transition to detect. Any
 *     firing rule on a single sample is a level test wearing a crossing's hat.
 *   - The failure modes are asymmetric. Firing on first sight sends a ping for
 *     a level that was already true when the alert was created — noise the
 *     operator learns to ignore, which is how an alert system dies. Staying
 *     quiet costs at most one cycle (~25s), because ANY genuine subsequent
 *     crossing fires normally.
 *   - It makes "arm an alert below the current price so it catches the way
 *     back down" work without a special case: the create is the baseline.
 * The cost, stated plainly: a token that crosses the target and comes back
 * within the same cycle is missed. That is inherent to sampling, not to this
 * rule.
 *
 * ABSTAIN ON MISSING DATA. No pair, no price, a failed request, or a
 * non-finite number is a data GAP, not a verdict. `lastSeenUsd` is left
 * untouched so the next real observation is compared against the last real
 * one, and nothing ever fires blind.
 */

import type { PriceAlertDirection, PriceAlertMetric } from '@oct/shared';

// --- Crossing ---------------------------------------------------------------

export interface CrossingInput {
  direction: PriceAlertDirection;
  targetUsd: number;
  /** Last real observation, in the alert's metric. Null = never observed. */
  lastSeenUsd: number | null;
  /** This cycle's observation. Null = no data (abstain). */
  observedUsd: number | null;
}

/**
 * - `abstain`: no usable data this cycle. Write nothing.
 * - `arm`: first ever observation. Record `observedUsd`; do NOT fire.
 * - `record`: observed, no crossing. Record `observedUsd`; do NOT fire.
 * - `fire`: a genuine crossing. Record AND fire (one-shot).
 */
export type CrossingAction = 'abstain' | 'arm' | 'record' | 'fire';

export interface CrossingVerdict {
  action: CrossingAction;
  /** The value to persist as lastSeenUsd; null only when abstaining. */
  observedUsd: number | null;
}

const ABSTAIN: CrossingVerdict = { action: 'abstain', observedUsd: null };

/**
 * Pure crossing evaluation. See the module header for the first-observation
 * rule and the abstain rule.
 */
export function evaluateCrossing(input: CrossingInput): CrossingVerdict {
  const observed = input.observedUsd;
  if (observed == null || !Number.isFinite(observed) || observed <= 0) return ABSTAIN;
  if (!Number.isFinite(input.targetUsd)) return ABSTAIN;

  const last = input.lastSeenUsd;
  // First observation: baseline only. Never fires — there is no transition yet.
  if (last == null || !Number.isFinite(last)) return { action: 'arm', observedUsd: observed };

  const crossed =
    input.direction === 'above'
      ? last <= input.targetUsd && observed > input.targetUsd
      : last >= input.targetUsd && observed < input.targetUsd;

  return { action: crossed ? 'fire' : 'record', observedUsd: observed };
}

// --- DexScreener batch reads ------------------------------------------------

/** The subset of a DexScreener pair this subsystem reads. */
export interface DexPair {
  baseToken?: { address?: string; symbol?: string };
  liquidity?: { usd?: number };
  priceUsd?: string;
  /** Token-level; `fdv` is the fallback when `marketCap` is absent. */
  marketCap?: number;
  fdv?: number;
}

export interface MintSnapshot {
  mint: string;
  symbol: string | null;
  priceUsd: number | null;
  mcapUsd: number | null;
}

/**
 * DexScreener's `/latest/dex/tokens/{a,b,c,…}` accepts up to 30 comma-separated
 * addresses, but the RESPONSE is capped at 30 PAIRS — not 30 tokens. Measured
 * against the live API on 2026-08-14: 10 liquid Solana mints came back as 30
 * pairs covering only 7 of them. The other 3 were silently absent, which is
 * indistinguishable from "not listed" unless you know about the cap.
 *
 * So the cap is treated as the real limit: batches are small (see
 * DEFAULT_BATCH_SIZE), and any batch that comes back AT the cap with missing
 * mints is re-queried in halves (`splitForRetry`) down to singletons. A
 * singleton that returns nothing is genuinely unlisted, and the poller
 * abstains on it.
 */
export const DEX_PAIR_CAP = 30;

/**
 * Mints per request. 10 keeps a typical memecoin watchlist (1-3 pools each)
 * comfortably under the 30-pair cap, so the retry path is the exception rather
 * than the rule. Tunable via OCT_PRICE_ALERT_BATCH_SIZE.
 */
export const DEFAULT_BATCH_SIZE = 10;

/** Split a mint list into request-sized chunks (order preserved). */
export function chunkMints(mints: string[], size: number = DEFAULT_BATCH_SIZE): string[][] {
  const n = Math.max(1, Math.min(Math.floor(size), 30));
  const out: string[][] = [];
  for (let i = 0; i < mints.length; i += n) out.push(mints.slice(i, i + n));
  return out;
}

/**
 * Fold one batch response into per-mint snapshots.
 *
 * Volumes are irrelevant here; what matters is price and market cap. Both come
 * from the DEEPEST-LIQUIDITY pair where the mint is the base token (the
 * convention everywhere else in this codebase — see
 * journal/volumeDeath.ts:extractTokenVolumeSnapshot). Market cap is a
 * token-level figure so any pair reporting one is acceptable as a fallback,
 * which matters for tokens whose deepest pool omits it.
 *
 * `missing` lists requested mints with no matching pair — either unlisted or
 * lost to the 30-pair cap. The caller disambiguates via `wasTruncated`.
 */
export function snapshotsFromPairs(
  pairs: DexPair[] | null | undefined,
  requested: string[],
): { snapshots: Map<string, MintSnapshot>; missing: string[] } {
  const snapshots = new Map<string, MintSnapshot>();
  const byMint = new Map<string, DexPair[]>();
  for (const p of pairs ?? []) {
    const addr = p.baseToken?.address;
    if (!addr) continue;
    const list = byMint.get(addr) ?? [];
    list.push(p);
    byMint.set(addr, list);
  }

  for (const mint of requested) {
    const matching = byMint.get(mint);
    if (!matching || matching.length === 0) continue;
    const sorted = [...matching].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const best = sorted[0];
    const price = best.priceUsd != null ? Number(best.priceUsd) : NaN;
    // Token-level number: prefer the deepest pair's marketCap, then its fdv,
    // then the first pair (deepest-first) that reports either.
    let mcapRaw: number | undefined;
    for (const p of sorted) {
      const candidate = p.marketCap ?? p.fdv;
      if (typeof candidate === 'number') {
        mcapRaw = candidate;
        break;
      }
    }
    snapshots.set(mint, {
      mint,
      symbol: best.baseToken?.symbol ?? null,
      priceUsd: Number.isFinite(price) && price > 0 ? price : null,
      mcapUsd: typeof mcapRaw === 'number' && Number.isFinite(mcapRaw) && mcapRaw > 0 ? mcapRaw : null,
    });
  }

  const missing = requested.filter((m) => !snapshots.has(m));
  return { snapshots, missing };
}

/**
 * True when a response plausibly hit the 30-pair cap, i.e. mints may have been
 * dropped rather than being unlisted. Only meaningful alongside a non-empty
 * `missing` list.
 */
export function wasTruncated(pairCount: number): boolean {
  return pairCount >= DEX_PAIR_CAP;
}

/**
 * Halve a truncated batch for re-query. A singleton cannot be split further —
 * an empty result for it is a real "not listed", so it returns [] and the
 * caller stops.
 */
export function splitForRetry(mints: string[]): string[][] {
  if (mints.length <= 1) return [];
  const mid = Math.ceil(mints.length / 2);
  return [mints.slice(0, mid), mints.slice(mid)];
}

/** Read the value an alert's metric refers to out of a snapshot. */
export function valueForMetric(snapshot: MintSnapshot, metric: PriceAlertMetric): number | null {
  return metric === 'price' ? snapshot.priceUsd : snapshot.mcapUsd;
}
