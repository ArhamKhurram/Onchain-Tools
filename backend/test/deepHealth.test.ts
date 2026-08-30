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
    gateway: { connected: true, invalidTokens: null },
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

/** An inactive poller, as the pollers actually report themselves. */
function inactive(reason: string | null): PollerFacts {
  return pollerFacts({
    active: false,
    reason,
    pollIntervalMs: null,
    lastPollAtMs: null,
    lastSuccessfulPollAtMs: null,
  });
}

describe('evaluatePoller', () => {
  it('reports a self-gated local-mode poller as idle, not degraded', () => {
    const report = evaluatePoller(inactive('no_supabase'), NOW, NOW - 60 * MIN, false);
    expect(report.state).toBe('idle');
    expect(report.reason).toBe('no_supabase');
    expect(report.stalenessBudgetSec).toBeNull();
  });

  it('reports a recently-successful poller as ok', () => {
    expect(evaluatePoller(pollerFacts(), NOW, NOW - 60 * MIN, true).state).toBe('ok');
  });

  it('reports degraded once the last successful sweep exceeds the budget', () => {
    const stale = pollerFacts({ lastSuccessfulPollAtMs: NOW - 11 * MIN });
    expect(evaluatePoller(stale, NOW, NOW - 60 * MIN, true).state).toBe('degraded');
  });

  // A restart wipes lastSuccessfulPollAt. Measuring from boot gives the process
  // one full budget to complete its first sweep instead of alerting instantly.
  it('gives a freshly booted process a grace window before its first success', () => {
    const neverRan = pollerFacts({ lastSuccessfulPollAtMs: null, lastPollAtMs: null });
    expect(evaluatePoller(neverRan, NOW, NOW - MIN, true).state).toBe('ok');
    expect(evaluatePoller(neverRan, NOW, NOW - 30 * MIN, true).state).toBe('degraded');
  });

  it('surfaces timestamps as ISO strings', () => {
    const report = evaluatePoller(
      pollerFacts({ lastPollErrorAtMs: NOW - 5_000 }),
      NOW,
      NOW - 60 * MIN,
      true,
    );
    expect(report.lastSuccessfulPollAt).toBe(new Date(NOW - 10_000).toISOString());
    expect(report.lastPollErrorAt).toBe(new Date(NOW - 5_000).toISOString());
  });

  // THE REGRESSION THIS FILE EXISTS FOR. An inactive poller skips the staleness
  // check entirely, so if this branch says `idle` the endpoint reports green
  // through a total subsystem outage. Every reason either poller can actually
  // emit is enumerated here; adding a reason string without adding a row makes
  // the fail-safe (hosted + unrecognised = degraded) cover it.
  //
  // Sources: fomo/poller.ts FomoPollerStatus['reason'] and
  // alerts/missedRunnerPoller.ts MissedRunnerPollerStatus['reason'].
  const INACTIVE_REASONS: Array<{ reason: string | null; local: string; hosted: string }> = [
    // Past the Supabase self-gate: a real failure in either mode.
    { reason: 'no_refresh_token', local: 'degraded', hosted: 'degraded' },
    { reason: 'bootstrap_failed', local: 'degraded', hosted: 'degraded' },
    // The self-gate itself: expected in local, a fault in hosted.
    { reason: 'no_supabase', local: 'idle', hosted: 'degraded' },
    { reason: 'not_started', local: 'idle', hosted: 'degraded' },
    // Fail-safe for reasons that do not exist yet.
    { reason: 'some_future_reason', local: 'idle', hosted: 'degraded' },
    { reason: null, local: 'idle', hosted: 'degraded' },
  ];

  for (const { reason, local, hosted } of INACTIVE_REASONS) {
    it(`classifies inactive reason ${reason ?? '(none)'} as ${local} local / ${hosted} hosted`, () => {
      expect(evaluatePoller(inactive(reason), NOW, NOW - 60 * MIN, false).state).toBe(local);
      expect(evaluatePoller(inactive(reason), NOW, NOW - 60 * MIN, true).state).toBe(hosted);
    });
  }

  // A dead Privy refresh token leaves no error and no stale timestamp — the poller
  // simply never starts — so nothing but the reason string can catch it.
  it('degrades a fault reason even with pristine timestamps and no error', () => {
    const report = evaluatePoller(inactive('no_refresh_token'), NOW, NOW - MIN, true);
    expect(report.state).toBe('degraded');
    expect(report.lastPollErrorAt).toBeNull();
    expect(report.lastSuccessfulPollAt).toBeNull();
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
        gateway: { connected: true, invalidTokens: 0 },
        fomoPoller: inactive('no_supabase'),
        missedRunner: inactive('no_supabase'),
      }),
    );
    expect(report.mode).toBe('local');
    expect(report.subsystems.supabase).toEqual({ state: 'idle', configured: false, required: false });
    expect(report.subsystems.fomoPoller.state).toBe('idle');
    expect(report.subsystems.missedRunner.state).toBe('idle');
    expect(report.status).toBe('ok');
    expect(deepHealthHttpStatus(report)).toBe(200);
  });

  it('degrades on a rejected Discord token', () => {
    const report = buildDeepHealth(
      facts({
        hosted: false,
        gateway: { connected: true, invalidTokens: 1 },
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
        gateway: { connected: false, invalidTokens: 0 },
      }),
    );
    expect(report.subsystems.gateway.state).toBe('idle');
    expect(report.status).toBe('ok');
  });

  // The two scenarios an adversarial verifier ran against the built dist and got
  // `status: ok` / HTTP 200 out of. This is the FOMO outage, end to end.
  for (const reason of ['bootstrap_failed', 'no_refresh_token']) {
    it(`degrades and 503s when the FOMO poller is inactive with reason ${reason}`, () => {
      const report = buildDeepHealth(facts({ fomoPoller: inactive(reason) }));
      expect(report.subsystems.fomoPoller.state).toBe('degraded');
      expect(report.subsystems.fomoPoller.reason).toBe(reason);
      expect(report.status).toBe('degraded');
      expect(deepHealthHttpStatus(report)).toBe(503);
    });
  }

  // bootstrap() is only reachable past the Supabase self-gate, so these mean a
  // real failure even if someone runs local mode with service credentials set.
  it('degrades on a past-the-gate poller fault in local mode too', () => {
    const report = buildDeepHealth(
      facts({
        hosted: false,
        gateway: { connected: true, invalidTokens: 0 },
        fomoPoller: inactive('no_refresh_token'),
        missedRunner: inactive('no_supabase'),
      }),
    );
    expect(report.subsystems.fomoPoller.state).toBe('degraded');
    expect(report.subsystems.missedRunner.state).toBe('idle');
    expect(report.status).toBe('degraded');
  });

  // Hosted mode starts both pollers unconditionally at boot, so an inactive one
  // is always worth a look — including reasons that only the self-gate emits.
  it('degrades when a hosted poller is inactive for any reason', () => {
    for (const reason of ['no_supabase', 'not_started', 'unrecognised', null]) {
      const report = buildDeepHealth(facts({ missedRunner: inactive(reason) }));
      expect(report.subsystems.missedRunner.state).toBe('degraded');
      expect(report.status).toBe('degraded');
      expect(deepHealthHttpStatus(report)).toBe(503);
    }
  });

  // An uptime monitor needs up/down, not business metrics, and this endpoint is
  // unauthenticated: the pooled per-user gateway count must not be published.
  it('reports gateway liveness without publishing the live user count', () => {
    const report = buildDeepHealth(facts());
    expect(report.subsystems.gateway).toEqual({
      state: 'ok',
      connected: true,
      invalidTokens: null,
    });
    expect(JSON.stringify(report)).not.toContain('activeUsers');
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
