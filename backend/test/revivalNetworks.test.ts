import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REVIVAL_NETWORKS,
  buildRevivalContractUrl,
  isRevivalNetwork,
  revivalNetworkForChain,
  revivalNetworkLabel,
} from '@oct/shared';
import type { ContractLinkTemplates } from '@oct/shared';
import { parseRevivalNetworks } from '../src/revival/networks.js';
import {
  DEFAULT_REQUEST_SPACING_MS,
  GECKOTERMINAL_RATE_LIMIT_PER_MIN,
  _clearPoolCacheForTest,
  _setRequestSpacingForTest,
  fetchRevivalCandles,
  resolveTopPool,
} from '../src/revival/candles.js';
import {
  DEFAULT_POLL_MS,
  MAX_TOKENS_PER_CYCLE,
  planRevivalCycle,
} from '../src/revival/poller.js';

// The Robinhood Chain token whose revival the Solana-only universe could never
// see (ATR z 3.4, RVOL 16.3x at ~$1.45M mcap, 3.4x after) — the case this
// whole change exists for.
const UP_ADDRESS = '0x57c0e45cb534413d1c20a4240955d6bb250bb4f1';

describe('revival network mapping', () => {
  it('maps every chain the detector supports', () => {
    expect(revivalNetworkForChain('sol')).toBe('solana');
    expect(revivalNetworkForChain('evm', 'bsc')).toBe('bsc');
    expect(revivalNetworkForChain('evm', 'robinhood')).toBe('robinhood');
  });

  it('accepts the aliases the ingestion pipeline can produce', () => {
    expect(revivalNetworkForChain('evm', 'BSC')).toBe('bsc');
    expect(revivalNetworkForChain('evm', 'bnb')).toBe('bsc');
    expect(revivalNetworkForChain('evm', 'hood')).toBe('robinhood');
    expect(revivalNetworkForChain('solana')).toBe('solana');
  });

  it('skips unknown / unsupported / unresolved chains instead of throwing', () => {
    // A watched chain OCT knows but the revival detector does not.
    expect(revivalNetworkForChain('evm', 'base')).toBeNull();
    expect(revivalNetworkForChain('evm', 'eth')).toBeNull();
    // An EVM address whose background chain resolve hasn't landed yet.
    expect(revivalNetworkForChain('evm', undefined)).toBeNull();
    expect(revivalNetworkForChain('evm', null)).toBeNull();
    // Junk.
    expect(revivalNetworkForChain(null)).toBeNull();
    expect(revivalNetworkForChain('', '')).toBeNull();
    expect(revivalNetworkForChain('evm', 'not-a-chain')).toBeNull();
  });

  it('recognises exactly the supported network ids', () => {
    for (const n of REVIVAL_NETWORKS) expect(isRevivalNetwork(n)).toBe(true);
    expect(isRevivalNetwork('base')).toBe(false);
    expect(isRevivalNetwork(null)).toBe(false);
  });

  it('labels networks for display', () => {
    expect(revivalNetworkLabel('solana')).toBe('SOL');
    expect(revivalNetworkLabel('bsc')).toBe('BNB');
    expect(revivalNetworkLabel('robinhood')).toBe('HOOD');
    // An unknown value (an older row) still renders rather than blanking out.
    expect(revivalNetworkLabel('base')).toBe('BASE');
  });
});

describe('buildRevivalContractUrl', () => {
  const templates: ContractLinkTemplates = {
    evm: 'https://gmgn.ai/base/token/{address}',
    sol: 'https://axiom.trade/t/{address}?chain=sol',
    solPlatform: 'axiom',
    evmPlatform: 'gmgn',
  };

  it('opens an EVM revival on ITS chain, not the template default (base)', () => {
    expect(buildRevivalContractUrl(UP_ADDRESS, 'robinhood', templates)).toContain('/robinhood/');
    expect(buildRevivalContractUrl(UP_ADDRESS, 'robinhood', templates)).not.toContain('/base/');
    expect(buildRevivalContractUrl(UP_ADDRESS, 'bsc', templates)).toContain('/bsc/');
  });

  it('leaves Solana links alone', () => {
    const url = buildRevivalContractUrl('So11111111111111111111111111111111111111112', 'solana', templates);
    expect(url).toContain('axiom.trade');
  });

  it('falls back to address-shape routing for an unknown network', () => {
    expect(buildRevivalContractUrl(UP_ADDRESS, 'nonsense', templates)).toContain('gmgn.ai');
  });
});

describe('OCT_REVIVAL_NETWORKS parsing', () => {
  it('defaults to every supported network', () => {
    expect(parseRevivalNetworks(undefined)).toEqual([...REVIVAL_NETWORKS]);
    expect(parseRevivalNetworks('')).toEqual([...REVIVAL_NETWORKS]);
    expect(parseRevivalNetworks('   ')).toEqual([...REVIVAL_NETWORKS]);
  });

  it('turns a chain off without a deploy', () => {
    expect(parseRevivalNetworks('solana')).toEqual(['solana']);
    expect(parseRevivalNetworks('solana, robinhood')).toEqual(['solana', 'robinhood']);
  });

  it('ignores unsupported ids rather than throwing, and never yields nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseRevivalNetworks('solana,ethereum')).toEqual(['solana']);
    expect(parseRevivalNetworks('ethereum,base')).toEqual([...REVIVAL_NETWORKS]);
    warn.mockRestore();
  });

  it('dedupes and normalises case', () => {
    expect(parseRevivalNetworks('SOLANA,solana,BSC')).toEqual(['solana', 'bsc']);
  });
});

// ---------------------------------------------------------------------------
// GeckoTerminal client — HTTP fully mocked, no live calls.
// ---------------------------------------------------------------------------

function poolsPayload(poolAddress: string, symbol: string) {
  return {
    data: [
      {
        attributes: {
          address: poolAddress,
          name: `${symbol} / WETH`,
          volume_usd: { h24: '12345' },
          base_token_price_usd: '0.5',
          fdv_usd: '1000000',
        },
      },
    ],
  };
}

function ohlcvPayload(rows: number[][]) {
  return { data: { attributes: { ohlcv_list: rows } } };
}

const NOW_S = Math.floor(Date.parse('2026-08-11T12:00:00.000Z') / 1000);
const MINUTE_ROWS = [[NOW_S - 120, 1, 1.1, 0.9, 1, 100]];
const HOUR_ROWS = [[NOW_S - 7200, 1, 1.1, 0.9, 1, 500]];

describe('GeckoTerminal candle client (mocked HTTP)', () => {
  let urls: string[];

  beforeEach(() => {
    _clearPoolCacheForTest();
    _setRequestSpacingForTest(0); // the queue's real 2.2s spacing is asserted separately
    urls = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      const body = url.includes('/pools?page=1')
        ? poolsPayload(`pool-for-${url.split('/networks/')[1].split('/')[0]}`, 'UP')
        : url.includes('/ohlcv/minute')
          ? ohlcvPayload(MINUTE_ROWS)
          : ohlcvPayload(HOUR_ROWS);
      return { ok: true, status: 200, json: async () => body };
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    _clearPoolCacheForTest();
  });

  it('addresses every endpoint on the requested network', async () => {
    const set = await fetchRevivalCandles('robinhood', UP_ADDRESS);
    expect(set).not.toBeNull();
    expect(urls[0]).toContain(`/networks/robinhood/tokens/${UP_ADDRESS}/pools?page=1`);
    expect(urls.some((u) => u.includes('/networks/robinhood/pools/') && u.includes('/ohlcv/minute'))).toBe(true);
    expect(urls.some((u) => u.includes('/networks/robinhood/pools/') && u.includes('/ohlcv/hour'))).toBe(true);
    expect(urls.every((u) => !u.includes('/networks/solana/'))).toBe(true);
  });

  it('keys the pool cache by network so two chains cannot collide', async () => {
    const bsc = await resolveTopPool('bsc', UP_ADDRESS);
    const hood = await resolveTopPool('robinhood', UP_ADDRESS);
    expect(bsc?.poolAddress).toBe('pool-for-bsc');
    expect(hood?.poolAddress).toBe('pool-for-robinhood');

    // Cached per network: a repeat costs no request, and does not serve the
    // other chain's pool.
    const before = urls.length;
    expect((await resolveTopPool('bsc', UP_ADDRESS))?.poolAddress).toBe('pool-for-bsc');
    expect(urls.length).toBe(before);
  });

  it('caches hour candles across cycles but always refetches minute candles', async () => {
    await fetchRevivalCandles('bsc', UP_ADDRESS);
    const firstHour = urls.filter((u) => u.includes('/ohlcv/hour')).length;
    const firstMinute = urls.filter((u) => u.includes('/ohlcv/minute')).length;
    expect(firstHour).toBe(1);

    await fetchRevivalCandles('bsc', UP_ADDRESS);
    expect(urls.filter((u) => u.includes('/ohlcv/hour')).length).toBe(firstHour);
    expect(urls.filter((u) => u.includes('/ohlcv/minute')).length).toBe(firstMinute + 1);
  });

  it('negative-caches a token GeckoTerminal does not index', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    });
    expect(await resolveTopPool('robinhood', UP_ADDRESS)).toBeNull();
    const after = urls.length;
    expect(await resolveTopPool('robinhood', UP_ADDRESS)).toBeNull();
    expect(urls.length).toBe(after); // no second request within the miss TTL
  });
});

// ---------------------------------------------------------------------------
// Pacing guard. Prod ran 700ms spacing (~85 req/min) against a ~30 req/min
// ceiling and lived in the 429 backoff; the failure is SILENT (it looks like
// "no revivals are firing"), so the config has to be checked by a test.
// ---------------------------------------------------------------------------

describe('request pacing fits the GeckoTerminal budget', () => {
  const plan = planRevivalCycle(DEFAULT_REQUEST_SPACING_MS);

  it('stays under the documented keyless rate ceiling', () => {
    expect(plan.requestsPerMinute).toBeLessThanOrEqual(GECKOTERMINAL_RATE_LIMIT_PER_MIN);
  });

  it('fits a full steady-state cycle inside the poll interval, with headroom', () => {
    expect(plan.steadyStateRequests).toBeLessThanOrEqual(plan.slots);
    // ≥25% of the interval left over for retries, jitter and the tracker.
    expect(plan.steadyStateUtilization).toBeLessThanOrEqual(0.75);
  });

  it('keeps even the cold-cache first cycle within one extra interval', () => {
    // Cold start is allowed to spill (the `polling` guard skips the overlapping
    // tick), but never by more than a whole cycle or the poller never catches up.
    expect(plan.coldStartRequests).toBeLessThanOrEqual(plan.slots * 2);
  });

  it('would reject the configuration that caused the prod 429 storm', () => {
    const bad = planRevivalCycle(700, DEFAULT_POLL_MS, 40);
    expect(bad.requestsPerMinute).toBeGreaterThan(GECKOTERMINAL_RATE_LIMIT_PER_MIN);
  });

  it('sizes the per-cycle cap from the interval, not by hand', () => {
    // Guards an edit that raises the cap without re-checking the budget.
    const affordable = Math.floor(
      (plan.slots * 0.75 - 8) / 1.25,
    );
    expect(MAX_TOKENS_PER_CYCLE).toBeLessThanOrEqual(affordable);
  });
});
