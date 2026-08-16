// The live pump.fun callout feed slice (src/stores/slices/pumpCalloutsSlice.ts).
//
// The feed is fed by a single WS frame with no history replay behind it, so the
// slice IS the feed's correctness: dedupe (a reconnect re-delivers the tail of a
// batch), the cap (a burst must not grow client state without bound), and
// timestamp choice (a call must sort by when it was CALLED, not when the socket
// happened to hand it over).

import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from '../src/stores/appStore';
import type { PumpCalloutEvent } from '../src/types/pumpfun';

const CALLER = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const MINT = 'So11111111111111111111111111111111111111112';

function callout(over: Partial<PumpCalloutEvent> = {}): PumpCalloutEvent {
  return {
    calloutId: 'c1',
    callerAddress: CALLER,
    username: 'papipablo',
    avatar: null,
    coinMint: MINT,
    symbol: 'TOAD',
    name: 'Toad Coin',
    image: null,
    marketCapUsd: 1_250_000,
    thesis: 'clean chart',
    multiple: 2.5,
    createdAt: null,
    ...over,
  };
}

describe('pumpCallouts slice', () => {
  beforeEach(() => {
    useAppStore.getState().clearPumpCallouts();
  });

  const add = (c: PumpCalloutEvent) => useAppStore.getState().addPumpCallout(c);
  const feed = () => useAppStore.getState().pumpCallouts;

  it('adds a callout and preserves every field off the wire', () => {
    add(callout());
    expect(feed()).toHaveLength(1);
    expect(feed()[0]).toMatchObject({
      calloutId: 'c1',
      callerAddress: CALLER,
      username: 'papipablo',
      symbol: 'TOAD',
      marketCapUsd: 1_250_000,
      thesis: 'clean chart',
      multiple: 2.5,
    });
  });

  it('puts the newest callout first', () => {
    add(callout({ calloutId: 'c1' }));
    add(callout({ calloutId: 'c2' }));
    expect(feed().map((c) => c.calloutId)).toEqual(['c2', 'c1']);
  });

  it('drops a re-delivered callout — a reconnect must not double the feed', () => {
    add(callout({ calloutId: 'c1' }));
    add(callout({ calloutId: 'c1' }));
    add(callout({ calloutId: 'c1', thesis: 'edited' }));
    expect(feed()).toHaveLength(1);
    expect(feed()[0].thesis).toBe('clean chart');
  });

  it('gives every entry a distinct React key', () => {
    for (let i = 0; i < 5; i++) add(callout({ calloutId: `c${i}` }));
    const keys = feed().map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('uses the call time when pump supplies one', () => {
    const called = Date.parse('2026-08-16T04:00:00.000Z');
    add(callout({ calloutId: 'c1', createdAt: called }));
    expect(feed()[0].occurredAt).toBe(called);
  });

  it('falls back to arrival when pump omits the timestamp', () => {
    const before = Date.now();
    add(callout({ calloutId: 'c1', createdAt: null }));
    const entry = feed()[0];
    expect(entry.occurredAt).toBeGreaterThanOrEqual(before);
    expect(entry.occurredAt).toBe(entry.receivedAt);
  });

  it('caps the feed so a burst cannot grow client state without bound', () => {
    for (let i = 0; i < 340; i++) add(callout({ calloutId: `c${i}` }));
    const list = feed();
    expect(list).toHaveLength(300);
    // The cap must drop the OLDEST, never the newest.
    expect(list[0].calloutId).toBe('c339');
    expect(list.some((c) => c.calloutId === 'c0')).toBe(false);
  });

  it('clears back to empty', () => {
    add(callout({ calloutId: 'c1' }));
    useAppStore.getState().clearPumpCallouts();
    expect(feed()).toEqual([]);
  });
});
