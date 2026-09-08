// @oct/shared — shared TYPE definitions used across the OCT workspaces (backend,
// frontend). These were previously duplicated (and drifting) between
// backend/src/discord/types.ts and frontend/src/types/index.ts (plus a few
// smaller files). They are moved here VERBATIM so both consumers import one
// canonical copy. See docs/architecture/tech-debt.md and docs/roadmap/.

// ---------------------------------------------------------------------------
// Discord raw gateway/REST types
// ---------------------------------------------------------------------------

export interface DiscordUser {
  id: string;
  username: string;
  discriminator: string;
  avatar: string | null;
  global_name?: string | null;
}

export interface DiscordGuild {
  id: string;
  name: string;
  icon: string | null;
}

export interface DiscordChannel {
  id: string;
  type: number;
  guild_id?: string;
  name?: string;
  recipients?: DiscordUser[];
}

export interface DiscordReaction {
  emoji: { id: string | null; name: string; animated?: boolean };
  count: number;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: DiscordUser;
  member?: { roles: string[] };
  content: string;
  timestamp: string;
  edited_timestamp?: string | null;
  attachments: DiscordAttachment[];
  embeds: DiscordEmbed[];
  mentions?: DiscordUser[];
  mention_roles?: string[];
  mention_everyone?: boolean;
  mention_channels?: { id: string; guild_id: string; name: string; type: number }[];
  referenced_message?: DiscordMessage | null;
  message_reference?: {
    message_id?: string;
    channel_id?: string;
    guild_id?: string;
  } | null;
  reactions?: DiscordReaction[];
}

export interface DiscordAttachment {
  id: string;
  filename: string;
  url: string;
  proxy_url: string;
  size: number;
  content_type?: string;
  width?: number;
  height?: number;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  thumbnail?: { url: string };
  image?: { url: string };
  author?: { name?: string; url?: string; icon_url?: string };
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string; icon_url?: string };
}

export interface GatewayPayload {
  op: number;
  d: any;
  s: number | null;
  t: string | null;
}

export const GatewayOpcodes = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

// ---------------------------------------------------------------------------
// Core app / config types
// ---------------------------------------------------------------------------

export type MessageSource = 'discord' | 'telegram';

export interface ChannelRef {
  source?: MessageSource;
  guildId: string | null;
  channelId: string;
  guildName?: string;
  channelName?: string;
  disableEmbeds?: boolean;
}

export type HighlightMode = 'background' | 'username';
export type MessageDisplay = 'default' | 'compact';
export type FeedChromePreset = 'terminal' | 'masthead' | 'rail';
export type SplitLayout = 'row' | 'grid';

export type KeywordMatchMode = 'includes' | 'exact' | 'regex';

export interface KeywordPattern {
  pattern: string;
  matchMode: KeywordMatchMode;
  isRegex?: boolean;
  label?: string;
}

export interface Room {
  id: string;
  name: string;
  channels: ChannelRef[];
  highlightedUsers: string[];
  filteredUsers: string[];
  filterEnabled: boolean;
  color?: string | null;
  keywordPatterns?: KeywordPattern[];
  highlightMode?: HighlightMode;
  highlightedUserColors?: Record<string, string>;
  hotkey?: string | null;
}

export type PushoverPriority = -2 | -1 | 0 | 1 | 2;

export const PUSHOVER_SOUNDS = [
  'pushover', 'bike', 'bugle', 'cashregister', 'classical', 'cosmic',
  'falling', 'gamelan', 'incoming', 'intermission', 'magic', 'mechanical',
  'pianobar', 'siren', 'spacealarm', 'tugboat', 'alien', 'climb',
  'persistent', 'echo', 'updown', 'vibrate', 'none',
] as const;

export type PushoverSound = (typeof PUSHOVER_SOUNDS)[number];

export interface PushoverTriggers {
  highlightedUser: boolean;
  highlightedUserContract: boolean;
  contract: boolean;
  keyword: boolean;
  signalConvergence: boolean;
  missedRunner: boolean;
}

export interface MissedRunnerConfig {
  enabled: boolean;
  minMultiplier: number;
  lookbackHours: number;
  cooldownHours: number;
  minMcAtCall?: number;
  /** How to deliver missed-runner alerts. Legacy: omit + Pushover trigger → pushover only. */
  notifyVia?: MissedRunnerNotifyVia;
}

export type MissedRunnerNotifyVia = 'toast' | 'pushover' | 'both';

export type ToastPosition =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right'
  | 'center';

/**
 * OCT bot DM alerts. Personal DMs only (see docs/architecture/discord-bot.md) — the bot
 * sends to the Discord account linked to this OCT account, so no channel config.
 *
 * NOTE: signal-convergence is intentionally absent. Those alerts are generated
 * client-side (useSignalConvergence) and never pass through the backend alert
 * broadcast, so they cannot be delivered from here yet.
 */
export interface DiscordBotTriggers {
  highlightedUser: boolean;
  highlightedUserContract: boolean;
  contract: boolean;
  keyword: boolean;
  missedRunner: boolean;
  /**
   * Product release notes. Unlike the others this is not a market signal, so it
   * is a separate opt-in rather than something bundled into the alert toggles —
   * somebody who wants contract scans in their DMs has not thereby asked for
   * changelog posts.
   */
  releaseNotes: boolean;
  /**
   * Once-a-day signal digest DM (revival alert outcomes, top pump.fun
   * callouts, caller-board movers). Like releaseNotes this is not a live
   * market signal, so it is its own opt-in — turning on alert DMs is not
   * asking for a daily summary. Default off.
   */
  dailyDigest: boolean;
  /**
   * Live pump.fun callout DMs for the callers this user follows.
   *
   * Unlike the feed triggers above, this one never fires on ambient volume:
   * a DM only happens for a caller the user explicitly followed, and the
   * follow row carries its own `notifyDiscord` mute. So it defaults ON in the
   * shipped defaults (like missedRunner) — but the master `enabled` switch
   * still gates it, and a STORED config missing this key reads as false,
   * so no existing account starts getting DMs without opting in.
   */
  pumpCallout: boolean;
}

export interface DiscordBotDmConfig {
  /** Master switch. Off by default — nobody gets DMed until they opt in. */
  enabled: boolean;
  triggers: DiscordBotTriggers;
}

export interface PushoverFilters {
  userIds: string[];
  channelIds: string[];
  guildIds: string[];
}

export interface PushoverConfig {
  enabled: boolean;
  appToken: string;
  userKey: string;
  priority: PushoverPriority;
  sound: PushoverSound;
  triggers: PushoverTriggers;
  filters: PushoverFilters;
}

export type SolPlatform = 'axiom' | 'padre' | 'bloom' | 'gmgn' | 'custom';
export type EvmPlatform = 'gmgn' | 'bloom' | 'custom';
export type ContractClickAction = 'copy' | 'copy_open' | 'open';
export type BadgeClickAction = 'discord' | 'platform' | 'both';

export interface ContractLinkTemplates {
  evm: string;
  sol: string;
  solPlatform: SolPlatform;
  evmPlatform: EvmPlatform;
}

export type SoundType = 'highlight' | 'contractAlert' | 'keywordAlert' | 'fomoTrade' | 'pumpCallout' | 'revival' | 'breakout';

export interface SoundConfig {
  enabled: boolean;
  volume: number;
  useCustom: boolean;
  customSoundUrl?: string;
  presetSound?: string;
  /**
   * Revival only: keep re-playing the sound every few seconds until the alert
   * banner is dismissed (capped client-side). Ignored by every other SoundType.
   */
  repeatUntilDismissed?: boolean;
}

export type SoundSettings = Record<SoundType, SoundConfig>;

// ---------------------------------------------------------------------------
// Revival ignition alerts (WS frame `revival_alert`)
// ---------------------------------------------------------------------------

/**
 * Payload of the `revival_alert` WS frame — a dormant token on the user's
 * radar just ignited (ATR-gate detector; see backend/src/revival/detector.ts).
 * This is its own independent signal: never fused with convergence,
 * missed-runner, or FOMO detections.
 */
export interface RevivalAlertData {
  /** Token address — a Solana mint, or an EVM contract on `network`. */
  mint: string;
  /**
   * GeckoTerminal network id the detection ran on ('solana' | 'bsc' |
   * 'robinhood'). Needed to open the token on the right chain and to re-fetch
   * its candles for outcome tracking. See REVIVAL_NETWORKS in contract.ts.
   */
  network: string;
  symbol: string | null;
  /** Last 1m close in USD, if known. */
  price: number | null;
  /** Market-cap estimate in USD (implied supply × last price), if known. */
  mcapUsd: number | null;
  /** ATR% expansion z-score vs the token's own trailing baseline. */
  atrZ: number;
  /** Last-5m volume vs trailing 24h per-5m average. */
  rvol: number;
  /**
   * Pre-ignition baseline price (median hourly close over the dormant window
   * that qualified the token), USD. Null when it could not be established.
   */
  baselinePrice: number | null;
  /**
   * price / baselinePrice at the moment of the alert — how far the token had
   * ALREADY run when it fired. Near 1x is an alert at the ignition; a large
   * value is an alert into an exhausted move, which is what the detector's run
   * gate now refuses. Surfaced so a late alert is diagnosable, not invisible.
   */
  runMultiple: number | null;
  /** ISO timestamp of the detection. */
  triggeredAt: string;
}

/**
 * Payload of the `breakout_alert` WS frame — a token that consolidated
 * QUIETLY NEAR ITS HIGHS just ignited. Same detector pass as revival; the
 * only difference is the drawdown gate: revival requires the token to have
 * died first (≥35% below its trailing peak), breakout requires that it did
 * NOT (sub-35% drawdown — the TOAD-plateau shape). Breakout is its own
 * independent signal, a sibling of revival: routed/displayed alongside it,
 * never fused with it (or with convergence / missed-runner / FOMO).
 */
export interface BreakoutAlertData extends RevivalAlertData {
  /**
   * 1 - baselinePrice / trailingPeakPrice at fire time — how little the
   * consolidation sat below the trailing peak. Always known for a breakout
   * (the gate requires it); bounded above by the revival drawdown threshold.
   */
  drawdownFromPeak: number;
}

/**
 * Which signal a persisted alert row came from. Rows written before breakout
 * existed carry no kind — absent/null means 'revival'.
 */
export type RevivalSignalKind = 'revival' | 'breakout';

/**
 * A persisted revival alert row (JSON log in local mode, `revival_alerts` in
 * hosted mode). Captures the numbers AT the moment of ignition plus the
 * outcome fields the 24h tracker fills in afterwards — so a missed alert can
 * be reviewed later ("it fired at $412K mcap and peaked at 3.1×").
 *
 * Breakout alerts share this table/shape (they differ only in the drawdown
 * gate), discriminated by `kind`.
 */
export interface RevivalAlertEntry {
  id: string;
  /**
   * Signal kind the row was fired by. Optional/null on rows written before
   * breakout existed — treat absent as 'revival'.
   */
  kind?: RevivalSignalKind | null;
  /** Token address — a Solana mint, or an EVM contract on `network`. */
  mint: string;
  symbol: string | null;
  /** GeckoTerminal network id the detection ran on ('solana' | 'bsc' | 'robinhood'). */
  network: string;
  /** Price at the moment the alert fired (last 1m close, USD). */
  priceUsd: number | null;
  /** Market-cap estimate at the moment the alert fired (USD). */
  mcapUsd: number | null;
  atrZ: number;
  rvol: number;
  /** Pre-ignition baseline price the run gate measured against (USD). */
  baselinePriceUsd: number | null;
  /** priceUsd / baselinePriceUsd at fire time — how far it had already run. */
  runMultiple: number | null;
  /**
   * 1 - baselinePriceUsd / trailing-peak price, as the detector measured it at
   * fire time — the label the drawdown knobs are calibrated from (the
   * detector's docs say to move `breakout.minDrawdownFloor` /
   * `minDrawdownFromPeak` only with labeled cases in hand, and this log IS the
   * labeled-case set). Breakout rows always carry a measured value in
   * [breakout floor, revival threshold); revival rows carry ≥ the threshold,
   * or null when the gate abstained (missing history). Absent on rows written
   * before the column existed.
   */
  drawdownFromPeak?: number | null;
  /** ISO timestamp of the detection. */
  triggeredAt: string;
  // ---- Outcome (filled by the 24h tracker; peak state lives in the row so
  // ---- tracking survives restarts) ----
  /** Highest price observed since the alert (USD). */
  peakPriceUsd: number | null;
  /** Market-cap at the peak price (USD). */
  peakMcapUsd: number | null;
  /** peakPriceUsd / priceUsd-at-alert. */
  peakMultiple: number | null;
  /** ISO timestamp of the peak observation. */
  peakAt: string | null;
  /** Set once the 24h outcome window ends; null while still tracking. */
  outcomeWindowClosedAt: string | null;
}

/** Partial outcome update written by the tracker (only on improvement/close). */
export type RevivalOutcomePatch = Partial<
  Pick<
    RevivalAlertEntry,
    'peakPriceUsd' | 'peakMcapUsd' | 'peakMultiple' | 'peakAt' | 'outcomeWindowClosedAt'
  >
>;

// ---------------------------------------------------------------------------
// Trade journal (the operator's OWN wallets — distinct from tracked/copy
// wallets). Solana only in v1. See backend/src/journal/.
// ---------------------------------------------------------------------------

/**
 * A wallet the user journals their own trading from. Distinct from
 * user_tracked_wallets (other people's wallets watched for movement) and
 * user_holding_wallets (Portfolio's Birdeye views) — the journal ingests raw
 * swaps via Helius and pairs them into positions itself.
 */
export interface JournalWallet {
  id: string;
  address: string;
  label: string | null;
  /** Solana only in v1. */
  chain: 'solana';
  /**
   * Ingestion cursor: the newest tx signature already ingested. Null until the
   * first poll completes (which triggers the capped history backfill).
   */
  lastSignature: string | null;
  /** When the poller last completed a cycle for this wallet. */
  lastPolledAt: string | null;
  createdAt: string;
}

export type JournalTradeSide = 'buy' | 'sell';

/**
 * One normalized swap leg from a journal wallet. Derived from
 * wallet-perspective balance deltas (NOT Helius events.swap, which is
 * unreliable on Jupiter routes) — see backend/src/journal/normalize.ts.
 */
export interface JournalTrade {
  id: string;
  walletId: string;
  walletAddress: string;
  mint: string;
  symbol: string | null;
  side: JournalTradeSide;
  /** Token quantity moved (always positive). */
  amountToken: number;
  /**
   * SOL paid (buy) / received (sell), fee-adjusted. Null when the tx paid or
   * received a stablecoin instead, or when the SOL split of a multi-token
   * route could not be attributed.
   */
  amountSol: number | null;
  /** USD value of the native leg (stable face value, or SOL × daily price). */
  amountUsd: number | null;
  txSignature: string;
  /** Helius `source` (JUPITER, PUMP_FUN, RAYDIUM, …) when known. */
  dex: string | null;
  /** ISO timestamp of the transaction. */
  ts: string;
}

export type JournalPositionStatus = 'open' | 'closed';

/**
 * Why an episode closed.
 * - `sold`      — the normal FIFO dust close (≤2% of acquired remains).
 * - `abandoned` — auto-closed as a dead bag: unsellable and untouched for
 *   days, booked as a sale at ZERO proceeds (backend/src/journal/abandoned.ts).
 * Null on open episodes and on rows written before the close_reason column.
 */
export type JournalCloseReason = 'sold' | 'abandoned';

/**
 * A FIFO trade episode per (wallet, token): opens on the first buy from flat,
 * closes when the remaining balance falls under the dust threshold (2% of
 * total acquired). Realized PnL accrues on each sell against FIFO lots.
 */
export interface JournalPosition {
  /** Deterministic: `${walletId}|${mint}|${openedAt}` — recomputes stably. */
  id: string;
  walletId: string;
  walletAddress: string;
  mint: string;
  symbol: string | null;
  status: JournalPositionStatus;
  /** Total tokens bought over the episode. */
  acquiredToken: number;
  /** Tokens still held (≤ dust threshold once closed). */
  remainingToken: number;
  /** Total SOL spent on buys (known legs only). */
  costSol: number;
  /** Total USD spent on buys (known legs only). */
  costUsd: number | null;
  realizedPnlSol: number;
  realizedPnlUsd: number | null;
  /**
   * True when some leg lacked a SOL/USD value (stable-paid, token-to-token
   * route, missing price) — realized PnL then under-reports that leg.
   */
  pnlIncomplete: boolean;
  openedAt: string;
  closedAt: string | null;
  /** Null while open; null on pre-migration rows (the column is optional). */
  closeReason: JournalCloseReason | null;
  lastTradeAt: string;
  /** Last DexScreener price observed for the mint (volume poller side-writes). */
  lastPriceUsd: number | null;
  lastPriceAt: string | null;
}

/**
 * Payload of the `journal_alert` WS frame. v1 has one kind: `volume_dying` —
 * an OPEN journal position whose market volume is collapsing (m5 rate < ratio
 * × h1 rate AND h1 rate < ratio × h6 rate) while the operator still holds.
 * This is its own independent signal: never fused with revival/breakout/
 * convergence/missed-runner/FOMO detections.
 */
export interface JournalAlertData {
  kind: 'volume_dying';
  mint: string;
  symbol: string | null;
  walletAddress: string;
  /** Rolling DexScreener volume windows (USD, summed across pairs). */
  m5VolumeUsd: number;
  h1VolumeUsd: number;
  h6VolumeUsd: number;
  /** Per-minute m5 rate ÷ per-minute h1 rate at fire time. */
  m5RateVsH1: number;
  /** Per-minute h1 rate ÷ per-minute h6 rate at fire time. */
  h1RateVsH6: number;
  /** remainingToken × last price, when a price was available. */
  positionValueUsd: number | null;
  triggeredAt: string;
}

/** One calendar day of realized PnL (journal day list). */
export interface JournalDayRow {
  /** YYYY-MM-DD (UTC). */
  date: string;
  trades: number;
  realizedPnlSol: number;
  realizedPnlUsd: number | null;
}

/** One point of the cumulative realized PnL curve (per realizing sell). */
export interface JournalCurvePoint {
  ts: string;
  cumSol: number;
  cumUsd: number | null;
}

/**
 * Header stats + curve + day list for the Journal tab. The drawdown fields are
 * the give-back meter: how far cumulative realized PnL sits below its
 * all-time high — the run-up→give-back cycle made visible.
 */
export interface JournalSummary {
  totalTrades: number;
  realized7dSol: number;
  realized7dUsd: number | null;
  /** Closed episodes with realizedPnlSol > 0 ÷ all closed episodes (0..1). */
  winRate: number | null;
  closedEpisodes: number;
  openEpisodes: number;
  cumRealizedSol: number;
  cumRealizedUsd: number | null;
  peakCumRealizedSol: number;
  /** peak − current cumulative realized PnL, ≥ 0. THE give-back meter. */
  drawdownFromPeakSol: number;
  drawdownFromPeakUsd: number | null;
  curve: JournalCurvePoint[];
  days: JournalDayRow[];
}

// ---------------------------------------------------------------------------
// Price alerts (operator-set levels; WS frame `price_alert`)
// ---------------------------------------------------------------------------

/** Which side of the target counts as a crossing. */
export type PriceAlertDirection = 'above' | 'below';

/**
 * What the target is measured in. `mcap` is the default because the operator
 * thinks in market caps ("buy FTR at 100-150K"); `price` is the per-token USD
 * price for anyone who prefers it.
 */
export type PriceAlertMetric = 'mcap' | 'price';

/**
 * `armed` — watching. `fired` — the crossing happened, one-shot, done.
 * `disabled` — reserved: parked without deleting (no v1 UI writes it, but the
 * poller already skips it, so a future toggle needs no migration).
 */
export type PriceAlertStatus = 'armed' | 'fired' | 'disabled';

/**
 * One operator-declared level on one token.
 *
 * This is the deliberate INVERSE of revival/breakout: no detection, no
 * scoring, no discovery. The operator names the token and the number; the
 * poller only reports the crossing. It stays its own independent signal and is
 * never fused with revival, breakout, convergence, FOMO or missed-runner.
 */
export interface PriceAlert {
  id: string;
  /** Solana only in v1 — the column exists so other chains need no migration. */
  chain: string;
  /** Token address (Solana mint in v1). */
  mint: string;
  /** Symbol as last observed upstream, or whatever the operator typed. */
  symbol: string | null;
  direction: PriceAlertDirection;
  /** The level, in USD, measured in `metric`. */
  targetUsd: number;
  metric: PriceAlertMetric;
  status: PriceAlertStatus;
  /** Why this level matters — free text, echoed back in the alert. */
  note: string | null;
  /**
   * Last value observed by the poller, in `metric`'s units. NULL means never
   * observed: the FIRST observation only records (see crossing.ts), so an
   * alert created on a token already past its target cannot fire instantly.
   */
  lastSeenUsd: number | null;
  lastSeenAt: string | null;
  firedAt: string | null;
  /** Value at the moment of firing (what the toast/Pushover reported). */
  firedValueUsd: number | null;
  createdAt: string;
}

/**
 * Payload of the `price_alert` WS frame — an operator-set level was crossed.
 * Normal loudness (toast + notification history); the emergency tier stays
 * revival-only.
 */
export interface PriceAlertData {
  alertId: string;
  mint: string;
  chain: string;
  symbol: string | null;
  direction: PriceAlertDirection;
  metric: PriceAlertMetric;
  targetUsd: number;
  /** Observed value that crossed the target, same units as `targetUsd`. */
  valueUsd: number;
  /** Previous observation — the value the crossing came FROM. */
  previousUsd: number | null;
  note: string | null;
  triggeredAt: string;
}

// ---------------------------------------------------------------------------
// Workspace layout (persisted per user)
// ---------------------------------------------------------------------------

export type WorkspacePanelType =
  | 'room'
  | 'contracts'
  | 'top-callers-feed'
  | 'radar'
  | 'fomo-feed'
  | 'fomo-leaderboard'
  | 'token-lookup'
  | 'pump-following'
  | 'pump-callout-feed'
  | 'pump-top-callers'
  | 'pump-leaderboard';

export interface WorkspacePanelConfig {
  roomId?: string;
}

/** A widget slot inside a column stack. */
export interface WorkspacePanelSlot {
  id: string;
  type: WorkspacePanelType;
  config?: WorkspacePanelConfig;
}

export interface WorkspaceColumn {
  id: string;
  panels: WorkspacePanelSlot[];
}

/** Column-stack layout (v2) — fills viewport, resizable splits. */
export interface WorkspaceLayout {
  version: 2;
  columns: WorkspaceColumn[];
}

/** Legacy free-grid panel (v1) — migrated on load. */
export interface WorkspacePanelLegacy {
  id: string;
  type: WorkspacePanelType;
  x: number;
  y: number;
  w: number;
  h: number;
  config?: WorkspacePanelConfig;
}

export type WorkspaceLayoutPersisted = WorkspaceLayout | WorkspacePanelLegacy[];

export type CallerTier = 'muted' | 'normal' | 'trusted';

/** A manual caller-quality override. See `callerQuality.ts` for how it resolves. */
export interface CallerTierEntry {
  /** Canonical `discord:<id>` / `telegram:<id>` key. */
  key: string;
  displayName: string;
  tier: CallerTier;
  /** Omitted = applies everywhere. A room entry beats a global one. */
  roomId?: string;
  note?: string;
}

/**
 * One threshold→emoji marker on the Radar's × column. See `radarEmoji.ts` for
 * the matching rules (highest threshold wins) and the sanitiser.
 */
export interface RadarMultipleEmojiRule {
  /** Multiple at or above which this rule applies (3 = "3x and up"). */
  threshold: number;
  /** The glyph rendered beside the multiple. */
  emoji: string;
}

/**
 * Reserved `hiddenUsers` bucket for a user hidden across *every* channel rather
 * than one `guildId:channelId`. Real keys are always `<guildId|'null'>:<channelId>`
 * — both halves are snowflake/numeric ids — so a bare `*` can never collide.
 */
export const GLOBAL_HIDDEN_USERS_KEY = '*';

export interface AppConfig {
  discordTokens: string[];
  rooms: Room[];
  globalHighlightedUsers: string[];
  contractDetection: boolean;
  guildColors: Record<string, string>;
  dmColors: Record<string, string>;
  telegramColors: Record<string, string>;
  enabledGuilds: string[];
  evmAddressColor: string;
  solAddressColor: string;
  openInDiscordApp: boolean;
  openInTelegramApp: boolean;
  /**
   * Users whose messages are filtered out of the feed, keyed by
   * `<guildId|'null'>:<channelId>` — plus the reserved `GLOBAL_HIDDEN_USERS_KEY`
   * bucket for "hide everywhere".
   */
  hiddenUsers: Record<string, { userId: string; displayName: string }[]>;
  /**
   * Caller quality tiers (see `callerQuality.ts`). Manual overrides on top of
   * the earned score — an entry with no `roomId` applies everywhere.
   */
  callerTiers?: CallerTierEntry[];
  /** Show muted callers' contracts collapsed rather than hiding them outright. */
  callerTierShowMuted?: boolean;
  /** Rank the contract feed and Radar by caller quality instead of time only. */
  callerQualityRanking?: boolean;
  /**
   * Extra authors kept out of earned scoring, on top of the known bots in
   * `DEFAULT_EXCLUDED_CALLERS`. Each entry is a caller key (`discord:123`) or a
   * display name. Scoring-only — an excluded author's messages and enrichment
   * are unaffected, which is what makes this the right tool for a bot and the
   * mute tier the wrong one.
   */
  callerScoreExclusions?: string[];
  /**
   * Threshold→emoji markers beside the Radar's × column. Absent = the shipped
   * defaults (3x 🧊, 5x 🔥); an explicit empty array = markers off. Highest
   * matching threshold wins, so a 6x row shows one emoji, not two.
   */
  radarMultipleEmojiRules?: RadarMultipleEmojiRule[];
  messageSounds: boolean;
  soundSettings: SoundSettings;
  channelSounds: Record<string, SoundConfig>;
  pushover: PushoverConfig;
  missedRunner: MissedRunnerConfig;
  /** OCT Discord bot DM alerts (opt-in). */
  discordBotDm?: DiscordBotDmConfig;
  contractLinkTemplates: ContractLinkTemplates;
  contractClickAction: ContractClickAction;
  showFullContractAddress: boolean;
  autoOpenHighlightedContracts: boolean;
  /** Minutes within which a FOMO buy + contract call count as signal convergence. */
  signalConvergenceWindowMinutes: number;
  globalKeywordPatterns: KeywordPattern[];
  keywordAlertsEnabled: boolean;
  desktopNotifications: boolean;
  toastAlertsEnabled: boolean;
  toastPosition: ToastPosition;
  mentionsUserEnabled: boolean;
  mentionsRoleEnabled: boolean;
  mentionsHereEnabled: boolean;
  mentionsEveryoneEnabled: boolean;
  badgeClickAction: BadgeClickAction;
  userNameCache: Record<string, string>;
  chattingEnabled: boolean;
  messageDisplay: MessageDisplay;
  /** Which chrome layout the Feed renders around the message list. */
  feedChromePreset?: FeedChromePreset;
  compactModeAvatars: boolean;
  roleColors: boolean;
  mobileZoomScale: number;
  splitLayout: SplitLayout;
  paneRoomIds: string[];
  paneLocks: boolean[];
  gridMirror: boolean;
  /** Custom workspace tab layout (column stacks, persisted per user). */
  workspaceLayout?: WorkspaceLayoutPersisted;
  seenAnnouncements: string[];
  telegramApiId?: string;
  telegramApiHash?: string;
  telegramSessions?: string[];
  // Optional HTTP/HTTPS proxy for the Discord gateway + REST connection. Local
  // mode only — lets VPN-blocked users route Discord traffic through a proxy.
  discordProxyUrl?: string;
}

// ---------------------------------------------------------------------------
// Discord / Telegram display types
// ---------------------------------------------------------------------------

export interface TelegramChatInfo {
  id: string;
  title: string;
  type: 'user' | 'group' | 'supergroup' | 'channel';
  photo?: string | null;
  /** Topic-enabled (forum) supergroup — its topics are separately subscribable. */
  isForum?: boolean;
}

/** One forum topic of a topic-enabled Telegram supergroup (GET /telegram/chats/:id/topics). */
export interface TelegramForumTopicInfo {
  id: number;
  title: string;
  closed?: boolean;
}

export interface GuildInfo {
  id: string;
  name: string;
  icon: string | null;
  channels: { id: string; name: string; type: number }[];
}

export interface DMChannel {
  id: string;
  recipients: { id: string; username: string; global_name?: string | null; avatar: string | null }[];
}

export interface FrontendReaction {
  emoji: { id: string | null; name: string; animated?: boolean };
  count: number;
}

export interface TelegramSticker {
  url: string;
  emoji?: string;
  isAnimated?: boolean;
}

export interface TelegramPoll {
  question: string;
  options: { text: string; voters: number }[];
}

export interface TelegramForward {
  name: string;
  chatTitle?: string;
}

export interface TelegramButton {
  text: string;
  url: string;
}

export interface FrontendMessage {
  id: string;
  channelId: string;
  guildId: string | null;
  channelName: string;
  guildName: string | null;
  source?: MessageSource;
  author: {
    id: string;
    username: string;
    displayName: string;
    avatar: string | null;
    roleColor?: string | null;
  };
  content: string;
  timestamp: string;
  attachments: DiscordAttachment[];
  embeds: DiscordEmbed[];
  isHighlighted: boolean;
  hasContractAddress: boolean;
  contractAddresses: string[];
  mentions: Record<string, string>;
  mentionTypes?: ('user' | 'role' | 'here' | 'everyone')[];
  referencedMessage?: {
    id: string;
    author: string;
    content: string;
    mentions: Record<string, string>;
  } | null;
  reactions?: FrontendReaction[];
  matchedKeywords?: string[];
  platformUrl?: string;
  sticker?: TelegramSticker;
  poll?: TelegramPoll;
  forwardFrom?: TelegramForward;
  buttons?: TelegramButton[];
  isEdited?: boolean;
  originalContent?: string;
  editedTimestamp?: string | null;
  isDeleted?: boolean;
}

// ---------------------------------------------------------------------------
// Contract log entry
// ---------------------------------------------------------------------------

export interface ContractEntry {
  address: string;
  chain: 'evm' | 'sol';
  evmChain?: string;
  authorId: string;
  authorName: string;
  channelId: string;
  channelName: string;
  guildId: string | null;
  guildName: string | null;
  roomIds: string[];
  messageId: string;
  timestamp: string;
  source?: 'discord' | 'telegram';
  firstSeen?: boolean;
  /**
   * True when this entry is a RE-DELIVERY of a call that was already logged —
   * the same (userId, messageId, address) reaching ingest a second time
   * because the Telegram update stream replayed the message after a reconnect
   * or an update-gap recovery.
   *
   * `logContract` suppresses the duplicate ROW (#368) and returns the stored
   * one, but ingest still broadcasts what it gets back, so the console needs
   * to be told the difference. Transport-level, not persisted: no `contracts`
   * column backs it, and it is never set on anything read out of storage.
   *
   * A flagged entry is not a new observation of anything — it carries the
   * original call's timestamp and enrichment — so the feed drops it outright
   * rather than folding it into the address's rescan group. Counting a
   * re-delivery as a "scan" would re-introduce, in the ×N badge, exactly the
   * inflation #368 removed from the database.
   */
  duplicate?: boolean;
  // Enrichment (Rick embed / DexScreener)
  tokenName?: string;
  tokenSymbol?: string;
  tokenPair?: string;
  description?: string;
  fdvAtCall?: number;
  fdvAtCallDisplay?: string;
  liquidityUsd?: number;
  liquidityDisplay?: string;
  volumeUsd?: number;
  volumeDisplay?: string;
  priceUsd?: number;
  tokenAge?: string;
  enrichmentSource?: 'rick' | 'dexscreener' | 'gmgn';
  enrichedAt?: string;
  // Global first call (Rick's cross-server footer: "espadabtw @ 49.3K · 86x · 10h").
  // Point-in-time like fdvAtCall: once recorded, an earlier reading always wins.
  firstCallerName?: string;
  firstCallMcapUsd?: number;
  /** Absolute timestamp of the global first call (message time minus Rick's relative age). */
  firstCallAt?: string;
  // ---- Token peak (joined at read time from the global token_peaks store;
  // ---- never persisted on the contract row itself). The peak is the highest
  // ---- market cap OCT has *observed* for the token since it was first seen
  // ---- called — sampled, so a floor for the true ATH, never an exact figure.
  peakMc?: number;
  /** ISO timestamp of the observation that set `peakMc`. */
  peakAt?: string;
}

// ---------------------------------------------------------------------------
// FOMO tracked user (mirrors backend fomo_tracked_users row)
// ---------------------------------------------------------------------------

export interface FomoTrackedUser {
  id: string;
  user_id: string;
  fomo_user_id: string;
  fomo_handle: string | null;
  display_name: string | null;
  notify_pushover: boolean;
  created_at: string;
}
