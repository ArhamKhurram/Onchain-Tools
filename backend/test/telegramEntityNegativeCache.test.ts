import { describe, it, expect } from 'vitest';
import { Api } from 'teleproto/tl/index.js';
import { TelegramClientWrapper } from '../src/telegram/client';

/**
 * resolveChat and resolveSender cache successes forever but historically retried
 * failures on every message: a peer or sender getEntity that throws (missing
 * access hash, restricted entity) cost one network attempt per message from that
 * chat/sender, indefinitely. These tests pin failure negative-caching: one
 * attempt per TTL window, and recovery after the TTL expires.
 */

function makeWrapper() {
  const wrapper = new TelegramClientWrapper(1, 'x', '');
  const anyW = wrapper as any;
  const calls = { getEntity: 0 };
  anyW.client.getEntity = async () => {
    calls.getEntity++;
    throw new Error('Could not find the input entity');
  };
  return { anyW, calls };
}

const msgFrom = (senderId: string | null, channelId: number) => ({
  id: 1,
  date: 1_756_000_000,
  peerId: new Api.PeerChannel({ channelId: channelId as any }),
  senderId: senderId ? { toString: () => senderId } : undefined,
  replyTo: undefined,
  rawText: 'hi',
  entities: undefined,
  media: undefined,
  replyMarkup: undefined,
  fwdFrom: undefined,
});

describe('Telegram entity resolution negative cache', () => {
  it('attempts an unresolvable chat once per TTL window, not once per message', async () => {
    const { anyW, calls } = makeWrapper();

    for (let i = 0; i < 10; i++) {
      const raw = await anyW.buildRawMessage(msgFrom('777', 999));
      expect(raw).toBeNull(); // chat unresolvable -> message dropped, as before
    }

    expect(calls.getEntity).toBe(1);
  });

  it('attempts an unresolvable sender once per TTL window, keeping the Unknown fallback', async () => {
    const { anyW, calls } = makeWrapper();
    // chat resolves from cache; only the sender lookup hits the network
    anyW.chatCache.set('-100999', { id: '-100999', title: 'Trench', type: 'supergroup', username: null });

    for (let i = 0; i < 10; i++) {
      const raw = await anyW.buildRawMessage(msgFrom('777', 999));
      expect(raw.sender).toEqual({ id: '777', username: null, firstName: 'Unknown', lastName: null, photo: null });
    }

    expect(calls.getEntity).toBe(1);
  });

  it('retries after the negative-cache TTL expires', async () => {
    const { anyW, calls } = makeWrapper();
    anyW.chatCache.set('-100999', { id: '-100999', title: 'Trench', type: 'supergroup', username: null });

    await anyW.buildRawMessage(msgFrom('777', 999));
    expect(calls.getEntity).toBe(1);

    // Age the negative entry past its TTL, then a new message retries the lookup.
    for (const [k, entry] of anyW.entityFailures) {
      anyW.entityFailures.set(k, entry - 10 * 60_000);
    }
    await anyW.buildRawMessage(msgFrom('777', 999));
    expect(calls.getEntity).toBe(2);
  });
});
