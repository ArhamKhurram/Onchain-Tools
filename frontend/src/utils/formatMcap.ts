/**
 * Compact USD market cap: 1_234_567 -> "$1.2M". Null -> em dash.
 *
 * Lives in its own module (not `types/pumpfun.ts`) on purpose: this is the one
 * pumpfun runtime helper the boot path needs (`useWebSocket` callout toasts,
 * `RevivalBanner`). Importing it from `types/pumpfun.ts` hoisted that entire
 * ~5 kB module — leaderboard normalizers, wallet-tracking helpers and all —
 * into the index chunk, because the lazy pumpfun pages need every export and a
 * module lives in exactly one chunk. Boot-path code must import from here, not
 * from `types/pumpfun.ts` (which re-exports this for the lazy consumers).
 */
export function formatMcap(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}
