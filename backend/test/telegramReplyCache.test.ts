import { describe, it, expect } from 'vitest';
import { Api } from 'teleproto/tl/index.js';
import { TelegramClientWrapper } from '../src/telegram/client';

/**
 * Reply resolution used to cost one getMessages MTProto round-trip per
 * reply-bearing message, with no reuse: N live messages replying to the same
 * root fetched that root N times, and a 30-message history page fetched up to
 * 30 replied-to messages one at a time, serially. These tests pin the cached +
 * batched behavior: one round-trip per unique reply root on the live path, and
 * a single batched getMessages for all of a history page's reply roots.
 */

function makeWrapper() {
  const wrapper = new TelegramClientWrapper(1, 'x', '');
  const anyW = wrapper as any;

  anyW.chatCache.set('-100999', { id: '-100999', title: 'Trench', type: 'supergroup', username: null });
  anyW.senderCache.set('777', { id: '777', username: 'bot', firstName: 'Bot', lastName: null, photo: null });

  const calls: { getMessages: Array<number[] | { limit: number }> } = { getMessages: [] };
  anyW.client.getMessages = async (_peer: unknown, params: { ids?: number[]; limit?: number }) => {
    if (params.ids) {
      calls.getMessages.push(params.ids);
      return params.ids.map((id) =>
        id === 404 ? undefined : { id, text: `root ${id}`, senderId: { toString: () => '777' } },
      );
    }
    calls.getMessages.push({ limit: params.limit ?? 0 });
    return [];
  };
  return { anyW, calls };
}

const liveMessage = (id: number, replyToMsgId: number) => ({
  id,
  date: 1_756_000_000,
  peerId: new Api.PeerChannel({ channelId: 999 as any }),
  senderId: { toString: () => '777' },
  replyTo: { replyToMsgId },
  rawText: `msg ${id}`,
  entities: undefined,
  media: undefined,
  replyMarkup: undefined,
  fwdFrom: undefined,
});

describe('Telegram reply cache (live path)', () => {
  it('fetches a shared reply root once, not once per message', async () => {
    const { anyW, calls } = makeWrapper();

    for (let i = 0; i < 20; i++) {
      const raw = await anyW.buildRawMessage(liveMessage(1000 + i, 42));
      expect(raw.replyTo).toEqual({ id: 42, senderName: 'Bot', text: 'root 42' });
    }

    expect(calls.getMessages.length).toBe(1);
  });

  it('does not re-fetch a deleted reply root on every subsequent message', async () => {
    const { anyW, calls } = makeWrapper();

    for (let i = 0; i < 5; i++) {
      const raw = await anyW.buildRawMessage(liveMessage(1000 + i, 404));
      expect(raw.replyTo).toBeNull();
    }

    expect(calls.getMessages.length).toBe(1);
  });

  it('fetches distinct reply roots separately', async () => {
    const { anyW, calls } = makeWrapper();

    await anyW.buildRawMessage(liveMessage(1000, 41));
    await anyW.buildRawMessage(liveMessage(1001, 42));

    expect(calls.getMessages.length).toBe(2);
  });
});

describe('Telegram reply prefetch (history path)', () => {
  it('resolves all reply roots of a history page in one batched call', async () => {
    const { anyW, calls } = makeWrapper();

    // A 12-message history page: every message replies to one of 4 roots.
    const page = Array.from({ length: 12 }, (_, i) => {
      const m = liveMessage(2000 + i, 41 + (i % 4));
      Object.setPrototypeOf(m, Api.Message.prototype);
      return m;
    });
    anyW.client.getMessages = async (_peer: unknown, params: { ids?: number[]; limit?: number }) => {
      if (params.ids) {
        calls.getMessages.push(params.ids);
        return params.ids.map((id) => ({ id, text: `root ${id}`, senderId: { toString: () => '777' } }));
      }
      calls.getMessages.push({ limit: params.limit ?? 0 });
      return page;
    };
    anyW.client.getEntity = async () => new Api.PeerChannel({ channelId: 999 as any });

    const msgs = await anyW.fetchMessages('-100999', 12);

    expect(msgs.length).toBe(12);
    for (const m of msgs) expect(m.replyTo?.text).toMatch(/^root 4[1-4]$/);
    // 1 page fetch + 1 batched reply fetch — not 1 + 12.
    expect(calls.getMessages.length).toBe(2);
    expect(calls.getMessages[1]).toEqual([41, 42, 43, 44]);
  });
});
