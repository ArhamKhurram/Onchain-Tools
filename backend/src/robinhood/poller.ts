// Robinhood Chain live-tape poller.
//
// Polls robinhoodtrenches' public /api/tape on a modest interval and fans new
// fills out over the EXISTING WebSocket as `robinhood_fill` frames — the same
// transport fomo/poller.ts already uses. No second transport, no persistence,
// no per-user state: the tape is a global public feed, so it broadcasts.
//
// Scope: Robinhood Chain (4663) only. This is its own labelled signal and is
// never fused with OCT's convergence detector or the fomo.family feed.
//
// Failure policy: every tick is wrapped. A third-party source being down parks
// the interval (never crashes the process, never rejects an unhandled promise)
// and surfaces through GET /api/robinhood/status as an unreachable source.

import type { WsServer } from '../ws/server.js';
import { getRobinhoodHealth, robinhoodGet } from './client.js';
import { recordFills } from './feed.js';
import {
  ROBINHOOD_SOURCE,
  highestFillId,
  normalizeFills,
  selectNewFills,
  type RobinhoodFill,
} from './normalize.js';

const DEFAULT_INTERVAL_MS = 20_000;
/** Floor: a typo'd env must not turn this into a hot loop against a free service. */
const MIN_INTERVAL_MS = 10_000;
/** Interval used when no console is connected — nothing is listening to fan out to. */
const IDLE_INTERVAL_MS = 120_000;
const TAPE_LIMIT = 60;
/** Bound on frames emitted per tick, so a long stall can't flood every console on resume. */
const MAX_EMIT_PER_TICK = 40;

function envFlag(name: string): boolean {
  const raw = (process.env[`OCT_${name}`] ?? process.env[`TRENCHCORD_${name}`])?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * Off by default. This adds an outbound poll to a third party, so it is opted
 * into explicitly with OCT_ROBINHOOD_ENABLED — the REST routes still work
 * without it (they are demand-driven), only the live push needs the switch.
 */
export function isRobinhoodPollerEnabled(): boolean {
  return envFlag('ROBINHOOD_ENABLED');
}

function resolveIntervalMs(): number {
  const raw = Number.parseInt(process.env.OCT_ROBINHOOD_POLL_MS ?? '', 10);
  if (Number.isFinite(raw) && raw > 0) return Math.max(raw, MIN_INTERVAL_MS);
  return DEFAULT_INTERVAL_MS;
}

export interface RobinhoodPollerStatus {
  active: boolean;
  reason: 'disabled' | 'running' | 'not_started';
  pollIntervalMs: number | null;
  lastPollAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  /** Highest upstream fill id seen; null until the first successful poll seeds it. */
  cursor: number | null;
}

class RobinhoodPoller {
  private wsServer: WsServer;
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private polling = false;
  private cursor: number | null = null;
  private lastPollAt: string | null = null;
  private lastError: string | null = null;
  private lastErrorAt: string | null = null;
  private pollIntervalMs = DEFAULT_INTERVAL_MS;

  constructor(wsServer: WsServer) {
    this.wsServer = wsServer;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.pollIntervalMs = resolveIntervalMs();
    console.log(
      `[Robinhood] Live tape poller started (interval ${this.pollIntervalMs}ms, ${ROBINHOOD_SOURCE}).`,
    );
    void this.tick();
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    // Back off hard when nothing is listening. In local mode sockets never
    // authenticate, so the count is 0 there — hence the hasClients fallback.
    const idle = this.wsServer.getAuthenticatedClientCount() === 0;
    this.pollIntervalMs = idle ? Math.max(resolveIntervalMs(), IDLE_INTERVAL_MS) : resolveIntervalMs();
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule());
    }, this.pollIntervalMs);
  }

  private async tick(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    this.lastPollAt = new Date().toISOString();
    try {
      const raw = await robinhoodGet(`/api/tape?limit=${TAPE_LIMIT}`);
      const fills = normalizeFills(raw);
      if (fills.length === 0) {
        this.lastError = null;
        return;
      }

      // Cold start seeds the cursor without emitting: a restart must not replay
      // the last 60 fills to every console as if they just happened.
      if (this.cursor == null) {
        recordFills([...fills].sort((a, b) => a.id - b.id));
        this.cursor = highestFillId(fills);
        this.lastError = null;
        return;
      }

      const fresh = selectNewFills(fills, this.cursor);
      this.cursor = highestFillId(fills, this.cursor);
      if (fresh.length > 0) {
        recordFills(fresh);
        for (const fill of fresh.slice(-MAX_EMIT_PER_TICK)) this.emit(fill);
      }
      this.lastError = null;
    } catch (err) {
      this.lastError = ((err as Error)?.message ?? String(err)).slice(0, 300);
      this.lastErrorAt = new Date().toISOString();
      console.warn('[Robinhood] Tape poll failed:', this.lastError);
    } finally {
      this.polling = false;
    }
  }

  /**
   * Global broadcast on the existing WS. `source` rides along on every frame so
   * the console can never render a Robinhood Chain fill as a fomo.family trade.
   */
  private emit(fill: RobinhoodFill): void {
    this.wsServer.broadcastRaw({ type: 'robinhood_fill', data: { ...fill, source: ROBINHOOD_SOURCE } });
  }

  getStatus(): RobinhoodPollerStatus {
    return {
      active: this.started,
      reason: this.started ? 'running' : 'not_started',
      pollIntervalMs: this.started ? this.pollIntervalMs : null,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      cursor: this.cursor,
    };
  }
}

let _poller: RobinhoodPoller | null = null;

export function startRobinhoodPoller(wsServer: WsServer): void {
  if (_poller) return;
  if (!isRobinhoodPollerEnabled()) {
    console.log('[Robinhood] Live tape poller disabled (set OCT_ROBINHOOD_ENABLED=true to run it).');
    return;
  }
  _poller = new RobinhoodPoller(wsServer);
  _poller.start();
}

export function getRobinhoodPollerStatus(): RobinhoodPollerStatus {
  if (!_poller) {
    return {
      active: false,
      reason: isRobinhoodPollerEnabled() ? 'not_started' : 'disabled',
      pollIntervalMs: null,
      lastPollAt: null,
      lastError: getRobinhoodHealth().lastError,
      lastErrorAt: getRobinhoodHealth().lastErrorAt,
      cursor: null,
    };
  }
  return _poller.getStatus();
}

/** Test hook. */
export function stopRobinhoodPoller(): void {
  _poller?.stop();
  _poller = null;
}
