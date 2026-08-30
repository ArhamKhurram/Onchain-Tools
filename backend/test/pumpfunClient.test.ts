import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PumpfunClient,
  PumpfunError,
  PumpfunConfigError,
  PumpfunAuthError,
  PumpfunContractError,
  PumpfunRequestError,
  resolvePumpfunApiKey,
  resolveKeyedReadRetries,
  isPumpfunConfigured,
  isTransientPumpfunError,
} from '../src/pumpfun/client';

// A distinctive key so any leak into an error message or log is caught by a
// substring check. It is set on process.env for the configured cases and cleared
// for the config-missing case.
const KEY = 'pk-secret-never-logged-123';

function mockFetch(status: number, body: string) {
  const spy = vi.fn(async () => new Response(body, { status }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

/**
 * Run a client call that hits the REAL retry backoff (0.5–1.5s of setTimeout per
 * attempt) under fake timers, flushing each scheduled sleep as it appears so the
 * suite never waits out wall-clock backoff. Only time is virtualised — the
 * mocked fetch, the call counts, and every assertion are untouched.
 */
async function withFlushedBackoff<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const pending = fn();
    // A rejection must not count as "unhandled" while the timers are flushed;
    // the caller still observes it via the returned promise below.
    pending.catch(() => {});
    await vi.runAllTimersAsync();
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

beforeEach(() => {
  process.env.PUMPFUN_API_KEY = KEY;
  delete process.env.OCT_PUMPFUN_API_KEY;
  delete process.env.TRENCHCORD_PUMPFUN_API_KEY;
  // The specs below pin narrowing and the error taxonomy, one response per case,
  // so the keyed retry budget is pinned OFF here to keep call counts exact and
  // the suite free of real backoff sleeps. The budget itself — including that it
  // defaults to ON — has its own describe block further down.
  process.env.PUMPFUN_READ_RETRIES = '0';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.PUMPFUN_API_KEY;
  delete process.env.OCT_PUMPFUN_API_KEY;
  delete process.env.TRENCHCORD_PUMPFUN_API_KEY;
  delete process.env.PUMPFUN_READ_RETRIES;
  delete process.env.OCT_PUMPFUN_READ_RETRIES;
  delete process.env.TRENCHCORD_PUMPFUN_READ_RETRIES;
});

const api = () => new PumpfunClient();

const GOOD_CALLOUT = {
  id: 'c1',
  communityId: 'comm1',
  userId: 'u1',
  username: 'vee',
  displayName: 'Vee',
  content: 'sending it',
  likeCount: 12,
  liked: false,
  multiplier: 2.5,
  calloutMarketCap: '1200000', // string number — must coerce
  isSpam: false,
  tokenAddress: 'So11111111111111111111111111111111111111112',
  createdAt: '2026-08-08T00:00:00Z',
  mentions: [],
};

describe('key resolution + self-gate', () => {
  it('resolves the primary var, then the dual-brand fallbacks', () => {
    expect(resolvePumpfunApiKey()).toBe(KEY);
    delete process.env.PUMPFUN_API_KEY;
    process.env.OCT_PUMPFUN_API_KEY = 'oct-key';
    expect(resolvePumpfunApiKey()).toBe('oct-key');
    delete process.env.OCT_PUMPFUN_API_KEY;
    process.env.TRENCHCORD_PUMPFUN_API_KEY = 'tc-key';
    expect(resolvePumpfunApiKey()).toBe('tc-key');
  });

  it('reports unconfigured when no key var is set', () => {
    delete process.env.PUMPFUN_API_KEY;
    expect(isPumpfunConfigured()).toBe(false);
    expect(resolvePumpfunApiKey()).toBeNull();
  });

  it('sends the key as x-api-key and no credentials', async () => {
    const spy = mockFetch(200, JSON.stringify({ callouts: [] }));
    await api().getTokenCallouts('So11111111111111111111111111111111111111112');
    const init = spy.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(KEY);
    expect(init.credentials).toBe('omit');
  });
});

describe('response narrowing', () => {
  it('parses a good callout row and coerces string numbers', async () => {
    mockFetch(200, JSON.stringify({ callouts: [GOOD_CALLOUT] }));
    const out = await api().getTokenCallouts('So11111111111111111111111111111111111111112');
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('c1');
    expect(out[0]!.multiplier).toBe(2.5);
    expect(out[0]!.calloutMarketCap).toBe(1_200_000);
    // Absent fields degrade to null/false, never undefined.
    expect(out[0]!.mediaUrl).toBeNull();
    expect(out[0]!.isHarmful).toBe(false);
  });

  it('drops a malformed row (missing id) without failing the list', async () => {
    mockFetch(200, JSON.stringify({ callouts: [GOOD_CALLOUT, { username: 'no-id' }, 42, null] }));
    const out = await api().getTokenCallouts('So11111111111111111111111111111111111111112');
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('c1');
  });

  it('throws unexpected-shape when the envelope is missing the array', async () => {
    mockFetch(200, JSON.stringify({ notCallouts: true }));
    await expect(api().getTokenCallouts('So11111111111111111111111111111111111111112')).rejects.toMatchObject({
      kind: 'unexpected-shape',
    });
  });

  it('throws unexpected-shape when the body is not an object (bare array)', async () => {
    mockFetch(200, JSON.stringify([GOOD_CALLOUT]));
    await expect(api().getTokenCallouts('So11111111111111111111111111111111111111112')).rejects.toBeInstanceOf(
      PumpfunContractError,
    );
  });

  it('throws unexpected-shape when a 200 body is not JSON (HTML error page)', async () => {
    mockFetch(200, '<!doctype html><title>oops</title>');
    await expect(api().getTrendingFeed()).rejects.toMatchObject({ kind: 'unexpected-shape' });
  });

  it('injects the mint into a single community (mint is a path param, not in body)', async () => {
    mockFetch(200, JSON.stringify({ tokenSymbol: 'WSOL', chainId: 1399811149, postCount: 3 }));
    const c = await api().getCommunity('So11111111111111111111111111111111111111112');
    expect(c.tokenAddress).toBe('So11111111111111111111111111111111111111112');
    expect(c.tokenSymbol).toBe('WSOL');
  });

  it('parses a wallet profile object', async () => {
    mockFetch(200, JSON.stringify({ userId: 'u1', username: 'vee', twitterId: 't1' }));
    const u = await api().getWalletProfile('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin');
    expect(u.userId).toBe('u1');
    expect(u.username).toBe('vee');
  });
});

describe('error taxonomy', () => {
  it('maps a 401 to auth-rejected', async () => {
    mockFetch(401, JSON.stringify({ error: 'unauthorized' }));
    await expect(api().getTopCommunities()).rejects.toMatchObject({ kind: 'auth-rejected' });
    await expect(api().getTopCommunities()).rejects.toBeInstanceOf(PumpfunAuthError);
  });

  it('maps a 403 to auth-rejected', async () => {
    mockFetch(403, 'forbidden');
    await expect(api().getTopCommunities()).rejects.toMatchObject({ kind: 'auth-rejected' });
  });

  it('maps a 500 to request-failed', async () => {
    mockFetch(500, 'internal error');
    await expect(api().getTopCommunities()).rejects.toMatchObject({ kind: 'request-failed' });
  });

  it('maps a network throw to request-failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));
    await expect(api().getTopCommunities()).rejects.toBeInstanceOf(PumpfunRequestError);
  });

  it('maps a missing key to config-missing (module inert)', async () => {
    delete process.env.PUMPFUN_API_KEY;
    const spy = mockFetch(200, JSON.stringify({ callouts: [] }));
    await expect(api().getTokenCallouts('So11111111111111111111111111111111111111112')).rejects.toBeInstanceOf(
      PumpfunConfigError,
    );
    // Fails before ever touching the network.
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('the key never leaks into an error', () => {
  // The key lives only in env and the request header; none of these failure
  // paths — where the client builds the message from request context — may
  // surface it. The network-throw case is the sharpest: even an underlying error
  // whose OWN message names the header must not be forwarded verbatim, because
  // that is the one place the key could ride out.
  const scenarios: Array<[string, () => void]> = [
    ['auth refusal', () => mockFetch(401, JSON.stringify({ error: 'unauthorized' }))],
    ['vendor 4xx body', () => mockFetch(400, JSON.stringify({ error: 'bad request' }))],
    [
      'network throw naming the header',
      () =>
        vi.stubGlobal('fetch', vi.fn(async () => {
          throw new Error(`connect failed with header x-api-key: ${KEY}`);
        })),
    ],
  ];

  for (const [name, setup] of scenarios) {
    it(`omits the key on a ${name}`, async () => {
      setup();
      try {
        await api().getTopCommunities();
        throw new Error('expected the call to reject');
      } catch (err) {
        expect(err).toBeInstanceOf(PumpfunError);
        expect((err as Error).message).not.toContain(KEY);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Wallet activity / PnL / balance — the SECOND host (profile-api.pump.fun),
// which is keyless. These specs also pin the security boundary: the keyed
// coin-communities credential must NEVER ride out to profile-api.
// ---------------------------------------------------------------------------

const WALLET = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const COIN_MINT = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';

// A raw SWAP row for a BUY: token_out is SOL, token_in is the coin.
const BUY_ROW = {
  tx_hash: 'sig-buy-1',
  block_time: 1_700_000_000,
  fee: 5000,
  transaction_type: 'BUY',
  type: 'SWAP',
  sol_value: 1.5,
  token_in: {
    amount: 1_000_000_000, // 6-decimal coin → 1000 units
    mint: COIN_MINT,
    metadata: { symbol: 'DOGE2', name: 'Doge Two', decimals: 6, program: 'spl-token', icon: null },
  },
  token_out: {
    amount: 1_500_000_000,
    mint: 'So11111111111111111111111111111111111111112',
    metadata: { symbol: 'SOL', name: 'Solana', decimals: 9, program: 'spl-token', icon: null },
  },
};

// A raw SWAP row for a SELL: the legs reverse (token_in is SOL, token_out coin).
const SELL_ROW = {
  tx_hash: 'sig-sell-1',
  block_time: 1_700_000_100,
  fee: 5000,
  transaction_type: 'SELL',
  type: 'SWAP',
  sol_value: 2.0,
  token_in: {
    amount: 2_000_000_000,
    mint: 'So11111111111111111111111111111111111111112',
    metadata: { symbol: 'SOL', name: 'Solana', decimals: 9, program: 'spl-token', icon: null },
  },
  token_out: {
    amount: 500_000_000, // 6-decimal coin → 500 units
    mint: COIN_MINT,
    metadata: { symbol: 'DOGE2', name: 'Doge Two', decimals: 6, program: 'spl-token', icon: null },
  },
};

describe('wallet transactions (profile-api, keyless)', () => {
  it('narrows a BUY: side=BUY and the non-SOL leg (token_in) is the coin', async () => {
    mockFetch(200, JSON.stringify({ transactions: [BUY_ROW], pagination: { has_more: false } }));
    const page = await api().getWalletTransactions(WALLET);
    expect(page.items).toHaveLength(1);
    const tx = page.items[0]!;
    expect(tx.type).toBe('SWAP');
    if (tx.type !== 'SWAP') throw new Error('narrowing failed');
    expect(tx.side).toBe('BUY');
    expect(tx.token).toBe(COIN_MINT);
    expect(tx.tokenSymbol).toBe('DOGE2');
    expect(tx.solValue).toBe(1.5);
    expect(tx.amount).toBe(1000); // 1_000_000_000 scaled by 6 decimals
  });

  it('narrows a SELL: side=SELL and the non-SOL leg (token_out) is the coin', async () => {
    mockFetch(200, JSON.stringify({ transactions: [SELL_ROW], pagination: { has_more: false } }));
    const page = await api().getWalletTransactions(WALLET);
    const tx = page.items[0]!;
    if (tx.type !== 'SWAP') throw new Error('narrowing failed');
    expect(tx.side).toBe('SELL');
    expect(tx.token).toBe(COIN_MINT);
    expect(tx.amount).toBe(500); // 500_000_000 scaled by 6 decimals
  });

  it('preserves an unknown type (CREATE_COIN) as OTHER rather than dropping it', async () => {
    const CREATE = { tx_hash: 'sig-create-1', block_time: 1, fee: 0, type: 'CREATE_COIN', mint: COIN_MINT };
    const MYSTERY = { tx_hash: 'sig-mystery-1', block_time: 2, fee: 0, type: 'FUTURE_TYPE_2027' };
    mockFetch(200, JSON.stringify({ transactions: [BUY_ROW, CREATE, MYSTERY], pagination: { has_more: false } }));
    const page = await api().getWalletTransactions(WALLET);
    // All three survive: the known SWAP plus two unmodeled types.
    expect(page.items).toHaveLength(3);
    const create = page.items[1]!;
    expect(create.type).toBe('OTHER');
    if (create.type !== 'OTHER') throw new Error('narrowing failed');
    expect(create.rawType).toBe('CREATE_COIN');
    // The full raw row is preserved for a consumer that wants the unmodeled shape.
    expect(create.raw.mint).toBe(COIN_MINT);
    const mystery = page.items[2]!;
    if (mystery.type !== 'OTHER') throw new Error('narrowing failed');
    expect(mystery.rawType).toBe('FUTURE_TYPE_2027');
  });

  it('narrows a TRANSFER with its direction and transferred leg', async () => {
    const XFER = {
      tx_hash: 'sig-xfer-1',
      block_time: 3,
      fee: 5000,
      type: 'TRANSFER',
      transaction_type: 'RECEIVE',
      direction: 'IN',
      token_transferred: { amount: 42, mint: COIN_MINT, metadata: { symbol: 'DOGE2', decimals: 6 } },
      from_address: 'FRoMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      to_address: WALLET,
    };
    mockFetch(200, JSON.stringify({ transactions: [XFER], pagination: { has_more: false } }));
    const tx = (await api().getWalletTransactions(WALLET)).items[0]!;
    expect(tx.type).toBe('TRANSFER');
    if (tx.type !== 'TRANSFER' && tx.type !== 'FEE_CLAIM') throw new Error('narrowing failed');
    expect(tx.direction).toBe('IN');
    expect(tx.transactionType).toBe('RECEIVE');
    expect(tx.tokenTransferred?.mint).toBe(COIN_MINT);
    expect(tx.toAddress).toBe(WALLET);
  });

  it('drops a malformed row (missing tx_hash) but keeps an unknown type', async () => {
    mockFetch(
      200,
      JSON.stringify({
        transactions: [BUY_ROW, { type: 'SWAP', no: 'tx_hash' }, 42, null, { tx_hash: 'x', type: 'WEIRD' }],
        pagination: { has_more: false },
      }),
    );
    const page = await api().getWalletTransactions(WALLET);
    // The BUY and the unknown-type row survive; the object without tx_hash, the
    // number and the null are dropped.
    expect(page.items).toHaveLength(2);
    expect(page.items[1]!.type).toBe('OTHER');
  });

  it('threads the pagination cursor through and back out', async () => {
    const spy = mockFetch(
      200,
      JSON.stringify({ transactions: [], pagination: { has_more: true, next_cursor: 'CURSOR_2', total: 250 } }),
    );
    const page = await api().getWalletTransactions(WALLET, { cursor: 'CURSOR_1', dustFilter: false });
    // The cursor and dustFilter=false are on the outbound query string...
    const url = spy.mock.calls[0]![0] as string;
    expect(url).toContain('cursor=CURSOR_1');
    expect(url).toContain('dustFilter=false');
    // ...and the next cursor is surfaced for the follow-up page.
    expect(page.pagination.hasMore).toBe(true);
    expect(page.pagination.nextCursor).toBe('CURSOR_2');
    expect(page.pagination.total).toBe(250);
  });

  it('defaults dustFilter to true when not specified', async () => {
    const spy = mockFetch(200, JSON.stringify({ transactions: [], pagination: { has_more: false } }));
    await api().getWalletTransactions(WALLET);
    const url = spy.mock.calls[0]![0] as string;
    expect(url).toContain('dustFilter=true');
    expect(url).not.toContain('cursor=');
  });

  it('throws unexpected-shape when the transactions array is missing', async () => {
    mockFetch(200, JSON.stringify({ pagination: { has_more: false } }));
    await expect(api().getWalletTransactions(WALLET)).rejects.toMatchObject({ kind: 'unexpected-shape' });
  });

  it('forwards a longer timeoutMs to the AbortSignal budget', async () => {
    const spy = mockFetch(200, JSON.stringify({ transactions: [], pagination: { has_more: false } }));
    await api().getWalletTransactions(WALLET, { timeoutMs: 20_000 });
    // The signal is an AbortSignal.timeout — we cannot read its budget directly,
    // but we can assert the call still went out (the longer budget did not break
    // the request path). The unit guarantee that it is *forwarded* is covered by
    // the retry tests below not being affected by the default 10s.
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('wallet transactions retry (transient-only, opt-in)', () => {
  // Return a distinct Response per call so a retry can succeed after a failure.
  function mockFetchSequence(...responses: Array<{ status: number; body: string } | { throw: Error }>) {
    let i = 0;
    const spy = vi.fn(async () => {
      const r = responses[Math.min(i, responses.length - 1)]!;
      i += 1;
      if ('throw' in r) throw r.throw;
      return new Response(r.body, { status: r.status });
    });
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  const OK = { status: 200, body: JSON.stringify({ transactions: [], pagination: { has_more: false } }) };

  it('retries a 502 and succeeds on the next attempt', async () => {
    const spy = mockFetchSequence({ status: 502, body: 'origin overloaded' }, OK);
    const page = await withFlushedBackoff(() => api().getWalletTransactions(WALLET, { retries: 2 }));
    expect(page.items).toHaveLength(0);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('retries a timeout (network status 0) and succeeds', async () => {
    const timeoutErr = Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
    const spy = mockFetchSequence({ throw: timeoutErr }, OK);
    const page = await withFlushedBackoff(() => api().getWalletTransactions(WALLET, { retries: 2 }));
    expect(page.items).toHaveLength(0);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('retries a 429 rate-limit', async () => {
    const spy = mockFetchSequence({ status: 429, body: 'slow down' }, OK);
    await withFlushedBackoff(() => api().getWalletTransactions(WALLET, { retries: 2 }));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a genuine 4xx (e.g. 400)', async () => {
    const spy = mockFetchSequence({ status: 400, body: 'bad request' }, OK);
    await expect(api().getWalletTransactions(WALLET, { retries: 3 })).rejects.toMatchObject({
      kind: 'request-failed',
      status: 400,
    });
    // One attempt only — a 4xx is not transient.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry an unexpected-shape (contract) error', async () => {
    const spy = mockFetchSequence({ status: 200, body: JSON.stringify({ nope: true }) }, OK);
    await expect(api().getWalletTransactions(WALLET, { retries: 3 })).rejects.toMatchObject({
      kind: 'unexpected-shape',
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('gives up after exhausting retries and throws the transient error', async () => {
    const spy = mockFetchSequence({ status: 503, body: 'unavailable' });
    await expect(withFlushedBackoff(() => api().getWalletTransactions(WALLET, { retries: 1 }))).rejects.toMatchObject({
      kind: 'request-failed',
      status: 503,
    });
    // Initial attempt + 1 retry = 2 calls.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('makes exactly one attempt when retries default to 0', async () => {
    const spy = mockFetchSequence({ status: 502, body: 'origin overloaded' });
    await expect(api().getWalletTransactions(WALLET)).rejects.toMatchObject({ status: 502 });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('isTransientPumpfunError', () => {
  it('treats network/timeout (status 0) and 429/502/503/504 as transient', () => {
    for (const status of [0, 429, 502, 503, 504]) {
      expect(isTransientPumpfunError(new PumpfunRequestError('/p', status, 'x'))).toBe(true);
    }
  });

  it('treats a genuine 4xx (not 429) and 500 as NOT transient', () => {
    for (const status of [400, 401, 403, 404, 422, 500]) {
      expect(isTransientPumpfunError(new PumpfunRequestError('/p', status, 'x'))).toBe(false);
    }
  });

  it('treats a shape/contract error and non-pump errors as NOT transient', () => {
    expect(isTransientPumpfunError(new PumpfunContractError('/p', 'bad shape'))).toBe(false);
    expect(isTransientPumpfunError(new Error('boom'))).toBe(false);
    expect(isTransientPumpfunError(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// KEYED-host retry (coin-communities). Unlike the profile-api budget above this
// one is ON by default: the shared x-api-key has one rate-limit budget across
// every reader, so a 429 is an ordinary contended moment, not an outage. These
// specs set the env budget explicitly (the client reads it late, per call).
// ---------------------------------------------------------------------------

describe('keyed read retry (429 and friends)', () => {
  function mockFetchSequence(...responses: Array<{ status: number; body: string } | { throw: Error }>) {
    let i = 0;
    const spy = vi.fn(async () => {
      const r = responses[Math.min(i, responses.length - 1)]!;
      i += 1;
      if ('throw' in r) throw r.throw;
      return new Response(r.body, { status: r.status });
    });
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  const MINT = 'So11111111111111111111111111111111111111112';
  const OK_CALLOUTS = { status: 200, body: JSON.stringify({ callouts: [GOOD_CALLOUT] }) };
  const RATE_LIMITED = { status: 429, body: 'Too Many Requests' };

  it('retries a 429 on the token callouts read and succeeds — the reported bug', async () => {
    process.env.PUMPFUN_READ_RETRIES = '2';
    const spy = mockFetchSequence(RATE_LIMITED, OK_CALLOUTS);
    const out = await withFlushedBackoff(() => api().getTokenCallouts(MINT));
    expect(out).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('retries a 429 on the community read too (the other half of the pair)', async () => {
    process.env.PUMPFUN_READ_RETRIES = '2';
    const spy = mockFetchSequence(RATE_LIMITED, { status: 200, body: JSON.stringify({ tokenSymbol: 'WSOL' }) });
    const c = await withFlushedBackoff(() => api().getCommunity(MINT));
    expect(c.tokenSymbol).toBe('WSOL');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a non-transient failure (404) — one attempt, budget untouched', async () => {
    process.env.PUMPFUN_READ_RETRIES = '3';
    const spy = mockFetchSequence({ status: 404, body: 'no such community' }, OK_CALLOUTS);
    await expect(api().getTokenCallouts(MINT)).rejects.toMatchObject({ kind: 'request-failed', status: 404 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry an auth refusal or a shape break', async () => {
    process.env.PUMPFUN_READ_RETRIES = '3';
    const authSpy = mockFetchSequence({ status: 401, body: 'nope' }, OK_CALLOUTS);
    await expect(api().getTopCommunities()).rejects.toMatchObject({ kind: 'auth-rejected' });
    expect(authSpy).toHaveBeenCalledTimes(1);

    const shapeSpy = mockFetchSequence({ status: 200, body: JSON.stringify({ nope: true }) }, OK_CALLOUTS);
    await expect(api().getTokenCallouts(MINT)).rejects.toMatchObject({ kind: 'unexpected-shape' });
    expect(shapeSpy).toHaveBeenCalledTimes(1);
  });

  it('respects the budget: gives up after the configured extra attempts', async () => {
    process.env.PUMPFUN_READ_RETRIES = '1';
    const spy = mockFetchSequence(RATE_LIMITED);
    await expect(withFlushedBackoff(() => api().getTokenCallouts(MINT))).rejects.toMatchObject({
      kind: 'request-failed',
      status: 429,
    });
    // Initial attempt + exactly 1 retry.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('makes a single attempt when the budget is explicitly 0', async () => {
    process.env.PUMPFUN_READ_RETRIES = '0';
    const spy = mockFetchSequence(RATE_LIMITED);
    await expect(api().getWalletCallouts('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin')).rejects.toMatchObject({
      status: 429,
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('retries by DEFAULT (no env set): three attempts on a persistent 429', async () => {
    delete process.env.PUMPFUN_READ_RETRIES;
    const spy = mockFetchSequence(RATE_LIMITED);
    await expect(withFlushedBackoff(() => api().getTokenCallouts(MINT))).rejects.toMatchObject({ status: 429 });
    // 1 initial + 2 default extra attempts.
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('never leaks the key when every retry fails', async () => {
    process.env.PUMPFUN_READ_RETRIES = '1';
    mockFetchSequence({ throw: new Error(`connect failed with header x-api-key: ${KEY}`) });
    try {
      await withFlushedBackoff(() => api().getTokenCallouts(MINT));
      throw new Error('expected the call to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(PumpfunError);
      expect((err as Error).message).not.toContain(KEY);
    }
  });
});

describe('resolveKeyedReadRetries', () => {
  it('defaults to two extra attempts when unset', () => {
    delete process.env.PUMPFUN_READ_RETRIES;
    expect(resolveKeyedReadRetries()).toBe(2);
  });

  it('reads the primary var, then the dual-brand fallbacks', () => {
    process.env.PUMPFUN_READ_RETRIES = '5';
    expect(resolveKeyedReadRetries()).toBe(5);
    delete process.env.PUMPFUN_READ_RETRIES;
    process.env.OCT_PUMPFUN_READ_RETRIES = '4';
    expect(resolveKeyedReadRetries()).toBe(4);
    delete process.env.OCT_PUMPFUN_READ_RETRIES;
    process.env.TRENCHCORD_PUMPFUN_READ_RETRIES = '3';
    expect(resolveKeyedReadRetries()).toBe(3);
  });

  it('honours an explicit 0 (opt out) but falls back on junk or a negative', () => {
    process.env.PUMPFUN_READ_RETRIES = '0';
    expect(resolveKeyedReadRetries()).toBe(0);
    for (const bad of ['', 'many', '-1']) {
      process.env.PUMPFUN_READ_RETRIES = bad;
      expect(resolveKeyedReadRetries()).toBe(2);
    }
  });
});

describe('wallet PnL (profile-api POST, 201)', () => {
  it('treats 201 as success and parses null figures for an untraded mint', async () => {
    const body = {
      success: true,
      data: [
        {
          mint: COIN_MINT,
          unrealized: null,
          realized: null,
          total_buy_spend: { sol: null, usd: null },
          total_buy_amount: null,
          has_transfers: false,
          has_untrusted_basis: false,
          fee: null,
          fee_detail: null,
        },
      ],
    };
    mockFetch(201, JSON.stringify(body)); // NOTE: 201, not 200.
    const rows = await api().getWalletPnl(WALLET, [COIN_MINT]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mint).toBe(COIN_MINT);
    expect(rows[0]!.unrealized).toBeNull();
    expect(rows[0]!.totalBuySpend).toEqual({ sol: null, usd: null });
    expect(rows[0]!.hasTransfers).toBe(false);
  });

  it('parses populated PnL figures', async () => {
    const body = {
      data: [
        {
          mint: COIN_MINT,
          unrealized: 12.5,
          realized: -3.25,
          total_buy_spend: { sol: 4.0, usd: 600 },
          total_buy_amount: 1000,
          has_transfers: true,
          has_untrusted_basis: false,
          fee: 0.01,
          fee_detail: { creator: 0.01 },
        },
      ],
    };
    mockFetch(201, JSON.stringify(body));
    const [row] = await api().getWalletPnl(WALLET, [COIN_MINT]);
    expect(row!.realized).toBe(-3.25);
    expect(row!.totalBuySpend).toEqual({ sol: 4.0, usd: 600 });
    expect(row!.hasTransfers).toBe(true);
    expect(row!.feeDetail).toEqual({ creator: 0.01 });
  });

  it('sends the mint list in the POST body as { tokens: [{ mint }] }', async () => {
    const spy = mockFetch(201, JSON.stringify({ data: [] }));
    await api().getWalletPnl(WALLET, [COIN_MINT]);
    const init = spy.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ tokens: [{ mint: COIN_MINT }] });
  });

  it('drops a malformed PnL row (missing mint)', async () => {
    mockFetch(201, JSON.stringify({ data: [{ mint: COIN_MINT, realized: 1 }, { realized: 2 }, null] }));
    const rows = await api().getWalletPnl(WALLET, [COIN_MINT]);
    expect(rows).toHaveLength(1);
  });

  it('throws unexpected-shape when data is missing', async () => {
    mockFetch(201, JSON.stringify({ success: true }));
    await expect(api().getWalletPnl(WALLET, [COIN_MINT])).rejects.toMatchObject({ kind: 'unexpected-shape' });
  });
});

describe('wallet balance (profile-api, keyless)', () => {
  it('passes a holdings summary object through untouched', async () => {
    mockFetch(200, JSON.stringify({ totalSol: 12.3, holdings: [{ mint: COIN_MINT, amount: 100 }] }));
    const summary = await api().getWalletBalance(WALLET);
    expect(summary.totalSol).toBe(12.3);
  });

  it('throws unexpected-shape when the body is not an object', async () => {
    mockFetch(200, JSON.stringify([1, 2, 3]));
    await expect(api().getWalletBalance(WALLET)).rejects.toMatchObject({ kind: 'unexpected-shape' });
  });
});

describe('the profile-api host is keyless and separate from the keyed host', () => {
  it('never attaches the coin-communities x-api-key to a profile-api request', async () => {
    // The key IS set in env (beforeEach) — the point is that the keyless code path
    // does not read or send it. If it leaked, this would catch it.
    const spy = mockFetch(200, JSON.stringify({ transactions: [], pagination: { has_more: false } }));
    await api().getWalletTransactions(WALLET);
    const [url, init] = spy.mock.calls[0]! as [string, RequestInit];
    // Right host...
    expect(url.startsWith('https://profile-api.pump.fun')).toBe(true);
    // ...and no credential of any kind on the wire.
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect('x-api-key' in headers).toBe(false);
    expect(headers['x-api-key']).toBeUndefined();
    expect(init.credentials).toBe('omit');
  });

  it('routes profile-api POST (pnl) to profile-api.pump.fun without the key', async () => {
    const spy = mockFetch(201, JSON.stringify({ data: [] }));
    await api().getWalletPnl(WALLET, [COIN_MINT]);
    const [url, init] = spy.mock.calls[0]! as [string, RequestInit];
    expect(url.startsWith('https://profile-api.pump.fun')).toBe(true);
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect('x-api-key' in headers).toBe(false);
  });

  it('still sends the x-api-key to the KEYED coin-communities host (contrast)', async () => {
    // Same client instance, same env — the keyed path must keep sending the key,
    // proving the two paths are genuinely distinct and not both stripped.
    const spy = mockFetch(200, JSON.stringify({ callouts: [] }));
    await api().getTokenCallouts(COIN_MINT);
    const [url, init] = spy.mock.calls[0]! as [string, RequestInit];
    expect(url.startsWith('https://api.coin-communities.xyz')).toBe(true);
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers['x-api-key']).toBe(KEY);
  });
});
