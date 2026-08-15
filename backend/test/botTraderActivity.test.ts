import { describe, it, expect, vi, beforeEach } from 'vitest';

const fomoCall = {
  getUserActivity: vi.fn(),
};

vi.mock('../src/fomo/client.js', () => ({
  ensureSharedFomoClientReady: async () => fomoCall,
}));

const { getBotTraderActivity } = await import('../src/bot/service.js');

const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MEME = 'GkyPYa7NnCF6bABGZQfmiJdgHHgh1ecgurbnLpdMpump';

const swap = (id: string) => ({
  activityType: 'swap',
  id,
  inTokenAddress: SOL_USDC,
  outTokenAddress: MEME,
  humanUsdAmountIn: 100,
  humanUsdAmountOut: 99,
  networkId: 1399811149,
  provider: 'RELAY',
  createdAt: '2026-08-15T12:00:00.000Z',
});

const activityHit = (activities: unknown[], hasNextPage = false) => ({
  status: 200,
  json: { success: true, message: 'ok', responseObject: { activities, hasNextPage } },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getBotTraderActivity', () => {
  it('requests at most the upstream cap of 100', async () => {
    fomoCall.getUserActivity.mockResolvedValue(activityHit([]));
    const res = await getBotTraderActivity('u1', 5000);
    expect(fomoCall.getUserActivity).toHaveBeenCalledWith('u1', 100);
    expect(res.limit).toBe(100);
  });

  it('normalizes and summarizes the returned window', async () => {
    fomoCall.getUserActivity.mockResolvedValue(activityHit([swap('a'), swap('b')]));
    const res = await getBotTraderActivity('u1', 10);
    expect(res.fomoUserId).toBe('u1');
    expect(res.entries).toHaveLength(2);
    expect(res.summary).toMatchObject({ swapCount: 2, transferCount: 0, buyUsd: 200, sellUsd: 0 });
  });

  it("flags truncation when the vendor says there's a next page it won't serve", async () => {
    fomoCall.getUserActivity.mockResolvedValue(activityHit([swap('a')], true));
    expect((await getBotTraderActivity('u1', 10)).truncated).toBe(true);
  });

  it('flags truncation when the page came back full, even without hasNextPage', async () => {
    const full = Array.from({ length: 3 }, (_, i) => swap(`s${i}`));
    fomoCall.getUserActivity.mockResolvedValue(activityHit(full, false));
    expect((await getBotTraderActivity('u1', 3)).truncated).toBe(true);
  });

  it('does not flag truncation on a short page', async () => {
    fomoCall.getUserActivity.mockResolvedValue(activityHit([swap('a')], false));
    expect((await getBotTraderActivity('u1', 50)).truncated).toBe(false);
  });

  it('drops record types it does not model instead of guessing at them', async () => {
    fomoCall.getUserActivity.mockResolvedValue(activityHit([swap('a'), { activityType: 'perp' }]));
    const res = await getBotTraderActivity('u1', 10);
    expect(res.entries).toHaveLength(1);
  });

  it('maps an unknown trader to not_found', async () => {
    fomoCall.getUserActivity.mockResolvedValue({ status: 404, json: null, text: 'User not found' });
    await expect(getBotTraderActivity('nobody')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects an empty id without calling upstream', async () => {
    await expect(getBotTraderActivity('   ')).rejects.toMatchObject({ code: 'not_found' });
    expect(fomoCall.getUserActivity).not.toHaveBeenCalled();
  });

  it('maps an upstream failure to upstream', async () => {
    fomoCall.getUserActivity.mockResolvedValue({ status: 502, json: null, text: 'bad gateway' });
    await expect(getBotTraderActivity('u1')).rejects.toMatchObject({ code: 'upstream' });
  });
});
