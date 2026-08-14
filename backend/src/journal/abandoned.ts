/**
 * "Abandoned position" detector — the DEAD-BAG close path for the trade
 * journal.
 *
 * The FIFO engine (positions.ts) closes an episode only when the remaining
 * TOKEN balance drops under DUST_RATIO (2%). A token that goes to zero in
 * VALUE while the operator still holds the full token count therefore stays
 * `open` forever: it clutters the open-positions list and burns one
 * DexScreener request per cycle in the volume-death sweep, on a bag that will
 * never move again.
 *
 * This detector is the ADDITIONAL close path. It never replaces the dust rule
 * and never changes it — a position it declines is left exactly as it was.
 *
 * A position is ABANDONED when ALL hold:
 *   1. it is open,
 *   2. it has a real cost basis (> 0) — defensive: transfer-ins are already
 *      excluded upstream (normalize.ts routes "tokens in, nothing paid" into
 *      transferIns and positions.ts skips a sell with no open episode), so a
 *      zero-cost open episode should be structurally impossible. If one ever
 *      appears, it is a bug and we refuse to book a loss on it,
 *   3. nothing has traded on it for `minAgeDays` (from lastTradeAt),
 *   4. it is effectively UNSELLABLE — either no DexScreener pair exists at
 *      all, or the pooled liquidity is under `minLiquidityUsd` (the operator's
 *      "not real coins — no LP" case), or the position is worth less than
 *      `maxValueUsd`.
 *
 * ABSTAIN BEATS WRONG. Closing books a real, permanent loss into realized
 * PnL, so every ambiguous input declines: an unparseable timestamp, a pair
 * that exists but returned no price this cycle, a pair whose liquidity is
 * unknown and whose value cannot be computed. Missing data is not evidence of
 * death.
 *
 * Pure — the poller owns the I/O. Unit-tested in journalAbandoned.test.ts.
 */

import type { JournalPosition } from '@oct/shared';

export interface AbandonConfig {
  /** Master switch (OCT_JOURNAL_ABANDON_ENABLED, default true). */
  enabled: boolean;
  /** Days of no trading before a position can be considered dead. */
  minAgeDays: number;
  /** Position value strictly under this counts as unsellable. */
  maxValueUsd: number;
  /** Pooled pair liquidity strictly under this counts as "no LP". */
  minLiquidityUsd: number;
}

export const DEFAULT_ABANDON_CONFIG: AbandonConfig = {
  enabled: true,
  minAgeDays: 7,
  maxValueUsd: 1,
  minLiquidityUsd: 100,
};

/** Market facts for the position's mint, from the sweep's existing fetch. */
export interface AbandonMarketInput {
  /** False when DexScreener returned no pair with this mint as base token. */
  pairFound: boolean;
  /** Summed pooled liquidity across matching pairs; null when unknown. */
  liquidityUsd: number | null;
  /** Price from the deepest matching pair; null when unknown. */
  priceUsd: number | null;
}

export type AbandonDecline =
  | 'disabled'
  | 'not_open'
  | 'zero_cost'
  | 'too_recent'
  | 'unknown_age'
  | 'unknown_price'
  | 'alive';

export type AbandonFireReason = 'no_pair' | 'no_liquidity' | 'worthless';

export type AbandonVerdict =
  | { abandoned: true; reason: AbandonFireReason; positionValueUsd: number | null }
  | { abandoned: false; declined: AbandonDecline };

const DAY_MS = 86_400_000;

/** A position has a real cost basis when either priced leg is positive. */
function hasCostBasis(p: Pick<JournalPosition, 'costSol' | 'costUsd'>): boolean {
  if (Number.isFinite(p.costSol) && p.costSol > 0) return true;
  return p.costUsd != null && Number.isFinite(p.costUsd) && p.costUsd > 0;
}

export function evaluateAbandoned(
  position: Pick<
    JournalPosition,
    'status' | 'costSol' | 'costUsd' | 'lastTradeAt' | 'remainingToken'
  >,
  market: AbandonMarketInput,
  nowMs: number,
  cfg: AbandonConfig = DEFAULT_ABANDON_CONFIG,
): AbandonVerdict {
  if (!cfg.enabled) return { abandoned: false, declined: 'disabled' };
  if (position.status !== 'open') return { abandoned: false, declined: 'not_open' };
  if (!hasCostBasis(position)) return { abandoned: false, declined: 'zero_cost' };

  const lastMs = Date.parse(position.lastTradeAt);
  if (!Number.isFinite(lastMs)) return { abandoned: false, declined: 'unknown_age' };
  if (nowMs - lastMs < cfg.minAgeDays * DAY_MS) {
    return { abandoned: false, declined: 'too_recent' };
  }

  // The "not a real coin" case: nothing to sell into at all.
  if (!market.pairFound) return { abandoned: true, reason: 'no_pair', positionValueUsd: null };

  const positionValueUsd =
    market.priceUsd != null && Number.isFinite(market.priceUsd)
      ? position.remainingToken * market.priceUsd
      : null;

  // A pool exists but is too shallow to exit through — the operator's "no LP".
  if (market.liquidityUsd != null && market.liquidityUsd < cfg.minLiquidityUsd) {
    return { abandoned: true, reason: 'no_liquidity', positionValueUsd };
  }

  // Pair exists with (or with unknown) liquidity and no price this cycle: a
  // data gap, not a death. Decline rather than book a loss on a guess.
  if (positionValueUsd == null) return { abandoned: false, declined: 'unknown_price' };

  if (positionValueUsd < cfg.maxValueUsd) {
    return { abandoned: true, reason: 'worthless', positionValueUsd };
  }
  return { abandoned: false, declined: 'alive' };
}

/**
 * The durable abandonment record, read back out of storage: position id →
 * closedAt. `close_reason` on the persisted row is the source of truth, so a
 * rebuild of the wallet's episodes (the ingestion poller, the summary route)
 * re-applies the same zero-proceeds close instead of silently re-opening the
 * bag on the next trade.
 */
export function abandonedMapFromPositions(
  positions: readonly JournalPosition[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of positions) {
    if (p.closeReason !== 'abandoned') continue;
    map.set(p.id, p.closedAt ?? p.lastTradeAt);
  }
  return map;
}
