import { configStore } from '../config/store.js';
import { processDiscordMessage as processShared, type MessageProcessorContext } from '@oct/shared';
import type { GatewayManager } from '../discord/gatewayManager.js';
import type { FrontendMessage, DiscordMessage, KeywordPattern } from '../discord/types.js';

// The transform itself lives in @oct/shared. This wrapper supplies the backend's
// config source: when no ctx is passed it falls back to the local configStore
// (single-user/local mode), preserving the previous behaviour exactly.
export type { MessageProcessorContext };

export function processDiscordMessage(
  gateway: GatewayManager,
  rawMsg: DiscordMessage,
  channelName?: string,
  guildName?: string | null,
  roomKeywordPatterns?: KeywordPattern[],
  ctx?: MessageProcessorContext,
): FrontendMessage {
  const resolvedCtx: MessageProcessorContext = {
    config: ctx?.config ?? configStore.getConfig(),
    isHighlighted: ctx?.isHighlighted ?? configStore.isUserHighlighted(rawMsg.author.id),
    cacheUserName: ctx?.cacheUserName ?? ((id: string, name: string) => configStore.cacheUserName(id, name)),
  };
  return processShared(gateway, rawMsg, channelName, guildName, roomKeywordPatterns, resolvedCtx);
}
