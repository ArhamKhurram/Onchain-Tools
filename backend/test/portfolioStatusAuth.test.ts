import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express, { Router } from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';

// `GET /api/portfolio/status` used to be exempted from authMiddleware by an
// explicit `req.path === '/portfolio/status'` bypass. That was wrong on two
// counts in hosted mode: the `probeChain`/`probeAddress` params drive a live
// Birdeye call against an arbitrary address (paid quota, no ownership check),
// and the response carried the exact character length of GMGN_API_KEY.
//
// These tests pin both halves of the fix, and — just as importantly — pin that
// local mode still works, since local mode has no auth by design and this
// endpoint is the operator's provider-env probe there.

import { authMiddleware } from '../src/auth/middleware.js';
import { createPortfolioRouter } from '../src/portfolio/routes.js';

const SOL_ADDRESS = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

// The server under test runs in this same process, so stubbing global `fetch`
// to detect outbound provider calls would also swallow the test client's own
// requests. Keep a handle on the real implementation for driving the server.
const realFetch = globalThis.fetch.bind(globalThis);

let server: Server;
let base: string;
let fetchSpy: ReturnType<typeof vi.fn>;

const ENV_KEYS = ['OCT_MODE', 'TRENCHCORD_MODE', 'BIRDEYE_API_KEY', 'GMGN_API_KEY'] as const;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  // Mirror the real mount shape from index.ts: `app.use('/api', authMiddleware,
  // createRouter(...))` with the portfolio router at '/portfolio'. This matters
  // because Express strips the '/api' mount prefix, which is exactly why the
  // old `req.path === '/portfolio/status'` comparison matched at all.
  const api = Router();
  api.use('/portfolio', createPortfolioRouter());

  const app = express();
  app.use(express.json());
  app.use('/api', authMiddleware, api);

  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  // No provider keys: the probe must resolve without touching the network, so a
  // stray real request would show up as a fetchSpy call rather than as billing.
  delete process.env.BIRDEYE_API_KEY;
  delete process.env.GMGN_API_KEY;

  fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function setLocalMode() {
  delete process.env.OCT_MODE;
  delete process.env.TRENCHCORD_MODE;
}

function setHostedMode() {
  process.env.OCT_MODE = 'hosted';
}

describe('local mode — no auth by design, endpoint stays usable', () => {
  it('serves the env status without any Authorization header', async () => {
    setLocalMode();
    const res = await realFetch(`${base}/api/portfolio/status`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.provider).toBe('birdeye');
    expect(body.birdeyeConfigured).toBe(false);
    expect(body.gmgn.gmgnApiKeyConfigured).toBe(false);
  });

  it('still runs the probe path', async () => {
    setLocalMode();
    const res = await realFetch(
      `${base}/api/portfolio/status?probeChain=sol&probeAddress=${SOL_ADDRESS}`,
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    // Reached probePortfolio and short-circuited on the missing key rather than
    // being blocked upstream by auth.
    expect(body.probes.holdings.birdeyeConfigured).toBe(false);
    expect(body.probes.holdings.chains).toEqual(['sol']);
  });
});

describe('hosted mode — auth required', () => {
  it('401s the plain status call when no bearer token is supplied', async () => {
    setHostedMode();
    const res = await realFetch(`${base}/api/portfolio/status`);
    expect(res.status).toBe(401);
  });

  it('401s a probe request and spends no provider quota', async () => {
    setHostedMode();
    const res = await realFetch(
      `${base}/api/portfolio/status?probeChain=sol&probeAddress=${SOL_ADDRESS}`,
    );
    expect(res.status).toBe(401);
    // The whole point: the request is rejected before any outbound provider
    // call is made, so an anonymous caller cannot bill the operator.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('leaks no env status in the rejection body', async () => {
    setHostedMode();
    const res = await realFetch(`${base}/api/portfolio/status`);
    const body = await res.json();
    expect(body).toEqual({ error: 'Authentication required.' });
  });
});

describe('secret length is never reported', () => {
  it('omits gmgnApiKeyLength even when GMGN_API_KEY is set', async () => {
    setLocalMode();
    process.env.GMGN_API_KEY = 'abcdef0123456789-a-key-of-a-very-specific-length';

    const res = await realFetch(`${base}/api/portfolio/status`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.gmgn.gmgnApiKeyConfigured).toBe(true);
    expect(body.gmgn).not.toHaveProperty('gmgnApiKeyLength');
    // Belt and braces: the key itself must not appear anywhere in the payload.
    expect(JSON.stringify(body)).not.toContain(process.env.GMGN_API_KEY);
  });
});
