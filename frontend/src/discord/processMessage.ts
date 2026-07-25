import { processDiscordMessage as processShared, type MessageProcessorContext } from '@oct/shared';
import type { GatewayManager } from './gatewayManager';
import type { FrontendMessage, DiscordMessage, KeywordPattern } from './types';

// The transform itself lives in @oct/shared. In the browser there is no
// server-side configStore, so config MUST be injected via ctx — same behaviour
// as before (throws if it's missing).
export type { MessageProcessorContext };

export function processDiscordMessage(
  gateway: GatewayManager,
  rawMsg: DiscordMessage,
  channelName?: string,
  guildName?: string | null,
  roomKeywordPatterns?: KeywordPattern[],
  ctx?: MessageProcessorContext,
): FrontendMessage {
  if (!ctx?.config) {
    throw new Error('processDiscordMessage requires config via ctx');
  }
  const resolvedCtx: MessageProcessorContext = {
    config: ctx.config,
    isHighlighted: ctx.isHighlighted ?? false,
    cacheUserName: ctx.cacheUserName ?? (() => {}),
  };
  return processShared(gateway, rawMsg, channelName, guildName, roomKeywordPatterns, resolvedCtx);
}
