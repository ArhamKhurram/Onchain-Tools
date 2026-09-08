import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { EventEmitter } from 'events';
import { TelegramClientManager } from '../src/telegram/clientManager';
import type { TelegramRawMessage } from '../src/telegram/types.js';

/**
 * One Telegram message must reach the ingest handler once, however many times
 * the update stream delivers it.
 *
 * teleproto replays a message after a reconnect or an `updates.getDifference`
 * gap recovery. #368 measured the gap between two deliveries of one message in
 * production at a median ~116s, p90 ~31min, p99 ~2.1h, max ~2.9h — and the
 * guard here used a 10-SECOND window, so four in five re-deliveries got through
 * and ran `wireTelegramEvents`'s message handler a second time.
 *
 * #368 and #372 made the storage-facing half of that handler idempotent (no
 * second `contracts` row; the re-broadcast is flagged so the feed drops it),
 * but its other effects — Pushover, the `keyword_match` and `contract_address`
 * alerts, the message frame — are fire-and-forget, so a re-delivery still
 * became a second ping. G.Yasuke reported five identical "Keyword match"
 * toasts on 2026-09-08; the toast stack renders at most five.
 *
 * These tests drive the real seam: the manager subscribes to its wrapped
 * clients, so emitting on `clients[0]` is exactly what the update stream does.
 */

const CHAT_ID = '-1002345678';
const MESSAGE_ID = 9901;

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

function rawMessage(over: Partial<TelegramRawMessage> = {}): TelegramRawMessage {
  return {
    id: MESSAGE_ID,
    chatId: CHAT_ID,
    chatTitle: 'Trench Signals',
    chatType: 'supergroup',
    sender: { id: '77', username: 'caller', firstName: 'Caller', lastName: null, photo: null },
    text: 'Aped 40k https://gmgn.ai/bsc/token/0xd7caad73264ef4340339391621fd691b1e267777',
    date: 1_757_000_000,
    ...over,
  };
}

/**
 * A connected manager with no network anywhere near it.
 *
 * `connect()` is what starts the dedupe sweep, and the sweep is half of what
 * decides whether a re-delivery is still recognised — so the test has to run it
 * rather than construct the manager and skip straight to emitting. Stubbing the
 * wrapped clients' own connect/disconnect is the smallest thing that allows
 * that: everything under test (the guard, the sweep, the timer that drives it)
 * stays the real implementation.
 */
async function connectedManager() {
  const manager = new TelegramClientManager(12345, 'apihash', ['']);
  const clients = (manager as unknown as { clients: EventEmitter[] }).clients;
  const client = clients[0];
  Object.assign(client, { connect: async () => {}, disconnect: () => {} });

  const delivered: TelegramRawMessage[] = [];
  manager.on('message', (raw: TelegramRawMessage) => delivered.push(raw));

  await manager.connect();
  return { manager, client, delivered };
}

describe('TelegramClientManager collapses a re-delivered message', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers a message the first time it arrives', async () => {
    const { manager, client, delivered } = await connectedManager();
    client.emit('message', rawMessage());
    expect(delivered).toHaveLength(1);
    manager.disconnect();
  });

  it('collapses two sessions delivering the same message at once', async () => {
    const { manager, client, delivered } = await connectedManager();
    client.emit('message', rawMessage());
    client.emit('message', rawMessage());
    expect(delivered).toHaveLength(1);
    manager.disconnect();
  });

  // The regression. Each of these gaps is a point on the measured distribution
  // and every one of them is past the old 10s window, so before the fix each
  // re-delivery ran the ingest handler again and raised its own toast, its own
  // Pushover push and its own bot DM.
  it.each([
    ['30s, inside the frontend contract-alert dedupe', 30 * SECOND],
    ['116s, the measured median', 116 * SECOND],
    ['31min, the measured p90', 31 * MINUTE],
    ['2.1h, the measured p99', 2.1 * HOUR],
  ])('collapses a re-delivery %s later', async (_label, gap) => {
    const { manager, client, delivered } = await connectedManager();
    client.emit('message', rawMessage());

    // Advancing the clock also runs the sweep interval, exactly as a live
    // process does while it waits for the replay.
    await vi.advanceTimersByTimeAsync(gap);
    client.emit('message', rawMessage());

    expect(delivered).toHaveLength(1);
    manager.disconnect();
  });

  it('collapses a burst of replays, the shape the five stacked toasts had', async () => {
    const { manager, client, delivered } = await connectedManager();
    for (let i = 0; i < 5; i++) {
      client.emit('message', rawMessage());
      await vi.advanceTimersByTimeAsync(90 * SECOND);
    }
    expect(delivered).toHaveLength(1);
    manager.disconnect();
  });

  it('still delivers a genuinely different message in the same chat', async () => {
    const { manager, client, delivered } = await connectedManager();
    client.emit('message', rawMessage());
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    client.emit('message', rawMessage({ id: MESSAGE_ID + 1 }));

    expect(delivered).toHaveLength(2);
    manager.disconnect();
  });

  it('still delivers the same message id from a different chat', async () => {
    const { manager, client, delivered } = await connectedManager();
    client.emit('message', rawMessage());
    client.emit('message', rawMessage({ chatId: '-1009999999' }));

    expect(delivered).toHaveLength(2);
    manager.disconnect();
  });

  it('bounds the remembered set, evicting oldest first', async () => {
    const { manager, client, delivered } = await connectedManager();
    client.emit('message', rawMessage());

    // Past the size cap the oldest ids go, so the guard cannot grow without
    // bound on a busy feed — the eviction that actually limits how far back it
    // sees. The first message is forgotten and delivers again; one from the end
    // of the run is still remembered.
    for (let i = 1; i <= 20_001; i++) client.emit('message', rawMessage({ id: MESSAGE_ID + i }));
    const beforeReplays = delivered.length;

    client.emit('message', rawMessage());
    client.emit('message', rawMessage({ id: MESSAGE_ID + 20_001 }));

    expect(delivered.length - beforeReplays).toBe(1);
    manager.disconnect();
  });

  it('forgets a message once it is past the retention', async () => {
    const { manager, client, delivered } = await connectedManager();
    client.emit('message', rawMessage());

    // Past the measured max re-delivery gap (~2.9h) the id is swept, so the
    // guard is bounded rather than a leak. A replay this late is indistinguishable
    // from a fresh call and is treated as one.
    await vi.advanceTimersByTimeAsync(4 * HOUR);
    client.emit('message', rawMessage());

    expect(delivered).toHaveLength(2);
    manager.disconnect();
  });
});
