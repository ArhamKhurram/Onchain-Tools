export interface UpdateEntry {
  date: string;
  added?: string[];
  fixed?: string[];
}

/** Public update log — newest first. */
export const UPDATES: UpdateEntry[] = [
  {
    date: '2026-07-25',
    added: [
      '**FOMO live trade feed** — individual buy/sell swaps from traders you track stream to the live feed over WebSocket; the backend polls each FOMO wallet once and fans out to every subscriber',
      '**FOMO store-and-fan-out** — swaps are stored once in the database, then delivered to all OCT users tracking that trader — no duplicate API polling when multiple people follow the same wallet',
      '**FOMO VPS worker** — optional always-on Chromium worker (`fomo-worker/`) proxies FOMO API calls from a VPS so Railway does not need Playwright in production',
      '**Robinhood Chain on FOMO** — HOOD swaps classify correctly for cross-chain and same-chain trades (USDG/WETH quote tokens)',
      '**Radar mention window toggle** — 15m, 1h, and 4h mention counts combined into one sortable column; window and visible columns configurable from Radar settings',
      '**Radar column picker** — choose which columns show (mentions, callers, MC@call, first caller, FOMO, etc.); platform shown as a dot on the token row',
      '**Home session status** — console home shows Telegram connected/disconnected alongside Discord and room count',
      '**Dark and light theme** — header toggle switches between the black/red console and a cream/blue light mode with improved Feed contrast',
    ],
    fixed: [
      '**FOMO live feed empty** — switched from the aggregate trading-activity feed to per-user activity API so individual swaps appear for tracked traders',
      '**Contract scan alerts** — contract detections broadcast in-app toasts and alert sounds again (Discord and Telegram)',
      '**Telegram media in hosted mode** — images, video, and audio load via authenticated fetch instead of broken proxy URLs',
      '**Workspace room settings** — gear icon opens room config from Workspace panels, not just Feed',
      '**Telegram disconnects** — stale sessions auto-reconnect on API and status checks',
    ],
  },
  {
    date: '2026-07-22',
    added: [
      '**Portfolio tab** — Birdeye wallet dashboard for My Wallets: realized/unrealized PnL, win rate, holdings, recent trades, plus PnL chart and calendar modals',
      '**Sortable Radar** — click any column header to sort tokens; active sort highlights in red with default latest mention first',
    ],
    fixed: [
      '**Portfolio rate limits** — Birdeye activity feed backs chart and calendar when deep PnL history is rate-limited',
    ],
  },
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
      '**FOMO leaderboard** — browse top FOMO traders (24h or all-time) on the Wallets tab and track them in one click',
      '**Holder overlap on Radar** — contract rows show how many of your tracked FOMO traders hold the token',
      '**Convergence badge + Pushover** — Radar marks cross-source hits; optional Pushover when feed chatter and a tracked FOMO buy align on the same token',
      '**FOMO follow sync + Railway Chromium** — shared service account auto-follows tracked users when needed; deploy installs Playwright browser deps',
    ],
    fixed: [
      '**Rescan metadata** — scanning the same contract again keeps $TICKER, FDV, and liquidity from the earlier enriched row instead of reverting to a raw address',
      '**Contracts disappearing in dev** — periodic refetches no longer replace the in-memory feed with an empty database list when using the client-side Discord gateway',
      '**FOMO Supabase key alias** — backend FOMO storage accepts `SUPABASE_SERVICE_ROLE_KEY` when `SUPABASE_SERVICE_KEY` is unset',
      '**FOMO poller bootstrap** — fan-out poller runs an initial poll on start and exposes `/api/fomo/status` for frontend gating',
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
