import { detectContractAddresses } from '../utils/contract.js';
import { matchKeywords } from '../utils/keywordMatcher.js';
import type { FrontendMessage, KeywordPattern, AppConfig } from '../discord/types.js';
import type { TelegramRawMessage } from './types.js';

export interface TelegramMessageProcessorContext {
  config: AppConfig;
  isHighlighted: boolean;
  cacheUserName: (telegramUserId: string, displayName: string) => void;
}

/**
 * The channel id for a Telegram message given its group and (optional) topic.
 *
 * A topic message is scoped to ``chatId:topicId`` — the topic is a channel *within* the group, the
 * way a Discord channel sits within a guild. A non-topic message stays scoped to the group
 * (``chatId``) unchanged, so pre-topics subscriptions keep matching. Both ingestion and routing
 * MUST use this one function, or a message and its subscription would compute different ids.
 */
export function telegramChannelId(chatId: string, topicId?: number | null): string {
  return topicId != null ? `${chatId}:${topicId}` : chatId;
}

/**
 * Rooms a Telegram message routes to, filtered out of one already-loaded room
 * list.
 *
 * A topic message reaches rooms subscribed to EITHER its topic-channel OR the
 * parent group — so a "whole group" subscription still receives every topic
 * (backward-compatible), while a per-topic subscription gets just that topic.
 * Non-topic messages resolve exactly as before.
 *
 * This is a pure filter rather than two `getRoomsForChannel` calls on purpose.
 * `getRoomsForChannel` is itself just `getRooms(...)` plus a filter, so asking
 * it twice per topic message meant two loads of the same room set on the
 * hottest path in the process — which is exactly what saturated the Supabase
 * pool on 2026-09-06. One load, two predicates.
 */
export function roomsForTelegramMessage<T extends { id: string; channels: { channelId: string }[] }>(
  rooms: T[],
  chatId: string,
  topicId?: number | null,
): T[] {
  const topicChannelId = topicId != null ? telegramChannelId(chatId, topicId) : null;
  return rooms.filter((room) =>
    room.channels.some(
      (ch) => ch.channelId === chatId || (topicChannelId !== null && ch.channelId === topicChannelId),
    ),
  );
}

export function processTelegramMessage(
  raw: TelegramRawMessage,
  roomKeywordPatterns?: KeywordPattern[],
  ctx?: TelegramMessageProcessorContext,
): FrontendMessage {
  const config = ctx?.config;
  const isHighlighted = ctx?.isHighlighted ?? false;
  const cacheUserName = ctx?.cacheUserName;

  let contractResult = { hasContract: false, addresses: [] as string[] };
  if (config?.contractDetection) {
    contractResult = detectContractAddresses(raw.text);
  }

  let matchedKeywords: string[] = [];
  if (config?.keywordAlertsEnabled) {
    const allPatterns = [...(config.globalKeywordPatterns ?? []), ...(roomKeywordPatterns ?? [])];
    matchedKeywords = matchKeywords(raw.text, allPatterns);
  }

  const displayName = raw.sender.firstName +
    (raw.sender.lastName ? ` ${raw.sender.lastName}` : '');

  if (cacheUserName) {
    cacheUserName(raw.sender.id, displayName);
  }

  const attachments: FrontendMessage['attachments'] = [];
  if (raw.media) {
    attachments.push({
      id: `tg_media_${raw.id}`,
      filename: raw.media.filename,
      url: raw.media.url,
      proxy_url: raw.media.url,
      size: raw.media.size,
      content_type: raw.media.mimeType,
      width: raw.media.width,
      height: raw.media.height,
    });
  }

  const referencedMessage = raw.replyTo
    ? {
        id: raw.replyTo.id.toString(),
        author: raw.replyTo.senderName,
        content: raw.replyTo.text,
        mentions: {} as Record<string, string>,
      }
    : null;

  let platformUrl: string | undefined;
  if (raw.chatUsername) {
    platformUrl = `https://t.me/${raw.chatUsername}/${raw.id}`;
  } else if (raw.chatId.startsWith('-100')) {
    platformUrl = `https://t.me/c/${raw.chatId.slice(4)}/${raw.id}`;
  } else if (raw.chatInviteLink) {
    platformUrl = raw.chatInviteLink;
  }

  // Topic scoping mirrors Discord's guild→channel shape: the group becomes the guild, the topic
  // becomes the channel. A message with no topic stays flat (guildId null, channel = group) exactly
  // as before, so nothing about non-forum groups changes.
  const inTopic = raw.topicId != null;
  const channelId = telegramChannelId(raw.chatId, raw.topicId);
  const channelName = inTopic ? (raw.topicTitle ?? `Topic ${raw.topicId}`) : raw.chatTitle;
  const guildId = inTopic ? raw.chatId : null;
  const guildName = inTopic ? raw.chatTitle : null;

  return {
    id: `tg_${raw.chatId}_${raw.id}`,
    channelId,
    guildId,
    channelName,
    guildName,
    source: 'telegram',
    platformUrl,
    author: {
      id: raw.sender.id,
      username: raw.sender.username ?? raw.sender.firstName,
      displayName,
      avatar: raw.sender.photo,
      roleColor: null,
    },
    content: raw.text,
    timestamp: new Date(raw.date * 1000).toISOString(),
    attachments,
    embeds: [],
    isHighlighted,
    hasContractAddress: contractResult.hasContract,
    contractAddresses: contractResult.addresses,
    mentions: {},
    referencedMessage,
    matchedKeywords: matchedKeywords.length > 0 ? matchedKeywords : undefined,
    sticker: raw.sticker ?? undefined,
    poll: raw.poll ?? undefined,
    forwardFrom: raw.forward ? { name: raw.forward.senderName, chatTitle: raw.forward.chatTitle } : undefined,
    buttons: raw.buttons ?? undefined,
  };
}
