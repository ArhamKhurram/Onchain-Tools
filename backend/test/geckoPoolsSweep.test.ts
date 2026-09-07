/**
 * The multi-source pool sweep behind the market-cap-crossing universe (#386).
 *
 * The owner's report was that the universe was "thin". The cause was that it
 * came from ONE ranking — the busiest pools by 24h volume — which is blind to a
 * token climbing on modest volume, i.e. exactly the shape of a token about to
 * cross a threshold. `sweepPools` composes several GeckoTerminal rankings, and
 * these tests pin the two properties that make that safe: priority-ordered
 * dedup (a trending mover is never crowded out by the volume leaders) and
 * graceful degradation (a failed endpoint shortens the universe, never empties
 * or throws).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { gt } = vi.hoisted(() => ({ gt: vi.fn() }));

// geckoPools imports ONLY geckoTerminalGet from candles; stubbing it keeps the
// real rate-limit queue and its timers out of the test.
vi.mock('../src/revival/candles.js', () => ({ geckoTerminalGet: gt }));

import {
  mergePoolLists,
  sweepPools,
  type PoolToken,
} from '../src/marketData/geckoPools.js';

function poolsResponse(entries: { addr: string; liquidity: number; volume: number }[]) {
  return {
    data: entries.map((e) => ({
      attributes: {
        name: `${e.addr} / SOL`,
        reserve_in_usd: e.liquidity,
        volume_usd: { h24: e.volume },
      },
      relationships: { base_token: { data: { id: `solana_${e.addr}` } } },
    })),
  };
}

/** Route a stubbed response per endpoint family, so priority/dedup is observable. */
function routeBy(map: Partial<Record<'pools' | 'trending_pools' | 'new_pools', unknown>>) {
  gt.mockImplementation(async (_network: unknown, rawPath?: unknown) => {
    const path = typeof rawPath === 'string' ? rawPath : '';
    if (path.includes('/trending_pools')) return map.trending_pools ?? { data: [] };
    if (path.includes('/new_pools')) return map.new_pools ?? { data: [] };
    if (path.includes('/pools')) return map.pools ?? { data: [] };
    return { data: [] };
  });
}

beforeEach(() => gt.mockReset());
afterEach(() => vi.clearAllMocks());

describe('mergePoolLists', () => {
  const tok = (address: string, source: PoolToken['source']): PoolToken => ({
    address,
    network: 'solana',
    liquidityUsd: 50_000,
    volume24hUsd: 100_000,
    poolName: null,
    source,
  });

  it('keeps the FIRST occurrence of an address across sources', () => {
    const merged = mergePoolLists(
      [[tok('a', 'trending'), tok('b', 'trending')], [tok('b', 'busiest'), tok('c', 'busiest')]],
      10,
    );
    expect(merged.map((t) => t.address)).toEqual(['a', 'b', 'c']);
    // 'b' was surfaced by trending first, so it keeps that provenance.
    expect(merged.find((t) => t.address === 'b')?.source).toBe('trending');
  });

  it('caps the merged universe at maxTokens, priority order first', () => {
    const merged = mergePoolLists(
      [[tok('t1', 'trending'), tok('t2', 'trending')], [tok('b1', 'busiest'), tok('b2', 'busiest')]],
      3,
    );
    expect(merged.map((t) => t.address)).toEqual(['t1', 't2', 'b1']);
  });

  it('returns nothing for a zero cap', () => {
    expect(mergePoolLists([[tok('a', 'busiest')]], 0)).toEqual([]);
  });
});

describe('sweepPools', () => {
  it('puts trending tokens ahead of busiest and dedupes the overlap', async () => {
    routeBy({
      trending_pools: poolsResponse([
        { addr: 'MOVER', liquidity: 40_000, volume: 200_000 },
        { addr: 'SHARED', liquidity: 60_000, volume: 500_000 },
      ]),
      pools: poolsResponse([
        { addr: 'SHARED', liquidity: 60_000, volume: 500_000 },
        { addr: 'WHALE', liquidity: 900_000, volume: 9_000_000 },
      ]),
    });

    const out = await sweepPools('solana', {
      sources: ['trending', 'busiest'],
      minLiquidityUsd: 2_000,
      maxTokens: 50,
    });

    expect(out.map((t) => t.address)).toEqual(['MOVER', 'SHARED', 'WHALE']);
    expect(out.find((t) => t.address === 'SHARED')?.source).toBe('trending');
    expect(out.find((t) => t.address === 'MOVER')?.source).toBe('trending');
    expect(out.find((t) => t.address === 'WHALE')?.source).toBe('busiest');
  });

  it('degrades to the sources that answered when one endpoint fails', async () => {
    gt.mockImplementation(async (_n: unknown, rawPath?: unknown) => {
      const path = typeof rawPath === 'string' ? rawPath : '';
      if (path.includes('/trending_pools')) return null; // upstream 429 / failure
      if (path.includes('/pools')) return poolsResponse([{ addr: 'WHALE', liquidity: 900_000, volume: 9_000_000 }]);
      return { data: [] };
    });

    const out = await sweepPools('solana', {
      sources: ['trending', 'busiest'],
      minLiquidityUsd: 2_000,
      maxTokens: 50,
    });

    expect(out.map((t) => t.address)).toEqual(['WHALE']);
  });

  it('returns an empty universe (never throws) when every source fails', async () => {
    gt.mockResolvedValue(null);
    await expect(
      sweepPools('solana', { sources: ['trending', 'busiest'], minLiquidityUsd: 2_000, maxTokens: 50 }),
    ).resolves.toEqual([]);
  });

  it('honours the liquidity floor before a token reaches the universe', async () => {
    routeBy({
      trending_pools: poolsResponse([
        { addr: 'THIN', liquidity: 500, volume: 1_000_000 },
        { addr: 'DEEP', liquidity: 80_000, volume: 1_000_000 },
      ]),
    });
    const out = await sweepPools('solana', {
      sources: ['trending'],
      minLiquidityUsd: 2_000,
      maxTokens: 50,
    });
    expect(out.map((t) => t.address)).toEqual(['DEEP']);
  });

  it('stops paging a source once a page yields nothing usable', async () => {
    // Page 1 has one token; page 2 would be empty. The sweep must not keep
    // requesting pages 3..N against the shared budget.
    let call = 0;
    gt.mockImplementation(async (_n: unknown, rawPath?: unknown) => {
      const path = typeof rawPath === 'string' ? rawPath : '';
      if (!path.includes('/pools')) return { data: [] };
      call += 1;
      return call === 1
        ? poolsResponse([{ addr: 'ONLY', liquidity: 50_000, volume: 100_000 }])
        : { data: [] };
    });
    const out = await sweepPools('solana', {
      sources: ['busiest'],
      minLiquidityUsd: 2_000,
      maxTokens: 200, // would otherwise page up to 10 times
    });
    expect(out.map((t) => t.address)).toEqual(['ONLY']);
    expect(call).toBe(2); // page 1 (data) + page 2 (empty, stop) — not 10 pages
  });
});
