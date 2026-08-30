/**
 * Broad-tier universe — the market-wide discovery that the feed tier structurally cannot do.
 *
 * The case these tests are written against is real. CHILL sat quiet on Robinhood Chain for 19 days
 * and then ran to $3.96M on $1.45M of 24h volume with ~$177K of liquidity. The chain was watched,
 * GeckoTerminal indexed it, and the detector never saw it — because the universe only contains
 * tokens someone posted in a monitored room within 48 hours. So the first thing pinned here is
 * that CHILL's own numbers clear the floor.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  broadMaxPerNetwork,
  broadMinLiquidityUsd,
  isBroadTierEnabled,
  parsePoolsPage,
} from '../src/revival/broadUniverse.js';

const ENV_KEYS = [
  'OCT_REVIVAL_BROAD_TIER',
  'TRENCHCORD_REVIVAL_BROAD_TIER',
  'OCT_REVIVAL_BROAD_MAX_PER_NETWORK',
  'OCT_REVIVAL_BROAD_MIN_LIQUIDITY_USD',
];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function pool(opts: {
  id: string;
  liquidity: number | string | null;
  volume: number | string | null;
}) {
  return {
    attributes: {
      reserve_in_usd: opts.liquidity,
      volume_usd: { h24: opts.volume },
    },
    relationships: { base_token: { data: { id: opts.id } } },
  };
}

describe('parsePoolsPage', () => {
  it('would have surfaced CHILL', () => {
    const json = {
      data: [
        pool({
          id: 'robinhood_0xbbf2c91fdcc488ba736e0c38adc82c9a92597deb',
          liquidity: 177_215.56,
          volume: 1_452_045.77,
        }),
      ],
    };
    const out = parsePoolsPage(json, 'robinhood', 15_000);
    expect(out).toHaveLength(1);
    expect(out[0]?.address).toBe('0xbbf2c91fdcc488ba736e0c38adc82c9a92597deb');
    expect(out[0]?.network).toBe('robinhood');
  });

  it('strips the network prefix without mangling the address', () => {
    const out = parsePoolsPage(
      { data: [pool({ id: 'solana_So11111111111111111111111111111111111111112', liquidity: 1e6, volume: 1e6 })] },
      'solana',
      15_000,
    );
    expect(out[0]?.address).toBe('So11111111111111111111111111111111111111112');
  });

  it('drops pools below the liquidity floor', () => {
    const json = {
      data: [
        pool({ id: 'bsc_0xdeep', liquidity: 50_000, volume: 100_000 }),
        pool({ id: 'bsc_0xthin', liquidity: 900, volume: 100_000 }),
      ],
    };
    const out = parsePoolsPage(json, 'bsc', 15_000);
    expect(out.map((t) => t.address)).toEqual(['0xdeep']);
  });

  it('drops non-positive and unparseable reserves rather than treating them as tiny', () => {
    // Both shapes occur in real GeckoTerminal responses for mid-migration pools.
    const json = {
      data: [
        pool({ id: 'robinhood_0xnegative', liquidity: -102_384, volume: 11_487_081 }),
        pool({ id: 'robinhood_0xzero', liquidity: 0, volume: 11_642_325 }),
        pool({ id: 'robinhood_0xnull', liquidity: null, volume: 1_000_000 }),
      ],
    };
    expect(parsePoolsPage(json, 'robinhood', 15_000)).toEqual([]);
  });

  it('drops pools with no traded volume — depth alone is not a revival candidate', () => {
    const json = { data: [pool({ id: 'bsc_0xidle', liquidity: 5_000_000, volume: 0 })] };
    expect(parsePoolsPage(json, 'bsc', 15_000)).toEqual([]);
  });

  it('survives a malformed or empty response instead of throwing', () => {
    expect(parsePoolsPage(null, 'solana', 15_000)).toEqual([]);
    expect(parsePoolsPage({}, 'solana', 15_000)).toEqual([]);
    expect(parsePoolsPage({ data: [{}] }, 'solana', 15_000)).toEqual([]);
    expect(parsePoolsPage({ data: [pool({ id: '', liquidity: 1e6, volume: 1e6 })] }, 'solana', 15_000)).toEqual([]);
  });
});

describe('configuration', () => {
  it('is OFF unless explicitly enabled', () => {
    // Enabling it multiplies how many tokens compete for a ~6-8 req/min budget, so the default
    // has to be off until Solana and BNB have moved to Pinax.
    expect(isBroadTierEnabled()).toBe(false);
  });

  it('accepts 1 and true, and nothing else', () => {
    process.env.OCT_REVIVAL_BROAD_TIER = '1';
    expect(isBroadTierEnabled()).toBe(true);
    process.env.OCT_REVIVAL_BROAD_TIER = 'true';
    expect(isBroadTierEnabled()).toBe(true);
    process.env.OCT_REVIVAL_BROAD_TIER = 'yes';
    expect(isBroadTierEnabled()).toBe(false);
    process.env.OCT_REVIVAL_BROAD_TIER = '0';
    expect(isBroadTierEnabled()).toBe(false);
  });

  it('honours the TRENCHCORD_ fallback', () => {
    process.env.TRENCHCORD_REVIVAL_BROAD_TIER = '1';
    expect(isBroadTierEnabled()).toBe(true);
  });

  it('has a bounded default cap and floor', () => {
    expect(broadMaxPerNetwork()).toBe(40);
    expect(broadMinLiquidityUsd()).toBe(15_000);
  });

  it('takes overrides but ignores nonsense', () => {
    process.env.OCT_REVIVAL_BROAD_MAX_PER_NETWORK = '10';
    expect(broadMaxPerNetwork()).toBe(10);
    process.env.OCT_REVIVAL_BROAD_MAX_PER_NETWORK = 'lots';
    expect(broadMaxPerNetwork()).toBe(40);
    process.env.OCT_REVIVAL_BROAD_MIN_LIQUIDITY_USD = '-5';
    expect(broadMinLiquidityUsd()).toBe(15_000);
  });
});
