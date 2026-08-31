import { describe, it, expect, beforeEach, vi } from 'vitest';
import { routeJ7Event, resetUnknownWarnings, BoundedDeduper, type J7EventSink } from '../src/j7/events.js';
import type { J7CalloutData, J7FomoTradeData } from '../src/j7/mappers.js';
import { parseJ7Accounts } from '../src/j7/client.js';

function fakeSink(): J7EventSink & { callouts: J7CalloutData[]; trades: J7FomoTradeData[] } {
  const callouts: J7CalloutData[] = [];
  const trades: J7FomoTradeData[] = [];
  return {
    callouts,
    trades,
    onCallout: (d) => callouts.push(d),
    onFomoTrade: (d) => trades.push(d),
  };
}

const CALLOUT_DATA = {
  calloutId: 'co_1',
  author: { wallet: 'WalletAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  token: { address: 'MintBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
  calledOutAtMcap: 50000,
  text: 'go',
  multiple: 1.1,
  maxMultiplier: 2,
  timestamp: '2026-08-29T13:24:16.047Z',
};

const TRADE_DATA = {
  tradeId: '0xtrade1',
  side: 'buy',
  userId: 'u1',
  userHandle: 'trader',
  usdAmount: 1000,
  token: { address: '0xtok', symbol: 'TOK', networkId: 8453, network: 'base' },
};

describe('routeJ7Event', () => {
  beforeEach(() => resetUnknownWarnings());

  it('dispatches pump_event{callout} to onCallout with the mapped payload', () => {
    const sink = fakeSink();
    routeJ7Event('pump_event', { type: 'pump', kind: 'callout', data: CALLOUT_DATA }, sink);
    expect(sink.callouts).toHaveLength(1);
    expect(sink.callouts[0].calloutId).toBe('co_1');
    expect(sink.callouts[0].marketCapUsd).toBe(50000);
    expect(sink.trades).toHaveLength(0);
  });

  it('dispatches fomo_event{trade} to onFomoTrade with the mapped payload', () => {
    const sink = fakeSink();
    routeJ7Event('fomo_event', { type: 'fomo', kind: 'trade', data: TRADE_DATA }, sink);
    expect(sink.trades).toHaveLength(1);
    expect(sink.trades[0].tradeId).toBe('0xtrade1');
    expect(sink.trades[0].venue).toBe('fomo.family');
    expect(sink.callouts).toHaveLength(0);
  });

  it('ignores pump replies (only kind:"callout" maps to a call)', () => {
    const sink = fakeSink();
    routeJ7Event('pump_event', { kind: 'reply', data: { parent: { calloutId: 'co_1' } } }, sink);
    expect(sink.callouts).toHaveLength(0);
    expect(sink.trades).toHaveLength(0);
  });

  it('ignores fomo thesis / new_account kinds', () => {
    const sink = fakeSink();
    routeJ7Event('fomo_event', { kind: 'thesis', data: {} }, sink);
    routeJ7Event('fomo_event', { kind: 'new_account', data: {} }, sink);
    expect(sink.trades).toHaveLength(0);
  });

  it('ignores an entirely unknown event name', () => {
    const sink = fakeSink();
    routeJ7Event('mystery_event', { kind: 'callout', data: CALLOUT_DATA }, sink);
    expect(sink.callouts).toHaveLength(0);
    expect(sink.trades).toHaveLength(0);
  });

  it('does not emit when the mapper rejects the data (missing keys)', () => {
    const sink = fakeSink();
    routeJ7Event('pump_event', { kind: 'callout', data: { calloutId: 'x' } }, sink);
    expect(sink.callouts).toHaveLength(0);
  });

  it('does not throw on a non-record payload or a missing envelope', () => {
    const sink = fakeSink();
    expect(() => routeJ7Event('pump_event', null, sink)).not.toThrow();
    expect(() => routeJ7Event('fomo_event', 'garbage', sink)).not.toThrow();
    expect(sink.callouts).toHaveLength(0);
    expect(sink.trades).toHaveLength(0);
  });

  it('warns only once per unknown (event × kind), not once per re-send', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const sink = fakeSink();
      routeJ7Event('pump_event', { kind: 'reply', data: {} }, sink);
      routeJ7Event('pump_event', { kind: 'reply', data: {} }, sink);
      routeJ7Event('pump_event', { kind: 'reply', data: {} }, sink);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('BoundedDeduper', () => {
  it('returns true the first time and false thereafter', () => {
    const d = new BoundedDeduper(10);
    expect(d.add('a')).toBe(true);
    expect(d.add('a')).toBe(false);
    expect(d.has('a')).toBe(true);
  });

  it('evicts the oldest id past capacity (so it can be re-seen)', () => {
    const d = new BoundedDeduper(2);
    expect(d.add('a')).toBe(true);
    expect(d.add('b')).toBe(true);
    expect(d.add('c')).toBe(true); // evicts 'a'
    expect(d.has('a')).toBe(false);
    expect(d.has('b')).toBe(true);
    expect(d.add('a')).toBe(true); // 'a' is new again
  });
});

describe('parseJ7Accounts', () => {
  it('returns [] for absent / empty / malformed env', () => {
    expect(parseJ7Accounts(undefined)).toEqual([]);
    expect(parseJ7Accounts('')).toEqual([]);
    expect(parseJ7Accounts('  ')).toEqual([]);
    expect(parseJ7Accounts('{not json')).toEqual([]);
    expect(parseJ7Accounts('{"a":1}')).toEqual([]); // object, not array
  });

  it('ignores entries with an empty / whitespace jwt', () => {
    const raw = JSON.stringify([
      { username: 'a', jwt: 'tokenA' },
      { username: 'b', jwt: '' },
      { username: 'c', jwt: '   ' },
      { username: 'd', jwt: 'tokenD' },
    ]);
    expect(parseJ7Accounts(raw)).toEqual([
      { username: 'a', jwt: 'tokenA' },
      { username: 'd', jwt: 'tokenD' },
    ]);
  });

  it('defaults a missing username to "account" and trims the jwt', () => {
    const raw = JSON.stringify([{ jwt: '  tokenX  ' }]);
    expect(parseJ7Accounts(raw)).toEqual([{ username: 'account', jwt: 'tokenX' }]);
  });
});
