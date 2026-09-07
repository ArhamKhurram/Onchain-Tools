// Route-level tests for POST /api/fomo/tracked.
//
// The property under test is a property of the ROUTING, not of any one
// function: that a request carrying an already-resolved identity never touches
// the fomo.family service account (which has been Forbidden upstream since
// 2026-08-26, and whose absence made the leaderboard's TRACK button a permanent
// 503), while free-text search still 503s because it genuinely cannot work.
//
// Same house style as sniperRoutes.test.ts: no supertest, the router is mounted
// on a bare express app on an ephemeral loopback port and driven with fetch.
// Supabase and the FOMO client are replaced with fakes — nothing leaves the box.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';

const UUID = '6d8c0bf3-5d42-506c-a0ea-9e1e75ff38af';

/** Set per-test: what ensureSharedFomoClientReady() resolves to. */
let fomoClient: any = null;
/** Set per-test: what the insert returns. */
let insertResult: { data: any; error: any } = { data: null, error: null };
/** Every insert payload the route handed Supabase. */
const inserts: any[] = [];
let backfillCalls: string[] = [];

vi.mock('../src/fomo/client.js', () => ({
  ensureSharedFomoClientReady: async () => fomoClient,
  resolveFomoRefreshToken: async () => null,
}));

vi.mock('../src/fomo/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/fomo/store.js')>();
  return {
    ...actual,
    getFomoServiceClient: () => fakeDb,
    loadFomoTokenRotatedAt: async () => null,
  };
});

vi.mock('../src/fomo/dispatch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/fomo/dispatch.js')>();
  return {
    ...actual,
    deliverRecentTradesToUser: async (_db: any, _ws: any, fomoUserId: string) => {
      backfillCalls.push(fomoUserId);
    },
  };
});

// Minimal Supabase stub: only the insert chain POST /tracked uses.
const fakeDb: any = {
  from(_table: string) {
    return {
      insert(payload: any) {
        inserts.push(payload);
        return {
          select() {
            return { single: async () => insertResult };
          },
        };
      },
    };
  },
};

const { createFomoRouter } = await import('../src/fomo/routes.js');

let server: Server;
let base: string;

async function post(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/fomo/tracked`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* leave null */
  }
  return { status: res.status, body: parsed };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/fomo', createFomoRouter({} as any));
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  fomoClient = null;
  inserts.length = 0;
  backfillCalls = [];
  insertResult = {
    data: {
      id: 'row-1',
      user_id: 'local',
      fomo_user_id: UUID,
      fomo_handle: 'kp',
      display_name: 'KP',
      notify_pushover: false,
      created_at: new Date().toISOString(),
    },
    error: null,
  };
});

describe('POST /api/fomo/tracked — resolved identity (the leaderboard TRACK button)', () => {
  it('tracks without the FOMO service account when the identity is supplied', async () => {
    const res = await post({ query: 'kp', fomoUserId: UUID, fomoHandle: 'kp', displayName: 'KP' });
    expect(res.status).toBe(201);
    expect(res.body.fomo_user_id).toBe(UUID);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ fomo_user_id: UUID, fomo_handle: 'kp', display_name: 'KP' });
  });

  it('still runs the recent-trade backfill (a no-op while FOMO is blocked, by design)', async () => {
    await post({ fomoUserId: UUID });
    expect(backfillCalls).toEqual([UUID]);
  });

  it('takes the row owner from the request, never from the body', async () => {
    await post({ fomoUserId: UUID, user_id: 'someone-else', userId: 'someone-else' });
    expect(inserts[0].user_id).toBe('local');
    expect(JSON.stringify(inserts[0])).not.toContain('someone-else');
  });

  it('returns 409 on the unique violation of (user_id, fomo_user_id)', async () => {
    insertResult = { data: null, error: { code: '23505', message: 'duplicate key' } };
    const res = await post({ fomoUserId: UUID });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already tracking/i);
  });

  it('rejects a malformed identity with 400 and writes nothing', async () => {
    for (const body of [
      { fomoUserId: 'not-a-uuid' },
      { fomoUserId: UUID, fomoHandle: '<img src=x onerror=alert(1)>' },
      { fomoUserId: UUID, displayName: 'a'.repeat(200) },
      { fomoUserId: { $ne: null } },
    ]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(inserts).toHaveLength(0);
  });
});

describe('POST /api/fomo/tracked — free text', () => {
  it('503s while the service account is blocked, and names the working route', async () => {
    const res = await post({ query: 'kp' });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/leaderboard/i);
    expect(inserts).toHaveLength(0);
  });

  it('400s when neither a query nor an identity is supplied', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
  });

  it('404s on a genuine miss when the client is available', async () => {
    fomoClient = {
      getUserByHandle: async () => ({ status: 404, json: null }),
      searchUsers: async () => ({ status: 200, json: [] }),
    };
    const res = await post({ query: 'nobody' });
    expect(res.status).toBe(404);
    expect(inserts).toHaveLength(0);
  });

  it('does not echo control characters from the query back into the 404', async () => {
    fomoClient = {
      getUserByHandle: async () => ({ status: 404, json: null }),
      searchUsers: async () => ({ status: 200, json: [] }),
    };
    const res = await post({ query: 'nobody\n[FomoAPI] forged log line' });
    expect(res.status).toBe(404);
    expect(res.body.error).not.toContain('\n');
  });

  it('still resolves and tracks when the client works', async () => {
    fomoClient = {
      getUserByHandle: async () => ({ status: 200, json: { id: UUID, handle: 'kp', name: 'KP' } }),
      searchUsers: async () => ({ status: 200, json: [] }),
    };
    const res = await post({ query: 'kp' });
    expect(res.status).toBe(201);
    expect(inserts[0]).toMatchObject({ fomo_user_id: UUID });
  });
});
