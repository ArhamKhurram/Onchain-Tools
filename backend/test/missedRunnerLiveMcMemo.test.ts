import { describe, expect, it, vi } from 'vitest';
import { fetchLiveMcMemoized, type LiveMcResult } from '../src/alerts/missedRunnerPoller.js';

// The sweep-scoped live-MC memo: one upstream GMGN/DexScreener fetch (and one
// peak observation) per unique token per sweep, no matter how many users'
// candidate lists contain it.

const SOL = 'So11111111111111111111111111111111111111112';
const EVM = '0xAbCdEf1234567890abcdef1234567890ABCDEF12';

function makeDeps(result: LiveMcResult) {
  return {
    fetcher: vi.fn(async () => result),
    record: vi.fn(),
  };
}

describe('fetchLiveMcMemoized', () => {
  it('fetches once per unique token and reuses the result across users', async () => {
    const memo = new Map<string, LiveMcResult>();
    const deps = makeDeps({ mcNow: 123_000, mcNowDisplay: '$123K' });
    const token = { address: SOL, chain: 'sol' as const, evmChain: undefined };

    const first = await fetchLiveMcMemoized(memo, token, deps);
    const second = await fetchLiveMcMemoized(memo, token, deps); // user 2, same sweep
    const third = await fetchLiveMcMemoized(memo, token, deps); // user 3, same sweep

    expect(deps.fetcher).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('records the peak observation once per fresh fetch, never on memo hits', async () => {
    const memo = new Map<string, LiveMcResult>();
    const deps = makeDeps({ mcNow: 50_000 });
    const token = { address: EVM, chain: 'evm' as const, evmChain: 'base' };

    await fetchLiveMcMemoized(memo, token, deps);
    await fetchLiveMcMemoized(memo, token, deps);

    expect(deps.record).toHaveBeenCalledTimes(1);
    expect(deps.record).toHaveBeenCalledWith({
      address: EVM,
      chain: 'evm',
      evmChain: 'base',
      mcNow: 50_000,
    });
  });

  it('memoizes failed fetches too — a broken upstream is not re-hammered per user', async () => {
    const memo = new Map<string, LiveMcResult>();
    const deps = makeDeps(null);
    const token = { address: SOL, chain: 'sol' as const, evmChain: undefined };

    expect(await fetchLiveMcMemoized(memo, token, deps)).toBeNull();
    expect(await fetchLiveMcMemoized(memo, token, deps)).toBeNull();
    expect(deps.fetcher).toHaveBeenCalledTimes(1);
    expect(deps.record).not.toHaveBeenCalled();
  });

  it('does not record a peak for a zero/absent market cap', async () => {
    const memo = new Map<string, LiveMcResult>();
    const deps = makeDeps({ mcNow: 0 });
    await fetchLiveMcMemoized(memo, { address: SOL, chain: 'sol', evmChain: undefined }, deps);
    expect(deps.record).not.toHaveBeenCalled();
  });

  it('mixed-case addresses of the same token share one memo entry', async () => {
    const memo = new Map<string, LiveMcResult>();
    const deps = makeDeps({ mcNow: 10_000 });
    await fetchLiveMcMemoized(memo, { address: EVM, chain: 'evm', evmChain: 'base' }, deps);
    await fetchLiveMcMemoized(memo, { address: EVM.toLowerCase(), chain: 'evm', evmChain: 'base' }, deps);
    expect(deps.fetcher).toHaveBeenCalledTimes(1);
  });

  it('the same address on different chains is fetched separately', async () => {
    const memo = new Map<string, LiveMcResult>();
    const deps = makeDeps({ mcNow: 10_000 });
    await fetchLiveMcMemoized(memo, { address: EVM, chain: 'evm', evmChain: 'base' }, deps);
    await fetchLiveMcMemoized(memo, { address: EVM, chain: 'evm', evmChain: 'eth' }, deps);
    expect(deps.fetcher).toHaveBeenCalledTimes(2);
  });
});
