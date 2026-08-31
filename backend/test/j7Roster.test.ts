// The roster allocation, which is the part of the j7 fan-out work that has to be
// exactly right: j7 caps each account at 50 targets per tracker, OCT's users
// collectively want more than the total (121 pump callers against 100 slots when
// this was measured), so every cycle makes a real choice about who gets tracked
// and who does not. planRoster is pure, so all of that is testable with no JWT,
// no socket and no Supabase.
import { describe, expect, it } from 'vitest';
import { planRoster, type AccountCapacity, type DesiredTarget } from '../src/j7/rosterPlan.js';

/** A desired target; `followers` and `addedAt` drive the over-capacity ranking. */
function want(
  key: string,
  followers = 1,
  addedAt = '2026-01-01T00:00:00.000Z',
  aliases: string[] = [],
): DesiredTarget {
  return { key, addAs: key, aliases, followerCount: followers, addedAt };
}

/** An account with `cap` slots, currently tracking `actual` (by identifier). */
function account(username: string, cap: number, actual: string[] = []): AccountCapacity {
  return { username, cap, actual: actual.map((id) => ({ removeAs: id, identifiers: [id] })) };
}

describe('planRoster — capacity', () => {
  it('adds everything when demand is under cap', () => {
    const plan = planRoster([want('a'), want('b')], [account('one', 50)]);
    expect(plan.accounts[0].toAdd).toEqual(['a', 'b']);
    expect(plan.accounts[0].toRemove).toEqual([]);
    expect(plan.dropped).toEqual([]);
    expect(plan.accounts[0].changed).toBe(true);
  });

  it('fills account 1 before account 2, exactly to cap', () => {
    const desired = [want('a', 4), want('b', 3), want('c', 2), want('d', 1)];
    const plan = planRoster(desired, [account('one', 2), account('two', 2)]);

    expect(plan.accounts[0].assigned).toEqual(['a', 'b']);
    expect(plan.accounts[1].assigned).toEqual(['c', 'd']);
    expect(plan.dropped).toEqual([]);
    // The invariant that makes the cap mean anything: no target on two sockets.
    const all = plan.accounts.flatMap((a) => a.assigned);
    expect(new Set(all).size).toBe(all.length);
  });

  it('is a no-op when the live set already matches', () => {
    const plan = planRoster([want('a'), want('b')], [account('one', 50, ['a', 'b'])]);
    expect(plan.accounts[0].toAdd).toEqual([]);
    expect(plan.accounts[0].toRemove).toEqual([]);
    // `changed` is the reconnect trigger — a stable roster must not bounce sockets.
    expect(plan.accounts[0].changed).toBe(false);
  });
});

describe('planRoster — over capacity', () => {
  it('keeps the most-followed and reports the rest as dropped', () => {
    const desired = [
      want('low', 1),
      want('top', 9),
      want('mid', 5),
      want('bottom', 0),
    ];
    const plan = planRoster(desired, [account('one', 2)]);

    expect(plan.accounts[0].assigned).toEqual(['top', 'mid']);
    expect(plan.dropped).toEqual([
      { key: 'low', followerCount: 1 },
      { key: 'bottom', followerCount: 0 },
    ]);
    expect(plan.desiredCount).toBe(4);
    expect(plan.totalSlots).toBe(2);
  });

  it('breaks follower ties by earliest follow, and the order is input-independent', () => {
    const older = want('older', 3, '2026-01-01T00:00:00.000Z');
    const newer = want('newer', 3, '2026-06-01T00:00:00.000Z');
    const newest = want('newest', 3, '2026-09-01T00:00:00.000Z');

    const a = planRoster([newest, older, newer], [account('one', 2)]);
    const b = planRoster([newer, newest, older], [account('one', 2)]);

    expect(a.accounts[0].assigned).toEqual(['older', 'newer']);
    // Same demand, different input order → same plan. Without this the tail
    // would reshuffle every cycle and churn subscriptions.
    expect(b.accounts[0].assigned).toEqual(a.accounts[0].assigned);
    expect(b.dropped).toEqual(a.dropped);
  });

  it('re-planning the same demand is stable across cycles', () => {
    const desired = [want('a', 2), want('b', 2), want('c', 1)];
    const first = planRoster(desired, [account('one', 2)]);
    // Second cycle: the accounts now hold what the first cycle assigned.
    const second = planRoster(desired, [account('one', 2, first.accounts[0].assigned)]);

    expect(second.accounts[0].toAdd).toEqual([]);
    expect(second.accounts[0].toRemove).toEqual([]);
    expect(second.accounts[0].changed).toBe(false);
    expect(second.dropped.map((d) => d.key)).toEqual(['c']);
  });

  it('promotes a dropped target once a slot frees up', () => {
    const desired = [want('kept', 5), want('waiting', 1)];
    const full = planRoster(desired, [account('one', 1, ['kept'])]);
    expect(full.dropped.map((d) => d.key)).toEqual(['waiting']);

    // Somebody unfollows 'kept' — demand shrinks, 'waiting' gets the slot.
    const freed = planRoster([want('waiting', 1)], [account('one', 1, ['kept'])]);
    expect(freed.accounts[0].toRemove).toEqual(['kept']);
    expect(freed.accounts[0].toAdd).toEqual(['waiting']);
    expect(freed.dropped).toEqual([]);
  });
});

describe('planRoster — diffing the live set', () => {
  it('removes targets nobody tracks any more, freeing the slot in the same cycle', () => {
    const plan = planRoster([want('keep'), want('new')], [account('one', 2, ['keep', 'stale'])]);
    expect(plan.accounts[0].toRemove).toEqual(['stale']);
    expect(plan.accounts[0].toAdd).toEqual(['new']);
  });

  it('recognises a target j7 lists under a different identifier', () => {
    // OCT keys pump demand by WALLET; j7 lists the row by username. Matching on
    // one field alone would re-add and re-remove the same caller forever.
    const desired = [{ ...want('WALLET111'), aliases: ['cupsey'] }];
    const live: AccountCapacity = {
      username: 'one',
      cap: 50,
      actual: [{ removeAs: 'cupsey', identifiers: ['cupsey', 'WALLET111'] }],
    };
    const plan = planRoster(desired, [live]);
    expect(plan.accounts[0].toAdd).toEqual([]);
    expect(plan.accounts[0].toRemove).toEqual([]);
  });

  it('matches identifiers case-insensitively', () => {
    const plan = planRoster([want('Cented')], [account('one', 50, ['cented'])]);
    expect(plan.accounts[0].changed).toBe(false);
  });

  it('drops a duplicate upstream row so the slot comes back', () => {
    const live: AccountCapacity = {
      username: 'one',
      cap: 50,
      actual: [
        { removeAs: 'dupe-a', identifiers: ['cupsey'] },
        { removeAs: 'dupe-b', identifiers: ['cupsey'] },
      ],
    };
    const plan = planRoster([want('cupsey')], [live]);
    expect(plan.accounts[0].toRemove).toEqual(['dupe-b']);
    expect(plan.accounts[0].toAdd).toEqual([]);
  });

  it('moves a target between accounts as a remove plus an add', () => {
    // 'b' outranks 'a' after a follow, so the boundary shifts by one.
    const desired = [want('b', 9), want('a', 1)];
    const plan = planRoster(desired, [account('one', 1, ['a']), account('two', 1, ['b'])]);

    expect(plan.accounts[0].toAdd).toEqual(['b']);
    expect(plan.accounts[0].toRemove).toEqual(['a']);
    expect(plan.accounts[1].toAdd).toEqual(['a']);
    expect(plan.accounts[1].toRemove).toEqual(['b']);
  });

  it('never spends two slots on the same caller followed by two users', () => {
    // The loaders fold by key; this guards the planner's own invariant.
    const plan = planRoster([want('a', 1), want('a', 1)], [account('one', 50)]);
    expect(plan.accounts[0].toAdd).toEqual(['a']);
    expect(plan.desiredCount).toBe(1);
  });

  it('drops everything and adds nothing when there are no accounts', () => {
    const plan = planRoster([want('a')], []);
    expect(plan.totalSlots).toBe(0);
    expect(plan.accounts).toEqual([]);
    expect(plan.dropped.map((d) => d.key)).toEqual(['a']);
  });
});
