// Canonical shared app types now live in @oct/shared. This module re-exports
// them (isolatedModules is on → every type re-export MUST use `export type`) and
// keeps the frontend-only types + const option lists that never existed on the
// backend.
import type { FrontendMessage, MissedRunnerNotifyVia, ToastPosition } from '@oct/shared';

// Workspace layout types (from @oct/shared, surfaced via ./workspace).
export type {
  WorkspaceLayout,
  WorkspaceLayoutPersisted,
  WorkspacePanelSlot,
  WorkspacePanelType,
  WorkspaceColumn,
} from './workspace';

// Shared type definitions.
export type {
  MessageSource,
  ChannelRef,
  HighlightMode,
  MessageDisplay,
  FeedChromePreset,
  SplitLayout,
  KeywordMatchMode,
  KeywordPattern,
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
  SolPlatform,
  EvmPlatform,
  ContractClickAction,
  BadgeClickAction,
  ContractLinkTemplates,
  SoundType,
  SoundConfig,
  SoundSettings,
  CallerTier,
  CallerTierEntry,
  CallerBand,
  CallerScore,
  AppConfig,
  GuildInfo,
  DMChannel,
  FrontendReaction,
  TelegramSticker,
  TelegramPoll,
  TelegramForward,
  TelegramButton,
  FrontendMessage,
  TelegramChatInfo,
  ContractEntry,
} from '@oct/shared';

// Shared runtime value.
export { PUSHOVER_SOUNDS } from '@oct/shared';

// --- Frontend-only const option lists ---

export const MISSED_RUNNER_NOTIFY_OPTIONS: { value: MissedRunnerNotifyVia; label: string; hint: string }[] = [
  { value: 'toast', label: 'Toast', hint: 'In-app popup only' },
  { value: 'pushover', label: 'Pushover', hint: 'Phone push only' },
  { value: 'both', label: 'Both', hint: 'Toast + Pushover' },
];

export const TOAST_POSITIONS: { value: ToastPosition; label: string }[] = [
  { value: 'top-left', label: 'Top left' },
  { value: 'top-center', label: 'Top center' },
  { value: 'top-right', label: 'Top right' },
  { value: 'bottom-left', label: 'Bottom left' },
  { value: 'bottom-center', label: 'Bottom center' },
  { value: 'bottom-right', label: 'Bottom right' },
  { value: 'center', label: 'Center' },
];

// --- Frontend-only types ---

export interface AuthStatus {
  configured: boolean;
  connected: boolean;
  clientGateway?: boolean;
  telegramConfigured?: boolean;
  telegramConnected?: boolean;
}

export interface MaskedToken {
  index: number;
  masked: string;
  invalid?: boolean;
}

export interface MaskedTokensResponse {
  tokens: MaskedToken[];
  count: number;
}

export interface ReactionUser {
  id: string;
  username: string;
  displayName: string;
  avatar: string | null;
  discriminator: string;
}

export interface Alert {
  id: string;
  type: 'highlighted_user' | 'contract_address' | 'keyword_match' | 'signal_convergence' | 'missed_runner' | 'fomo_trade';
  message: FrontendMessage;
  reason: string;
  timestamp: number;
}

export interface WsIncoming {
  type: 'message' | 'message_update' | 'message_delete' | 'alert' | 'reaction_update' | 'contract' | 'contract_enrichment' | 'chain_update' | 'gateway_ready' | 'telegram_ready' | 'gateway_auth_failed' | 'fomo_trade';
  data: any;
  error?: string;
  tokenIndex?: number;
  tokenInvalid?: boolean;
  tokenBlocked?: boolean;
  roomIds?: string[];
}
