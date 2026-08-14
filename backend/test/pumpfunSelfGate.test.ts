import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';

// The self-gate must cover ONLY the keyed coin-communities routes. The
// trades/balance/pnl routes read from profile-api.pump.fun, which is keyless, so
// gating them on PUMPFUN_API_KEY would make the whole activity feature
// unreachable without a key it never uses. Key deliberately UNSET here.
delete process.env.PUMPFUN_API_KEY;
delete process.env.OCT_PUMPFUN_API_KEY;
delete process.env.TRENCHCORD_PUMPFUN_API_KEY;

const WALLET = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const MINT = 'So11111111111111111111111111111111111111112';

const { createPumpfunRouter } = await import('../src/pumpfun/routes.js');

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/pumpfun', createPumpfunRouter());
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  vi.unstubAllGlobals();
});

describe('self-gate applies to keyed routes only (key unset)', () => {
  it('503s a keyed callouts route when PUMPFUN_API_KEY is missing', async () => {
    const res = await fetch(`${base}/pumpfun/token/${MINT}/callouts`);
    expect(res.status).toBe(503);
  });

  it('does NOT 503 the keyless trades route — it reaches the keyless host', async () => {
    // Stub the upstream so the route resolves without a real network call. The
    // point is only that it got PAST the gate: a 503 would mean it was blocked
    // on a key it does not use.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ transactions: [], pagination: {} }), { status: 200 })),
    );
    const res = await fetch(`${base}/pumpfun/wallet/${WALLET}/transactions`);
    vi.unstubAllGlobals();
    expect(res.status).not.toBe(503);
    expect(res.status).toBe(200);
  });

  it('does NOT 503 the keyless balance route', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ }), { status: 200 })),
    );
    const res = await fetch(`${base}/pumpfun/wallet/${WALLET}/balance`);
    vi.unstubAllGlobals();
    expect(res.status).not.toBe(503);
  });
});
