export type UpdateSlideVariant =
  | 'radar'
  | 'fomo'
  | 'pump'
  | 'convergence'
  | 'feed'
  | 'landing'
  | 'gateway'
  | 'portfolio'
  | 'default';

export interface UpdateSlide {
  /** Stored in user_configs.seenAnnouncements when dismissed. */
  id: string;
  title: string;
  description: string;
  /** Optional screenshot under /updates/… */
  image?: string;
  variant?: UpdateSlideVariant;
}

/**
 * Feature highlights — one slide per panel (newest first).
 * Add slides here when shipping; users only auto-see ids they haven't dismissed.
 */
export const UPDATE_SLIDES: UpdateSlide[] = [
  {
    id: 'slide-2026-08-24-peak-mc',
    title: 'Peak MC on Every Call',
    description:
      'Contract rows now show what a CA actually did after the call — MC at call → the peak observed since, with the multiple: 10K → 104K · ≥10×. Peaks are sampled floors, a run that happened before the call is never credited to it, and rows update live as new highs print.',
    variant: 'feed',
  },
  {
    id: 'slide-2026-08-24-caller-band-feed',
    title: 'Caller Strength on the CA Feed',
    description:
      'Every contract row now wears its caller’s band — Elite, Solid, Mixed, Slop — or an honest Unrated when there isn’t enough history to judge. Hover the badge for the numbers behind it: 2x and 5x hit rates, scored calls, median reach. No more guessing whether a CA came from someone worth following.',
    variant: 'feed',
  },
  {
    id: 'slide-2026-08-09-pump-holders',
    title: 'Top Holders, Side by Side',
    description:
      'Open holders on any Solana token to see two boards at once: the FOMO traders you track, and the coin’s top on-chain holders from pump.fun — wallet, balance, % of supply, and live PnL, straight from chain.',
    variant: 'pump',
  },
  {
    id: 'slide-2026-08-08-pump-theses',
    title: 'FOMO Theses',
    description:
      'See why traders are in a coin, not just that they are. The new Theses tab surfaces every fomo.family write-up per token — the author, their position and PnL, and the actual thesis text.',
    variant: 'fomo',
  },
  {
    id: 'slide-2026-08-07-pump-leaderboard',
    title: 'Pump.fun Leaderboard',
    description:
      'Connect your pump.fun account to browse the PnL leaderboard right in the console — daily, weekly, or monthly — and add any trader to your tracker in one tap. Your session stays encrypted server-side.',
    variant: 'pump',
  },
  {
    id: 'slide-2026-08-06-pump-tab',
    title: 'Pump.fun Tab',
    description:
      'A new Pump.fun tab pulls callouts, live buys and sells, and communities into OCT — every callout shows the caller, the thesis, MC at call, current and peak multiple, plus likes and replies. Sort any column.',
    variant: 'pump',
  },
  {
    id: 'slide-2026-07-29-caller-quality',
    title: 'Caller Quality',
    description:
      'Right-click any name to mute the slop or trust the callers worth watching — everywhere, or in one room only. Callers also earn a score from their own calls: the market cap when they posted against the token’s peak since. The contract feed and Radar can rank on it; muted callers collapse behind a counter rather than disappearing.',
    variant: 'feed',
  },
  {
    id: 'slide-2026-07-25-notification-history',
    title: 'Notification History',
    description:
      'Bell icon in the header keeps your last 10 alerts — contract scans, highlights, keywords, and missed runners — so nothing disappears when toasts auto-dismiss.',
    variant: 'feed',
  },
  {
    id: 'slide-2026-07-25-tg-contract-feed',
    title: 'Telegram Contract Feed',
    description:
      'TG scans now land in the contract feed with DexScreener enrichment, correct RESCAN/NEW badges, TG attribution, and an Open in Telegram link.',
    variant: 'feed',
  },
  {
    id: 'slide-2026-07-25-radar-columns',
    title: 'Radar Column Picker',
    description:
      'Token Radar is slimmer — pick which columns you want (mentions, callers, MC@call, first caller, etc.) from the columns settings. 15m / 1h / 4h window lives there too.',
    variant: 'radar',
  },
  {
    id: 'slide-2026-07-25-contract-alerts',
    title: 'Contract Scan Alerts',
    description:
      'Contract detections now trigger in-app toasts and alert sounds again — not just keyword and highlighted-user alerts.',
    variant: 'feed',
  },
  {
    id: 'slide-2026-07-25-telegram-fixes',
    title: 'Telegram & Workspace Fixes',
    description:
      'TG images and audio load in hosted mode. Room settings work from Workspace panels. Stale Telegram sessions auto-reconnect on status checks.',
    variant: 'feed',
  },
  {
    id: 'slide-2026-07-25-fomo-live-feed',
    title: 'FOMO Live Trades',
    description:
      'Individual buy/sell swaps from traders you track now stream to the live feed. Each wallet is polled once — stored once — then fanned out to everyone tracking them, including Robinhood Chain.',
    variant: 'fomo',
  },
  {
    id: 'slide-2026-07-25-radar-mentions',
    title: 'Radar Mention Window',
    description:
      'Platform shown as a dot on the token row. Mention counts use a single window column — toggle 15m, 1h, or 4h from Radar settings.',
    variant: 'radar',
  },
  {
    id: 'slide-2026-07-24-theme',
    title: 'Dark & Light Theme',
    description:
      'Toggle theme from the header. Light mode uses cream and blue accents; Feed and panes are fully themed in both modes.',
    variant: 'landing',
  },
  {
    id: 'slide-2026-07-22-portfolio',
    title: 'Portfolio Tab',
    description:
      'Birdeye wallet dashboard for My Wallets — stats, holdings, activity, PnL chart & calendar. EVM wallets aggregate across ETH, Base, and BSC automatically.',
    variant: 'portfolio',
  },
  {
    id: 'slide-2026-07-21-radar-sort',
    title: 'Sortable Radar',
    description: 'Click any column header to sort tokens. Active sort glows red — default is latest mention.',
    variant: 'radar',
  },
  {
    id: 'slide-2026-07-21-fomo-leaderboard',
    title: 'FOMO Leaderboard',
    description: 'Browse top traders on Wallets → FOMO. Track anyone in one tap from the leaderboard.',
    variant: 'fomo',
  },
  {
    id: 'slide-2026-07-20-convergence',
    title: 'Signal Convergence',
    description: 'Get alerted when a contract call and a tracked FOMO buy hit the same token within your window.',
    variant: 'convergence',
  },
  {
    id: 'slide-2026-07-20-fomo-tracking',
    title: 'FOMO Tracking',
    description: 'Follow fomo.family traders — live buy/sell feed, Pushover per trader, holder overlap on Radar.',
    variant: 'fomo',
  },
  {
    id: 'slide-2026-07-20-feed-enrichment',
    title: 'Smarter Contract Feed',
    description: 'Contract scans wait for Rick enrichment, then fall back to DexScreener so rows land with ticker and MC.',
    variant: 'feed',
  },
  {
    id: 'slide-2026-07-19-landing',
    title: 'New Landing',
    description: 'Full-screen scroll experience with a public changelog — console reskin to match.',
    variant: 'landing',
  },
  {
    id: 'slide-2026-07-14-gateway',
    title: 'Browser Discord Gateway',
    description: 'Connect Discord from your browser in hosted mode — tokens stay on your machine.',
    variant: 'gateway',
  },
];

export function formatUpdateDate(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00`);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}
