// @oct/shared — code shared across the OCT workspaces (backend, frontend,
// fomo-worker). Keyword matching + contract detection logic, plus the canonical
// shared TYPE definitions (previously duplicated between backend and frontend).
// See docs/architecture/tech-debt.md and docs/roadmap/.
export { matchKeywords } from './keyword.js';
export {
  SOL_ADDRESS_REGEX,
  EVM_ADDRESS_REGEX,
  detectContractAddresses,
  isEvmAddress,
  normalizeContractAddress,
  REFERRALS,
  getPresetTemplate,
  injectReferralIntoCustomTemplate,
  buildContractUrl,
  FOMO_NETWORK_CHAIN_SLUGS,
  chainSlugFromNetworkId,
  chainKindFromNetworkId,
} from './contract.js';
export type { ContractDetectionResult } from './contract.js';
export { processDiscordMessage } from './message.js';
export type { MessageProcessorContext, MessageGateway } from './message.js';

// Bot API contract (see docs/architecture/discord-bot.md).
export type {
  BotNetworkId,
  BotTokenInfo,
  BotHolder,
  BotHoldersResponse,
  BotLeaderboardEntry,
  BotLeaderboardResponse,
  BotSnapshotResponse,
  BotTrackedTrader,
  BotTrackedResponse,
  BotWalletHolding,
  BotWalletProfile,
} from './bot.js';

// Caller quality — slop filter + earned ranking (docs/roadmap/).
export {
  MIN_RATED_CALLS,
  SLOP_MULTIPLE,
  BAND_LABELS,
  callerKey,
  parseCallerKey,
  contractCallerKey,
  resolveCallerTier,
  median,
  bandFromRates,
  scoreCaller,
  buildCallerScores,
  effectiveBand,
  callerRank,
} from './callerQuality.js';
export type {
  CallerPlatform,
  CallerBand,
  RatedCall,
  CallerScore,
  PeakLookup,
} from './callerQuality.js';

// Generated Supabase schema types (see database.types.ts header for regen).
export type { Database, Json, Tables, TablesInsert, TablesUpdate } from './database.types.js';

// Runtime consts (values) from the shared type module.
export { PUSHOVER_SOUNDS, GatewayOpcodes } from './types.js';

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
  CallerTier,
  CallerTierEntry,
  AppConfig,
  // workspace layout
  WorkspacePanelType,
  WorkspacePanelConfig,
  WorkspacePanelSlot,
  WorkspaceColumn,
  WorkspaceLayout,
  WorkspacePanelLegacy,
  WorkspaceLayoutPersisted,
  // display types
  TelegramChatInfo,
  GuildInfo,
  DMChannel,
  FrontendReaction,
  TelegramSticker,
  TelegramPoll,
  TelegramForward,
  TelegramButton,
  FrontendMessage,
  // contract log entry
  ContractEntry,
  // fomo
  FomoTrackedUser,
} from './types.js';
