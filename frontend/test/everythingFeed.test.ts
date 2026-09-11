import { describe, it, expect } from 'vitest';
import {
  EVERYTHING_KINDS,
  mergeEverythingFeed,
  resolveEnabledKinds,
  type EverythingItem,
} from '../src/utils/everythingFeed';
import type { FomoTrade } from '../src/types/fomo';
import type { FomoStreamTradeEntry } from '../src/types/fomoStream';
import type { PumpCalloutFeedEntry } from '../src/types/pumpfun';
import type { RobinhoodFillEntry } from '../src/types/robinhood';

// The Everything feed is display-only interleaving of four already-detected
// streams (see the "Signals stay independent" rule). These guard the pure core:
// chronological order across sources, the cap, per-kind filtering, and that each
// source keeps its own kind rather than being fused into another.

function fomo(over: Partial<FomoTrade> & { key: string; occurredAt: number }): FomoTrade {
  return {
    fomoUserId: null,
    fomoHandle: 'trader',
    displayName: null,
    side: 'buy',
    tokenAddress: 'So1111111111111111111111111111111111111111',
    tokenSymbol: 'ABC',
    tokenName: null,
    marketCap: null,
    marketCapDisplay: null,
    networkId: 1399811149,
    usdValue: 100,
    tradeId: over.key,
    receivedAt: over.occurredAt,
    ...over,
  };
}

function stream(over: Partial<FomoStreamTradeEntry> & { key: string; ts: number }): FomoStreamTradeEntry {
  return {
    id: over.key,
    side: 'buy',
    handle: 'tapeguy',
    displayName: null,
    avatar: null,
    followers: null,
    usd: 50,
    amount: null,
    tokenAddress: null,
    symbol: 'TAPE',
    tokenImage: null,
    chainId: null,
    chainName: 'Base',
    marketCap: null,
    priceUsd: null,
    comment: null,
    txUrl: null,
    receivedAt: over.ts,
    ...over,
  };
}

function callout(
  over: Partial<PumpCalloutFeedEntry> & { key: string; occurredAt: number },
): PumpCalloutFeedEntry {
  return {
    calloutId: over.key,
    callerAddress: 'Ca11er1111111111111111111111111111111111111',
    username: 'caller',
    avatar: null,
    coinMint: 'Coin1111111111111111111111111111111111111111',
    symbol: 'PUMP',
    name: null,
    image: null,
    marketCapUsd: 25000,
    thesis: 'this one runs',
    multiple: 2,
    createdAt: over.occurredAt,
    maxMultiplier: null,
    receivedAt: over.occurredAt,
    ...over,
  };
}

function rh(over: Partial<RobinhoodFillEntry> & { key: string; ts: number }): RobinhoodFillEntry {
  return {
    id: Number(over.ts),
    tx: null,
    side: 'sell',
    usd: 75,
    amount: null,
    price: null,
    handle: 'rhtrader',
    displayName: null,
    followers: null,
    wallet: null,
    token: '0xabc',
    symbol: 'RHT',
    name: null,
    mark: null,
    liquidity: null,
    pairUrl: null,
    isStock: null,
    newPosition: null,
    receivedAt: over.ts * 1000,
    ...over,
  };
}

const SOURCES = {
  // fomo/pump timestamps are epoch ms; robinhood ts is SECONDS.
  fomoTrades: [fomo({ key: 'f1', occurredAt: 3000, side: 'buy' }), fomo({ key: 'f2', occurredAt: 5000, side: 'sell' })],
  fomoStreamTrades: [stream({ key: 's1', ts: 4000 })],
  pumpCallouts: [callout({ key: 'c1', occurredAt: 2000 })],
  robinhoodFills: [rh({ key: 'r1', ts: 6 })], // 6s -> 6000ms
};

describe('mergeEverythingFeed', () => {
  it('interleaves all four sources newest-first by timestamp', () => {
    const out = mergeEverythingFeed(SOURCES);
    expect(out.map((i) => i.id)).toEqual(['r1', 'f2', 's1', 'f1', 'c1']);
    // Strictly descending timestamps.
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1].ts).toBeGreaterThanOrEqual(out[i].ts);
    }
  });

  it('maps each source to the right kind and never fuses them', () => {
    const byId = new Map(mergeEverythingFeed(SOURCES).map((i) => [i.id, i] as const));
    expect(byId.get('f1')!.kind).toBe('buy');
    expect(byId.get('f2')!.kind).toBe('sell');
    expect(byId.get('s1')!.kind).toBe('tape');
    expect(byId.get('c1')!.kind).toBe('callout');
    expect(byId.get('r1')!.kind).toBe('rh');
    // Sources are preserved distinctly — a tape row is never relabelled fomo, etc.
    expect(byId.get('s1')!.source).toBe('fomo-stream');
    expect(byId.get('c1')!.source).toBe('pump');
  });

  it('scales robinhood seconds to ms so it orders correctly (r1 at 6000ms is newest)', () => {
    const r = mergeEverythingFeed(SOURCES).find((i) => i.id === 'r1')!;
    expect(r.ts).toBe(6000);
  });

  it('surfaces the thesis only on callout rows', () => {
    const out = mergeEverythingFeed(SOURCES);
    const call = out.find((i) => i.id === 'c1')!;
    expect(call.text).toBe('this one runs');
    // No other kind carries thesis text here.
    expect(out.filter((i) => i.text).map((i) => i.id)).toEqual(['c1']);
  });

  it('a disabled chip removes that kind entirely', () => {
    // Everything except sells.
    const noSell = mergeEverythingFeed(SOURCES, { enabled: ['buy', 'callout', 'tape', 'rh'] });
    expect(noSell.some((i) => i.kind === 'sell')).toBe(false);
    expect(noSell.some((i) => i.id === 'f2')).toBe(false);
    // Only-callout keeps just the callout.
    const onlyCall = mergeEverythingFeed(SOURCES, { enabled: ['callout'] });
    expect(onlyCall.map((i) => i.id)).toEqual(['c1']);
    // Empty enabled set yields an empty feed (all chips off), not a fallback to all.
    expect(mergeEverythingFeed(SOURCES, { enabled: [] })).toEqual([]);
  });

  it('caps the merged list to the requested size, keeping the newest', () => {
    const many: FomoTrade[] = Array.from({ length: 20 }, (_, n) =>
      fomo({ key: `m${n}`, occurredAt: n * 1000 }),
    );
    const out = mergeEverythingFeed({ ...SOURCES, fomoTrades: many }, { cap: 5 });
    expect(out).toHaveLength(5);
    // Newest first: m19 (19000ms) down.
    expect(out[0].id).toBe('m19');
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1].ts).toBeGreaterThanOrEqual(out[i].ts);
    }
  });

  it('is deterministic on timestamp ties (breaks on id)', () => {
    const a = mergeEverythingFeed({
      fomoTrades: [fomo({ key: 'a', occurredAt: 1000 }), fomo({ key: 'b', occurredAt: 1000 })],
      fomoStreamTrades: [],
      pumpCallouts: [],
      robinhoodFills: [],
    });
    const b = mergeEverythingFeed({
      fomoTrades: [fomo({ key: 'b', occurredAt: 1000 }), fomo({ key: 'a', occurredAt: 1000 })],
      fomoStreamTrades: [],
      pumpCallouts: [],
      robinhoodFills: [],
    });
    expect(a.map((i) => i.id)).toEqual(b.map((i) => i.id));
  });

  it('degrades an unlabeled FOMO trade to the buy bucket rather than dropping it', () => {
    const out = mergeEverythingFeed({
      fomoTrades: [fomo({ key: 'u', occurredAt: 1000, side: null })],
      fomoStreamTrades: [],
      pumpCallouts: [],
      robinhoodFills: [],
    });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('buy');
    expect(out[0].side).toBeNull();
  });

  it('resolves the handle label per source', () => {
    const out = mergeEverythingFeed(SOURCES);
    const byId = new Map(out.map((i) => [i.id, i] as const));
    expect(byId.get('f1')!.handle).toBe('@trader');
    expect(byId.get('c1')!.handle).toBe('@caller');
    expect(byId.get('r1')!.handle).toBe('@rhtrader');
  });
});

describe('resolveEnabledKinds', () => {
  it('undefined means every kind is on', () => {
    expect(resolveEnabledKinds(undefined)).toEqual([...EVERYTHING_KINDS]);
  });

  it('an explicit empty list stays empty (all chips off)', () => {
    expect(resolveEnabledKinds([])).toEqual([]);
  });

  it('drops unknown kinds from a stale config', () => {
    expect(resolveEnabledKinds(['buy', 'garbage' as never, 'rh'])).toEqual(['buy', 'rh']);
  });
});

// Type-only guard: EverythingItem always exposes the fields the renderer reads.
const _shape: EverythingItem = {
  id: 'x',
  ts: 0,
  kind: 'buy',
  source: 'fomo',
  handle: null,
  symbol: null,
  address: null,
  usd: null,
  side: null,
  chain: null,
  networkId: null,
  text: null,
  txUrl: null,
  multiple: null,
  marketCap: null,
};
void _shape;
