// @oct/shared — code shared across the OCT workspaces (backend, frontend,
// fomo-worker). Keyword matching + contract detection logic, plus the canonical
// shared TYPE definitions (previously duplicated between backend and frontend).
// See REFACTOR.md / IDEAS.md.
export { matchKeywords } from './keyword.js';
export {
  SOL_ADDRESS_REGEX,
  EVM_ADDRESS_REGEX,
  detectContractAddresses,
  REFERRALS,
  getPresetTemplate,
  injectReferralIntoCustomTemplate,
  buildContractUrl,
} from './contract.js';
export type { ContractDetectionResult } from './contract.js';
export { processDiscordMessage } from './message.js';
export type { MessageProcessorContext, MessageGateway } from './message.js';

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
  ContractClickAction,
  BadgeClickAction,
  SoundType,
  SoundConfig,
  SoundSettings,
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
