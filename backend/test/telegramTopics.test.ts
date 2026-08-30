import { describe, it, expect } from 'vitest';
import { extractTopicId, isGenuineReply } from '../src/telegram/client';
import { processTelegramMessage, telegramChannelId } from '../src/telegram/messageProcessor';
import type { TelegramRawMessage } from '../src/telegram/types.js';
import type { AppConfig } from '../src/discord/types.js';

// The functions under test only read forumTopic / replyToTopId / replyToMsgId, so a minimal
// object cast to the header type exercises them without a live MTProto message.
const header = (over: Record<string, unknown>) => over as unknown as Parameters<typeof extractTopicId>[0];

describe('extractTopicId', () => {
  it('returns null when there is no reply header', () => {
    expect(extractTopicId(undefined)).toBeNull();
  });

  it('returns null for a plain reply in a non-forum group', () => {
    expect(extractTopicId(header({ replyToMsgId: 42 }))).toBeNull();
  });

  it('uses replyToTopId for a reply inside a topic', () => {
    expect(extractTopicId(header({ forumTopic: true, replyToTopId: 7, replyToMsgId: 99 }))).toBe(7);
  });

  it('falls back to replyToMsgId for a top-level topic post (the topic root)', () => {
    expect(extractTopicId(header({ forumTopic: true, replyToMsgId: 7 }))).toBe(7);
  });
});

describe('isGenuineReply', () => {
  it('is false with no reply header', () => {
    expect(isGenuineReply(undefined)).toBe(false);
  });

  it('is true for an ordinary reply outside a forum', () => {
    expect(isGenuineReply(header({ replyToMsgId: 42 }))).toBe(true);
  });

  it('is false for a top-level topic post (replyToMsgId is the topic root, not a reply)', () => {
    expect(isGenuineReply(header({ forumTopic: true, replyToMsgId: 7 }))).toBe(false);
  });

  it('is true for a real reply inside a topic (has replyToTopId as well)', () => {
    expect(isGenuineReply(header({ forumTopic: true, replyToTopId: 7, replyToMsgId: 99 }))).toBe(true);
  });
});

describe('telegramChannelId', () => {
  it('scopes to the group when there is no topic', () => {
    expect(telegramChannelId('-100123', null)).toBe('-100123');
    expect(telegramChannelId('-100123', undefined)).toBe('-100123');
  });

  it('scopes to chatId:topicId inside a topic', () => {
    expect(telegramChannelId('-100123', 7)).toBe('-100123:7');
  });
});

const config = { contractDetection: false, keywordAlertsEnabled: false } as AppConfig;

const rawMsg = (over: Partial<TelegramRawMessage> = {}): TelegramRawMessage => ({
  id: 55,
  chatId: '-100999',
  chatTitle: 'SOL Algorithm',
  chatType: 'supergroup',
  sender: { id: 'u1', username: 'trencher', firstName: 'Trench', lastName: null, photo: null },
  text: 'gm',
  date: 1_756_000_000,
  ...over,
});

describe('processTelegramMessage — topic mapping', () => {
  it('maps a topic message to the Discord-style guild→channel shape', () => {
    const msg = processTelegramMessage(rawMsg({ topicId: 7, topicTitle: 'EVM Algorithm' }), undefined, {
      config,
      isHighlighted: false,
      cacheUserName: () => {},
    });
    expect(msg.guildId).toBe('-100999'); // the group is the guild
    expect(msg.guildName).toBe('SOL Algorithm');
    expect(msg.channelId).toBe('-100999:7'); // the topic is the channel
    expect(msg.channelName).toBe('EVM Algorithm');
  });

  it('falls back to "Topic <id>" when the title is not yet resolved', () => {
    const msg = processTelegramMessage(rawMsg({ topicId: 7, topicTitle: null }), undefined, {
      config,
      isHighlighted: false,
      cacheUserName: () => {},
    });
    expect(msg.channelName).toBe('Topic 7');
    expect(msg.channelId).toBe('-100999:7');
  });

  it('leaves a non-topic message flat (guildId null, channel = group) — backward compatible', () => {
    const msg = processTelegramMessage(rawMsg({ topicId: null }), undefined, {
      config,
      isHighlighted: false,
      cacheUserName: () => {},
    });
    expect(msg.guildId).toBeNull();
    expect(msg.guildName).toBeNull();
    expect(msg.channelId).toBe('-100999');
    expect(msg.channelName).toBe('SOL Algorithm');
  });
});
