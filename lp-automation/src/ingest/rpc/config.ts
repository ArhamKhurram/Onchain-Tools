// Env-driven configuration for the RPC watch layer.
//
// `parseRpcConfig` is pure (takes an env-shaped record, returns config or
// throws) so it is unit-testable; `loadRpcConfig` is the thin impure wrapper
// that reads `.env` first. Matches the repo convention of loading dotenv with
// `override: false` so a platform-injected variable always wins over a stale
// local file (see CLAUDE.md — "never clobber injected secrets").

import { config as loadDotenv } from 'dotenv';
import { ROBINHOOD_BLOCK_TIME_MS } from './chain.js';

export type PreferredMode = 'auto' | 'websocket' | 'polling';

export interface RpcConfig {
  /** HTTPS endpoint. Required: eth_call and the poll fallback both need it. */
  httpUrl: string;
  /** WSS endpoint, or null when none is configured. */
  wsUrl: string | null;
  /**
   * 'auto'      — use WebSocket when configured, fall back to polling if it
   *               keeps failing (the fallback is always reported, never silent).
   * 'websocket' — never fall back; a dead socket stays loudly dead.
   * 'polling'   — never open a socket. Explicitly not sub-second.
   */
  preferredMode: PreferredMode;
  /** Interval between slot0 reads in polling mode. */
  pollIntervalMs: number;
  /** No block seen for this long => stale, alert + forced reconnect. */
  stalenessMs: number;
  /** Blocks of depth required before a crossing is reported as confirmed. */
  confirmations: number;
  /** Consecutive WebSocket connect failures before falling back to polling. */
  maxWebsocketAttempts: number;
}

/**
 * Defaults derived from a ~100ms block time (see ROBINHOOD_BLOCK_TIME_MS):
 *
 *  • stalenessMs 10s   — ~100 missed blocks. Long enough that a provider hiccup
 *                        is not an alert storm, short enough that a silently
 *                        dead subscription is caught inside one policy tick.
 *  • confirmations 3   — ~300ms of settling, which still leaves the spec's
 *                        sub-second reaction budget intact. See poolWatcher.ts.
 *  • pollIntervalMs 1s — the degraded path. Deliberately NOT presented as
 *                        sub-second; that is the whole point of reporting mode.
 */
export const RPC_CONFIG_DEFAULTS = {
  preferredMode: 'auto' as PreferredMode,
  pollIntervalMs: 1_000,
  stalenessMs: 10_000,
  confirmations: 3,
  maxWebsocketAttempts: 5,
} as const;

export class RpcConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcConfigError';
  }
}

function readUrl(raw: string | undefined, name: string, schemes: string[]): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RpcConfigError(`${name} is not a valid URL`);
  }
  if (!schemes.includes(parsed.protocol)) {
    throw new RpcConfigError(`${name} must use one of ${schemes.join(', ')} (got ${parsed.protocol})`);
  }
  return value;
}

function readNumber(raw: string | undefined, name: string, fallback: number, min: number): number {
  const value = raw?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new RpcConfigError(`${name} must be a number >= ${min} (got "${value}")`);
  }
  return parsed;
}

/** Pure: env record in, validated config out. Never reads `process.env` itself. */
export function parseRpcConfig(env: Record<string, string | undefined>): RpcConfig {
  const httpUrl = readUrl(env.LP_RPC_URL, 'LP_RPC_URL', ['http:', 'https:']);
  const wsUrl = readUrl(env.LP_RPC_WS_URL, 'LP_RPC_WS_URL', ['ws:', 'wss:']);

  if (!httpUrl) {
    throw new RpcConfigError(
      'LP_RPC_URL is required (an HTTPS endpoint is needed for eth_call even when watching over WebSocket)',
    );
  }

  const rawMode = env.LP_RPC_MODE?.trim().toLowerCase();
  let preferredMode: PreferredMode = RPC_CONFIG_DEFAULTS.preferredMode;
  if (rawMode) {
    if (rawMode !== 'auto' && rawMode !== 'websocket' && rawMode !== 'polling') {
      throw new RpcConfigError(`LP_RPC_MODE must be auto | websocket | polling (got "${rawMode}")`);
    }
    preferredMode = rawMode;
  }

  if (preferredMode === 'websocket' && !wsUrl) {
    throw new RpcConfigError('LP_RPC_MODE=websocket requires LP_RPC_WS_URL to be set');
  }

  const stalenessMs = readNumber(
    env.LP_RPC_STALENESS_MS,
    'LP_RPC_STALENESS_MS',
    RPC_CONFIG_DEFAULTS.stalenessMs,
    // A threshold below one block time would flap permanently.
    ROBINHOOD_BLOCK_TIME_MS,
  );

  return {
    httpUrl,
    wsUrl,
    preferredMode,
    pollIntervalMs: readNumber(
      env.LP_RPC_POLL_INTERVAL_MS,
      'LP_RPC_POLL_INTERVAL_MS',
      RPC_CONFIG_DEFAULTS.pollIntervalMs,
      50,
    ),
    stalenessMs,
    confirmations: readNumber(
      env.LP_RPC_CONFIRMATIONS,
      'LP_RPC_CONFIRMATIONS',
      RPC_CONFIG_DEFAULTS.confirmations,
      0,
    ),
    maxWebsocketAttempts: readNumber(
      env.LP_RPC_MAX_WS_ATTEMPTS,
      'LP_RPC_MAX_WS_ATTEMPTS',
      RPC_CONFIG_DEFAULTS.maxWebsocketAttempts,
      1,
    ),
  };
}

/** Loads `.env` (without clobbering injected vars) and parses the RPC config. */
export function loadRpcConfig(env: NodeJS.ProcessEnv = process.env): RpcConfig {
  loadDotenv({ override: false });
  return parseRpcConfig(env);
}
