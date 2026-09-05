import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';

// GET /pumpfun/roster/dropped is the one place the console learns that a
// followed caller / tracked trader is NOT being watched upstream (j7's 50-slot
// cap). These tests pin three things: the route exists on the pumpfun router,
// it returns the reconciler's snapshot verbatim (both trackers + the timestamp),
// and it is NOT gated on the callout store — local mode must get an honest
// empty answer, not a 503.

// Controllable stand-in for the reconciler's snapshot. vi.mock is hoisted, so
// the router import below sees this module, never the real one (which would
// otherwise pull in the Supabase-backed demand readers).
const snapshot = vi.hoisted(() => ({
  value: {
    pump: [] as { key: string; followerCount: number }[],
    fomo: [] as { key: string; followerCount: number }[],
    at: null as string | null,
  },
}));

vi.mock('../src/j7/roster.js', () => ({
  getDroppedRoster: () => ({
    pump: [...snapshot.value.pump],
    fomo: [...snapshot.value.fomo],
    at: snapshot.value.at,
  }),
}));

// Local mode: no Supabase, so the callout store is absent. The tracked-set
// routes 503 in this state; the dropped-roster route must not.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

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
});

describe('GET /pumpfun/roster/dropped', () => {
  it('returns an empty snapshot (200, not 503) when nothing has been dropped', async () => {
    snapshot.value = { pump: [], fomo: [], at: null };
    const res = await fetch(`${base}/pumpfun/roster/dropped`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pump: [], fomo: [], at: null });
  });

  it('returns both trackers and the reconcile timestamp verbatim', async () => {
    snapshot.value = {
      pump: [
        { key: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', followerCount: 2 },
        { key: 'So11111111111111111111111111111111111111112', followerCount: 1 },
      ],
      fomo: [{ key: 'someTrader', followerCount: 1 }],
      at: '2026-09-04T10:00:00.000Z',
    };
    const res = await fetch(`${base}/pumpfun/roster/dropped`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof snapshot.value;
    expect(body.pump).toHaveLength(2);
    expect(body.pump[0]).toEqual({ key: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', followerCount: 2 });
    expect(body.fomo).toEqual([{ key: 'someTrader', followerCount: 1 }]);
    expect(body.at).toBe('2026-09-04T10:00:00.000Z');
  });

  it('is read-only: no POST/DELETE is registered on the path', async () => {
    for (const method of ['POST', 'DELETE', 'PUT']) {
      const res = await fetch(`${base}/pumpfun/roster/dropped`, { method });
      expect(res.status, method).toBe(404);
    }
  });

  it('stays mounted next to the tracked-set routes it complements', async () => {
    // The sibling /callers route is store-gated and 503s here (no Supabase) —
    // that contrast is the point: same router, different gate.
    const res = await fetch(`${base}/pumpfun/callers`);
    expect(res.status).toBe(503);
  });
});
