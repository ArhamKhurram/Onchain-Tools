// 985monitor.xyz live-event-stream listener.
//
// Holds ONE long-lived SSE connection to the site's public, keyless
// `/api/events-stream`, keeps only the `event: fomo` frames, and fans them out
// over the EXISTING WebSocket as `fomo_stream_trade` — the same transport
// `fomo_trade` and `robinhood_fill` already use. No second transport, no
// persistence, no per-user state: the stream is a global public feed, so it
// broadcasts.
//
// Why a stream rather than a poll: the upstream pushes at second-level latency
// (measured: median lag under 1s, ~17 fomo events/min across every chain), and
// there is no snapshot endpoint to poll. See streamNormalize.ts for the scope
// and labelling rules that apply to everything this emits.
//
// COST NOTE. The upstream has no server-side filter — its own client subscribes
// to every event type and filters in the browser — so this connection carries
// roughly 55 MB/hour inbound, of which the fomo rows are a small fraction. That
// is inbound bandwidth on the backend host and no Supabase egress at all, but
// it is the reason this is opt-in rather than on by default, and the reason the
// hot path below only JSON.parses a block after a substring test says it is a
// fomo frame.
//
// Failure policy: nothing here can throw into the process. The read loop is
// wrapped, a dropped connection reconnects with capped exponential backoff and
// jitter, a stalled connection is aborted by a watchdog, and the state is
// surfaced through GET /api/fomo/stream/status as a degraded source.

import type { WsServer } from '../ws/server.js';
import { recordStreamTrade } from './streamFeed.js';
import {
  FOMO_STREAM_SOURCE,
  normalizeStreamTrade,
  parseSseFrame,
  splitSseBlocks,
  type FomoStreamTrade,
} from './streamNormalize.js';

const STREAM_URL =
  process.env.OCT_FOMO_STREAM_URL?.trim() || 'https://www.985monitor.xyz/api/events-stream';

/** Time allowed for the response headers to arrive before giving up. */
const CONNECT_TIMEOUT_MS = 20_000;
/**
 * No bytes at all for this long means the connection is wedged. The upstream
 * heartbeats roughly every 15s and the other event types are near-continuous,
 * so a full minute of silence is unambiguous.
 */
const IDLE_TIMEOUT_MS = 90_000;
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;
/**
 * Guard against a pathological upstream burst flooding every console. Frames
 * beyond this in a single second are recorded in the buffer but not broadcast.
 */
const MAX_EMIT_PER_SECOND = 20;
/** A single frame far larger than anything observed is a sign of trouble; skip it. */
const MAX_FRAME_BYTES = 64 * 1024;

function envFlag(name: string): boolean {
  const raw = (process.env[`OCT_${name}`] ?? process.env[`TRENCHCORD_${name}`])?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * Off by default. This holds an always-open connection to a third party, so it
 * is opted into explicitly with OCT_FOMO_STREAM_ENABLED. The REST routes still
 * answer without it — they just report an inactive listener and an empty
 * buffer, which the console renders as "the live push is switched off".
 */
export function isFomoStreamEnabled(): boolean {
  return envFlag('FOMO_STREAM_ENABLED');
}

export interface FomoStreamStatus {
  enabled: boolean;
  connected: boolean;
  /** ISO timestamps, all null until the corresponding thing has happened. */
  connectedAt: string | null;
  lastEventAt: string | null;
  lastTradeAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  reconnects: number;
  /** fomo rows seen since boot (including duplicates dropped by the buffer). */
  tradesSeen: number;
  sourceUrl: string;
}

class FomoStreamListener {
  private wsServer: WsServer;
  private controller: AbortController | null = null;
  private stopped = false;
  private running = false;
  private attempt = 0;
  private lastEventId: string | null = null;
  private retryTimer: NodeJS.Timeout | null = null;

  private connected = false;
  private connectedAt: string | null = null;
  private lastEventAt: string | null = null;
  private lastTradeAt: string | null = null;
  private lastError: string | null = null;
  private lastErrorAt: string | null = null;
  private reconnects = 0;
  private tradesSeen = 0;

  private emitWindowStart = 0;
  private emitsInWindow = 0;

  constructor(wsServer: WsServer) {
    this.wsServer = wsServer;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    console.log(`[FomoStream] Listening to ${STREAM_URL} (985monitor.xyz public event stream).`);
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.running = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.controller?.abort();
    this.controller = null;
    this.connected = false;
  }

  /** Reconnect loop. Only exits when stop() is called. */
  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.connectOnce();
        // A clean end-of-stream is still a disconnect; fall through to backoff.
        this.noteError('stream ended');
      } catch (err) {
        this.noteError((err as Error)?.message ?? String(err));
      }
      this.connected = false;
      if (this.stopped) return;
      this.reconnects += 1;
      await this.sleep(this.backoffMs());
    }
  }

  /** Capped exponential backoff with jitter, so a site-wide outage is not a stampede. */
  private backoffMs(): number {
    const base = Math.min(BACKOFF_MIN_MS * 2 ** this.attempt, BACKOFF_MAX_MS);
    this.attempt = Math.min(this.attempt + 1, 8);
    return base / 2 + Math.random() * (base / 2);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.retryTimer = setTimeout(resolve, ms);
    });
  }

  private noteError(message: string): void {
    this.lastError = message.slice(0, 300);
    this.lastErrorAt = new Date().toISOString();
    console.warn('[FomoStream] Disconnected:', this.lastError);
  }

  private async connectOnce(): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;

    // Two separate deadlines: one for the handshake, then a rolling idle
    // watchdog. A single overall timeout would kill a healthy long stream.
    let watchdog: NodeJS.Timeout = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
    const resetWatchdog = (ms: number) => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => controller.abort(), ms);
    };

    try {
      const url = new URL(STREAM_URL);
      if (this.lastEventId) url.searchParams.set('lastEventId', this.lastEventId);

      const res = await fetch(url, {
        signal: controller.signal,
        headers: { accept: 'text/event-stream', 'cache-control': 'no-cache' },
      });
      if (!res.ok || !res.body) throw new Error(`985monitor stream → HTTP ${res.status}`);

      this.connected = true;
      this.connectedAt = new Date().toISOString();
      this.attempt = 0;
      this.lastError = null;
      resetWatchdog(IDLE_TIMEOUT_MS);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        resetWatchdog(IDLE_TIMEOUT_MS);
        this.lastEventAt = new Date().toISOString();

        buffer += decoder.decode(value, { stream: true });
        // A buffer this large means we never found a frame boundary; the
        // upstream is not speaking SSE any more. Drop it rather than grow.
        if (buffer.length > MAX_FRAME_BYTES * 4) buffer = '';

        const { blocks, rest } = splitSseBlocks(buffer);
        buffer = rest;
        for (const block of blocks) this.handleBlock(block);
      }
    } finally {
      clearTimeout(watchdog);
      if (this.controller === controller) this.controller = null;
    }
  }

  /**
   * The hot path. Runs ~14x/second across every event type on the stream, of
   * which fewer than 4% are fomo rows, so the cheap substring test comes first
   * and nothing else is ever parsed.
   */
  private handleBlock(block: string): void {
    if (block.length > MAX_FRAME_BYTES) return;
    if (!block.includes('event: fomo')) return;

    const frame = parseSseFrame(block);
    if (!frame || frame.event !== 'fomo') return;
    if (frame.id) this.lastEventId = frame.id;

    let parsed: unknown;
    try {
      parsed = JSON.parse(frame.data);
    } catch {
      return; // Malformed upstream row: drop it, never throw.
    }

    const trade = normalizeStreamTrade(parsed);
    if (!trade) return;

    this.tradesSeen += 1;
    this.lastTradeAt = new Date().toISOString();
    // The upstream re-emits the same key across its internal lanes, so the
    // buffer owns dedupe and its answer decides whether anyone hears about it.
    if (!recordStreamTrade(trade)) return;
    if (this.allowEmit()) this.emit(trade);
  }

  private allowEmit(): boolean {
    const now = Date.now();
    if (now - this.emitWindowStart >= 1000) {
      this.emitWindowStart = now;
      this.emitsInWindow = 0;
    }
    this.emitsInWindow += 1;
    return this.emitsInWindow <= MAX_EMIT_PER_SECOND;
  }

  /**
   * Global broadcast on the existing WS. `source` rides along on every frame so
   * the console can never render a 985monitor row as a fomo.family trade.
   */
  private emit(trade: FomoStreamTrade): void {
    this.wsServer.broadcastRaw({
      type: 'fomo_stream_trade',
      data: { ...trade, source: FOMO_STREAM_SOURCE },
    });
  }

  getStatus(): FomoStreamStatus {
    return {
      enabled: true,
      connected: this.connected,
      connectedAt: this.connectedAt,
      lastEventAt: this.lastEventAt,
      lastTradeAt: this.lastTradeAt,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      reconnects: this.reconnects,
      tradesSeen: this.tradesSeen,
      sourceUrl: STREAM_URL,
    };
  }
}

let _listener: FomoStreamListener | null = null;

export function startFomoStreamListener(wsServer: WsServer): void {
  if (_listener) return;
  if (!isFomoStreamEnabled()) {
    console.log(
      '[FomoStream] 985monitor live stream disabled (set OCT_FOMO_STREAM_ENABLED=true to run it).',
    );
    return;
  }
  _listener = new FomoStreamListener(wsServer);
  _listener.start();
}

export function getFomoStreamStatus(): FomoStreamStatus {
  if (_listener) return _listener.getStatus();
  return {
    enabled: isFomoStreamEnabled(),
    connected: false,
    connectedAt: null,
    lastEventAt: null,
    lastTradeAt: null,
    lastError: null,
    lastErrorAt: null,
    reconnects: 0,
    tradesSeen: 0,
    sourceUrl: STREAM_URL,
  };
}

/** Test hook. */
export function stopFomoStreamListener(): void {
  _listener?.stop();
  _listener = null;
}
