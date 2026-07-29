import { describe, it, expect } from 'vitest';
import {
  isReleaseNotesOptIn,
  selectOptInUserIds,
  retryDelayMs,
  MAX_RECIPIENTS,
  DM_INTERVAL_MS,
} from '../src/bot/releaseNotes.js';

const optedIn = {
  discordBotDm: {
    enabled: true,
    triggers: { highlightedUser: false, highlightedUserContract: false, contract: false, keyword: false, missedRunner: false, releaseNotes: true },
  },
};

describe('isReleaseNotesOptIn', () => {
  it('is true only when both the master switch and the trigger are on', () => {
    expect(isReleaseNotesOptIn(optedIn)).toBe(true);
  });

  // The whole point of the separate trigger: enabling bot DMs for market
  // signals is not consent to receive changelog posts.
  it('is false when DMs are on but release notes were not requested', () => {
    expect(
      isReleaseNotesOptIn({
        discordBotDm: { enabled: true, triggers: { missedRunner: true, releaseNotes: false } },
      }),
    ).toBe(false);
  });

  it('is false when the trigger is on but the master switch is off', () => {
    expect(
      isReleaseNotesOptIn({ discordBotDm: { enabled: false, triggers: { releaseNotes: true } } }),
    ).toBe(false);
  });

  // settings is an untyped JSON blob; anything unexpected must read as "no".
  it('is false for junk rather than throwing', () => {
    for (const junk of [null, undefined, 'yes', 42, {}, { discordBotDm: null }, { discordBotDm: 'on' }]) {
      expect(isReleaseNotesOptIn(junk)).toBe(false);
    }
  });

  it('does not accept a truthy non-true value as consent', () => {
    expect(
      isReleaseNotesOptIn({ discordBotDm: { enabled: 1, triggers: { releaseNotes: 'true' } } }),
    ).toBe(false);
  });
});

describe('selectOptInUserIds', () => {
  it('keeps only opted-in users', () => {
    const { userIds } = selectOptInUserIds([
      { user_id: 'a', settings: optedIn },
      { user_id: 'b', settings: { discordBotDm: { enabled: true, triggers: { releaseNotes: false } } } },
      { user_id: 'c', settings: {} },
      { user_id: 'd', settings: optedIn },
    ]);
    expect(userIds).toEqual(['a', 'd']);
  });

  it('reports nothing to send when nobody opted in', () => {
    const { userIds, truncated } = selectOptInUserIds([{ user_id: 'a', settings: {} }]);
    expect(userIds).toEqual([]);
    expect(truncated).toBe(false);
  });

  // A broadcast larger than the cap means something is wrong upstream; better to
  // send a bounded batch and say so than to spray.
  it('caps the recipient list and flags the truncation', () => {
    const rows = Array.from({ length: MAX_RECIPIENTS + 25 }, (_, i) => ({
      user_id: `u${i}`,
      settings: optedIn,
    }));
    const { userIds, truncated } = selectOptInUserIds(rows);
    expect(userIds).toHaveLength(MAX_RECIPIENTS);
    expect(truncated).toBe(true);
  });
});

describe('retryDelayMs', () => {
  it('honours Discord retry_after in seconds', () => {
    expect(retryDelayMs({ retry_after: 2 })).toBe(2000);
  });

  it('accepts the camelCase spelling too', () => {
    expect(retryDelayMs({ retryAfter: 1.5 })).toBe(1500);
  });

  it('falls back to the floor delay when absent or nonsense', () => {
    expect(retryDelayMs({})).toBe(DM_INTERVAL_MS);
    expect(retryDelayMs(null)).toBe(DM_INTERVAL_MS);
    expect(retryDelayMs({ retry_after: -5 })).toBe(DM_INTERVAL_MS);
  });

  // A malformed retry-after must not park the broadcast for an hour.
  it('clamps an absurd retry-after to a minute', () => {
    expect(retryDelayMs({ retry_after: 99999 })).toBe(60_000);
  });
});
