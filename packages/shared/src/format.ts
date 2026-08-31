// Shared number formatting helpers.

/**
 * Compact number formatting with K/M/B suffixes — used for market caps,
 * volumes and holdings across enrichment, storage and wallet balance checks.
 * Rounds to one decimal for suffixed magnitudes and to a whole number below
 * 1,000. Values under 1,000 (including 0 and negatives) fall through to
 * `toFixed(0)`, so this is unsuitable for sub-dollar prices — see
 * priceAlerts/poller `formatUsd` for that case.
 */
export function formatCompact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}
