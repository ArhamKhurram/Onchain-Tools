import { describe, it, expect, vi, beforeEach } from 'vitest';

const fomoCall = {
  searchUsers: vi.fn(),
  getUserByHandle: vi.fn(),
  getUserBalances: vi.fn(),
};

vi.mock('../src/fomo/client.js', () => ({
  ensureSharedFomoClientReady: async () => fomoCall,
}));

const { getBotWallet } = await import('../src/bot/service.js');
const { BotServiceError } = await import('../src/bot/service.js');

// Realistic /v2/users/fuzzy-search envelope, matching the old bot's proven parsing.
const searchHit = (over: Record<string, unknown> = {}) => ({
  status: 200,
  json: {
    responseObject: {
      users: [
        {
          id: 'u1',
          userHandle: 'vee',
          displayName: 'Vee',
          address: 'SoLWaLLeT1111111111111111111111111111111111',
          evmAddress: '0xEvMwALLET00000000000000000000000000000000',
          followers: 10,
          ...over,
        },
      ],
    },
  },
});

// Realistic /v2/users/:id/balances envelope.
const balancesHit = (holdings: unknown[] = []) => ({
  status: 200,
  json: {
    responseObject: {
      balances: holdings,
      otherPnl: 50,
      livePerpPnl: -20,
    },
  },
});

const holding = (over: Record<string, unknown> = {}) => ({
  tokenFilterResult: { token: { symbol: 'TA' }, priceUSD: '2.5' },
  balance: { shiftedBalance: 100 },
  userToken: { currentCostBasisUsd: 200, currentRealizedPnlUsd: 10 },
  ...over,
});

describe('getBotWallet', () => {
  beforeEach(() => {
    fomoCall.searchUsers.mockReset();
    fomoCall.getUserByHandle.mockReset();
    fomoCall.getUserBalances.mockReset();
  });

  it('resolves a trader by search and returns their wallets + holdings', async () => {
    fomoCall.searchUsers.mockResolvedValue(searchHit());
    fomoCall.getUserBalances.mockResolvedValue(balancesHit([holding()]));

    const profile = await getBotWallet('vee');

    expect(profile.displayName).toBe('Vee');
    expect(profile.handle).toBe('vee');
    expect(profile.solAddress).toBe('SoLWaLLeT1111111111111111111111111111111111');
    expect(profile.evmAddress).toBe('0xEvMwALLET00000000000000000000000000000000');
    expect(fomoCall.getUserBalances).toHaveBeenCalledWith('u1');
  });

  it('computes holding value and PnL from price/balance/cost-basis', async () => {
    fomoCall.searchUsers.mockResolvedValue(searchHit());
    fomoCall.getUserBalances.mockResolvedValue(balancesHit([holding()]));

    const profile = await getBotWallet('vee');

    // currentValue = 2.5 * 100 = 250; pnl = 250 - 200 + 10 = 60
    expect(profile.holdings).toEqual([{ symbol: 'TA', valueUsd: 250, pnlUsd: 60 }]);
    // portfolioPnl = holdingsPnlSum (60) + otherPnl (50) = 110
    expect(profile.portfolioPnlUsd).toBe(110);
    expect(profile.livePerpPnlUsd).toBe(-20);
  });

  it('falls back to otherPnl alone when there are no holdings', async () => {
    fomoCall.searchUsers.mockResolvedValue(searchHit());
    fomoCall.getUserBalances.mockResolvedValue(balancesHit([]));

    const profile = await getBotWallet('vee');
    expect(profile.holdings).toEqual([]);
    expect(profile.portfolioPnlUsd).toBe(50); // otherPnl only
  });

  it('prefers an exact handle match over other candidates', async () => {
    fomoCall.searchUsers.mockResolvedValue({
      status: 200,
      json: {
        responseObject: {
          users: [
            { id: 'popular', userHandle: 'veefan', displayName: 'Vee Fan', followers: 9999 },
            { id: 'exact', userHandle: 'vee', displayName: 'Vee', followers: 1 },
          ],
        },
      },
    });
    fomoCall.getUserBalances.mockResolvedValue(balancesHit([]));

    const profile = await getBotWallet('vee');
    expect(profile.displayName).toBe('Vee');
    expect(fomoCall.getUserBalances).toHaveBeenCalledWith('exact');
  });

  it('resolves via getUserByHandle when search omits an id', async () => {
    fomoCall.searchUsers.mockResolvedValue(searchHit({ id: undefined }));
    fomoCall.getUserByHandle.mockResolvedValue({ status: 200, json: { id: 'resolved-id', userHandle: 'vee' } });
    fomoCall.getUserBalances.mockResolvedValue(balancesHit([]));

    await getBotWallet('vee');
    expect(fomoCall.getUserByHandle).toHaveBeenCalledWith('vee');
    expect(fomoCall.getUserBalances).toHaveBeenCalledWith('resolved-id');
  });

  it('throws not_found when the search returns no candidates', async () => {
    fomoCall.searchUsers.mockResolvedValue({ status: 200, json: { responseObject: { users: [] } } });
    await expect(getBotWallet('nobody')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('throws not_found when no id can ever be resolved', async () => {
    fomoCall.searchUsers.mockResolvedValue(searchHit({ id: undefined, userId: undefined }));
    fomoCall.getUserByHandle.mockResolvedValue({ status: 404, json: null });
    await expect(getBotWallet('vee')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('throws upstream when the balances call fails', async () => {
    fomoCall.searchUsers.mockResolvedValue(searchHit());
    fomoCall.getUserBalances.mockResolvedValue({ status: 500, json: null });
    await expect(getBotWallet('vee')).rejects.toMatchObject({ code: 'upstream' });
  });
});
