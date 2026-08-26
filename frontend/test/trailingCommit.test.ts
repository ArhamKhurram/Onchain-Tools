import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTrailingCommit } from '../src/utils/trailingCommit';

// The colour picker commits through this: per-tick picker events must collapse
// into one trailing commit, and the LAST value pushed must always be the one
// committed — a dropped final value is exactly the "colour didn't stick" bug.

describe('createTrailingCommit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('collapses a burst of pushes into a single commit of the last value', () => {
    const commit = vi.fn();
    const t = createTrailingCommit<string>(commit, 250);

    for (let i = 0; i < 30; i++) {
      t.push(`#0000${i.toString().padStart(2, '0')}`);
      vi.advanceTimersByTime(10); // ticks arrive faster than the delay
    }
    expect(commit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(250);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('#000029');
  });

  it('commits separate gestures separately', () => {
    const commit = vi.fn();
    const t = createTrailingCommit<string>(commit, 250);

    t.push('#111111');
    vi.advanceTimersByTime(250);
    t.push('#222222');
    vi.advanceTimersByTime(250);

    expect(commit.mock.calls.map((c) => c[0])).toEqual(['#111111', '#222222']);
  });

  it('flush commits a pending value immediately (unmount mid-gesture)', () => {
    const commit = vi.fn();
    const t = createTrailingCommit<string>(commit, 250);

    t.push('#333333');
    t.flush();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('#333333');

    // Nothing pending afterwards — the timer must not fire a duplicate.
    vi.advanceTimersByTime(1000);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('flush with nothing pending is a no-op', () => {
    const commit = vi.fn();
    const t = createTrailingCommit<string>(commit, 250);
    t.flush();
    expect(commit).not.toHaveBeenCalled();
  });

  it('cancel drops the pending value', () => {
    const commit = vi.fn();
    const t = createTrailingCommit<string>(commit, 250);
    t.push('#444444');
    t.cancel();
    vi.advanceTimersByTime(1000);
    t.flush();
    expect(commit).not.toHaveBeenCalled();
  });
});
