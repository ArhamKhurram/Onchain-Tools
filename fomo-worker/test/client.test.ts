// JWT expiry behavior under the poller's concurrent burst.
//
// The poller fires ~20 /v1/call requests at once. When the Privy JWT expires,
// every one of them comes back 401 from fomo.family. The worker must:
//   1. refresh the JWT exactly ONCE (concurrent refreshes race the rotating
//      refresh token — the second Privy POST with an already-rotated token can
//      invalidate the whole session), and
//   2. retry each call in-place with the fresh JWT, so the backend never sees
//      the 401 and no poll cycle is lost.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('playwright-extra', () => ({
  chromium: { use: () => undefined, launchPersistentContext: vi.fn() },
}));
vi.mock('puppeteer-extra-plugin-stealth', () => ({ default: () => ({}) }));

import { FomoBrowserClient } from '../src/client.js';

const FRESH_JWT = 'fresh-jwt';
const STALE_JWT = 'stale-jwt';

function makePrivyFetchMock() {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ session: { access_token: FRESH_JWT } }),
    text: async () => '',
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** A fake tab: 401 for the stale JWT, 200 for the fresh one. */
function makeFakePage() {
  const evaluate = vi.fn(async (_fn: unknown, args: { jwt: string }) => {
    if (args.jwt === STALE_JWT) return { status: 401, text: '', json: null };
    return { status: 200, text: '{"ok":true}', json: { ok: true } };
  });
  return { evaluate, isClosed: () => false };
}

function makeClient(page: ReturnType<typeof makeFakePage>): FomoBrowserClient {
  const client = new FomoBrowserClient({ refreshToken: 'refresh-token' }, '/tmp/unused-profile');
  const anyClient = client as any;
  anyClient.page = page;
  anyClient.context = {};
  anyClient.contextClosed = false;
  anyClient.pageOpenedAt = Date.now(); // keep the tab "young" so no recycle triggers
  anyClient.jwt = STALE_JWT;
  return client;
}

describe('FomoBrowserClient JWT expiry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a concurrent 401 burst refreshes the JWT once and every call succeeds in-place', async () => {
    const fetchMock = makePrivyFetchMock();
    const page = makeFakePage();
    const client = makeClient(page);

    const CONCURRENCY = 10;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => client.call('/v2/leaderboard?limit=50')),
    );

    // One Privy round-trip for the whole burst, not one per call.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Every call recovered in-place — the backend never sees the 401.
    for (const result of results) {
      expect(result.status).toBe(200);
    }

    // Each call evaluated at most twice: once with the stale JWT, once retried fresh.
    expect(page.evaluate.mock.calls.length).toBeLessThanOrEqual(CONCURRENCY * 2);
  });

  it('a single 401 is retried once with the fresh JWT and returns the real payload', async () => {
    const fetchMock = makePrivyFetchMock();
    const page = makeFakePage();
    const client = makeClient(page);

    const result = await client.call('/feed/tradingActivity?limit=50');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ ok: true });
    expect(page.evaluate).toHaveBeenCalledTimes(2);
    expect(client.lastError).toBeNull();
  });

  it('a later expiry refreshes again — the single-flight gate is per outage, not forever', async () => {
    const fetchMock = makePrivyFetchMock();
    const page = makeFakePage();
    const client = makeClient(page);

    await client.call('/v2/leaderboard?limit=50');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Simulate the fresh JWT expiring later.
    (client as any).jwt = STALE_JWT;
    const result = await client.call('/v2/leaderboard?limit=50');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.status).toBe(200);
  });

  it('a still-401 response after a fresh JWT is returned as-is (no retry loop)', async () => {
    makePrivyFetchMock();
    const page = makeFakePage();
    // Upstream rejects even the fresh JWT.
    page.evaluate.mockImplementation(async () => ({ status: 401, text: '', json: null }));
    const client = makeClient(page);

    const result = await client.call('/v2/leaderboard?limit=50');

    expect(result.status).toBe(401);
    // Exactly two attempts — never a third.
    expect(page.evaluate).toHaveBeenCalledTimes(2);
  });
});
