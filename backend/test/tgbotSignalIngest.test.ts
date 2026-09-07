// OCT Alerts hosted ingest: the decision + keep-alive logic that boot relies on.
//
// The actual connect and the single boot getConfig read live in index.ts (the
// composition root, which boots a server on import and so is not unit-imported);
// this pins the pure pieces it is built from — which user ingest keys off, when
// a connect is attempted vs skipped, and that a configured user is marked
// keep-alive / eviction-exempt.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  resolveSignalIngestUserId,
  planSignalIngest,
  signalIngestKeepAlive,
  redactUserId,
  type SignalIngestConfig,
} from '../src/tgbot/signalIngest';

const OPERATOR = 'operator-user-id-abcdef0123456789';

const goodConfig: SignalIngestConfig = {
  telegramSessions: ['a-session-string'],
  telegramApiId: '123456',
  telegramApiHash: 'deadbeefdeadbeefdeadbeefdeadbeef',
};

beforeEach(() => {
  vi.unstubAllEnvs();
  signalIngestKeepAlive.reset();
});

describe('resolveSignalIngestUserId — which account ingest keys off', () => {
  it('is null when nothing is configured (feature simply off)', () => {
    expect(resolveSignalIngestUserId()).toBeNull();
  });

  it('reads the dedicated OCT_SIGNAL_INGEST_USER_ID first', () => {
    vi.stubEnv('OCT_SIGNAL_INGEST_USER_ID', OPERATOR);
    expect(resolveSignalIngestUserId()).toBe(OPERATOR);
  });

  it('falls back to TG_BOT_ALERT_SOURCE_USER_ID (the bot feed account)', () => {
    vi.stubEnv('TG_BOT_ALERT_SOURCE_USER_ID', OPERATOR);
    expect(resolveSignalIngestUserId()).toBe(OPERATOR);
  });

  it('prefers the dedicated var over the alert-source fallback', () => {
    vi.stubEnv('OCT_SIGNAL_INGEST_USER_ID', OPERATOR);
    vi.stubEnv('TG_BOT_ALERT_SOURCE_USER_ID', 'some-other-account');
    expect(resolveSignalIngestUserId()).toBe(OPERATOR);
  });
});

describe('planSignalIngest — connect vs skip vs missing-session', () => {
  it('skips when no ingest user is configured', () => {
    expect(planSignalIngest(null, goodConfig)).toEqual({ action: 'skip' });
  });

  it('attempts a connect for a configured user with a usable session', () => {
    const plan = planSignalIngest(OPERATOR, goodConfig);
    expect(plan).toEqual({
      action: 'connect',
      userId: OPERATOR,
      apiId: 123456,
      apiHash: 'deadbeefdeadbeefdeadbeefdeadbeef',
      sessions: ['a-session-string'],
    });
  });

  it('reports missing-session when the operator has no session stored', () => {
    expect(planSignalIngest(OPERATOR, { telegramApiId: '123456', telegramApiHash: 'x' }))
      .toEqual({ action: 'missing-session', userId: OPERATOR });
    expect(planSignalIngest(OPERATOR, null))
      .toEqual({ action: 'missing-session', userId: OPERATOR });
  });

  it('rejects blank sessions and a non-numeric / non-positive apiId', () => {
    expect(planSignalIngest(OPERATOR, { ...goodConfig, telegramSessions: ['  '] }).action)
      .toBe('missing-session');
    expect(planSignalIngest(OPERATOR, { ...goodConfig, telegramApiId: 'not-a-number' }).action)
      .toBe('missing-session');
    expect(planSignalIngest(OPERATOR, { ...goodConfig, telegramApiId: '0' }).action)
      .toBe('missing-session');
    expect(planSignalIngest(OPERATOR, { ...goodConfig, telegramApiHash: '' }).action)
      .toBe('missing-session');
  });
});

describe('keep-alive registry — the eviction-exempt set', () => {
  it('marks and reports a user as keep-alive', () => {
    expect(signalIngestKeepAlive.has(OPERATOR)).toBe(false);
    signalIngestKeepAlive.mark(OPERATOR);
    expect(signalIngestKeepAlive.has(OPERATOR)).toBe(true);
    expect(signalIngestKeepAlive.list()).toContain(OPERATOR);
  });

  it('is idempotent — marking twice keeps one entry', () => {
    signalIngestKeepAlive.mark(OPERATOR);
    signalIngestKeepAlive.mark(OPERATOR);
    expect(signalIngestKeepAlive.list()).toEqual([OPERATOR]);
  });
});

describe('redactUserId — never logs the full id', () => {
  it('trims to an 8-char prefix', () => {
    expect(redactUserId(OPERATOR)).toBe('operator…');
    expect(redactUserId(OPERATOR)).not.toContain('0123456789');
  });
});
