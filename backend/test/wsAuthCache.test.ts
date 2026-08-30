import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';

// The WS auth frame used to verify its bearer token with a dedicated Supabase
// client, so every connect — and every reconnect after a redeploy or network
// blip — was a fresh GoTrue round-trip even though the console's REST polling
// had just verified the exact same JWT through the authMiddleware cache (#209).
// These tests pin the consolidation: WS auth goes through the shared
// cache-first verifier, and a warm token costs zero extra round-trips.
//
// A local HTTP server stands in for GoTrue and counts /auth/v1/user hits, so
// the assertions are about actual network round-trips, not internal spies.

const USER_ID = '11111111-2222-3333-4444-555555555555';
const GOOD_TOKEN = 'ws-auth-cache-good-token';
const BAD_TOKEN = 'ws-auth-cache-bad-token';

let gotrue: HttpServer;
let gotrueHits = 0;
let httpServer: HttpServer;
let wsServer: any;

const ENV_KEYS = ['OCT_MODE', 'TRENCHCORD_MODE', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'] as const;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];

  gotrue = createServer((req, res) => {
    if (req.url?.startsWith('/auth/v1/user')) {
      gotrueHits++;
      if (req.headers.authorization === `Bearer ${BAD_TOKEN}`) {
        res.statusCode = 401;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'invalid_token', error_description: 'nope' }));
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: USER_ID, aud: 'authenticated', role: 'authenticated',
        email: 'test@example.com', created_at: new Date().toISOString(),
        app_metadata: {}, user_metadata: {},
      }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((r) => gotrue.listen(0, '127.0.0.1', r));

  process.env.OCT_MODE = 'hosted';
  delete process.env.TRENCHCORD_MODE;
  process.env.SUPABASE_URL = `http://127.0.0.1:${(gotrue.address() as AddressInfo).port}`;
  process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

  // Import after env is set: the verifier reads SUPABASE_URL lazily but only once.
  const { WsServer } = await import('../src/ws/server.js');
  httpServer = createServer();
  wsServer = new WsServer(httpServer);
});

afterAll(() => {
  wsServer?.wss?.close();
  httpServer?.close();
  gotrue?.close();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** Fake socket + client state registered directly in the private clients map. */
function connectSocket(): { ws: any; state: any } {
  const ws: any = { readyState: 1, sent: [] as string[], send(p: string) { this.sent.push(p); } };
  wsServer.clients.set(ws, { subscribedRooms: new Set(), userId: null });
  return { ws, state: wsServer.clients.get(ws) };
}

async function authAndSettle(ws: any, token: string): Promise<void> {
  wsServer.handleClientMessage(ws, { type: 'auth', token });
  for (let i = 0; i < 400; i++) {
    const state = wsServer.clients.get(ws);
    if (state.userId || ws.sent.length) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('WS auth never settled');
}

describe('WS auth token verification cache', () => {
  it('verifies a cold token with exactly one GoTrue round-trip', async () => {
    const { ws, state } = connectSocket();
    await authAndSettle(ws, GOOD_TOKEN);
    expect(state.userId).toBe(USER_ID);
    expect(gotrueHits).toBe(1);
  });

  it('authenticates a reconnect with the same JWT from cache — no extra round-trip', async () => {
    const { ws, state } = connectSocket();
    await authAndSettle(ws, GOOD_TOKEN);
    expect(state.userId).toBe(USER_ID);
    expect(gotrueHits).toBe(1);
  });

  it('shares the cache with the REST authMiddleware', async () => {
    const { authMiddleware } = await import('../src/auth/middleware.js');
    const userId = await new Promise<string>((resolve, reject) => {
      const req: any = { headers: { authorization: `Bearer ${GOOD_TOKEN}` } };
      const res: any = { status: () => ({ json: (b: any) => reject(new Error(JSON.stringify(b))) }) };
      authMiddleware(req, res, () => resolve(req.userId));
    });
    expect(userId).toBe(USER_ID);
    expect(gotrueHits).toBe(1);
  });

  it('rejects an invalid token every time — negative results are not cached', async () => {
    const before = gotrueHits;
    for (let i = 0; i < 2; i++) {
      const { ws, state } = connectSocket();
      await authAndSettle(ws, BAD_TOKEN);
      expect(state.userId).toBeNull();
      expect(ws.sent.some((p: string) => JSON.parse(p).type === 'auth_error')).toBe(true);
    }
    expect(gotrueHits).toBe(before + 2);
  });
});
