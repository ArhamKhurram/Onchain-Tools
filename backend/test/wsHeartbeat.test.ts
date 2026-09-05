import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server as HttpServer } from 'http';

// A peer that vanishes without a FIN (mobile sleep, network drop, killed
// process) used to stay readyState OPEN in the clients map forever: fan-out
// kept buffering frames into the dead socket, and one ghost pinned every
// adaptive poller (fomo 10s, callouts 12s, wallet movement 30s) at its fast
// interval because getAuthenticatedClientCount() never reached 0. These tests
// pin the heartbeat sweep: ping every open socket, terminate any that never
// ponged the previous ping — bounding ghost lifetime to ~2 sweep intervals.

let httpServer: HttpServer;
let wsServer: any;

beforeAll(async () => {
  const { WsServer } = await import('../src/ws/server.js');
  httpServer = createServer();
  wsServer = new WsServer(httpServer);
});

afterAll(() => {
  wsServer?.wss?.close();
  httpServer?.close();
});

beforeEach(() => {
  wsServer.clients.clear();
});

function fakeSocket(userId: string | null = null): { ws: any; state: any } {
  const ws: any = {
    readyState: 1,
    pings: 0,
    terminated: false,
    ping() { this.pings++; },
    terminate() {
      this.terminated = true;
      this.readyState = 3; // a real terminate() also fires 'close' → map cleanup
      wsServer.clients.delete(this);
    },
    send() {},
  };
  wsServer.clients.set(ws, { subscribedRooms: new Set(['__all__']), userId, isAlive: true });
  return { ws, state: wsServer.clients.get(ws) };
}

describe('WS heartbeat sweep', () => {
  it('a responsive client (pongs between sweeps) is pinged and never terminated', () => {
    const { ws, state } = fakeSocket();

    for (let i = 0; i < 5; i++) {
      wsServer.sweepDeadConnections();
      expect(ws.terminated).toBe(false);
      state.isAlive = true; // what the 'pong' handler does
    }
    expect(ws.pings).toBe(5);
  });

  it('an unresponsive client is terminated on the second sweep', () => {
    const { ws } = fakeSocket('ghost-user');

    wsServer.sweepDeadConnections(); // ping, clear isAlive
    expect(ws.pings).toBe(1);
    expect(ws.terminated).toBe(false);

    wsServer.sweepDeadConnections(); // no pong arrived -> terminate
    expect(ws.terminated).toBe(true);
    expect(ws.pings).toBe(1);
  });

  it('a terminated ghost stops counting as an authenticated client', () => {
    fakeSocket('ghost-user');
    expect(wsServer.getAuthenticatedClientCount()).toBe(1);

    wsServer.sweepDeadConnections();
    wsServer.sweepDeadConnections();

    expect(wsServer.getAuthenticatedClientCount()).toBe(0);
    expect(wsServer.hasActiveClients('ghost-user')).toBe(false);
  });

  it('only the dead socket is terminated; live ones keep receiving broadcasts', () => {
    const dead = fakeSocket();
    const live = fakeSocket();

    wsServer.sweepDeadConnections();
    live.state.isAlive = true; // live one ponged
    wsServer.sweepDeadConnections();

    expect(dead.ws.terminated).toBe(true);
    expect(live.ws.terminated).toBe(false);
  });
});
