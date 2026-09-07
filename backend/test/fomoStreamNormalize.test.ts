import { describe, expect, it, beforeEach } from 'vitest';
import {
  normalizeSide,
  normalizeStreamTrade,
  parseSseFrame,
  splitSseBlocks,
  streamDedupeKeys,
} from '../src/fomo/streamNormalize.js';
import {
  getRecentStreamTrades,
  getStreamFeedSize,
  recordStreamTrade,
  resetStreamFeed,
} from '../src/fomo/streamFeed.js';

// Captured verbatim off https://www.985monitor.xyz/api/events-stream on
// 2026-09-07. Kept whole rather than trimmed: the point of these tests is the
// shape the upstream actually sends, not the shape we wish it sent.
const LIVE_EVENT = {
  source: 'fomo',
  event: {
    key: 'fomo::wind::ocp::0xd847…:0x62cd…:in',
    source: 'fomo',
    eventType: 'FOMO_BUY',
    feedType: 'wind_ocp',
    handle: 'feeeq',
    userName: 'feeeq',
    avatar: 'https://wind.jokkimon.club/api/tgmedia/avatar_fomo_feeeq.jpg',
    followers: 57812,
    side: 'BUY',
    usd: 248.07,
    amount: 112217.44340536743,
    tokenAddress: '0x62cd5cd9d354a2a50affe9efa21c8918b9640a5b',
    networkId: 4663,
    chainName: 'Robinhood',
    symbol: 'LDX',
    tokenImage: 'https://cdn.dexscreener.com/cms/images/_FDvLWdwpVLCL8m9',
    marketCap: 2543982.4,
    priceUsd: 0.0025439824,
    vol24h: 1485413.67940421,
    comment: '',
    ts: 1788778931000,
    receivedAt: 1788778942808,
    txUrl: 'https://8crv4vmq6tiu1yqr.blockscout.com/tx/0xd847',
  },
  seq: 20819,
  broadcastAt: 1788778950942,
};

const LIVE_THESIS = {
  source: 'fomo',
  event: {
    key: 'fomo::wind::th::b4fc8941',
    eventType: 'FOMO_THESIS',
    handle: 'downhorrndously',
    userName: 'downhorrndously',
    followers: 19810,
    side: 'THESIS',
    usd: 0,
    amount: null,
    tokenAddress: '0x0521c5d59aac8c063224525bc44a0d38f02275c8',
    networkId: 4663,
    chainName: 'Robinhood',
    symbol: 'CAPITALCAT',
    marketCap: 140909.2,
    comment: 'Guy is followed by Vlad?',
    ts: 1788778600000,
  },
  broadcastAt: 1788778601000,
};

describe('normalizeSide', () => {
  it('accepts every casing and the FOMO_ prefix the lanes disagree on', () => {
    expect(normalizeSide('BUY')).toBe('buy');
    expect(normalizeSide('FOMO_SELL')).toBe('sell');
    expect(normalizeSide('thesis')).toBe('thesis');
  });

  it('returns null rather than guessing at anything unrecognised', () => {
    // A mislabelled sell rendered as a buy is worse than a blank.
    expect(normalizeSide('TRANSFER')).toBeNull();
    expect(normalizeSide(null)).toBeNull();
    expect(normalizeSide(42)).toBeNull();
    expect(normalizeSide({ side: 'buy' })).toBeNull();
  });
});

describe('normalizeStreamTrade', () => {
  it('narrows a live buy row', () => {
    const trade = normalizeStreamTrade(LIVE_EVENT);
    expect(trade).not.toBeNull();
    expect(trade).toMatchObject({
      id: 'fomo::wind::ocp::0xd847…:0x62cd…:in',
      side: 'buy',
      handle: 'feeeq',
      followers: 57812,
      usd: 248.07,
      symbol: 'LDX',
      chainId: 4663,
      chainName: 'Robinhood',
      ts: 1788778931000,
    });
  });

  it('narrows a thesis row and keeps usd null rather than $0.00', () => {
    const trade = normalizeStreamTrade(LIVE_THESIS);
    expect(trade?.side).toBe('thesis');
    expect(trade?.usd).toBeNull();
    expect(trade?.comment).toBe('Guy is followed by Vlad?');
  });

  it('falls back to eventType when side is missing', () => {
    const trade = normalizeStreamTrade({
      event: { ...LIVE_EVENT.event, side: undefined, eventType: 'FOMO_SELL' },
    });
    expect(trade?.side).toBe('sell');
  });

  // --- hostile / malformed payloads ---

  it('rejects rows with no dedupe key or no trader', () => {
    expect(normalizeStreamTrade({ event: { ...LIVE_EVENT.event, key: undefined } })).toBeNull();
    expect(
      normalizeStreamTrade({ event: { ...LIVE_EVENT.event, handle: undefined, userName: undefined } }),
    ).toBeNull();
  });

  it('rejects non-objects outright', () => {
    for (const bad of [null, undefined, 42, 'buy', [], [LIVE_EVENT]]) {
      expect(normalizeStreamTrade(bad)).toBeNull();
    }
  });

  it('drops non-http(s) urls before they can reach an <img src> or <a href>', () => {
    const trade = normalizeStreamTrade({
      event: {
        ...LIVE_EVENT.event,
        avatar: 'javascript:alert(1)',
        tokenImage: 'data:text/html;base64,PHNjcmlwdD4=',
        txUrl: 'file:///etc/passwd',
      },
    });
    expect(trade?.avatar).toBeNull();
    expect(trade?.tokenImage).toBeNull();
    expect(trade?.txUrl).toBeNull();
  });

  it('rejects non-finite numbers that would reach toFixed() in the UI', () => {
    const trade = normalizeStreamTrade({
      event: { ...LIVE_EVENT.event, usd: 'NaN', marketCap: 'Infinity', followers: {} },
    });
    expect(trade?.usd).toBeNull();
    expect(trade?.marketCap).toBeNull();
    expect(trade?.followers).toBeNull();
  });

  it('caps runaway strings instead of propagating them into React state', () => {
    const trade = normalizeStreamTrade({
      event: { ...LIVE_EVENT.event, comment: 'x'.repeat(50_000), symbol: 'y'.repeat(5_000) },
    });
    expect(trade!.comment!.length).toBe(500);
    expect(trade!.symbol!.length).toBe(32);
  });

  it('refuses implausible timestamps rather than rendering "56 years ago"', () => {
    const zero = normalizeStreamTrade({ event: { ...LIVE_EVENT.event, ts: 0, receivedAt: 0 } });
    // Falls through to now(), not to 1970.
    expect(zero!.ts).toBeGreaterThan(1_700_000_000_000);

    const far = normalizeStreamTrade({
      event: { ...LIVE_EVENT.event, ts: 99_999_999_999_999, receivedAt: 0 },
    });
    expect(far!.ts).toBeGreaterThan(1_700_000_000_000);
  });

  it('promotes seconds-since-epoch to ms', () => {
    const trade = normalizeStreamTrade({ event: { ...LIVE_EVENT.event, ts: 1788778931 } });
    expect(trade?.ts).toBe(1788778931000);
  });

  it('accepts a bare event object as well as the wrapped envelope', () => {
    expect(normalizeStreamTrade(LIVE_EVENT.event)?.handle).toBe('feeeq');
  });
});

describe('parseSseFrame / splitSseBlocks', () => {
  it('parses a real frame', () => {
    const frame = parseSseFrame('id: 17862\nevent: fomo\ndata: {"a":1}');
    expect(frame).toEqual({ event: 'fomo', data: '{"a":1}', id: '17862' });
  });

  it('joins multi-line data per the SSE spec', () => {
    expect(parseSseFrame('event: fomo\ndata: {"a":\ndata: 1}')?.data).toBe('{"a":\n1}');
  });

  it('drops comments, retry directives and heartbeat-shaped blocks', () => {
    expect(parseSseFrame('retry: 5000')).toBeNull();
    expect(parseSseFrame(': keep-alive')).toBeNull();
    expect(parseSseFrame('event: heartbeat')).toBeNull(); // no data line
    expect(parseSseFrame('')).toBeNull();
  });

  it('returns the trailing partial so a mid-frame chunk boundary is not lost', () => {
    const { blocks, rest } = splitSseBlocks('event: a\ndata: 1\n\nevent: b\ndata: 2');
    expect(blocks).toEqual(['event: a\ndata: 1']);
    expect(rest).toBe('event: b\ndata: 2');
  });
});

describe('streamDedupeKeys', () => {
  it('claims the raw id, any embedded uuid, and the event signature', () => {
    const keys = streamDedupeKeys(normalizeStreamTrade(LIVE_EVENT)!);
    expect(keys).toContain('id:fomo::wind::ocp::0xd847…:0x62cd…:in');
    expect(keys).toContain(
      'ev:feeeq|buy|0x62cd5cd9d354a2a50affe9efa21c8918b9640a5b|1788778931000',
    );
  });

  it('extracts the uuid that pairs the ws and wind lanes', () => {
    const uuid = '65debf2f-5b87-4e19-a15e-a7182414b6f0';
    const a = streamDedupeKeys({ ...normalizeStreamTrade(LIVE_THESIS)!, id: `fomo::ws::${uuid}` });
    const b = streamDedupeKeys({
      ...normalizeStreamTrade(LIVE_THESIS)!,
      id: `fomo::wind::th::${uuid}`,
    });
    expect(a).toContain(`uuid:${uuid}`);
    expect(b).toContain(`uuid:${uuid}`);
  });

  it('omits the event signature when there is no token to key on', () => {
    const keys = streamDedupeKeys({ ...normalizeStreamTrade(LIVE_EVENT)!, tokenAddress: null });
    expect(keys.some((k) => k.startsWith('ev:'))).toBe(false);
  });
});

describe('stream feed buffer', () => {
  beforeEach(() => resetStreamFeed());

  it('records, orders newest-first, and reports duplicates', () => {
    const base = normalizeStreamTrade(LIVE_EVENT)!;
    const make = (id: string, ts: number) => ({ ...base, id, ts });
    expect(recordStreamTrade(make('a', 1))).toBe(true);
    expect(recordStreamTrade(make('b', 2))).toBe(true);
    expect(recordStreamTrade(make('a', 3))).toBe(false);
    expect(getStreamFeedSize()).toBe(2);
    expect(getRecentStreamTrades().map((t) => t.id)).toEqual(['b', 'a']);
  });

  it('collapses the same thesis arriving on the ws and wind lanes', () => {
    // Observed live 2026-09-07: one thesis, two keys, timestamps 18ms apart.
    const base = normalizeStreamTrade(LIVE_THESIS)!;
    const uuid = '65debf2f-5b87-4e19-a15e-a7182414b6f0';
    expect(recordStreamTrade({ ...base, id: `fomo::ws::${uuid}`, ts: 1788779691018 })).toBe(true);
    expect(recordStreamTrade({ ...base, id: `fomo::wind::th::${uuid}`, ts: 1788779691000 })).toBe(
      false,
    );
    expect(getStreamFeedSize()).toBe(1);
  });

  it('collapses one buy reported by two tx-keyed lanes with drifting usd', () => {
    const base = normalizeStreamTrade(LIVE_EVENT)!;
    expect(recordStreamTrade({ ...base, id: 'fomo::wind::fh::0xaaa', usd: 249.97 })).toBe(true);
    expect(recordStreamTrade({ ...base, id: 'fomo::wind::ocp::0xbbb', usd: 248.07 })).toBe(false);
    expect(getStreamFeedSize()).toBe(1);
  });

  it('keeps two genuine trades of the same token seconds apart', () => {
    // CryptoBuck_ really did buy $HMM twice inside 15s; collapsing that would
    // hide real activity, which is why the signature keys on the exact ts.
    const base = normalizeStreamTrade(LIVE_EVENT)!;
    expect(recordStreamTrade({ ...base, id: 'x1', ts: 1788778931000 })).toBe(true);
    expect(recordStreamTrade({ ...base, id: 'x2', ts: 1788778945000 })).toBe(true);
    expect(getStreamFeedSize()).toBe(2);
  });

  it('clamps a hostile limit', () => {
    recordStreamTrade(normalizeStreamTrade(LIVE_EVENT)!);
    expect(getRecentStreamTrades(-5)).toHaveLength(1);
    expect(getRecentStreamTrades(Number.NaN)).toHaveLength(1);
    expect(getRecentStreamTrades(10_000)).toHaveLength(1);
  });
});
