import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server as HttpServer } from 'http';

// Broadcasts used to JSON.stringify their payload up front and then look for
// recipients. In hosted mode the steady state is pollers and idle telegram
// gateways broadcasting for users whose console tabs are closed, so the
// serialization was pure waste (~4-16us per call for a typical 2KB message vs
// ~0.3us for the map walk alone). These tests pin the lazy contract: stringify
// happens exactly once when there is at least one eligible socket, and never
// when there is none.

let httpServer: HttpServer;
let wsServer: any;
const savedMode: Record<string, string | undefined> = {};

beforeAll(async () => {
  savedMode.OCT_MODE = process.env.OCT_MODE;
  savedMode.TRENCHCORD_MODE = process.env.TRENCHCORD_MODE;
  const { WsServer } = await import('../src/ws/server.js');
  httpServer = createServer();
  wsServer = new WsServer(httpServer);
});

afterAll(() => {
  wsServer?.wss?.close();
  httpServer?.close();
  for (const [k, v] of Object.entries(savedMode)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(() => {
  wsServer.clients.clear();
  delete process.env.OCT_MODE;
  delete process.env.TRENCHCORD_MODE;
});

function fakeSocket(userId: string | null, rooms: string[] = ['__all__']): any {
  const ws: any = { readyState: 1, sent: [] as string[], send(p: string) { this.sent.push(p); } };
  wsServer.clients.set(ws, { subscribedRooms: new Set(rooms), userId });
  return ws;
}

/** Message payload that counts how many times it gets serialized. */
function countingPayload(): { data: any; count: () => number } {
  let n = 0;
  const data = { id: 'm1', content: 'hello', toJSON() { n++; return { id: 'm1', content: 'hello' }; } };
  return { data, count: () => n };
}

describe('WS fan-out lazy serialization', () => {
  it('does not serialize at all when no eligible socket exists (hosted, offline user)', () => {
    process.env.OCT_MODE = 'hosted';
    const other = fakeSocket('user-b');
    const { data, count } = countingPayload();

    wsServer.broadcastContract(data, 'user-a');
    wsServer.sendToUser('user-a', { type: 'fomo_trade', data });
    wsServer.broadcastMessage(data, ['room-1'], 'user-a');

    expect(count()).toBe(0);
    expect(other.sent).toHaveLength(0);
  });

  it('does not serialize when no client subscribes to the rooms', () => {
    const ws = fakeSocket(null, ['room-other']);
    const { data, count } = countingPayload();

    wsServer.broadcastMessage(data, ['room-1', 'room-2']);

    expect(count()).toBe(0);
    expect(ws.sent).toHaveLength(0);
  });

  it('serializes exactly once for multiple recipients and delivers the identical payload', () => {
    const a = fakeSocket(null);
    const b = fakeSocket(null);
    const closed = fakeSocket(null);
    closed.readyState = 3; // CLOSED
    const { data, count } = countingPayload();

    wsServer.broadcastMessage(data, ['room-1']);

    expect(count()).toBe(1);
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
    expect(closed.sent).toHaveLength(0);
    expect(a.sent[0]).toBe(b.sent[0]);
    const frame = JSON.parse(a.sent[0]);
    expect(frame).toMatchObject({ type: 'message', roomIds: ['room-1'], data: { id: 'm1', content: 'hello' } });
  });

  it('still filters by user in hosted mode', () => {
    process.env.OCT_MODE = 'hosted';
    const mine = fakeSocket('user-a');
    const other = fakeSocket('user-b');

    wsServer.sendToUser('user-a', { type: 'journal_update', data: { walletId: 'w1' } });

    expect(mine.sent).toHaveLength(1);
    expect(other.sent).toHaveLength(0);
    expect(JSON.parse(mine.sent[0]).type).toBe('journal_update');
  });

  it('local mode ignores the user filter (single tenant, sockets never authenticate)', () => {
    const ws = fakeSocket(null);

    wsServer.broadcastContract({ address: 'So1anaAddr' }, 'local');

    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0]).type).toBe('contract');
  });
});
