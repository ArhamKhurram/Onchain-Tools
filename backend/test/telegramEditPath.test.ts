import { describe, it, expect } from 'vitest';
import { Api } from 'teleproto/tl/index.js';
import { TelegramClientWrapper } from '../src/telegram/client';

/**
 * The EditedMessage path's only consumer broadcasts {messageId, channelId, content},
 * yet buildRawMessage historically resolved the full reply/forward context — one
 * getMessages round-trip per edit of a reply-bearing message, one getEntity per
 * edit of a forwarded message. Bot channels edit stat messages continuously, so
 * that was a steady stream of discarded MTProto calls. These tests pin the edit
 * path to zero network round-trips beyond the (cached) chat/sender resolution.
 */

function makeWrapper() {
  const wrapper = new TelegramClientWrapper(1, 'x', '');
  const anyW = wrapper as any;

  // Pre-seed caches the way a live session has them after the first message.
  anyW.chatCache.set('-100999', { id: '-100999', title: 'Trench', type: 'supergroup', username: null });
  anyW.senderCache.set('777', { id: '777', username: 'bot', firstName: 'Bot', lastName: null, photo: null });

  const calls = { getMessages: 0, getEntity: 0 };
  anyW.client.getMessages = async () => {
    calls.getMessages++;
    return [{ id: 42, text: 'root message', senderId: { toString: () => '777' } }];
  };
  anyW.client.getEntity = async () => {
    calls.getEntity++;
    return new Api.User({ id: 1 as any, firstName: 'Someone' } as any);
  };
  return { anyW, calls };
}

// A reply-bearing, forwarded message — the worst-case edit event.
const editedMessage = () => ({
  id: 555,
  date: 1_756_000_000,
  peerId: new Api.PeerChannel({ channelId: 999 as any }),
  senderId: { toString: () => '777' },
  replyTo: { replyToMsgId: 42 },
  fwdFrom: { fromId: { toString: () => '1' }, fromName: 'Original Poster' },
  rawText: 'price update',
  entities: undefined,
  media: undefined,
  replyMarkup: undefined,
});

describe('Telegram edit path (skipContext)', () => {
  it('resolves a reply-bearing forwarded edit with zero network round-trips', async () => {
    const { anyW, calls } = makeWrapper();

    const raw = await anyW.buildRawMessage(editedMessage(), { skipContext: true });

    expect(raw).not.toBeNull();
    expect(raw.chatId).toBe('-100999');
    expect(raw.text).toBe('price update');
    expect(raw.replyTo).toBeNull(); // context skipped, not fetched
    expect(raw.forward).toEqual({ senderName: 'Original Poster', chatTitle: undefined });
    expect(calls.getMessages).toBe(0);
    expect(calls.getEntity).toBe(0);
  });

  it('still resolves full context on the new-message path', async () => {
    const { anyW, calls } = makeWrapper();

    const raw = await anyW.buildRawMessage(editedMessage());

    expect(raw).not.toBeNull();
    expect(raw.replyTo).toEqual({ id: 42, senderName: 'Bot', text: 'root message' });
    expect(calls.getMessages).toBe(1);
    expect(calls.getEntity).toBe(1);
  });
});
