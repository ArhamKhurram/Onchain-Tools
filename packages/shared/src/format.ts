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

// --- Card formatters (transport-agnostic) ----------------------------------
//
// These three lived in backend/src/bot/layout.ts next to the Discord
// Components V2 builders. The builders are Discord-specific; these are not —
// a market cap reads the same in a Discord embed and a Telegram message. They
// moved here when the Telegram bot (backend/src/tgbot/) landed as a second
// transport over the same data, so both render identically from one source.
// bot/layout.ts re-exports them, so every Discord call site is unchanged.

/** `$1,234` — whole-dollar, comma-grouped. Backs compactUsd below the 1K mark. */
export function usd(value: number): string {
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

/**
 * `$1.2M` / `$980.5K` — compact market caps.
 *
 * Deliberately NOT formatCompact above: this one is dollar-prefixed, keeps two
 * decimals at M/B, and handles negatives by magnitude. Both exist because both
 * are already load-bearing on rendered surfaces.
 */
export function compactUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return usd(value);
}

/** `7xK…pump` → `7xK1..pump` — short address for tight card lines. */
export function shortAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 4)}..${address.slice(-4)}`;
}
