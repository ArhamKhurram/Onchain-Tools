import { describe, it, expect } from 'vitest';
import {
  bestRoutable,
  classifyPool,
  describeCandidates,
  parseDexScreenerPools,
  rankPools,
  readV4PoolKey,
  resolveRoute,
  type DiscoveredPool,
} from '../src/sniper/evm/routing';
import { WETH_ADDRESS, UNISWAP_V4_POOL_MANAGER, V4_INITIALIZE_TOPIC } from '../src/sniper/evm/chain';
import type { EvmRpc } from '../src/sniper/evm/rpc';

const TOKEN = '0x79fe86b963255ce884bdcac6388c50a599ba277f';
const NATIVE = '0x0000000000000000000000000000000000000000';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';

const pool = (over: Partial<DiscoveredPool> = {}): DiscoveredPool => ({
  dexId: 'uniswap',
  label: 'v3',
  pairAddress: '0x8aac0c4c9236096aa79262b0a53a683979ed8c7a',
  liquidityUsd: 1_000,
  baseToken: TOKEN,
  quoteToken: WETH_ADDRESS,
  ...over,
});

const v4Id = (n: string) => `0x${n.repeat(64).slice(0, 64)}`;

/** A stub EvmRpc. Each method throws unless the test supplies it — no accidental network. */
function stubRpc(over: Partial<EvmRpc> = {}): EvmRpc {
  return {
    call: over.call ?? (async () => { throw new Error('call not stubbed'); }),
    getLogs: over.getLogs ?? (async () => { throw new Error('getLogs not stubbed'); }),
    simulate: over.simulate ?? (async () => { throw new Error('simulate not stubbed'); }),
  };
}

describe('classifyPool — what this module can and cannot execute against', () => {
  it('routes a WETH-quoted Uniswap V3 pool', () => {
    expect(classifyPool(pool(), TOKEN)).toMatchObject({ routable: true, family: 'uniswap_v3' });
  });

  it('routes a native-quoted Uniswap V4 pool', () => {
    const c = classifyPool(pool({ label: 'v4', pairAddress: v4Id('a'), quoteToken: NATIVE }), TOKEN);
    expect(c).toMatchObject({ routable: true, family: 'uniswap_v4' });
  });

  it('refuses a USDG-quoted pool as quote_not_native rather than pretending it is unsupported', () => {
    // The distinction matters to an operator: this is a real, deep pool that a
    // native-ETH buy simply cannot reach in one hop.
    expect(classifyPool(pool({ quoteToken: USDG }), TOKEN)).toMatchObject({
      routable: false,
      reason: 'quote_not_native',
    });
  });

  it('refuses an unknown DEX', () => {
    expect(classifyPool(pool({ dexId: 'flapsh', label: '' }), TOKEN)).toMatchObject({
      routable: false,
      reason: 'unsupported_dex',
    });
  });

  it('refuses a V2-era pair (no version label, no V2 executor)', () => {
    expect(classifyPool(pool({ label: '' }), TOKEN)).toMatchObject({ routable: false, reason: 'unsupported_dex' });
  });

  it('refuses a V3 entry carrying a 32-byte poolId — that is a mislabelled V4 pool', () => {
    expect(classifyPool(pool({ pairAddress: v4Id('b') }), TOKEN)).toMatchObject({
      routable: false,
      reason: 'malformed',
    });
  });

  it('refuses a V4 entry carrying a 20-byte address', () => {
    expect(classifyPool(pool({ label: 'v4', quoteToken: NATIVE }), TOKEN)).toMatchObject({
      routable: false,
      reason: 'malformed',
    });
  });

  it('refuses a pool that does not contain the token we asked about', () => {
    expect(classifyPool(pool({ baseToken: USDG, quoteToken: WETH_ADDRESS }), TOKEN)).toMatchObject({
      routable: false,
      reason: 'malformed',
    });
  });

  it('handles the token being the QUOTE side of the pair', () => {
    expect(classifyPool(pool({ baseToken: WETH_ADDRESS, quoteToken: TOKEN }), TOKEN)).toMatchObject({
      routable: true,
      family: 'uniswap_v3',
    });
  });

  it('compares addresses case-insensitively — DexScreener returns EIP-55 casing', () => {
    expect(classifyPool(pool({ baseToken: TOKEN.toUpperCase().replace('0X', '0x') }), TOKEN)).toMatchObject({
      routable: true,
    });
  });
});

describe('rankPools — deepest first', () => {
  it('orders by liquidity descending', () => {
    const ranked = rankPools(
      [pool({ liquidityUsd: 32 }), pool({ liquidityUsd: 27_000 }), pool({ liquidityUsd: 5_000 })],
      TOKEN,
    );
    expect(ranked.map((c) => c.pool.liquidityUsd)).toEqual([27_000, 5_000, 32]);
  });

  it('ranks UNROUTABLE pools too, so the operator can see what was passed over', () => {
    const ranked = rankPools(
      [pool({ liquidityUsd: 1_000 }), pool({ liquidityUsd: 50_000, quoteToken: USDG })],
      TOKEN,
    );
    expect(ranked[0]).toMatchObject({ routable: false, reason: 'quote_not_native' });
    expect(ranked[0].pool.liquidityUsd).toBe(50_000);
    // …and the chosen route is still the deepest one we can actually execute.
    expect(bestRoutable(ranked)?.pool.liquidityUsd).toBe(1_000);
  });

  it('picks the deepest routable pool given several candidates', () => {
    const ranked = rankPools(
      [
        pool({ liquidityUsd: 0.82, pairAddress: '0x' + '1'.repeat(40) }),
        pool({ liquidityUsd: 13_775, pairAddress: '0x' + '2'.repeat(40) }),
        pool({ liquidityUsd: 12.22, pairAddress: '0x' + '3'.repeat(40) }),
      ],
      TOKEN,
    );
    expect(bestRoutable(ranked)?.pool.liquidityUsd).toBe(13_775);
  });

  it('does not mutate its input', () => {
    const input = [pool({ liquidityUsd: 1 }), pool({ liquidityUsd: 9 })];
    rankPools(input, TOKEN);
    expect(input.map((p) => p.liquidityUsd)).toEqual([1, 9]);
  });
});

describe('parseDexScreenerPools — untrusted third-party shape', () => {
  it('keeps only this chain and normalises the version label', () => {
    const parsed = parseDexScreenerPools({
      pairs: [
        { chainId: 'robinhood', dexId: 'uniswap', labels: ['V3'], pairAddress: '0xabc', liquidity: { usd: 100 }, baseToken: { address: TOKEN }, quoteToken: { address: WETH_ADDRESS } },
        { chainId: 'base', dexId: 'uniswap', labels: ['v3'], pairAddress: '0xdef', liquidity: { usd: 999_999 }, baseToken: { address: TOKEN }, quoteToken: { address: WETH_ADDRESS } },
      ],
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0].label).toBe('v3');
  });

  it('normalises missing/NaN liquidity to 0 so it can never win a "deepest" comparison', () => {
    const parsed = parseDexScreenerPools({
      pairs: [{ chainId: 'robinhood', dexId: 'uniswap', labels: ['v3'], pairAddress: '0xabc', baseToken: { address: TOKEN }, quoteToken: { address: WETH_ADDRESS } }],
    });
    expect(parsed[0].liquidityUsd).toBe(0);
  });

  it('survives every shape of junk without throwing', () => {
    expect(parseDexScreenerPools(null)).toEqual([]);
    expect(parseDexScreenerPools({})).toEqual([]);
    expect(parseDexScreenerPools({ pairs: 'nope' })).toEqual([]);
    expect(parseDexScreenerPools({ pairs: [null, 7, { chainId: 'robinhood' }] })).toEqual([]);
  });

  it('drops a pair with no version label into an empty label (which classifies as unsupported)', () => {
    const parsed = parseDexScreenerPools({
      pairs: [{ chainId: 'robinhood', dexId: 'ponsv2', pairAddress: '0xabc', liquidity: { usd: 5 }, baseToken: { address: TOKEN }, quoteToken: { address: WETH_ADDRESS } }],
    });
    expect(parsed[0].label).toBe('');
    expect(classifyPool(parsed[0], TOKEN)).toMatchObject({ routable: false, reason: 'unsupported_dex' });
  });
});

describe('readV4PoolKey — recovering a PoolKey from an Initialize log', () => {
  const poolId = v4Id('4');

  it('decodes currencies from topics and fee/tickSpacing/hooks from data', async () => {
    const rpc = stubRpc({
      getLogs: async (p) => {
        expect(p.address).toBe(UNISWAP_V4_POOL_MANAGER);
        expect(p.topics).toEqual([V4_INITIALIZE_TOPIC, poolId]);
        return [
          {
            topics: [
              V4_INITIALIZE_TOPIC,
              poolId,
              '0x' + '0'.repeat(64),
              '0x' + '0'.repeat(24) + TOKEN.slice(2),
            ],
            data:
              '0x' +
              (0).toString(16).padStart(64, '0') + // fee
              (200).toString(16).padStart(64, '0') + // tickSpacing
              '0'.repeat(24) + 'e5e702641ea86f4ae6cc3cdaed2b886f976be044', // hooks
          },
        ];
      },
    });
    expect(await readV4PoolKey(rpc, poolId)).toEqual({
      currency0: '0x' + '0'.repeat(40),
      currency1: TOKEN,
      fee: 0,
      tickSpacing: 200,
      hooks: '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044',
    });
  });

  it('decodes a negative tickSpacing as int24, not as a colossal unsigned number', () => {
    // Never seen in practice, but decoding it unsigned would hash to the wrong
    // poolId and the swap would revert with nothing to point at.
    const twosComplementMinusOne = 'f'.repeat(64);
    return expect(
      readV4PoolKey(
        stubRpc({
          getLogs: async () => [
            {
              topics: [V4_INITIALIZE_TOPIC, poolId, '0x' + '0'.repeat(64), '0x' + '0'.repeat(24) + TOKEN.slice(2)],
              data: '0x' + '0'.repeat(64) + twosComplementMinusOne + '0'.repeat(64),
            },
          ],
        }),
        poolId,
      ),
    ).resolves.toMatchObject({ tickSpacing: -1 });
  });

  it('returns null (pool not routable) instead of throwing when no log exists', async () => {
    expect(await readV4PoolKey(stubRpc({ getLogs: async () => [] }), poolId)).toBeNull();
  });
});

describe('resolveRoute — discovery, ranking and on-chain enrichment together', () => {
  it('picks the deepest routable pool and reads its fee tier', async () => {
    const decision = await resolveRoute(TOKEN, {
      rpc: stubRpc({ call: async () => '0x' + (10_000).toString(16).padStart(64, '0') }),
      fetchPools: async () => [
        pool({ liquidityUsd: 6_644, pairAddress: '0x' + 'a'.repeat(40) }),
        pool({ liquidityUsd: 31_276, pairAddress: '0x' + 'b'.repeat(40) }),
      ],
    });
    expect(decision.route).toEqual({
      family: 'uniswap_v3',
      poolAddress: '0x' + 'b'.repeat(40),
      fee: 10_000,
      liquidityUsd: 31_276,
    });
  });

  it('falls through to the next routable pool when the deepest will not enrich', async () => {
    let firstCall = true;
    const decision = await resolveRoute(TOKEN, {
      // The deepest pool's fee() returns empty (not a V3 pool after all).
      rpc: stubRpc({
        call: async () => {
          if (firstCall) { firstCall = false; return '0x'; }
          return '0x' + (3_000).toString(16).padStart(64, '0');
        },
      }),
      fetchPools: async () => [
        pool({ liquidityUsd: 50_000, pairAddress: '0x' + 'c'.repeat(40) }),
        pool({ liquidityUsd: 9_000, pairAddress: '0x' + 'd'.repeat(40) }),
      ],
    });
    expect(decision.route).toMatchObject({ poolAddress: '0x' + 'd'.repeat(40), fee: 3_000 });
  });

  it('returns route:null — but still every candidate — when nothing is routable', async () => {
    const decision = await resolveRoute(TOKEN, {
      rpc: stubRpc(),
      fetchPools: async () => [pool({ liquidityUsd: 90_000, quoteToken: USDG })],
    });
    expect(decision.route).toBeNull();
    expect(decision.deepest?.liquidityUsd).toBe(90_000);
    expect(describeCandidates(decision.candidates)).toContain('quote_not_native');
  });

  it('returns route:null for a token with no pools at all', async () => {
    const decision = await resolveRoute(TOKEN, { rpc: stubRpc(), fetchPools: async () => [] });
    expect(decision.route).toBeNull();
    expect(decision.deepest).toBeNull();
    expect(describeCandidates(decision.candidates)).toBe('no pools found');
  });
});
