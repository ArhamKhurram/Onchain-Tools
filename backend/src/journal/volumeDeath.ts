/**
 * "Meta dying" detector — volume collapse on a token the operator still holds.
 *
 * The audit's single biggest leak: continuing to trade a token/meta after its
 * volume died, at elevated size. The detector fires when BOTH:
 *   - the m5 per-minute volume rate has collapsed vs the h1 rate, AND
 *   - the h1 per-minute rate has collapsed vs the h6 rate,
 * each below OCT_JOURNAL_VOLDEATH_RATIO (default 0.35). Windows are nested
 * (m5 ⊆ h1 ⊆ h6), so steady volume reads ≈ 1.0 on both ratios and a genuine
 * collapse reads low on both — a one-window blip cannot fire alone.
 *
 * This is a NEW independent signal. It reuses CONCEPTS from revival (pure
 * detector + cooldown + poller), never code paths — signals stay independent
 * per CLAUDE.md. Pure functions only; unit-tested with real-shaped
 * DexScreener fixtures (journalVolumeDeath.test.ts).
 */

export interface VolumeWindows {
  /** Rolling USD volume, DexScreener shape. */
  m5: number;
  h1: number;
  h6: number;
}

export interface VolumeDeathConfig {
  /** Both rate ratios must sit below this to fire. */
  ratio: number;
  /**
   * Abstain below this h6 volume: a token that never had volume is not
   * "dying", it is dead-on-arrival, and alerting on it every cycle is noise.
   */
  minH6VolumeUsd: number;
}

export const DEFAULT_VOLUME_DEATH_CONFIG: VolumeDeathConfig = {
  ratio: 0.35,
  minH6VolumeUsd: 500,
};

export interface VolumeDeathVerdict {
  dying: boolean;
  /** (m5/5min) ÷ (h1/60min); null when it cannot be computed honestly. */
  m5RateVsH1: number | null;
  /** (h1/60min) ÷ (h6/360min); null when it cannot be computed honestly. */
  h1RateVsH6: number | null;
}

/** Pure gate evaluation. Missing/zero baselines abstain — never fire blind. */
export function evaluateVolumeDeath(
  w: VolumeWindows,
  cfg: VolumeDeathConfig = DEFAULT_VOLUME_DEATH_CONFIG,
): VolumeDeathVerdict {
  if (!(w.h6 > 0) || w.h6 < cfg.minH6VolumeUsd) {
    return { dying: false, m5RateVsH1: null, h1RateVsH6: null };
  }

  const h1RateVsH6 = (w.h1 / 60) / (w.h6 / 360);
  // h1 of 0 with a live h6 means literally no volume in the last hour: the m5
  // ratio is 0/0 but the collapse is total, so treat it as fully collapsed.
  const m5RateVsH1 = w.h1 > 0 ? (w.m5 / 5) / (w.h1 / 60) : w.m5 === 0 ? 0 : null;

  const dying =
    m5RateVsH1 != null && m5RateVsH1 < cfg.ratio && h1RateVsH6 < cfg.ratio;
  return { dying, m5RateVsH1, h1RateVsH6 };
}

/**
 * One alert per position per cooldown window (OCT_JOURNAL_VOLDEATH_COOLDOWN_MS,
 * default 30 min). Pure — the poller owns the lastAlertAt map (in-memory v1,
 * resets on reboot, same tradeoff revival's suppression makes).
 */
export function shouldAlertVolumeDeath(
  lastAlertAtMs: number | null | undefined,
  nowMs: number,
  cooldownMs: number,
): boolean {
  if (lastAlertAtMs == null) return true;
  return nowMs - lastAlertAtMs >= cooldownMs;
}

// --- DexScreener payload extraction ----------------------------------------

/** The subset of a `/latest/dex/tokens/{mint}` pair we read. */
export interface DexTokenPair {
  baseToken?: { address?: string; symbol?: string };
  liquidity?: { usd?: number };
  priceUsd?: string;
  volume?: { m5?: number; h1?: number; h6?: number; h24?: number };
}

export interface TokenVolumeSnapshot {
  windows: VolumeWindows;
  /** From the deepest-liquidity matching pair. */
  priceUsd: number | null;
  symbol: string | null;
}

/**
 * Fold a token's pairs into one volume snapshot: volumes SUM across every
 * pair where the token is the base (the meta dies across all its pools, not
 * one), price/symbol come from the deepest pool. Null when no pair matches.
 */
export function extractTokenVolumeSnapshot(
  pairs: DexTokenPair[] | null | undefined,
  mint: string,
): TokenVolumeSnapshot | null {
  const matching = (pairs ?? []).filter((p) => p.baseToken?.address === mint);
  if (matching.length === 0) return null;

  const windows: VolumeWindows = { m5: 0, h1: 0, h6: 0 };
  for (const p of matching) {
    windows.m5 += p.volume?.m5 ?? 0;
    windows.h1 += p.volume?.h1 ?? 0;
    windows.h6 += p.volume?.h6 ?? 0;
  }

  const best = [...matching].sort(
    (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
  )[0];
  const price = best.priceUsd != null ? Number(best.priceUsd) : NaN;

  return {
    windows,
    priceUsd: Number.isFinite(price) ? price : null,
    symbol: best.baseToken?.symbol ?? null,
  };
}
