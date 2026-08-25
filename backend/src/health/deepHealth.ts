// Readiness reporting for an EXTERNAL uptime monitor — deliberately NOT the
// probe Railway polls.
//
// LIVENESS vs READINESS — the split is load-bearing, do not collapse it:
//
//   GET /health       liveness.  "the event loop is answering." ALWAYS 200.
//                                railway.toml points `healthcheckPath` here.
//   GET /health/deep  readiness. Per-subsystem detail. MAY return 503.
//                                Only an external uptime monitor should poll it.
//
// Railway pairs `healthcheckPath` with `restartPolicyType = "ON_FAILURE"`. If the
// probed endpoint returned non-200 because a *subsystem* was degraded, Railway
// would kill the container, the replacement would come up with the same degraded
// subsystem (the FOMO VPS worker is still down, Supabase is still unreachable),
// and it would fail the probe again — a restart storm that turns one degraded
// signal into a total outage. That is why the failing endpoint has to be a
// second path that nothing with a restart policy is watching.
//
// This module does NO I/O. Every fact is read from in-process state, so
// /health/deep costs the same as /health and is safe to poll on a short
// interval. In particular it does NOT call the FOMO VPS worker: the deep FOMO
// diagnostics (worker reachability, Privy token age, cache stats) already live
// behind GET /api/fomo/status, which makes that network call. This endpoint
// reuses the same in-memory poller getter instead of duplicating it.
//
// It is also unauthenticated, like /health, so it reports only booleans, enum
// reasons and timestamps — never upstream error text, which can carry URLs and
// identifiers, and never a business metric. An uptime monitor needs up/down; the
// live user count that used to sit in `subsystems.gateway.activeUsers` told an
// anonymous caller how many people were using OCT right now, so the pooled
// gateway count is no longer part of the report at all (`GatewayFacts` carries
// only the boolean it derives). `invalidTokens` stays because it is a fault
// count, and it is null in hosted mode — the one mode where this endpoint is
// reachable from the internet.

import { getFomoPollerStatus } from '../fomo/poller.js';
import { getMissedRunnerPollerStatus } from '../alerts/missedRunnerPoller.js';
import { isSupabaseServiceConfigured } from '../fomo/store.js';
import { isHostedMode } from '../storage/index.js';
import { getLastIngestAtMs } from './ingestHeartbeat.js';

/** `idle` = deliberately not running (self-gated), which is not a fault. */
export type SubsystemState = 'ok' | 'degraded' | 'idle';

export interface PollerFacts {
  active: boolean;
  reason: string | null;
  pollIntervalMs: number | null;
  lastPollAtMs: number | null;
  lastSuccessfulPollAtMs: number | null;
  lastPollErrorAtMs: number | null;
}

export interface GatewayFacts {
  /**
   * local: a global GatewayManager exists. hosted: at least one pooled manager.
   * Deliberately a boolean and not the pooled count — see the module header.
   */
  connected: boolean;
  /** local only — Discord tokens the gateway saw rejected. null in hosted mode. */
  invalidTokens: number | null;
}

export interface DeepHealthFacts {
  nowMs: number;
  processStartedAtMs: number;
  hosted: boolean;
  supabaseConfigured: boolean;
  gateway: GatewayFacts;
  fomoPoller: PollerFacts;
  missedRunner: PollerFacts;
  lastIngestAtMs: number | null;
}

export interface PollerReport {
  state: SubsystemState;
  reason: string | null;
  pollIntervalMs: number | null;
  /** How stale the last successful sweep may get before this reports degraded. */
  stalenessBudgetSec: number | null;
  lastPollAt: string | null;
  lastSuccessfulPollAt: string | null;
  lastPollErrorAt: string | null;
}

export interface DeepHealthReport {
  status: 'ok' | 'degraded';
  mode: 'local' | 'hosted';
  uptimeSec: number;
  subsystems: {
    supabase: { state: SubsystemState; configured: boolean; required: boolean };
    gateway: { state: SubsystemState } & GatewayFacts;
    fomoPoller: PollerReport;
    missedRunner: PollerReport;
  };
  /**
   * Informational ONLY — never contributes to `status`. In hosted mode the
   * Discord gateway runs in the browser, so a perfectly healthy backend can
   * ingest nothing for hours; and in local mode a user with no sources
   * configured never ingests at all. Failing on it would be a false alarm.
   */
  lastIngestAt: string | null;
  lastIngestAgeSec: number | null;
}

/** Floor, so a 10s-interval poller does not report degraded after 50 quiet seconds. */
const MIN_STALENESS_BUDGET_MS = 10 * 60_000;
/** Ceiling, so a slow poller cannot go unwatched for half a day. */
const MAX_STALENESS_BUDGET_MS = 60 * 60_000;

export function pollStalenessBudgetMs(pollIntervalMs: number | null): number {
  const fiveSweeps = (pollIntervalMs ?? 0) * 5;
  return Math.min(MAX_STALENESS_BUDGET_MS, Math.max(MIN_STALENESS_BUDGET_MS, fiveSweeps));
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * Inactive reasons that are NEVER benign, in either mode.
 *
 * Both pollers self-gate on Supabase *first* and only then attempt to bootstrap
 * (`fomo/poller.ts` start() → bootstrap()). So these two reasons are unreachable
 * without a configured Supabase service client: getting here means the subsystem
 * was expected to run and failed to. `no_refresh_token` in particular is exactly
 * the shape of the 2026-08-20 outage — `ensureSharedFomoClientReady` is
 * contractually non-throwing and returns null when the Privy refresh token is
 * dead, so a 34-hour FOMO blackout presents as a quietly inactive poller with no
 * error and no stale timestamp to trip the staleness check.
 */
const POLLER_FAULT_REASONS: ReadonlySet<string> = new Set(['no_refresh_token', 'bootstrap_failed']);

/**
 * An inactive poller is only "idle by design" in local mode, and only for the
 * reasons that come from the self-gate itself (`no_supabase`, `not_started`).
 *
 * In hosted mode there is no such thing as a legitimately inactive poller —
 * Supabase is the system of record and both pollers are started unconditionally
 * at boot — so ANY inactive reason is degraded there. That also fails safe if a
 * poller gains a new reason string later: an unrecognised reason alerts rather
 * than silently reporting green, which is how the FOMO blind spot happened.
 */
function classifyInactivePoller(reason: string | null, hosted: boolean): SubsystemState {
  if (reason !== null && POLLER_FAULT_REASONS.has(reason)) return 'degraded';
  return hosted ? 'degraded' : 'idle';
}

export function evaluatePoller(
  facts: PollerFacts,
  nowMs: number,
  processStartedAtMs: number,
  hosted: boolean,
): PollerReport {
  const base = {
    reason: facts.reason,
    pollIntervalMs: facts.pollIntervalMs,
    lastPollAt: iso(facts.lastPollAtMs),
    lastSuccessfulPollAt: iso(facts.lastSuccessfulPollAtMs),
    lastPollErrorAt: iso(facts.lastPollErrorAtMs),
  };

  // An inactive poller never reaches the staleness check below, so this branch
  // is the ONLY thing standing between a dead subsystem and a green report.
  // Getting it wrong is silent: `status: ok`, HTTP 200, FOMO down for a day.
  if (!facts.active) {
    return {
      state: classifyInactivePoller(facts.reason, hosted),
      stalenessBudgetSec: null,
      ...base,
    };
  }

  const budgetMs = pollStalenessBudgetMs(facts.pollIntervalMs);
  // Never succeeded yet? Measure from boot, so a freshly restarted process gets
  // a full budget of grace instead of reporting degraded before its first sweep.
  const lastGoodMs = facts.lastSuccessfulPollAtMs ?? processStartedAtMs;
  const state: SubsystemState = nowMs - lastGoodMs > budgetMs ? 'degraded' : 'ok';

  return { state, stalenessBudgetSec: Math.round(budgetMs / 1000), ...base };
}

/** Pure: same facts in, same report out. All the impurity lives in `collectDeepHealthFacts`. */
export function buildDeepHealth(facts: DeepHealthFacts): DeepHealthReport {
  // Supabase is the hosted-mode system of record; in local mode its absence is
  // the expected configuration, not a fault.
  const supabaseRequired = facts.hosted;
  const supabaseState: SubsystemState = facts.supabaseConfigured
    ? 'ok'
    : supabaseRequired
      ? 'degraded'
      : 'idle';

  // A rejected Discord token is the one gateway condition that is unambiguously
  // broken: the feed goes quiet and nothing else surfaces it. "Not connected" is
  // not a fault — plenty of installs never configure Discord.
  const invalidTokens = facts.gateway.invalidTokens ?? 0;
  const gatewayState: SubsystemState =
    invalidTokens > 0 ? 'degraded' : facts.gateway.connected ? 'ok' : 'idle';

  // Same "required = hosted" rule as Supabase above: a poller that is not
  // running is expected in local mode and a fault in hosted.
  const fomoPoller = evaluatePoller(
    facts.fomoPoller,
    facts.nowMs,
    facts.processStartedAtMs,
    facts.hosted,
  );
  const missedRunner = evaluatePoller(
    facts.missedRunner,
    facts.nowMs,
    facts.processStartedAtMs,
    facts.hosted,
  );

  const degraded =
    supabaseState === 'degraded' ||
    gatewayState === 'degraded' ||
    fomoPoller.state === 'degraded' ||
    missedRunner.state === 'degraded';

  return {
    status: degraded ? 'degraded' : 'ok',
    mode: facts.hosted ? 'hosted' : 'local',
    uptimeSec: Math.max(0, Math.round((facts.nowMs - facts.processStartedAtMs) / 1000)),
    subsystems: {
      supabase: {
        state: supabaseState,
        configured: facts.supabaseConfigured,
        required: supabaseRequired,
      },
      gateway: { state: gatewayState, ...facts.gateway },
      fomoPoller,
      missedRunner,
    },
    lastIngestAt: iso(facts.lastIngestAtMs),
    lastIngestAgeSec:
      facts.lastIngestAtMs === null
        ? null
        : Math.max(0, Math.round((facts.nowMs - facts.lastIngestAtMs) / 1000)),
  };
}

function toMs(at: string | null | undefined): number | null {
  if (!at) return null;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Read every subsystem's in-process state. No network, no disk — see the module
 * header. Gateway facts are passed in because the hosted-mode gateway pool is
 * owned by index.ts.
 */
export function collectDeepHealthFacts(
  gateway: GatewayFacts,
  nowMs: number = Date.now(),
): DeepHealthFacts {
  const fomo = getFomoPollerStatus();
  const missed = getMissedRunnerPollerStatus();

  return {
    nowMs,
    processStartedAtMs: nowMs - Math.round(process.uptime() * 1000),
    hosted: isHostedMode(),
    supabaseConfigured: isSupabaseServiceConfigured(),
    gateway,
    fomoPoller: {
      active: fomo.active,
      reason: fomo.reason ?? null,
      pollIntervalMs: fomo.pollIntervalMs ?? null,
      lastPollAtMs: toMs(fomo.lastPollAt),
      lastSuccessfulPollAtMs: toMs(fomo.lastSuccessfulPollAt),
      lastPollErrorAtMs: toMs(fomo.lastPollErrorAt),
    },
    missedRunner: {
      active: missed.active,
      reason: missed.reason ?? null,
      pollIntervalMs: missed.pollIntervalMs ?? null,
      lastPollAtMs: toMs(missed.lastPollAt),
      lastSuccessfulPollAtMs: toMs(missed.lastSuccessfulPollAt),
      lastPollErrorAtMs: toMs(missed.lastPollErrorAt),
    },
    lastIngestAtMs: getLastIngestAtMs(),
  };
}

/**
 * 503 on degraded. Safe ONLY because nothing with a restart policy polls this
 * path — see the module header before wiring anything else to it.
 */
export function deepHealthHttpStatus(report: DeepHealthReport): number {
  return report.status === 'degraded' ? 503 : 200;
}
