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
  GECKOTERMINAL_MAX_REQUESTS_PER_MIN,
  GECKOTERMINAL_SUSTAINED_REQUESTS_PER_MIN,
  _clearPoolCacheForTest,
  _setRequestSpacingForTest,
  currentSpacingMultiplier,
  fetchRevivalCandles,
  isBackedOff,
  resolveTopPool,
  revivalRequestCounters,
} from '../src/revival/candles.js';
import {
  DEFAULT_POLL_MS,
  MAX_TOKENS_PER_CYCLE,
  OUTCOME_TRACKER_RESERVED_REQUESTS,
  STEADY_STATE_REQUESTS_PER_TOKEN,
  formatCycleSummary,
  planRevivalCycle,
  seedRotationOffset,
  summarizeCycle,
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
    _setRequestSpacingForTest(0); // the queue's real 10s spacing is asserted separately
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
// 429 strategy. Measured behaviour (2026-08-11, two IPs): 429s arrive
// INTERMITTENTLY even at compliant rates — 5 of 12 at 5000ms spacing,
// interleaved with successes. So one 429 must re-queue that request and widen
// the spacing, NOT halt every revival fetch; only sustained failure may stop us.
// ---------------------------------------------------------------------------

describe('429 handling re-queues rather than halting', () => {
  beforeEach(() => {
    _clearPoolCacheForTest();
    _setRequestSpacingForTest(0);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    _clearPoolCacheForTest();
  });

  it('retries the individual request and still returns data', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 429, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => poolsPayload('pool-retry', 'UP'),
      };
    });

    const pool = await resolveTopPool('bsc', UP_ADDRESS);
    expect(pool?.poolAddress).toBe('pool-retry'); // the 429 did not lose the item
    expect(calls).toBe(2);
    expect(revivalRequestCounters().retried).toBe(1);
    warn.mockRestore();
  });

  it('does not pause every revival fetch on an isolated 429', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 429, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => poolsPayload('pool-ok', 'UP') };
    });

    await resolveTopPool('bsc', UP_ADDRESS);
    // The old behaviour was a 30s global halt here. The new behaviour is a
    // spacing widen that any subsequent chain can still fetch through.
    expect(isBackedOff()).toBe(false);
    expect(currentSpacingMultiplier()).toBeGreaterThan(1);
    expect(await resolveTopPool('robinhood', UP_ADDRESS)).not.toBeNull();
    warn.mockRestore();
  });

  it('recovers the spacing after a run of consecutive successes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 429, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => poolsPayload(`pool-${calls}`, 'UP') };
    });

    await resolveTopPool('bsc', UP_ADDRESS);
    expect(currentSpacingMultiplier()).toBeGreaterThan(1);
    // Four clean requests walk the slowdown back off (RECOVERY_SUCCESSES).
    for (const n of ['solana', 'robinhood'] as const) {
      await resolveTopPool(n, UP_ADDRESS);
      await fetchRevivalCandles(n, `${UP_ADDRESS}-other`);
    }
    expect(currentSpacingMultiplier()).toBe(1);
    warn.mockRestore();
  });

  it('still backs off hard when failure is sustained, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 429, json: async () => ({}) }));

    // Every request refused: the rolling failure rate passes 50% over the
    // minimum sample count and the safety valve trips.
    for (let i = 0; i < 6 && !isBackedOff(); i++) {
      await resolveTopPool('bsc', `${UP_ADDRESS}-${i}`);
    }
    expect(isBackedOff()).toBe(true);
    expect(warn.mock.calls.flat().join(' ')).toContain('sustained rate limiting');

    // And once backed off we genuinely stop asking.
    const before = revivalRequestCounters().sent;
    await resolveTopPool('solana', `${UP_ADDRESS}-after`);
    expect(revivalRequestCounters().sent).toBe(before);
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Pacing guard. The ceiling this subsystem was built around (~30 req/min) was
// never measured and was wrong by ~4x; prod was cut off at 6 req/60s. The
// failure is SILENT (it looks like "no revivals are firing"), so both the
// config and the coverage reporting have to be checked by a test.
// ---------------------------------------------------------------------------

describe('request pacing fits the MEASURED GeckoTerminal budget', () => {
  const plan = planRevivalCycle(DEFAULT_REQUEST_SPACING_MS);

  it('paces to the measured sustainable rate, not the ~30/min myth', () => {
    expect(DEFAULT_REQUEST_SPACING_MS).toBe(10_000);
    expect(plan.requestsPerMinute).toBe(GECKOTERMINAL_SUSTAINED_REQUESTS_PER_MIN);
    expect(plan.requestsPerMinute).toBeLessThanOrEqual(GECKOTERMINAL_MAX_REQUESTS_PER_MIN);
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

  it('rejects both configurations prod has actually shipped', () => {
    // #113-era: 700ms spacing, 40 tokens.
    expect(planRevivalCycle(700, 150_000, 40).requestsPerMinute).toBeGreaterThan(
      GECKOTERMINAL_MAX_REQUESTS_PER_MIN,
    );
    // #121-era: 2200ms spacing, 24 tokens, 150s interval — the config this
    // change replaces. ~27 req/min against a measured ~6-8.
    const shipped = planRevivalCycle(2200, 150_000, 24);
    expect(shipped.requestsPerMinute).toBeGreaterThan(GECKOTERMINAL_MAX_REQUESTS_PER_MIN);
  });

  it('sizes the per-cycle cap from the interval, not by hand', () => {
    // Guards an edit that raises the cap without re-checking the budget.
    const affordable = Math.floor(
      (plan.slots * 0.75 - OUTCOME_TRACKER_RESERVED_REQUESTS) / STEADY_STATE_REQUESTS_PER_TOKEN,
    );
    expect(MAX_TOKENS_PER_CYCLE).toBeLessThanOrEqual(affordable);
  });

  it('sweeps a realistic universe inside the latency the PR promises', () => {
    const sweepMinutes = (size: number) =>
      (Math.ceil(size / MAX_TOKENS_PER_CYCLE) * DEFAULT_POLL_MS) / 60_000;
    // Cap 13 since the tracker reserve was doubled for the second default-on
    // alert class (breakout outcomes share the queue) — one cycle slower on a
    // 30-token universe than the revival-only cap of 15.
    expect(sweepMinutes(30)).toBe(15);
    expect(sweepMinutes(100)).toBe(40);
    // Revival runs last tens of minutes to hours, so a sweep measured in
    // minutes is fine — never reaching the tail at all is not.
    expect(sweepMinutes(30)).toBeLessThanOrEqual(15);
  });
});

// ---------------------------------------------------------------------------
// Coverage reporting. The operator runs multi-day bakes off these numbers;
// a rate-limited poller and a quiet market must not produce the same log.
// ---------------------------------------------------------------------------

describe('per-cycle coverage summary', () => {
  it('extrapolates the sweep from what was actually scanned', () => {
    const s = summarizeCycle({
      universeSize: 37,
      scanned: 15,
      requests: 19,
      rateLimited: 2,
      pollMs: DEFAULT_POLL_MS,
      pausedEarly: false,
    });
    expect(s.fullSweepMs).toBe(3 * DEFAULT_POLL_MS); // ceil(37/15) cycles
    expect(formatCycleSummary(s)).toBe(
      '[RevivalPoller] cycle: 15/37 tokens scanned, 19 requests, 2 rate-limited, full sweep ~15min',
    );
  });

  it('reports the SLOWER sweep a rate-limited cycle is really achieving', () => {
    const healthy = summarizeCycle({
      universeSize: 60,
      scanned: 15,
      requests: 19,
      rateLimited: 0,
      pollMs: DEFAULT_POLL_MS,
      pausedEarly: false,
    });
    const starved = summarizeCycle({
      universeSize: 60,
      scanned: 4,
      requests: 9,
      rateLimited: 5,
      pollMs: DEFAULT_POLL_MS,
      pausedEarly: true,
    });
    expect(starved.fullSweepMs!).toBeGreaterThan(healthy.fullSweepMs!);
    expect(formatCycleSummary(starved)).toContain('paused early');
  });

  it('surfaces drawdown-blocked tokens, and only when the gate held something', () => {
    // The drawdown gate has no persisted column (no migration), so this line
    // is the only record of how often it is rejecting consolidations.
    const base = {
      universeSize: 20,
      scanned: 15,
      requests: 19,
      rateLimited: 0,
      pollMs: DEFAULT_POLL_MS,
      pausedEarly: false,
    };
    const held = summarizeCycle({ ...base, drawdownBlocked: 2 });
    expect(held.drawdownBlocked).toBe(2);
    expect(formatCycleSummary(held)).toContain('2 drawdown-blocked');
    // Omitted (pre-gate caller shape) defaults to 0 and stays off the line.
    const quiet = summarizeCycle(base);
    expect(quiet.drawdownBlocked).toBe(0);
    expect(formatCycleSummary(quiet)).not.toContain('drawdown');
  });

  it('refuses to invent a sweep time for a cycle that scanned nothing', () => {
    const s = summarizeCycle({
      universeSize: 40,
      scanned: 0,
      requests: 0,
      rateLimited: 3,
      pollMs: DEFAULT_POLL_MS,
      pausedEarly: true,
    });
    expect(s.fullSweepMs).toBeNull();
    expect(formatCycleSummary(s)).toContain('STALLED');
  });
});

describe('rotation fairness across restarts', () => {
  it('does not restart every boot at the head of the universe', () => {
    const keys = 37;
    // Two boots five cycles apart must not land on the same token.
    const bootA = seedRotationOffset(keys, MAX_TOKENS_PER_CYCLE, DEFAULT_POLL_MS, 0);
    const bootB = seedRotationOffset(
      keys,
      MAX_TOKENS_PER_CYCLE,
      DEFAULT_POLL_MS,
      5 * DEFAULT_POLL_MS,
    );
    expect(bootA).toBe(0);
    expect(bootB).toBe((5 * MAX_TOKENS_PER_CYCLE) % keys);
    expect(bootB).not.toBe(bootA);
  });

  it('advances at the same rate a process that never restarted would have', () => {
    const keys = 50;
    const at = (cycle: number) =>
      seedRotationOffset(keys, MAX_TOKENS_PER_CYCLE, DEFAULT_POLL_MS, cycle * DEFAULT_POLL_MS);
    // Consecutive boots differ by exactly one cycle's worth of tokens.
    expect((at(4) - at(3) + keys) % keys).toBe(MAX_TOKENS_PER_CYCLE % keys);
  });

  it('stays a valid index for any universe size', () => {
    for (const keys of [1, 3, 15, 16, 200]) {
      const o = seedRotationOffset(keys, MAX_TOKENS_PER_CYCLE, DEFAULT_POLL_MS, 1_754_000_000_000);
      expect(o).toBeGreaterThanOrEqual(0);
      expect(o).toBeLessThan(keys);
    }
    expect(seedRotationOffset(0)).toBe(0);
  });
});
