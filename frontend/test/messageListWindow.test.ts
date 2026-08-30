import { describe, it, expect } from 'vitest';
import {
  computeFrozenWindow,
  scrollAnchorDecision,
} from '../src/utils/messageListWindow';

const msgs = (ids: string[]) => ids.map((id) => ({ id }));

describe('computeFrozenWindow', () => {
  it('renders everything when not frozen', () => {
    const list = msgs(['a', 'b', 'c']);
    const w = computeFrozenWindow(list, null);
    expect(w.baseList).toBe(list); // same reference: no copy when not frozen
    expect(w.newMessageCount).toBe(0);
    expect(w.firstNewMessage).toBeNull();
  });

  it('truncates at the boundary and counts newer messages', () => {
    const list = msgs(['a', 'b', 'c', 'd', 'e']);
    const w = computeFrozenWindow(list, 'c');
    expect(w.baseList.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(w.newMessageCount).toBe(2);
    expect(w.firstNewMessage?.id).toBe('d');
  });

  it('frozen at the newest message counts nothing as new', () => {
    const list = msgs(['a', 'b', 'c']);
    const w = computeFrozenWindow(list, 'c');
    expect(w.baseList.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(w.newMessageCount).toBe(0);
    expect(w.firstNewMessage).toBeNull();
  });

  it('boundary evicted by the room cap falls back to the full list', () => {
    const list = msgs(['d', 'e', 'f']);
    const w = computeFrozenWindow(list, 'a'); // 'a' already dropped
    expect(w.baseList).toBe(list);
    expect(w.newMessageCount).toBe(0);
  });

  it('duplicate-free scan picks the boundary from the newest end', () => {
    // frozenAtId is always a message id (unique), but the reverse scan must
    // still terminate at the first hit from the end.
    const list = msgs(['a', 'b']);
    const w = computeFrozenWindow(list, 'b');
    expect(w.baseList.length).toBe(2);
  });

  it('empty list stays empty', () => {
    const w = computeFrozenWindow([], 'a');
    expect(w.baseList).toEqual([]);
    expect(w.newMessageCount).toBe(0);
  });
});

describe('scrollAnchorDecision', () => {
  const base = { scrollHeight: 5000, clientHeight: 800, nearBottomThreshold: 150 };

  it('sticks when within the bottom threshold', () => {
    // distanceFromBottom = 5000 - 4100 - 800 = 100 < 150
    expect(
      scrollAnchorDecision({ ...base, scrollTop: 4100, previousScrollTop: 4200 }),
    ).toBe('stick');
  });

  it('sticks exactly at the bottom even while scrolling up slightly', () => {
    expect(
      scrollAnchorDecision({ ...base, scrollTop: 4200, previousScrollTop: 4210 }),
    ).toBe('stick');
  });

  it('releases on a deliberate upward scroll away from the bottom', () => {
    // distanceFromBottom = 5000 - 3000 - 800 = 1200
    expect(
      scrollAnchorDecision({ ...base, scrollTop: 3000, previousScrollTop: 3100 }),
    ).toBe('release');
  });

  it('does not release when content grows under a stationary user', () => {
    // Content grew (scrollHeight up) but scrollTop unchanged: not an upward
    // scroll, so streaming must not yank the anchor state.
    expect(
      scrollAnchorDecision({ ...base, scrollTop: 3000, previousScrollTop: 3000 }),
    ).toBe('keep');
  });

  it('tolerates sub-2px jitter without releasing', () => {
    expect(
      scrollAnchorDecision({ ...base, scrollTop: 2999, previousScrollTop: 3000 }),
    ).toBe('keep');
  });

  it('downward scroll away from the bottom keeps current state', () => {
    expect(
      scrollAnchorDecision({ ...base, scrollTop: 3100, previousScrollTop: 3000 }),
    ).toBe('keep');
  });
});
