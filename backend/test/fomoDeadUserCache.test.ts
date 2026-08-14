import { describe, expect, it } from 'vitest';
import {
  DEAD_USER_MISS_THRESHOLD,
  DEFAULT_DEAD_USER_SKIP_MS,
  isUserNotFound,
  recordNotFound,
  shouldSkipUser,
  type DeadUserEntry,
} from '../src/fomo/deadUserCache.js';

const SKIP_MS = DEFAULT_DEAD_USER_SKIP_MS;

describe('isUserNotFound', () => {
  it('matches a 404 whose body says the user is gone', () => {
    expect(isUserNotFound(404, '{"message":"User not found"}')).toBe(true);
    expect(isUserNotFound(404, 'user not found')).toBe(true);
  });

  it('ignores 404s with other bodies (bad path, upstream flap)', () => {
    expect(isUserNotFound(404, 'Not Found')).toBe(false);
    expect(isUserNotFound(404, '')).toBe(false);
    expect(isUserNotFound(404, null)).toBe(false);
  });

  it('ignores non-404 statuses even with a matching body', () => {
    expect(isUserNotFound(500, 'User not found')).toBe(false);
    expect(isUserNotFound(200, 'User not found')).toBe(false);
    expect(isUserNotFound(0, 'User not found')).toBe(false);
  });
});

describe('recordNotFound / shouldSkipUser', () => {
  it('does not park a user below the consecutive-miss threshold', () => {
    let entry: DeadUserEntry | undefined;
    for (let i = 0; i < DEAD_USER_MISS_THRESHOLD - 1; i++) {
      entry = recordNotFound(entry, 1_000 + i, SKIP_MS);
      expect(entry.skipUntil).toBeNull();
      expect(shouldSkipUser(entry, 1_000 + i)).toBe(false);
    }
  });

  it('parks a user for the skip window at the threshold', () => {
    let entry: DeadUserEntry | undefined;
    const now = 50_000;
    for (let i = 0; i < DEAD_USER_MISS_THRESHOLD; i++) {
      entry = recordNotFound(entry, now, SKIP_MS);
    }
    expect(entry!.skipUntil).toBe(now + SKIP_MS);
    expect(shouldSkipUser(entry, now)).toBe(true);
    expect(shouldSkipUser(entry, now + SKIP_MS - 1)).toBe(true);
  });

  it('allows a probe again once the window expires', () => {
    let entry: DeadUserEntry | undefined;
    const now = 50_000;
    for (let i = 0; i < DEAD_USER_MISS_THRESHOLD; i++) {
      entry = recordNotFound(entry, now, SKIP_MS);
    }
    expect(shouldSkipUser(entry, now + SKIP_MS)).toBe(false);
  });

  it('re-parks immediately after a failed post-window probe (one retry per window)', () => {
    let entry: DeadUserEntry | undefined;
    const now = 50_000;
    for (let i = 0; i < DEAD_USER_MISS_THRESHOLD; i++) {
      entry = recordNotFound(entry, now, SKIP_MS);
    }
    const probeAt = now + SKIP_MS + 1;
    entry = recordNotFound(entry, probeAt, SKIP_MS);
    expect(entry.skipUntil).toBe(probeAt + SKIP_MS);
    expect(shouldSkipUser(entry, probeAt)).toBe(true);
  });

  it('never skips an unknown user', () => {
    expect(shouldSkipUser(undefined, 1_000)).toBe(false);
  });
});
