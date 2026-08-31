import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer, type Server as HttpServer } from 'http';

// Backpressure guard on WS sends. `ws.send()` never blocks — anything the
// kernel socket can't take is buffered in server memory (`bufferedAmount`), so
// before this guard a client that stopped reading grew an unbounded per-socket
// buffer while broadcasts kept flowing. The guard is two-stage:
//
//   soft cap  -> skip non-essential frames (feed traffic) for that socket
//   hard cap  -> terminate the socket (frontend useWebSocket auto-reconnects)
//
// These tests drive the real WsServer with fake sockets exposing a
// controllable `bufferedAmount`, and pin three things:
//   1. healthy sockets see zero behavior change (every frame, same order)
//   2. a stalled client's buffer stays bounded near the soft cap — memory no
//      longer grows with broadcast volume
//   3. essential frames (alerts) survive the soft cap but nothing survives the
//      hard cap.

const ENV_KEYS = [
  'OCT_MODE', 'TRENCHCORD_MODE',
  'OCT_WS_BUFFER_SOFT_LIMIT', 'TRENCHCORD_WS_BUFFER_SOFT_LIMIT',
  'OCT_WS_BUFFER_HARD_LIMIT', 'TRENCHCORD_WS_BUFFER_HARD_LIMIT',
] as const;
const saved: Record<string, string | undefined> = {};

let WsServerClass: any;
const cleanups: Array<() => void> = [];

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  delete process.env.OCT_MODE; // local mode: no user filtering, simplest fan-out
  delete process.env.TRENCHCORD_MODE;
  ({ WsServer: WsServerClass } = await import('../src/ws/server.js'));
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  for (const k of ENV_KEYS.slice(2)) delete process.env[k]; // drop cap overrides
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function makeWsServer(): any {
  const httpServer: HttpServer = createServer();
  const wsServer = new WsServerClass(httpServer);
  cleanups.push(() => { wsServer.wss.close(); httpServer.close(); });
  return wsServer;
}

interface FakeSocket {
  readyState: number;
  bufferedAmount: number;
  sent: string[];
  terminated: boolean;
  /** When false, send() grows bufferedAmount and nothing ever drains — a stalled TCP peer. */
  drains: boolean;
  send(payload: string): void;
  terminate(): void;
}

/** Fake socket + client state registered directly in the private clients map. */
function connectSocket(wsServer: any, opts?: { drains?: boolean }): { ws: FakeSocket; state: any } {
  const ws: FakeSocket = {
    readyState: 1, // WebSocket.OPEN
    bufferedAmount: 0,
    sent: [],
    terminated: false,
    drains: opts?.drains ?? true,
    send(payload: string) {
      this.sent.push(payload);
      if (!this.drains) this.bufferedAmount += Buffer.byteLength(payload);
    },
    terminate() {
      this.terminated = true;
      this.readyState = 3; // WebSocket.CLOSED
    },
  };
  wsServer.clients.set(ws, {
    subscribedRooms: new Set(['__all__']),
    userId: null,
    skippedFrames: 0,
  });
  return { ws, state: wsServer.clients.get(ws) };
}

const msg = (i: number) => ({
  id: `m${i}`, channelId: 'c1', guildId: 'g1', channelName: 'alpha-calls',
  guildName: 'Alpha', author: { id: 'u1', username: 'caller', displayName: 'Caller', avatar: null },
  content: `new runner ${i} — So1ana111111111111111111111111111111111111`,
  timestamp: new Date().toISOString(), attachments: [], embeds: [],
  isHighlighted: false, hasContractAddress: true,
  contractAddresses: ['So1ana111111111111111111111111111111111111'], mentions: {},
} as any);

const alert = (i: number) => ({ type: 'keyword', message: msg(i), reason: `keyword hit ${i}` });

describe('WS backpressure guard', () => {
  it('healthy sockets see zero behavior change — every frame delivered in order', () => {
    const wsServer = makeWsServer();
    const { ws, state } = connectSocket(wsServer); // drains: bufferedAmount stays 0

    for (let i = 0; i < 25; i++) {
      wsServer.broadcastMessage(msg(i), ['room-1']);
      wsServer.broadcastContract({ address: `addr${i}`, chain: 'sol' });
      wsServer.broadcastAlert(alert(i));
      wsServer.broadcastContractEnrichment({ address: `addr${i}`, tokenSymbol: 'TKN' });
    }

    expect(ws.sent).toHaveLength(100);
    expect(ws.terminated).toBe(false);
    expect(state.skippedFrames).toBe(0);
    // Order preserved: first four frames are exactly the first iteration's sequence.
    expect(ws.sent.slice(0, 4).map((p) => JSON.parse(p).type))
      .toEqual(['message', 'contract', 'alert', 'contract_enrichment']);
  });

  it('skips non-essential frames once bufferedAmount exceeds the soft cap', () => {
    const wsServer = makeWsServer();
    const { ws, state } = connectSocket(wsServer);
    ws.bufferedAmount = 1 * 1024 * 1024 + 1; // just past the 1 MiB default soft cap

    wsServer.broadcastMessage(msg(1), ['room-1']);
    wsServer.broadcastContract({ address: 'addr1', chain: 'sol' });
    wsServer.broadcastReactionUpdate({ channelId: 'c1', messageId: 'm1', emoji: { id: null, name: 'x' }, delta: 1 });
    wsServer.sendToUser('local', { type: 'fomo_trade', data: { tradeId: 't1' } });

    expect(ws.sent).toHaveLength(0);
    expect(state.skippedFrames).toBe(4);
    expect(ws.terminated).toBe(false);
  });

  it('still delivers essential alert frames between the soft and hard caps', () => {
    const wsServer = makeWsServer();
    const { ws, state } = connectSocket(wsServer);
    ws.bufferedAmount = 2 * 1024 * 1024; // past soft (1 MiB), well under hard (8 MiB)

    wsServer.broadcastAlert(alert(1));
    wsServer.broadcastRevivalAlert({ address: 'addr1', tokenSymbol: 'TKN' });
    wsServer.broadcastBreakoutAlert({ address: 'addr2', tokenSymbol: 'TKN2' });
    wsServer.broadcastContract({ address: 'addr3', chain: 'sol' }); // non-essential control

    expect(ws.sent.map((p) => JSON.parse(p).type))
      .toEqual(['alert', 'revival_alert', 'breakout_alert']);
    expect(state.skippedFrames).toBe(1);
    expect(ws.terminated).toBe(false);
  });

  it('terminates a socket past the hard cap — even for essential frames', () => {
    const wsServer = makeWsServer();
    const { ws } = connectSocket(wsServer);
    ws.bufferedAmount = 8 * 1024 * 1024 + 1; // just past the 8 MiB default hard cap

    wsServer.broadcastRevivalAlert({ address: 'addr1', tokenSymbol: 'TKN' });

    expect(ws.terminated).toBe(true);
    expect(ws.sent).toHaveLength(0);

    // A terminated socket is CLOSED and never touched again.
    wsServer.broadcastContract({ address: 'addr2', chain: 'sol' });
    expect(ws.sent).toHaveLength(0);
  });

  it('memory stays bounded for a stalled client: 10k broadcasts, buffer parked at the soft cap', () => {
    process.env.OCT_WS_BUFFER_SOFT_LIMIT = '4096';
    process.env.OCT_WS_BUFFER_HARD_LIMIT = '16384';
    const wsServer = makeWsServer();

    const stalled = connectSocket(wsServer, { drains: false });
    const healthy = connectSocket(wsServer); // control: guard must not touch it

    const frames = 10_000;
    for (let i = 0; i < frames; i++) {
      wsServer.broadcastContract({ address: `addr${i}`, chain: 'sol', channelName: 'alpha-calls' });
    }

    const frameBytes = Buffer.byteLength(
      JSON.stringify({ type: 'contract', data: { address: 'addr9999', chain: 'sol', channelName: 'alpha-calls' } }),
    );
    const unbounded = frames * frameBytes; // what the old behavior would have buffered (~800 KB here, GBs in prod)

    // Bounded: once past the soft cap the guard stops queueing, so the buffer
    // never exceeds soft cap + one frame — three orders of magnitude below
    // what unguarded broadcasting would have accumulated.
    expect(stalled.ws.bufferedAmount).toBeGreaterThan(4096); // it did stall past the cap
    expect(stalled.ws.bufferedAmount).toBeLessThanOrEqual(4096 + frameBytes);
    expect(stalled.ws.bufferedAmount).toBeLessThan(unbounded / 100);
    expect(stalled.state.skippedFrames).toBe(frames - stalled.ws.sent.length);
    expect(stalled.ws.terminated).toBe(false); // parked at soft cap, never reached hard

    // The healthy socket got every single frame.
    expect(healthy.ws.sent).toHaveLength(frames);
    expect(healthy.state.skippedFrames).toBe(0);
  });

  it('a stalled client fed only essential frames is terminated at the hard cap, not grown unboundedly', () => {
    process.env.OCT_WS_BUFFER_SOFT_LIMIT = '4096';
    process.env.OCT_WS_BUFFER_HARD_LIMIT = '16384';
    const wsServer = makeWsServer();
    const { ws } = connectSocket(wsServer, { drains: false });

    let maxFrame = 0;
    for (let i = 0; i < 500 && !ws.terminated; i++) {
      const payload = { address: `addr${i}`, tokenSymbol: 'TKN', reason: 'revival ignition' };
      maxFrame = Math.max(maxFrame, Buffer.byteLength(JSON.stringify({ type: 'revival_alert', data: payload })));
      wsServer.broadcastRevivalAlert(payload);
    }

    expect(ws.terminated).toBe(true);
    expect(ws.bufferedAmount).toBeLessThanOrEqual(16384 + maxFrame);
  });

  it('caps are env-tunable via OCT_* with TRENCHCORD_* fallback; junk values fall back to defaults', () => {
    process.env.OCT_WS_BUFFER_SOFT_LIMIT = '2048';
    process.env.OCT_WS_BUFFER_HARD_LIMIT = '8192';
    const tuned = makeWsServer();
    expect(tuned.softBufferLimit).toBe(2048);
    expect(tuned.hardBufferLimit).toBe(8192);

    delete process.env.OCT_WS_BUFFER_SOFT_LIMIT;
    delete process.env.OCT_WS_BUFFER_HARD_LIMIT;
    process.env.TRENCHCORD_WS_BUFFER_SOFT_LIMIT = '1024';
    process.env.TRENCHCORD_WS_BUFFER_HARD_LIMIT = '4096';
    const legacy = makeWsServer();
    expect(legacy.softBufferLimit).toBe(1024);
    expect(legacy.hardBufferLimit).toBe(4096);

    process.env.OCT_WS_BUFFER_SOFT_LIMIT = 'not-a-number';
    process.env.TRENCHCORD_WS_BUFFER_SOFT_LIMIT = '-5';
    process.env.OCT_WS_BUFFER_HARD_LIMIT = '';
    delete process.env.TRENCHCORD_WS_BUFFER_HARD_LIMIT;
    const junk = makeWsServer();
    expect(junk.softBufferLimit).toBe(1 * 1024 * 1024);
    expect(junk.hardBufferLimit).toBe(8 * 1024 * 1024);
  });

  it('clamps a hard cap configured below the soft cap so skip always precedes terminate', () => {
    process.env.OCT_WS_BUFFER_SOFT_LIMIT = '65536';
    process.env.OCT_WS_BUFFER_HARD_LIMIT = '1024';
    const wsServer = makeWsServer();
    expect(wsServer.hardBufferLimit).toBe(65536);

    const { ws, state } = connectSocket(wsServer);
    ws.bufferedAmount = 32768; // between the misconfigured hard cap and the soft cap
    wsServer.broadcastContract({ address: 'addr1', chain: 'sol' });
    expect(ws.terminated).toBe(false); // clamped: still merely below the soft cap
    expect(ws.sent).toHaveLength(1);
    expect(state.skippedFrames).toBe(0);
  });
});
