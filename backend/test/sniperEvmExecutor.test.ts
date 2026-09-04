import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EvmUniswapExecutor, classifySendFailure, ethToWei } from '../src/sniper/executors/evmUniswap';
import { readEvmSniperConfig } from '../src/sniper/evm/config';
import type { EvmRpc, SimCallResult } from '../src/sniper/evm/rpc';
import { WETH_ADDRESS } from '../src/sniper/evm/chain';
import type { FireIntent, FireLeg } from '../src/sniper/types';

const TOKEN = '0x79fe86b963255ce884bdcac6388c50a599ba277f';

const intent: FireIntent = {
  ruleId: 'evm-telegram-trigger',
  userId: 'local',
  chain: 'rhc',
  venue: 'evm_uniswap',
  mint: TOKEN,
  triggerKey: TOKEN,
  legs: [],
  slippageBps: 500,
  exec: { kind: 'evm', mevRelay: null },
};
const leg: FireLeg = { walletId: 'evm-rhc-env-key', legNo: 0, amount: 0.01 };

const ok = (returnData = '0x'): SimCallResult => ({ status: '0x1', returnData });
const tokensOut = (n: bigint): SimCallResult => ok('0x' + n.toString(16).padStart(64, '0'));

/** An RPC that throws on everything, so a passing test proves nothing was queried. */
const hostileRpc: EvmRpc = {
  call: async () => { throw new Error('the executor must not have reached the network'); },
  getLogs: async () => { throw new Error('the executor must not have reached the network'); },
  simulate: async () => { throw new Error('the executor must not have reached the network'); },
};

/** A healthy read path: a deep V3 pool, a clean round trip. */
function healthyRpc(): EvmRpc {
  let n = 0;
  return {
    call: async () => '0x' + (10_000).toString(16).padStart(64, '0'), // fee()
    getLogs: async () => [],
    simulate: async () => (n++ === 0 ? [ok(), tokensOut(1_000_000n)] : [ok(), ok(), ok()]),
  };
}
const healthyPools = async () => [
  {
    dexId: 'uniswap',
    label: 'v3',
    pairAddress: '0x' + 'b'.repeat(40),
    liquidityUsd: 30_000,
    baseToken: TOKEN,
    quoteToken: WETH_ADDRESS,
  },
];

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('the module does not touch the key at import time', () => {
  it('imports cleanly with no SNIPER_EVM_PRIVATE_KEY set', async () => {
    const saved = process.env.SNIPER_EVM_PRIVATE_KEY;
    delete process.env.SNIPER_EVM_PRIVATE_KEY;
    try {
      // A throw here would take the whole server down over a variable that is
      // legitimately absent until the operator sets it.
      await expect(import('../src/sniper/executors/evmUniswap')).resolves.toBeDefined();
    } finally {
      if (saved !== undefined) process.env.SNIPER_EVM_PRIVATE_KEY = saved;
    }
  });

  it('constructs without a key and without reading one', () => {
    const readKey = vi.fn(() => undefined);
    // eslint-disable-next-line no-new
    new EvmUniswapExecutor({ config: readEvmSniperConfig({}), rpc: hostileRpc, readKey });
    // The constructor stores the READER, never its result.
    expect(readKey).not.toHaveBeenCalled();
  });

  it('never holds the key on the instance', async () => {
    const secret = `0x${'ab'.repeat(32)}`;
    const ex = new EvmUniswapExecutor({
      config: readEvmSniperConfig({}),
      rpc: hostileRpc,
      readKey: () => secret,
    });
    // Enumerable state after construction carries nothing derived from the key.
    expect(JSON.stringify(ex)).not.toContain('abab');
  });
});

describe('an absent key refuses to fire, clearly', () => {
  it('returns a dead/auth outcome and makes no network call', async () => {
    const ex = new EvmUniswapExecutor({
      config: readEvmSniperConfig({}),
      rpc: hostileRpc,
      readKey: () => undefined,
      fetchPools: async () => { throw new Error('must not discover pools without a key'); },
    });
    // `dead`, not `unknown`: nothing was built, nothing signed, nothing sent —
    // which is exactly the "provably unsubmitted" precondition executeFire
    // requires before it will release the reservation.
    expect(await ex.send(intent, leg, 'c1')).toEqual({ kind: 'dead', reason: 'auth', status: 0 });
  });

  it('says so on the log line, without printing anything about the key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ex = new EvmUniswapExecutor({
      config: readEvmSniperConfig({}), rpc: hostileRpc, readKey: () => undefined,
    });
    await ex.send(intent, leg, 'c1');
    const line = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(line).toContain('SNIPER_EVM_PRIVATE_KEY is not set');
    expect(line).toContain('No transaction was built');
  });

  it('refuses a malformed key WITHOUT echoing it', async () => {
    const badKey = 'not-a-key-but-still-secret-material';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ex = new EvmUniswapExecutor({
      config: readEvmSniperConfig({}), rpc: hostileRpc, readKey: () => badKey,
    });
    expect(await ex.send(intent, leg, 'c1')).toEqual({ kind: 'dead', reason: 'auth', status: 0 });
    const line = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(line).not.toContain(badKey);
    expect(line).not.toContain('secret-material');
  });

  it('treats a whitespace-only env value as absent (default reader)', async () => {
    const saved = process.env.SNIPER_EVM_PRIVATE_KEY;
    process.env.SNIPER_EVM_PRIVATE_KEY = '   ';
    try {
      const ex = new EvmUniswapExecutor({ config: readEvmSniperConfig({}), rpc: hostileRpc });
      expect(await ex.send(intent, leg, 'c1')).toEqual({ kind: 'dead', reason: 'auth', status: 0 });
    } finally {
      if (saved === undefined) delete process.env.SNIPER_EVM_PRIVATE_KEY;
      else process.env.SNIPER_EVM_PRIVATE_KEY = saved;
    }
  });
});

describe('refusals that happen before any signing', () => {
  const key = `0x${'11'.repeat(32)}`;

  it('refuses when no pool is routable', async () => {
    const ex = new EvmUniswapExecutor({
      config: readEvmSniperConfig({}),
      rpc: healthyRpc(),
      readKey: () => key,
      fetchPools: async () => [],
    });
    expect(await ex.send(intent, leg, 'c1')).toEqual({ kind: 'dead', reason: 'validation', status: 0 });
  });

  it('reports a discovery outage as `network` (retryable) rather than a bad token', async () => {
    const ex = new EvmUniswapExecutor({
      config: readEvmSniperConfig({}),
      rpc: healthyRpc(),
      readKey: () => key,
      fetchPools: async () => { throw new Error('DexScreener HTTP 502'); },
    });
    expect(await ex.send(intent, leg, 'c1')).toEqual({ kind: 'dead', reason: 'network', status: 0 });
  });

  it('refuses when a pre-trade gate rejects — and never reaches the signer', async () => {
    const ex = new EvmUniswapExecutor({
      // A $1,000,000 floor no pool on this chain clears.
      config: readEvmSniperConfig({ SNIPER_EVM_MIN_LIQUIDITY_USD: '1000000' }),
      rpc: healthyRpc(),
      readKey: () => key,
      fetchPools: healthyPools,
    });
    expect(await ex.send(intent, leg, 'c1')).toEqual({ kind: 'dead', reason: 'validation', status: 0 });
  });

  it('refuses when the key derives a different address than SNIPER_EVM_WALLET_ADDRESS declares', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ex = new EvmUniswapExecutor({
      config: readEvmSniperConfig({
        SNIPER_EVM_WALLET_ADDRESS: '0x1111111111111111111111111111111111111111',
      }),
      rpc: healthyRpc(),
      readKey: () => key,
      fetchPools: healthyPools,
    });
    // Rotating a key without updating the config would otherwise fire from an
    // address nobody funded, sized or capped.
    expect(await ex.send(intent, leg, 'c1')).toEqual({ kind: 'dead', reason: 'validation', status: 0 });
    expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('SNIPER_EVM_WALLET_ADDRESS');
  });

  it('refuses a leg amount that cannot become a positive wei value', async () => {
    const ex = new EvmUniswapExecutor({
      config: readEvmSniperConfig({}), rpc: hostileRpc, readKey: () => key,
    });
    expect(await ex.send(intent, { ...leg, amount: 0 }, 'c1')).toEqual({
      kind: 'dead', reason: 'validation', status: 0,
    });
  });
});

describe('the executor declares what it can serve', () => {
  it('is the evm_uniswap venue on Robinhood Chain only', () => {
    const ex = new EvmUniswapExecutor({ config: readEvmSniperConfig({}), rpc: hostileRpc });
    expect(ex.venue).toBe('evm_uniswap');
    expect(ex.chains).toEqual(['rhc']);
    // The registry refuses to route a rule whose chain the executor omits, so
    // this is what stops a `bsc` rule reaching Robinhood pools.
    expect(ex.chains).not.toContain('bsc');
    expect(ex.chains).not.toContain('sol');
  });
});

describe('ethToWei', () => {
  it('converts the operator default exactly', () => {
    expect(ethToWei(0.01)).toBe(10_000_000_000_000_000n);
  });

  it('truncates a repeating ladder split DOWN, never up', () => {
    // Rounding up would put the wei amount above the reservation executeFire
    // already took. The double `0.1/3` is exactly
    // 0.03333333333333333287074046406180..., so a truncating conversion must
    // land on ...332 and a rounding one lands on ...333.
    expect(ethToWei(0.1 / 3)).toBe(33_333_333_333_333_332n);
  });

  it('never exceeds the exact value of the double it was given', () => {
    for (const v of [0.01, 0.1 / 3, 0.3, 0.007, 0.02 / 7]) {
      // Reconstruct the exact decimal expansion of the double and floor it to
      // 18 places. (Every value here is < 1, so the integer part is always 0.)
      const exact = BigInt(v.toFixed(30).split('.')[1].slice(0, 18));
      expect(ethToWei(v)).toBeLessThanOrEqual(exact);
      // …and it is not so conservative as to be wrong: within one wei.
      expect(exact - ethToWei(v)).toBeLessThanOrEqual(1n);
    }
  });

  it('refuses junk with 0 rather than a guess', () => {
    expect(ethToWei(0)).toBe(0n);
    expect(ethToWei(-1)).toBe(0n);
    expect(ethToWei(Number.NaN)).toBe(0n);
    expect(ethToWei(Number.POSITIVE_INFINITY)).toBe(0n);
  });
});

describe('classifySendFailure — only provable non-submission may be retried', () => {
  it.each([
    ['ECONNREFUSED', { code: 'ECONNREFUSED' }],
    ['ENOTFOUND', { code: 'ENOTFOUND' }],
    ['EAI_AGAIN', { code: 'EAI_AGAIN' }],
  ])('%s is dead/network — the connection was never made', (_l, err) => {
    expect(classifySendFailure(err, 'c1')).toEqual({ kind: 'dead', reason: 'network', status: 0 });
  });

  it.each(['insufficient funds for gas', 'nonce too low', 'intrinsic gas too low', 'execution reverted'])(
    'a node rejection (%s) is dead/validation — it is in no mempool',
    (message) => {
      expect(classifySendFailure({ message }, 'c1')).toEqual({ kind: 'dead', reason: 'validation', status: 0 });
    },
  );

  it.each([
    ['socket hang up', { code: 'ECONNRESET', message: 'socket hang up' }],
    ['EPIPE', { code: 'EPIPE', message: 'write EPIPE' }],
    ['a timeout', { name: 'TimeoutError', message: 'timed out' }],
    ['anything unrecognised', { message: 'the sky fell' }],
  ])('%s is UNKNOWN — the bytes may already be out', (_l, err) => {
    // This is the whole double-buy defence: `dead` is what executeFire retries.
    expect(classifySendFailure(err, 'c1')).toEqual({ kind: 'unknown' });
  });
});
