export interface UpdateEntry {
  date: string;
  added?: string[];
  fixed?: string[];
}

/** Public update log — newest first. */
export const UPDATES: UpdateEntry[] = [
  {
    date: '2026-07-20',
    added: [
      '**Rick wait on contract scans** — every live contract detection now waits up to 30 seconds for a Rick embed before the row appears in the feed, so ticker, FDV, and liquidity land together instead of flashing a bare address first',
      '**Enrichment fallbacks** — if Rick does not reply in time, OCT tries DexScreener, then copies metadata from a prior scan of the same address, before showing the bare CA as a last resort',
      '**Client gateway persistence** — contracts detected in browser-only mode are saved to the API so rescans and refreshes no longer wipe the feed in dev',
      '**FOMO tracked-user storage** — the Wallets → FOMO tab reads and writes your track list via Supabase; the backend only resolves handles through the shared FOMO service account',
      '**Per-trader Pushover toggle** — enable or disable Pushover alerts per tracked FOMO user from the bell icon on each row',
      '**Signal convergence alerts (v1)** — high-priority in-app toast when a contract call and a tracked FOMO buy hit the same token within 30 minutes',
      '**Console code-splitting** — dashboard routes, Settings, and GlobalSettings load on demand; vendor libraries split into separate chunks for faster first paint',
    ],
    fixed: [
      '**Rescan metadata** — scanning the same contract again keeps $TICKER, FDV, and liquidity from the earlier enriched row instead of reverting to a raw address',
      '**Contracts disappearing in dev** — periodic refetches no longer replace the in-memory feed with an empty database list when using the client-side Discord gateway',
      '**FOMO Supabase key alias** — backend FOMO storage accepts `SUPABASE_SERVICE_ROLE_KEY` when `SUPABASE_SERVICE_KEY` is unset',
    ],
  },
  {
    date: '2026-07-19',
    added: [
      '**Stope-style landing** — full-screen scroll sections with flame/black palette, scroll rail, and gate screen before entering the site',
      '**Console reskin** — Feed, Settings, Callers, and nav aligned with the landing aesthetic; contract feed shows token tickers like Radar',
    ],
    fixed: [
      '**Landing footer overlap** — security disclaimer no longer sits under the fixed scroll footer; fake counter removed',
    ],
  },
  {
    date: '2026-07-14',
    added: [
      '**Browser-side Discord gateway** — connect directly from your browser in hosted mode; tokens stay in localStorage and never hit our servers',
      '**OCT rebrand** — Onchain Terminal identity, favicon, and routing split at /dashboard',
    ],
  },
];

export function formatUpdateDate(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}
