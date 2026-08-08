import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  PumpfunError,
  PumpfunContractError,
  PumpfunSessionExpiredError,
  PumpfunRequestError,
} from '../src/pumpfun/client';
import {
  PumpfunLeaderboardClient,
  looksLikeJwt,
  decodeJwtExpiry,
  sessionStatus,
} from '../src/pumpfun/leaderboardClient';

// A distinctive bearer so any leak into a response or an error message is caught
// by a substring check. It is what authenticates AS the user, so the sharpest
// invariant of this whole feature is that it never rides out.
const BEARER = 'eyBEARER-secret-never-logged-xyz.payload.sig';

function mockFetch(status: number, body: string) {
  const spy = vi.fn(async () => new Response(body, { status }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const api = () => new PumpfunLeaderboardClient();

// A well-formed leaderboard row (best guess at the unverified shape).
const GOOD_ROW = {
  rank: 1,
  walletAddress: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
  userId: 'u1',
  username: 'vee',
  displayName: 'Vee',
  profileImageUrl: 'https://img/vee.png',
  userTwitterUrl: 'https://x.com/vee',
  pnlUsd: '125000', // string number — must coerce
  calloutCount: 42,
  winRate: 0.66,
};

describe('bearer transport', () => {
  it('sends Authorization: Bearer and no x-api-key or cookies', async () => {
    const spy = mockFetch(200, JSON.stringify({ leaderboard: [] }));
    await api().getCalloutLeaderboard(BEARER, '7d');
    const [url, init] = spy.mock.calls[0]! as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${BEARER}`);
    expect('x-api-key' in headers).toBe(false);
    expect(init.credentials).toBe('omit');
    // The window is a PATH segment, not a query param.
    expect(url).toContain('/leaderboard/callouts/7d');
    expect(url).not.toContain('?');
  });

  it('puts the timeframe in the path for 30d and all', async () => {
    const spy = mockFetch(200, JSON.stringify({ leaderboard: [] }));
    await api().getCalloutLeaderboard(BEARER, '30d');
    await api().getCalloutLeaderboard(BEARER, 'all');
    expect(spy.mock.calls[0]![0] as string).toContain('/leaderboard/callouts/30d');
    expect(spy.mock.calls[1]![0] as string).toContain('/leaderboard/callouts/all');
  });

  it('hits the ranked endpoint for getRankedCallers', async () => {
    const spy = mockFetch(200, JSON.stringify({ leaderboard: [] }));
    await api().getRankedCallers(BEARER);
    expect(spy.mock.calls[0]![0] as string).toContain('/leaderboard/callouts/ranked');
  });
});

describe('response narrowing', () => {
  it('parses a good row and coerces string numbers', async () => {
    mockFetch(200, JSON.stringify({ leaderboard: [GOOD_ROW] }));
    const rows = await api().getCalloutLeaderboard(BEARER, '7d');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.walletAddress).toBe(GOOD_ROW.walletAddress);
    expect(rows[0]!.rank).toBe(1);
    expect(rows[0]!.pnlUsd).toBe(125_000); // coerced from string
    expect(rows[0]!.username).toBe('vee');
  });

  it('reads several envelope spellings and a bare array', async () => {
    for (const body of [
      JSON.stringify({ data: [GOOD_ROW] }),
      JSON.stringify({ callers: [GOOD_ROW] }),
      JSON.stringify({ entries: [GOOD_ROW] }),
      JSON.stringify([GOOD_ROW]), // bare array
    ]) {
      mockFetch(200, body);
      const rows = await api().getCalloutLeaderboard(BEARER, '7d');
      expect(rows).toHaveLength(1);
    }
  });

  it('reads alternate field spellings (wallet, handle, pnl)', async () => {
    const alt = { rank: 2, wallet: 'AltWa11etxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', handle: 'zed', pnl: 4200 };
    mockFetch(200, JSON.stringify({ leaderboard: [alt] }));
    const rows = await api().getCalloutLeaderboard(BEARER, '7d');
    expect(rows[0]!.walletAddress).toBe(alt.wallet);
    expect(rows[0]!.username).toBe('zed');
    expect(rows[0]!.pnlUsd).toBe(4200);
  });

  it('drops a malformed row (no wallet address) without failing the list', async () => {
    mockFetch(200, JSON.stringify({ leaderboard: [GOOD_ROW, { username: 'no-wallet' }, 42, null] }));
    const rows = await api().getCalloutLeaderboard(BEARER, '7d');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.walletAddress).toBe(GOOD_ROW.walletAddress);
  });

  it('throws unexpected-shape for a non-array body (object with no row array)', async () => {
    mockFetch(200, JSON.stringify({ notRows: true, total: 5 }));
    await expect(api().getCalloutLeaderboard(BEARER, '7d')).rejects.toMatchObject({ kind: 'unexpected-shape' });
    await expect(api().getCalloutLeaderboard(BEARER, '7d')).rejects.toBeInstanceOf(PumpfunContractError);
  });

  it('throws unexpected-shape when a 200 body is not JSON (HTML error page)', async () => {
    mockFetch(200, '<!doctype html><title>oops</title>');
    await expect(api().getRankedCallers(BEARER)).rejects.toMatchObject({ kind: 'unexpected-shape' });
  });
});

describe('error taxonomy: a bearer refusal is auth-expired, not auth-rejected', () => {
  it('maps a 401 to auth-expired (session lapsed → reconnect)', async () => {
    mockFetch(401, JSON.stringify({ error: 'unauthorized' }));
    await expect(api().getCalloutLeaderboard(BEARER, '7d')).rejects.toMatchObject({ kind: 'auth-expired' });
    await expect(api().getCalloutLeaderboard(BEARER, '7d')).rejects.toBeInstanceOf(PumpfunSessionExpiredError);
  });

  it('maps a 403 to auth-expired as well', async () => {
    mockFetch(403, 'forbidden');
    await expect(api().getRankedCallers(BEARER)).rejects.toMatchObject({ kind: 'auth-expired' });
  });

  it('maps a 500 to request-failed', async () => {
    mockFetch(500, 'internal error');
    await expect(api().getCalloutLeaderboard(BEARER, '7d')).rejects.toMatchObject({ kind: 'request-failed' });
  });

  it('maps a network throw to request-failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));
    await expect(api().getCalloutLeaderboard(BEARER, '7d')).rejects.toBeInstanceOf(PumpfunRequestError);
  });
});

describe('the bearer NEVER leaks into an error message', () => {
  // Every failure path where the client builds the message from request context
  // must omit the bearer. The network-throw case is sharpest: even an underlying
  // error whose OWN message quotes the Authorization header must not be forwarded
  // verbatim — that is the one frame where the token could ride out.
  const scenarios: Array<[string, () => void]> = [
    ['session refusal (401)', () => mockFetch(401, JSON.stringify({ error: 'unauthorized' }))],
    ['vendor 4xx body', () => mockFetch(400, JSON.stringify({ error: 'bad request' }))],
    ['vendor 5xx body', () => mockFetch(503, 'upstream down')],
    [
      'network throw quoting the Authorization header',
      () =>
        vi.stubGlobal('fetch', vi.fn(async () => {
          throw new Error(`connect failed with header authorization: Bearer ${BEARER}`);
        })),
    ],
  ];

  for (const [name, setup] of scenarios) {
    it(`omits the bearer on a ${name}`, async () => {
      setup();
      try {
        await api().getCalloutLeaderboard(BEARER, '7d');
        throw new Error('expected the call to reject');
      } catch (err) {
        expect(err).toBeInstanceOf(PumpfunError);
        expect((err as Error).message).not.toContain(BEARER);
      }
    });
  }

  it('never places the bearer in the fetched URL either', async () => {
    const spy = mockFetch(200, JSON.stringify({ leaderboard: [] }));
    await api().getCalloutLeaderboard(BEARER, '7d');
    const url = spy.mock.calls[0]![0] as string;
    expect(url).not.toContain(BEARER);
  });
});

// ---------------------------------------------------------------------------
// JWT helpers + status projection — pure, no network.
// ---------------------------------------------------------------------------

// Build a real JWT (unsigned payload is all decodeJwtExpiry reads).
function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.${'sig'}`;
}

describe('looksLikeJwt', () => {
  it('accepts three non-empty base64url segments', () => {
    expect(looksLikeJwt(makeJwt({ exp: 123 }))).toBe(true);
    expect(looksLikeJwt('aA0-_.bB1-_.cC2-_')).toBe(true);
  });

  it('rejects junk, wrong segment counts, and empty segments', () => {
    for (const bad of ['', 'nope', 'a.b', 'a.b.c.d', 'a..c', '.b.c', 'a.b.', 'has spaces.b.c', 'plus+slash/.b.c']) {
      expect(looksLikeJwt(bad)).toBe(false);
    }
  });
});

describe('decodeJwtExpiry', () => {
  it('reads a numeric exp claim', () => {
    expect(decodeJwtExpiry(makeJwt({ exp: 1_800_000_000 }))).toBe(1_800_000_000);
  });

  it('returns null for a missing, non-numeric, or undecodable exp', () => {
    expect(decodeJwtExpiry(makeJwt({ sub: 'u1' }))).toBeNull();
    expect(decodeJwtExpiry(makeJwt({ exp: 'soon' }))).toBeNull();
    expect(decodeJwtExpiry('not.a.jwt-payload')).toBeNull();
    expect(decodeJwtExpiry('only.two')).toBeNull();
  });
});

describe('sessionStatus (the ONLY shape a status/connect route returns)', () => {
  it('null session → not connected, with no token field of any kind', () => {
    const status = sessionStatus(null);
    expect(status).toEqual({ connected: false });
    expect(status.expiresAt).toBeUndefined();
    expect(status.updatedAt).toBeUndefined();
  });

  it('connected: surfaces updatedAt and a decoded expiresAt, never the token', () => {
    const exp = 1_900_000_000;
    const token = makeJwt({ exp });
    const updatedAt = '2026-08-08T00:00:00.000Z';
    const status = sessionStatus({ token, updatedAt });
    expect(status.connected).toBe(true);
    expect(status.updatedAt).toBe(updatedAt);
    expect(status.expiresAt).toBe(new Date(exp * 1000).toISOString());
    // THE invariant: the token is nowhere in the serialized status.
    expect(JSON.stringify(status)).not.toContain(token);
  });

  it('connected with an undecodable exp: connected + updatedAt, no expiresAt', () => {
    const token = 'opaque-but.looks.jwtish';
    const status = sessionStatus({ token, updatedAt: '2026-08-08T00:00:00.000Z' });
    expect(status.connected).toBe(true);
    expect(status.expiresAt).toBeUndefined();
    expect(JSON.stringify(status)).not.toContain(token);
  });
});
