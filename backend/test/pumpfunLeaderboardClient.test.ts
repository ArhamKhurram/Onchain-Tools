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

// A distinctive session token so any leak into a response or an error message is
// caught by a substring check. It is what authenticates AS the user, so the
// sharpest invariant of this whole feature is that it never rides out.
const TOKEN = 'eyTOKEN-secret-never-logged-xyz.payload.sig';

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

// A well-formed leaderboard row (the verified /pnl-leaderboard shape).
const GOOD_ROW = {
  rank: 1,
  walletAddress: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
  username: 'vee',
  xUsername: 'vee_x',
  profileImage: 'https://img/vee.png',
  pnlSol: 812.4,
  pnlUsd: '125000', // string number — must coerce
  pnlPercent: 66,
  realizedPnlSol: 800,
  realizedPnlUsd: 123_000,
  unrealizedPnlSol: 12.4,
  unrealizedPnlUsd: 2000,
  buySpendSol: 400,
  lastRefreshedAtMs: 1_733_000_000_000,
};

describe('session-cookie transport', () => {
  it('sends Cookie: auth_token=<token> and no x-api-key or Authorization', async () => {
    const spy = mockFetch(200, JSON.stringify({ entries: [] }));
    await api().getPnlLeaderboard(TOKEN, 'daily');
    const [url, init] = spy.mock.calls[0]! as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.cookie).toBe(`auth_token=${TOKEN}`);
    expect('authorization' in headers).toBe(false);
    expect('x-api-key' in headers).toBe(false);
    expect(init.credentials).toBe('omit');
    // Hits frontend-api-v3.pump.fun/pnl-leaderboard with the period as a query.
    expect(url).toContain('https://frontend-api-v3.pump.fun/pnl-leaderboard?');
    expect(url).toContain('period=daily');
  });

  it('defaults sort to combined and carries the limit query', async () => {
    const spy = mockFetch(200, JSON.stringify({ entries: [] }));
    await api().getPnlLeaderboard(TOKEN, 'weekly', { limit: 200 });
    const url = spy.mock.calls[0]![0] as string;
    expect(url).toContain('period=weekly');
    expect(url).toContain('sort=combined');
    expect(url).toContain('limit=200');
  });

  it('maps each period into the query', async () => {
    const spy = mockFetch(200, JSON.stringify({ entries: [] }));
    await api().getPnlLeaderboard(TOKEN, 'daily');
    await api().getPnlLeaderboard(TOKEN, 'weekly');
    await api().getPnlLeaderboard(TOKEN, 'monthly');
    expect(spy.mock.calls[0]![0] as string).toContain('period=daily');
    expect(spy.mock.calls[1]![0] as string).toContain('period=weekly');
    expect(spy.mock.calls[2]![0] as string).toContain('period=monthly');
  });

  it('honours an explicit sort', async () => {
    const spy = mockFetch(200, JSON.stringify({ entries: [] }));
    await api().getPnlLeaderboard(TOKEN, 'daily', { sort: 'realized' });
    expect(spy.mock.calls[0]![0] as string).toContain('sort=realized');
  });
});

describe('response narrowing', () => {
  it('parses a good row and coerces string numbers', async () => {
    mockFetch(200, JSON.stringify({ entries: [GOOD_ROW] }));
    const rows = await api().getPnlLeaderboard(TOKEN, 'daily');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.walletAddress).toBe(GOOD_ROW.walletAddress);
    expect(rows[0]!.rank).toBe(1);
    expect(rows[0]!.pnlUsd).toBe(125_000); // coerced from string
    expect(rows[0]!.username).toBe('vee');
    expect(rows[0]!.xUsername).toBe('vee_x');
    expect(rows[0]!.buySpendSol).toBe(400);
  });

  it('degrades an optional field to null without dropping the row', async () => {
    const { xUsername: _x, pnlUsd: _p, ...noOptionals } = GOOD_ROW;
    mockFetch(200, JSON.stringify({ entries: [noOptionals] }));
    const rows = await api().getPnlLeaderboard(TOKEN, 'daily');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.xUsername).toBeNull();
    expect(rows[0]!.pnlUsd).toBeNull();
    expect(rows[0]!.walletAddress).toBe(GOOD_ROW.walletAddress);
  });

  it('drops a malformed row (no wallet, or no rank) without failing the list', async () => {
    mockFetch(
      200,
      JSON.stringify({
        entries: [GOOD_ROW, { rank: 2, username: 'no-wallet' }, { walletAddress: 'x', username: 'no-rank' }, 42, null],
      }),
    );
    const rows = await api().getPnlLeaderboard(TOKEN, 'daily');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.walletAddress).toBe(GOOD_ROW.walletAddress);
  });

  it('throws unexpected-shape for a non-array entries (or a bare array)', async () => {
    for (const body of [
      JSON.stringify({ entries: 5 }),
      JSON.stringify({ notEntries: [GOOD_ROW] }),
      JSON.stringify([GOOD_ROW]), // a bare array is NOT the verified envelope
    ]) {
      mockFetch(200, body);
      await expect(api().getPnlLeaderboard(TOKEN, 'daily')).rejects.toMatchObject({ kind: 'unexpected-shape' });
    }
  });

  it('throws unexpected-shape when a 200 body is not JSON (HTML error page)', async () => {
    mockFetch(200, '<!doctype html><title>oops</title>');
    await expect(api().getPnlLeaderboard(TOKEN, 'daily')).rejects.toBeInstanceOf(PumpfunContractError);
  });
});

describe('error taxonomy: a session refusal is auth-expired, not auth-rejected', () => {
  it('maps a 401 to auth-expired (session lapsed → reconnect)', async () => {
    mockFetch(401, JSON.stringify({ error: 'unauthorized' }));
    await expect(api().getPnlLeaderboard(TOKEN, 'daily')).rejects.toMatchObject({ kind: 'auth-expired' });
    await expect(api().getPnlLeaderboard(TOKEN, 'daily')).rejects.toBeInstanceOf(PumpfunSessionExpiredError);
  });

  it('maps a 403 to auth-expired as well', async () => {
    mockFetch(403, 'forbidden');
    await expect(api().getPnlLeaderboard(TOKEN, 'weekly')).rejects.toMatchObject({ kind: 'auth-expired' });
  });

  it('maps a 500 to request-failed', async () => {
    mockFetch(500, 'internal error');
    await expect(api().getPnlLeaderboard(TOKEN, 'daily')).rejects.toMatchObject({ kind: 'request-failed' });
  });

  it('maps a network throw to request-failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));
    await expect(api().getPnlLeaderboard(TOKEN, 'daily')).rejects.toBeInstanceOf(PumpfunRequestError);
  });
});

describe('the session token NEVER leaks into an error message', () => {
  // Every failure path where the client builds the message from request context
  // must omit the token. The network-throw case is sharpest: even an underlying
  // error whose OWN message quotes the Cookie header must not be forwarded
  // verbatim — that is the one frame where the token could ride out.
  const scenarios: Array<[string, () => void]> = [
    ['session refusal (401)', () => mockFetch(401, JSON.stringify({ error: 'unauthorized' }))],
    ['vendor 4xx body', () => mockFetch(400, JSON.stringify({ error: 'bad request' }))],
    ['vendor 5xx body', () => mockFetch(503, 'upstream down')],
    [
      'network throw quoting the Cookie header',
      () =>
        vi.stubGlobal('fetch', vi.fn(async () => {
          throw new Error(`connect failed with header cookie: auth_token=${TOKEN}`);
        })),
    ],
  ];

  for (const [name, setup] of scenarios) {
    it(`omits the token on a ${name}`, async () => {
      setup();
      try {
        await api().getPnlLeaderboard(TOKEN, 'daily');
        throw new Error('expected the call to reject');
      } catch (err) {
        expect(err).toBeInstanceOf(PumpfunError);
        expect((err as Error).message).not.toContain(TOKEN);
      }
    });
  }

  it('never places the token in the fetched URL either', async () => {
    const spy = mockFetch(200, JSON.stringify({ entries: [] }));
    await api().getPnlLeaderboard(TOKEN, 'daily');
    const url = spy.mock.calls[0]![0] as string;
    expect(url).not.toContain(TOKEN);
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
