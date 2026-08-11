import { describe, expect, it } from 'vitest';
import {
  initialWatchdogState,
  isBrowserDeathMessage,
  noteRequest,
  noteSuccess,
  shouldExitForHang,
  type WatchdogState,
} from '../src/watchdog.js';

const MIN = 60_000;
const THRESHOLD = 5 * MIN;

describe('shouldExitForHang', () => {
  it('never trips before any request arrives', () => {
    const state = initialWatchdogState();
    expect(shouldExitForHang(state, 100 * MIN, THRESHOLD)).toBe(false);
  });

  it('does not trip right after the first request (stall stretch too short)', () => {
    let state = initialWatchdogState();
    state = noteRequest(state, 10 * MIN);
    expect(shouldExitForHang(state, 10 * MIN + 30_000, THRESHOLD)).toBe(false);
  });

  it('trips when requests keep arriving but none ever completes (the 18h wedge)', () => {
    let state = initialWatchdogState();
    // Backend polls every ~30s against a hung worker.
    for (let t = 0; t <= 6 * MIN; t += 30_000) {
      state = noteRequest(state, t);
    }
    expect(shouldExitForHang(state, 6 * MIN, THRESHOLD)).toBe(true);
  });

  it('trips when successes stop but traffic continues', () => {
    let state = initialWatchdogState();
    state = noteRequest(state, 0);
    state = noteSuccess(state, 1_000);
    // Worker wedges at t=1min; requests keep arriving, nothing completes.
    for (let t = MIN; t <= 7 * MIN; t += 30_000) {
      state = noteRequest(state, t);
    }
    expect(shouldExitForHang(state, 7 * MIN, THRESHOLD)).toBe(true);
  });

  it('does not trip while calls are completing, whatever the upstream status', () => {
    let state = initialWatchdogState();
    // Hours of 404-spam: every call still completes, so this is health.
    for (let t = 0; t <= 60 * MIN; t += 30_000) {
      state = noteRequest(state, t);
      state = noteSuccess(state, t + 2_000);
    }
    expect(shouldExitForHang(state, 60 * MIN + 10_000, THRESHOLD)).toBe(false);
  });

  it('does not trip during a quiet period after a success', () => {
    let state = initialWatchdogState();
    state = noteRequest(state, 0);
    state = noteSuccess(state, 2_000);
    // Nothing for 10 hours — idle, not hung.
    expect(shouldExitForHang(state, 600 * MIN, THRESHOLD)).toBe(false);
  });

  it('does not trip when traffic stops even if the last request never completed', () => {
    let state = initialWatchdogState();
    state = noteRequest(state, 0);
    // One unanswered request, then silence: quiet periods never trip.
    expect(shouldExitForHang(state, 600 * MIN, THRESHOLD)).toBe(false);
  });

  it('an in-flight request during heavy traffic does not count as a stall', () => {
    let state = initialWatchdogState();
    state = noteRequest(state, 0);
    state = noteRequest(state, 1_000);
    state = noteSuccess(state, 1_500); // one of them completed — window closes
    expect(shouldExitForHang(state, 6 * MIN, THRESHOLD)).toBe(false);
  });

  it('is disabled when the threshold is zero', () => {
    let state = initialWatchdogState();
    for (let t = 0; t <= 60 * MIN; t += 30_000) {
      state = noteRequest(state, t);
    }
    expect(shouldExitForHang(state, 60 * MIN, 0)).toBe(false);
  });

  it('never trips with stalledSinceAt unset regardless of other fields', () => {
    const state: WatchdogState = { lastRequestAt: 0, lastSuccessAt: null, stalledSinceAt: null };
    expect(shouldExitForHang(state, 600 * MIN, THRESHOLD)).toBe(false);
  });
});

describe('isBrowserDeathMessage', () => {
  it('matches the incident message from a dead persistent context', () => {
    expect(
      isBrowserDeathMessage(
        'browserContext.newPage: Target page, context or browser has been closed',
      ),
    ).toBe(true);
  });

  it('matches target-closed variants', () => {
    expect(isBrowserDeathMessage('page.evaluate: Target closed')).toBe(true);
    expect(isBrowserDeathMessage('Browser closed unexpectedly')).toBe(true);
  });

  it('does not match a plain navigation timeout', () => {
    expect(isBrowserDeathMessage('page.goto: Timeout 60000ms exceeded')).toBe(false);
  });

  it('handles missing messages', () => {
    expect(isBrowserDeathMessage(undefined)).toBe(false);
    expect(isBrowserDeathMessage(null)).toBe(false);
    expect(isBrowserDeathMessage('')).toBe(false);
  });
});
