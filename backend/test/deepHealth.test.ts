import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildDeepHealth,
  deepHealthHttpStatus,
  evaluatePoller,
  pollStalenessBudgetMs,
  type DeepHealthFacts,
  type PollerFacts,
} from '../src/health/deepHealth.js';
import {
  recordIngest,
  getLastIngestAtMs,
  resetIngestHeartbeat,
} from '../src/health/ingestHeartbeat.js';

const NOW = Date.parse('2026-08-25T12:00:00.000Z');
const MIN = 60_000;

function pollerFacts(over: Partial<PollerFacts> = {}): PollerFacts {
  return {
    active: true,
    reason: 'running',
    pollIntervalMs: 10_000,
    lastPollAtMs: NOW - 10_000,
    lastSuccessfulPollAtMs: NOW - 10_000,
    lastPollErrorAtMs: null,
    ...over,
  };
}

function facts(over: Partial<DeepHealthFacts> = {}): DeepHealthFacts {
  return {
    nowMs: NOW,
    processStartedAtMs: NOW - 60 * MIN,
    hosted: true,
    supabaseConfigured: true,
    gateway: { connected: true, activeUsers: 3, invalidTokens: null },
    fomoPoller: pollerFacts(),
    missedRunner: pollerFacts({ pollIntervalMs: 180_000 }),
    lastIngestAtMs: NOW - 30_000,
    ...over,
  };
}

describe('pollStalenessBudgetMs', () => {
  // A 10s poller must not report degraded after 50 quiet seconds; the floor is
  // what keeps the endpoint from flapping on fast pollers.
  it('floors fast pollers at 10 minutes', () => {
    expect(pollStalenessBudgetMs(10_000)).toBe(10 * MIN);
    expect(pollStalenessBudgetMs(null)).toBe(10 * MIN);
  });

  it('scales with the interval between the floor and the ceiling', () => {
    expect(pollStalenessBudgetMs(4 * MIN)).toBe(20 * MIN);
  });

  it('caps slow pollers at an hour so nothing goes unwatched all day', () => {
    expect(pollStalenessBudgetMs(6 * 60 * MIN)).toBe(60 * MIN);
  });
});

describe('evaluatePoller', () => {
  it('reports a self-gated poller as idle, not degraded', () => {
    const report = evaluatePoller(
      pollerFacts({ active: false, reason: 'no_supabase', pollIntervalMs: null }),
      NOW,
      NOW - 60 * MIN,
    );
    expect(report.state).toBe('idle');
    expect(report.reason).toBe('no_supabase');
    expect(report.stalenessBudgetSec).toBeNull();
  });

  it('reports a recently-successful poller as ok', () => {
    expect(evaluatePoller(pollerFacts(), NOW, NOW - 60 * MIN).state).toBe('ok');
  });

  it('reports degraded once the last successful sweep exceeds the budget', () => {
    const stale = pollerFacts({ lastSuccessfulPollAtMs: NOW - 11 * MIN });
    expect(evaluatePoller(stale, NOW, NOW - 60 * MIN).state).toBe('degraded');
  });

  // A restart wipes lastSuccessfulPollAt. Measuring from boot gives the process
  // one full budget to complete its first sweep instead of alerting instantly.
  it('gives a freshly booted process a grace window before its first success', () => {
    const neverRan = pollerFacts({ lastSuccessfulPollAtMs: null, lastPollAtMs: null });
    expect(evaluatePoller(neverRan, NOW, NOW - MIN).state).toBe('ok');
    expect(evaluatePoller(neverRan, NOW, NOW - 30 * MIN).state).toBe('degraded');
  });

  it('surfaces timestamps as ISO strings', () => {
    const report = evaluatePoller(
      pollerFacts({ lastPollErrorAtMs: NOW - 5_000 }),
      NOW,
      NOW - 60 * MIN,
    );
    expect(report.lastSuccessfulPollAt).toBe(new Date(NOW - 10_000).toISOString());
    expect(report.lastPollErrorAt).toBe(new Date(NOW - 5_000).toISOString());
  });
});

describe('buildDeepHealth', () => {
  it('reports ok when every subsystem is healthy', () => {
    const report = buildDeepHealth(facts());
    expect(report.status).toBe('ok');
    expect(report.mode).toBe('hosted');
    expect(report.uptimeSec).toBe(3600);
    expect(report.subsystems.supabase).toEqual({ state: 'ok', configured: true, required: true });
    expect(report.lastIngestAgeSec).toBe(30);
    expect(deepHealthHttpStatus(report)).toBe(200);
  });

  it('degrades when hosted mode has no Supabase', () => {
    const report = buildDeepHealth(facts({ supabaseConfigured: false }));
    expect(report.subsystems.supabase.state).toBe('degraded');
    expect(report.status).toBe('degraded');
    expect(deepHealthHttpStatus(report)).toBe(503);
  });

  // Local mode is the desktop app: no Supabase is the expected configuration.
  it('treats a missing Supabase in local mode as idle', () => {
    const report = buildDeepHealth(
      facts({
        hosted: false,
        supabaseConfigured: false,
        gateway: { connected: true, activeUsers: null, invalidTokens: 0 },
        fomoPoller: pollerFacts({ active: false, reason: 'no_supabase', pollIntervalMs: null }),
        missedRunner: pollerFacts({ active: false, reason: 'no_supabase', pollIntervalMs: null }),
      }),
    );
    expect(report.mode).toBe('local');
    expect(report.subsystems.supabase).toEqual({ state: 'idle', configured: false, required: false });
    expect(report.status).toBe('ok');
    expect(deepHealthHttpStatus(report)).toBe(200);
  });

  it('degrades on a rejected Discord token', () => {
    const report = buildDeepHealth(
      facts({
        hosted: false,
        gateway: { connected: true, activeUsers: null, invalidTokens: 1 },
      }),
    );
    expect(report.subsystems.gateway.state).toBe('degraded');
    expect(report.status).toBe('degraded');
  });

  // Plenty of installs never configure Discord; "no gateway" is not a fault.
  it('treats an unconfigured gateway as idle, not degraded', () => {
    const report = buildDeepHealth(
      facts({
        hosted: false,
        gateway: { connected: false, activeUsers: null, invalidTokens: 0 },
      }),
    );
    expect(report.subsystems.gateway.state).toBe('idle');
    expect(report.status).toBe('ok');
  });

  it('degrades when a poller has gone stale', () => {
    const report = buildDeepHealth(
      facts({ missedRunner: pollerFacts({ pollIntervalMs: 180_000, lastSuccessfulPollAtMs: NOW - 40 * MIN }) }),
    );
    expect(report.subsystems.missedRunner.state).toBe('degraded');
    expect(report.status).toBe('degraded');
  });

  // In hosted mode the Discord gateway runs in the browser, so the backend can
  // legitimately ingest nothing for hours. Failing on that would be a false alarm.
  it('never lets a silent ingest feed affect status', () => {
    const report = buildDeepHealth(facts({ lastIngestAtMs: null }));
    expect(report.lastIngestAt).toBeNull();
    expect(report.lastIngestAgeSec).toBeNull();
    expect(report.status).toBe('ok');

    const ancient = buildDeepHealth(facts({ lastIngestAtMs: NOW - 24 * 60 * MIN }));
    expect(ancient.lastIngestAgeSec).toBe(86_400);
    expect(ancient.status).toBe('ok');
  });

  // The endpoint is unauthenticated, like /health. Upstream error text can carry
  // URLs and identifiers, so the report must stay booleans/counts/enums/timestamps.
  it('exposes no free-form upstream error text', () => {
    const serialized = JSON.stringify(
      buildDeepHealth(facts({ fomoPoller: pollerFacts({ lastPollErrorAtMs: NOW - MIN }) })),
    );
    expect(serialized).not.toContain('lastPollError"');
    expect(serialized).not.toContain('message');
  });
});

describe('ingest heartbeat', () => {
  beforeEach(() => resetIngestHeartbeat());

  it('starts empty and records the latest arrival', () => {
    expect(getLastIngestAtMs()).toBeNull();
    recordIngest(NOW);
    expect(getLastIngestAtMs()).toBe(NOW);
    recordIngest(NOW + 1_000);
    expect(getLastIngestAtMs()).toBe(NOW + 1_000);
  });
});
