import { describe, it, expect, vi } from 'vitest';
import {
  createChartCandleService,
  isChartAddress,
  parseChartLimit,
  parseChartNetwork,
  parseChartTimeframe,
  type ChartCandleFetcher,
  type ChartCandleResult,
} from '../src/charts/chartCandles';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const EVM = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';

const ok: ChartCandleResult = {
  status: 'ok',
  data: {
    source: 'geckoterminal',
    pool: { address: 'pool', symbol: 'SYM' },
    candles: [{ ts: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }],
  },
};

describe('param parsing', () => {
  it('maps GeckoTerminal ids and OCT chain slugs to a revival network', () => {
    expect(parseChartNetwork('solana')).toBe('solana');
    expect(parseChartNetwork('sol')).toBe('solana');
    expect(parseChartNetwork('BSC')).toBe('bsc');
    expect(parseChartNetwork('bnb')).toBe('bsc');
    expect(parseChartNetwork('hood')).toBe('robinhood');
  });

  it('rejects chains no candle source indexes', () => {
    for (const bad of ['eth', 'base', '', undefined, 42]) expect(parseChartNetwork(bad)).toBeNull();
  });

  it('accepts base58 and 0x addresses only', () => {
    expect(isChartAddress(SOL_MINT)).toBe(true);
    expect(isChartAddress(EVM)).toBe(true);
    for (const bad of ['', 'nope', '../x', '0x1234', `${SOL_MINT}/x`, 'l0OI00000000000000000000000000000']) {
      expect(isChartAddress(bad)).toBe(false);
    }
  });

  it('parses timeframes strictly', () => {
    expect(parseChartTimeframe('1m')).toBe('1m');
    expect(parseChartTimeframe('1h')).toBe('1h');
    for (const bad of ['5m', 'minute', '', undefined, ['1m']]) expect(parseChartTimeframe(bad)).toBeNull();
  });

  it('clamps the limit and falls back per timeframe', () => {
    expect(parseChartLimit(undefined, '1m')).toBe(300);
    expect(parseChartLimit(undefined, '1h')).toBe(168);
    expect(parseChartLimit('abc', '1h')).toBe(168);
    expect(parseChartLimit('0', '1m')).toBe(1);
    expect(parseChartLimit('5000', '1m')).toBe(1000);
    expect(parseChartLimit('250', '1m')).toBe(250);
  });
});

describe('createChartCandleService', () => {
  it('serves a cached answer inside the TTL and refetches after it', async () => {
    let now = 0;
    const fetcher = vi.fn<ChartCandleFetcher>(async () => ok);
    const svc = createChartCandleService(fetcher, () => now);

    await svc.get('solana', SOL_MINT, '1m', 300);
    await svc.get('solana', SOL_MINT, '1m', 300);
    expect(fetcher).toHaveBeenCalledTimes(1);

    now = 59_000;
    await svc.get('solana', SOL_MINT, '1m', 300);
    expect(fetcher).toHaveBeenCalledTimes(1);

    now = 61_000;
    await svc.get('solana', SOL_MINT, '1m', 300);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keys the cache on every dimension', async () => {
    const fetcher = vi.fn<ChartCandleFetcher>(async () => ok);
    const svc = createChartCandleService(fetcher, () => 0);
    await svc.get('solana', SOL_MINT, '1m', 300);
    await svc.get('solana', SOL_MINT, '1h', 300);
    await svc.get('solana', SOL_MINT, '1m', 100);
    await svc.get('bsc', EVM, '1m', 300);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('coalesces concurrent requests for the same key into one upstream call', async () => {
    let resolve!: (r: ChartCandleResult) => void;
    const fetcher = vi.fn<ChartCandleFetcher>(() => new Promise((r) => (resolve = r)));
    const svc = createChartCandleService(fetcher, () => 0);

    const a = svc.get('solana', SOL_MINT, '1m', 300);
    const b = svc.get('solana', SOL_MINT, '1m', 300);
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolve(ok);
    expect(await a).toBe(ok);
    expect(await b).toBe(ok);
  });

  it('remembers a no_pool answer but never an unavailable one', async () => {
    const results: ChartCandleResult[] = [{ status: 'unavailable' }, ok];
    const fetcher = vi.fn<ChartCandleFetcher>(async () => results.shift() ?? ok);
    const svc = createChartCandleService(fetcher, () => 0);

    expect((await svc.get('solana', SOL_MINT, '1m', 300)).status).toBe('unavailable');
    expect((await svc.get('solana', SOL_MINT, '1m', 300)).status).toBe('ok');
    expect(fetcher).toHaveBeenCalledTimes(2);

    const missFetcher = vi.fn<ChartCandleFetcher>(async () => ({ status: 'no_pool' }));
    const missSvc = createChartCandleService(missFetcher, () => 0);
    await missSvc.get('bsc', EVM, '1h', 168);
    await missSvc.get('bsc', EVM, '1h', 168);
    expect(missFetcher).toHaveBeenCalledTimes(1);
  });

  it('drops the in-flight entry when the fetcher rejects, so the next ask retries', async () => {
    const fetcher = vi
      .fn<ChartCandleFetcher>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(ok);
    const svc = createChartCandleService(fetcher, () => 0);
    await expect(svc.get('solana', SOL_MINT, '1m', 300)).rejects.toThrow('boom');
    expect((await svc.get('solana', SOL_MINT, '1m', 300)).status).toBe('ok');
  });
});
