import { describe, it, expect } from 'vitest';
import {
  buildActivationSteps,
  countDone,
  hasSource,
  needsActivation,
  nextStep,
  upstreamGap,
  type ActivationInput,
} from '../src/lib/activation';

const blank: ActivationInput = {
  discordConfigured: false,
  telegramConfigured: false,
  roomCount: 0,
  watchedCallerCount: 0,
  trackedWalletCount: 0,
  holdingWalletCount: 0,
  contractCount: 0,
  hosted: true,
};

describe('activation model', () => {
  it('a fresh signup has all four steps open and points at connect', () => {
    const steps = buildActivationSteps(blank);
    expect(steps.map((s) => s.id)).toEqual(['connect', 'room', 'watch', 'signal']);
    expect(countDone(steps)).toBe(0);
    expect(nextStep(steps)?.id).toBe('connect');
    expect(needsActivation(blank)).toBe(true);
  });

  it('telegram alone counts as a source', () => {
    expect(hasSource({ discordConfigured: false, telegramConfigured: true })).toBe(true);
    const steps = buildActivationSteps({ ...blank, telegramConfigured: true });
    expect(steps[0].done).toBe(true);
    expect(nextStep(steps)?.id).toBe('room');
  });

  it('keeps the list up after connect — the connect-then-stall leak', () => {
    expect(needsActivation({ ...blank, discordConfigured: true })).toBe(true);
    expect(needsActivation({ ...blank, discordConfigured: true, roomCount: 1 })).toBe(true);
  });

  it('any watch target ticks the watch step', () => {
    expect(buildActivationSteps({ ...blank, watchedCallerCount: 1 })[2].done).toBe(true);
    expect(buildActivationSteps({ ...blank, trackedWalletCount: 1 })[2].done).toBe(true);
    expect(buildActivationSteps({ ...blank, holdingWalletCount: 1 })[2].done).toBe(true);
  });

  it('is fully activated once a contract has been detected on top of the rest', () => {
    const done: ActivationInput = {
      ...blank,
      discordConfigured: true,
      roomCount: 2,
      watchedCallerCount: 1,
      contractCount: 5,
    };
    expect(countDone(buildActivationSteps(done))).toBe(4);
    expect(nextStep(buildActivationSteps(done))).toBeNull();
    expect(needsActivation(done)).toBe(false);
  });

  it('local mode routes the watch step to Feed (no Directory without Supabase)', () => {
    const hosted = buildActivationSteps(blank)[2];
    const local = buildActivationSteps({ ...blank, hosted: false })[2];
    expect(hosted.to).toBe('/directory');
    expect(local.to).toBe('/feed');
    expect(local.label).not.toContain('wallet');
  });

  it('resolves the upstream gap for the Callers surfaces in dependency order', () => {
    expect(upstreamGap(blank)).toBe('source');
    expect(upstreamGap({ ...blank, discordConfigured: true })).toBe('room');
    expect(upstreamGap({ ...blank, discordConfigured: true, roomCount: 1 })).toBe('none');
  });
});
