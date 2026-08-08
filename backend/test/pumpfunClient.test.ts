import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PumpfunClient,
  PumpfunError,
  PumpfunConfigError,
  PumpfunAuthError,
  PumpfunContractError,
  PumpfunRequestError,
  resolvePumpfunApiKey,
  isPumpfunConfigured,
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

beforeEach(() => {
  process.env.PUMPFUN_API_KEY = KEY;
  delete process.env.OCT_PUMPFUN_API_KEY;
  delete process.env.TRENCHCORD_PUMPFUN_API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.PUMPFUN_API_KEY;
  delete process.env.OCT_PUMPFUN_API_KEY;
  delete process.env.TRENCHCORD_PUMPFUN_API_KEY;
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
