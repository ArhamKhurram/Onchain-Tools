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

export type SoundType = 'highlight' | 'contractAlert' | 'keywordAlert' | 'fomoTrade';

export interface SoundConfig {
  enabled: boolean;
  volume: number;
  useCustom: boolean;
  customSoundUrl?: string;
  presetSound?: string;
}

export type SoundSettings = Record<SoundType, SoundConfig>;

// ---------------------------------------------------------------------------
// Workspace layout (persisted per user)
// ---------------------------------------------------------------------------

export type WorkspacePanelType =
  | 'room'
  | 'contracts'
  | 'radar'
  | 'fomo-feed'
  | 'fomo-leaderboard'
  | 'token-lookup';

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
