// @oct/shared — code shared across the OCT workspaces (backend, frontend,
// fomo-worker). Keyword matching + contract detection logic, plus the canonical
// shared TYPE definitions (previously duplicated between backend and frontend).
// See docs/architecture/tech-debt.md and docs/roadmap/.
export { matchKeywords } from './keyword.js';
export {
  SOL_ADDRESS_REGEX,
  detectContractAddresses,
  isEvmAddress,
  normalizeContractAddress,
  REFERRALS,
  buildContractUrl,
  chainSlugFromNetworkId,
  chainKindFromNetworkId,
  REVIVAL_NETWORKS,
  REVIVAL_NETWORK_CHAIN_SLUGS,
  isRevivalNetwork,
  revivalNetworkForChain,
  revivalNetworkLabel,
  buildRevivalContractUrl,
  buildAxiomEvmUrl,
} from './contract.js';
export type { ContractDetectionResult, RevivalNetwork } from './contract.js';
// Radar × column emoji markers (threshold ladder, highest match wins).
export {
  DEFAULT_RADAR_MULTIPLE_EMOJI_RULES,
  MAX_RADAR_EMOJI_RULES,
  MAX_RADAR_EMOJI_LENGTH,
  sanitizeRadarEmoji,
  sanitizeRadarEmojiRules,
  resolveRadarEmojiRules,
  radarEmojiForMultiple,
} from './radarEmoji.js';

export { processDiscordMessage } from './message.js';
export type { MessageProcessorContext } from './message.js';

// Discord forwards — a forwarded body lives in `message_snapshots`, not
// `content`. Read forward.ts before touching anything that scans message text.
export {
  MESSAGE_REFERENCE_DEFAULT,
  MESSAGE_REFERENCE_FORWARD,
  isForwardReference,
  forwardedParts,
  contentWithForward,
  embedsWithForward,
} from './forward.js';
export type { ForwardedParts } from './forward.js';

// Effective Discord channel permissions — the Room Settings picker must only
// offer channels the signed-in user can actually view. Shared because both
// gateways build that list: the server one in local mode, the browser one in
// hosted mode.
export {
  PERMISSION_ADMINISTRATOR,
  PERMISSION_VIEW_CHANNEL,
  OVERWRITE_TYPE_ROLE,
  OVERWRITE_TYPE_MEMBER,
  FEED_CHANNEL_TYPES,
  isFeedChannelType,
  toBits,
  computeBasePermissions,
  computeChannelPermissions,
  canViewChannel,
  buildGuildPermissionContext,
  filterPickableChannels,
} from './discordPermissions.js';
export type {
  PermissionOverwrite,
  GuildMemberPermissionContext,
  ChannelPermissionInput,
} from './discordPermissions.js';
export {
  readGuildChannels,
  readSelfMemberRoleIds,
  readGuildPermissionSnapshot,
  mergedMembersAt,
} from './discordGuildPayload.js';
export type { RawGuildChannel, GuildPermissionSnapshot } from './discordGuildPayload.js';

// Recently-seen Discord message cache (reply/reference preview resolution).
export { cacheDiscordMessage, lookupCachedMessage } from './messageReplyCache.js';

// Shared number formatting. usd/compactUsd/shortAddress are the transport-agnostic
// card formatters shared by the Discord bot (bot/layout.ts) and the Telegram bot
// (tgbot/render.ts).
export { formatCompact, usd, compactUsd, shortAddress } from './format.js';

// Bot API contract (see docs/architecture/discord-bot.md).
export type {
  BotNetworkId,
  BotTokenInfo,
  BotHolder,
  BotHoldersResponse,
  BotThesisEntry,
  BotThesesResponse,
  BotLeaderboardResponse,
  BotSnapshotResponse,
  BotTrackedResponse,
  BotWalletProfile,
  BotSwapDirection,
  BotTraderSwap,
  BotTraderTransfer,
  BotTraderActivityEntry,
  BotTraderActivitySummary,
  BotTraderActivityResponse,
} from './bot.js';

// Caller quality — slop filter + earned ranking (docs/roadmap/).
export {
  MIN_RATED_CALLS,
  SLOP_MULTIPLE,
  BAND_LABELS,
  DEFAULT_EXCLUDED_CALLERS,
  normalizeCallerName,
  isExcludedCaller,
  isExcludedCallerKey,
  callerKey,
  parseCallerKey,
  contractCallerKey,
  resolveCallerTier,
  median,
  bandFromRates,
  scoreCaller,
  buildCallerScores,
  buildRoomCallerScores,
  pickRoomScore,
  effectiveBand,
  callerRank,
  foldCallerCalls,
  rateCall,
  scoreFromAggregate,
  splitCallerAggregates,
} from './callerQuality.js';
export type {
  CallerBand,
  RatedCall,
  CallerScore,
  RoomCallerScores,
  CallerCall,
  CallerAggregateRow,
} from './callerQuality.js';

// Generated Supabase schema types (see database.types.ts header for regen).
export type { Database, Json, Tables, TablesInsert, TablesUpdate } from './database.types.js';

// Runtime consts (values) from the shared type module.
export { PUSHOVER_SOUNDS, GatewayOpcodes, GLOBAL_HIDDEN_USERS_KEY } from './types.js';

// Shared type definitions.
export type {
  // keyword
  KeywordPattern,
  KeywordMatchMode,
  // contract link templates
  ContractLinkTemplates,
  SolPlatform,
  EvmPlatform,
  // Discord raw types
  DiscordUser,
  DiscordGuild,
  DiscordChannel,
  DiscordReaction,
  DiscordMessage,
  DiscordMessageSnapshot,
  DiscordAttachment,
  DiscordEmbed,
  GatewayPayload,
  // core app/config types
  MessageSource,
  ChannelRef,
  HighlightMode,
  MessageDisplay,
  FeedChromePreset,
  SplitLayout,
  Room,
  PushoverPriority,
  PushoverSound,
  PushoverTriggers,
  MissedRunnerConfig,
  MissedRunnerNotifyVia,
  ToastPosition,
  PushoverFilters,
  PushoverConfig,
  DiscordBotTriggers,
  DiscordBotDmConfig,
  ContractClickAction,
  BadgeClickAction,
  SoundType,
  SoundConfig,
  SoundSettings,
  RevivalAlertData,
  BreakoutAlertData,
  RevivalSignalKind,
  RevivalAlertEntry,
  RevivalOutcomePatch,
  // trade journal
  JournalWallet,
  JournalTrade,
  JournalTradeSide,
  JournalPosition,
  JournalPositionStatus,
  JournalCloseReason,
  JournalAlertData,
  JournalDayRow,
  JournalCurvePoint,
  JournalSummary,
  // price alerts (operator-set levels)
  PriceAlert,
  PriceAlertDirection,
  PriceAlertMetric,
  PriceAlertStatus,
  PriceAlertData,
  CallerTier,
  CallerTierEntry,
  RadarMultipleEmojiRule,
  AppConfig,
  // workspace layout
  WorkspacePanelType,
  EverythingFeedKind,
  WorkspacePanelConfig,
  WorkspacePanelSlot,
  WorkspaceColumn,
  WorkspaceLayout,
  WorkspacePanelLegacy,
  WorkspaceLayoutPersisted,
  // display types
  TelegramChatInfo,
  TelegramForumTopicInfo,
  GuildInfo,
  DMChannel,
  FrontendReaction,
  TelegramSticker,
  TelegramPoll,
  TelegramForward,
  TelegramButton,
  ForwardedMessage,
  FrontendMessage,
  // contract log entry
  ContractEntry,
  // fomo
  FomoTrackedUser,
} from './types.js';
