// Per-follower delivery of j7 events. The behaviour under test is the contract
// the old pump-callout poller had and this replaces: one frame per follower, the
// per-follower `notify` flag (which drives the console toast/sound, not just the
// push), a Pushover push only for followers who asked for one, and — the easy
// one to get wrong — persisting a callout whose caller nobody follows, because
// j7 never backfills.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fanOutCallout, fanOutTrade, type J7FanoutDeps } from '../src/j7/fanout.js';
import { flushJ7Deliveries, makeSink } from '../src/j7/index.js';
import type { CallerTrackerRow } from '../src/pumpfun/calloutStore.js';
import type { FomoHandleTracker } from '../src/j7/demand.js';
import type { J7CalloutData, J7FomoTradeData } from '../src/j7/mappers.js';

const CALLER = 'WALLET111';

function callout(overrides: Partial<J7CalloutData> = {}): J7CalloutData {
  return {
    calloutId: 'c1',
    callerAddress: CALLER,
    username: 'cupsey',
    avatar: null,
    coinMint: 'MINT111',
    symbol: 'TOAD',
    name: 'Toad',
    image: null,
    marketCapUsd: 42_000,
    thesis: 'sending',
    multiple: null,
    createdAt: 1_700_000_000_000,
    maxMultiplier: null,
    ...overrides,
  };
}

function trade(overrides: Partial<J7FomoTradeData> = {}): J7FomoTradeData {
  return {
    fomoUserId: 'u1',
    fomoHandle: 'unipcs',
    displayName: 'Unipcs',
    side: 'buy',
    tokenAddress: 'MINT222',
    tokenSymbol: 'BONK',
    tokenName: null,
    marketCap: null,
    marketCapDisplay: null,
    networkId: null,
    usdValue: 1234,
    tradeId: 't1',
    timestamp: null,
    network: 'solana',
    venue: 'fomo.family',
    ...overrides,
  };
}

interface Harness {
  deps: J7FanoutDeps;
  sent: { userId: string; payload: Record<string, unknown> }[];
  pushed: { userId: string; title: string }[];
  dmUserIds: string[];
}

function harness(options: {
  followers?: CallerTrackerRow[];
  trackers?: FomoHandleTracker[];
  observerUserId?: string | null;
}): Harness {
  const sent: Harness['sent'] = [];
  const pushed: Harness['pushed'] = [];
  const dmUserIds: string[] = [];
  return {
    sent,
    pushed,
    dmUserIds,
    deps: {
      loadCalloutTrackers: async () => new Map([[CALLER, options.followers ?? []]]),
      loadTradeTrackers: async () => new Map([['unipcs', options.trackers ?? []]]),
      sendToUser: (userId, payload) => void sent.push({ userId, payload }),
      pushover: async (userId, msg) => void pushed.push({ userId, title: msg.title }),
      deliverDms: async (jobs) => void dmUserIds.push(...jobs.map((j) => j.userId)),
      observerUserId: options.observerUserId ?? null,
    },
  };
}

/** The `data` of a captured frame. */
function data(entry: { payload: Record<string, unknown> }): Record<string, unknown> {
  return entry.payload.data as Record<string, unknown>;
}

describe('j7 callout fan-out', () => {
  it('sends one frame per follower with that follower\'s notify flag', async () => {
    const h = harness({
      followers: [
        { userId: 'user-a', notifyPushover: true, notifyDiscord: false },
        { userId: 'user-b', notifyPushover: false, notifyDiscord: false },
      ],
    });
    await fanOutCallout(callout(), h.deps);

    expect(h.sent.map((s) => s.userId)).toEqual(['user-a', 'user-b']);
    expect(h.sent.every((s) => s.payload.type === 'pump_callout')).toBe(true);
    expect(data(h.sent[0]).notify).toBe(true);
    expect(data(h.sent[1]).notify).toBe(false);
    // The push follows the same flag — a muted follow lands silently in the feed.
    expect(h.pushed).toEqual([{ userId: 'user-a', title: 'Pump: @cupsey called $TOAD' }]);
  });

  it('sends nothing when nobody follows the caller', async () => {
    const h = harness({ followers: [] });
    await fanOutCallout(callout(), h.deps);
    expect(h.sent).toEqual([]);
    expect(h.pushed).toEqual([]);
  });

  it('queues a Discord DM only for followers who opted in', async () => {
    const h = harness({
      followers: [
        { userId: 'user-a', notifyPushover: false, notifyDiscord: true },
        { userId: 'user-b', notifyPushover: false, notifyDiscord: false },
      ],
    });
    await fanOutCallout(callout(), h.deps);
    expect(h.dmUserIds).toEqual(['user-a']);
  });

  it('mirrors to the observer without duplicating a follower', async () => {
    const h = harness({
      followers: [
        { userId: 'watcher', notifyPushover: true, notifyDiscord: false },
        { userId: 'user-b', notifyPushover: true, notifyDiscord: false },
      ],
      observerUserId: 'watcher',
    });
    await fanOutCallout(callout(), h.deps);
    // Exactly two frames: the observer already got theirs as a follower.
    expect(h.sent.map((s) => s.userId)).toEqual(['watcher', 'user-b']);
    expect(data(h.sent[0]).notify).toBe(true);
  });

  it('gives the observer a silent copy of a callout they do not follow', async () => {
    const h = harness({ followers: [], observerUserId: 'watcher' });
    await fanOutCallout(callout(), h.deps);

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].userId).toBe('watcher');
    // The mirror is the whole global feed — a toast per callout would be unusable.
    expect(data(h.sent[0]).notify).toBe(false);
    expect(h.pushed).toEqual([]);
  });
});

describe('j7 trade fan-out', () => {
  it('delivers to everyone tracking the handle, case-insensitively', async () => {
    const h = harness({
      trackers: [
        { userId: 'user-a', notifyPushover: true },
        { userId: 'user-b', notifyPushover: false },
      ],
    });
    await fanOutTrade(trade({ fomoHandle: 'UniPCS' }), h.deps);

    expect(h.sent.map((s) => s.userId)).toEqual(['user-a', 'user-b']);
    expect(h.sent.every((s) => s.payload.type === 'fomo_trade')).toBe(true);
    expect(data(h.sent[0]).notify).toBe(true);
    expect(data(h.sent[1]).notify).toBe(false);
    expect(h.pushed.map((p) => p.userId)).toEqual(['user-a']);
  });

  it('sends nothing for an untracked handle, and tolerates a missing one', async () => {
    const h = harness({ trackers: [] });
    await fanOutTrade(trade({ fomoHandle: 'nobody-tracks-me' }), h.deps);
    await fanOutTrade(trade({ fomoHandle: null }), h.deps);
    expect(h.sent).toEqual([]);
  });
});

describe('j7 sink — persist before fan-out', () => {
  beforeEach(() => flushJ7Deliveries());

  it('records a callout even when nobody follows the caller', async () => {
    const h = harness({ followers: [] });
    const record = vi.fn(() => true);
    makeSink(h.deps, { record }).onCallout(callout());
    await flushJ7Deliveries();

    // j7 never backfills: an unrecorded callout is gone for good, follower or not.
    expect(record).toHaveBeenCalledTimes(1);
    expect(h.sent).toEqual([]);
  });

  it('does not re-deliver a callout the store has already recorded', async () => {
    const h = harness({ followers: [{ userId: 'user-a', notifyPushover: true, notifyDiscord: false }] });
    const record = vi.fn(() => false); // idempotent store: already present
    makeSink(h.deps, { record }).onCallout(callout());
    await flushJ7Deliveries();

    expect(h.sent).toEqual([]);
  });

  it('dedups a re-sent trade by tradeId', async () => {
    const h = harness({ trackers: [{ userId: 'user-a', notifyPushover: false }] });
    const sink = makeSink(h.deps, { record: () => true });
    sink.onFomoTrade(trade());
    sink.onFomoTrade(trade()); // same tradeId in j7's next ~30s batch
    await flushJ7Deliveries();

    expect(h.sent).toHaveLength(1);
  });

  it('delivers a batch in arrival order', async () => {
    const h = harness({ followers: [{ userId: 'user-a', notifyPushover: false, notifyDiscord: false }] });
    const sink = makeSink(h.deps, { record: () => true });
    sink.onCallout(callout({ calloutId: 'c1', coinMint: 'MINT-1' }));
    sink.onCallout(callout({ calloutId: 'c2', coinMint: 'MINT-2' }));
    await flushJ7Deliveries();

    expect(h.sent.map((s) => data(s).coinMint)).toEqual(['MINT-1', 'MINT-2']);
  });
});
