import { describe, it, expect } from 'vitest';
import { resolveRetentionDays } from '../src/fomo/retention.js';

describe('resolveRetentionDays', () => {
  it('defaults to a week when unset or unparseable', () => {
    expect(resolveRetentionDays(undefined)).toBe(7);
    expect(resolveRetentionDays('')).toBe(7);
    expect(resolveRetentionDays('forever')).toBe(7);
  });

  it('honours a configured window', () => {
    expect(resolveRetentionDays('30')).toBe(30);
    expect(resolveRetentionDays('1')).toBe(1);
  });

  // Deleting a trade event also drops the unique trade_id that stops it being
  // dispatched twice, so a sub-day window is never what someone meant.
  it('refuses to go below a day', () => {
    expect(resolveRetentionDays('0')).toBe(7);
    expect(resolveRetentionDays('-5')).toBe(7);
  });

  it('caps an implausible window rather than keeping everything', () => {
    expect(resolveRetentionDays('99999')).toBe(365);
  });
});
