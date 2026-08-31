// The roster reconciler: make j7's upstream subscriptions equal what OCT's
// users actually track.
//
// Before this, j7's target list was maintained by hand on j7tracker's own site,
// which meant a user could follow a caller in the console and simply never hear
// from them. Now the loop closes: follow a caller → the next reconcile
// subscribes j7 to that caller → their callouts arrive → fanout.ts delivers them
// to the follower. Unfollowing frees the slot again.
//
// Four things are worth knowing before changing this:
//
//  1. DEMAND EXCEEDS SUPPLY, AND THAT IS NOT AN ERROR PATH. Two accounts give
//     50 pump + 50 fomo slots each; live demand was 121 distinct pump callers
//     against 100 slots the day this was written. Over-capacity is the normal
//     state, so it is ranked (rosterPlan.ts) and LOUD — never a silent truncation.
//  2. THE PLAN IS PURE, THE APPLY IS NOT. Every decision lives in planRoster;
//     this file only reads, POSTs and logs. That is what makes the allocation
//     testable without a JWT.
//  3. A CHANGED ACCOUNT MUST RECONNECT. Measured live: j7 scopes a socket at
//     CONNECT time (it pushes `tracked_*` snapshots on connect), so a target
//     added after the socket came up does not start delivering. Reconnecting is
//     therefore part of applying the change, not an optimisation — and it is
//     done only for accounts whose set actually moved, since a reconnect is a
//     brief gap in that account's coverage.
//  4. NOTHING HERE MAY THROW. It runs on a timer next to a live socket; a j7
//     REST hiccup costs this cycle and nothing else.

import type { J7Account, J7Consumer } from './client.js';
import { loadFomoDemand, loadPumpDemand } from './demand.js';
import {
  planRoster,
  type AccountCapacity,
  type DesiredTarget,
  type DroppedTarget,
  type RosterPlan,
} from './rosterPlan.js';
import {
  addFomoTarget,
  addPumpTarget,
  listFomoTargetRows,
  listPumpTargetRows,
  removeFomoTarget,
  removePumpTarget,
} from './subscriptions.js';

/** j7's documented per-account cap, used when a `/list` omits its `limit`. */
const DEFAULT_CAP = 50;
const INTERVAL_MS = Number.parseInt(process.env.J7_ROSTER_INTERVAL_MS ?? '', 10) || 5 * 60_000;
/**
 * Let the sockets connect and the process settle before the first reconcile —
 * boot is already the busiest moment, and a reconcile immediately followed by a
 * reconnect would just re-do the connect we are waiting on.
 */
const BOOT_DELAY_MS = Number.parseInt(process.env.J7_ROSTER_BOOT_DELAY_MS ?? '', 10) || 20_000;
/** Re-state an unchanged over-capacity warning at most this often. */
const WARN_REPEAT_MS = Number.parseInt(process.env.J7_ROSTER_WARN_REPEAT_MS ?? '', 10) || 60 * 60_000;

type Tracker = 'pump' | 'fomo';

/** What the last completed reconcile could not fit upstream. */
export interface DroppedRoster {
  pump: DroppedTarget[];
  fomo: DroppedTarget[];
  /** ISO time of the reconcile that produced this, or null if none has run. */
  at: string | null;
}

let _dropped: DroppedRoster = { pump: [], fomo: [], at: null };

/**
 * Targets OCT users track that no j7 account has a slot for.
 *
 * Exposed so an API/UI can mark a followed caller "not tracked upstream" rather
 * than leaving the user to wonder why a caller they follow never fires. Returns
 * a copy: callers must not be able to mutate the reconciler's state.
 */
export function getDroppedRoster(): DroppedRoster {
  return { pump: [..._dropped.pump], fomo: [..._dropped.fomo], at: _dropped.at };
}

// One warning per distinct over-capacity situation, re-stated hourly. Silence
// is the thing we are guarding against; a line every 5 minutes saying the same
// thing is how a log stops being read.
const _lastWarn = new Map<Tracker, { signature: string; at: number }>();

function warnOverCapacity(tracker: Tracker, plan: RosterPlan): void {
  if (plan.dropped.length === 0) {
    _lastWarn.delete(tracker);
    return;
  }
  const signature = `${plan.desiredCount}/${plan.totalSlots}:${plan.dropped.map((d) => d.key).join(',')}`;
  const prev = _lastWarn.get(tracker);
  if (prev && prev.signature === signature && Date.now() - prev.at < WARN_REPEAT_MS) return;
  _lastWarn.set(tracker, { signature, at: Date.now() });
  console.warn(
    `[J7] ${tracker} demand ${plan.desiredCount} > ${plan.totalSlots} slots — tracking top ` +
      `${plan.totalSlots} by follower count, ${plan.dropped.length} not tracked ` +
      '(add another j7 account to cover them).',
  );
}

/** Test seam: forget the warning latch. */
export function resetRosterWarnings(): void {
  _lastWarn.clear();
}

/**
 * Read every account's live target set for one tracker.
 *
 * Returns null if ANY account fails: assignment is positional across the whole
 * account array, so planning from a partial view would move targets between
 * accounts for no reason and cost a reconnect each. Skipping the cycle is
 * strictly cheaper — the next one is 5 minutes away.
 */
async function readCapacities(accounts: J7Account[], tracker: Tracker): Promise<AccountCapacity[] | null> {
  const list = tracker === 'pump' ? listPumpTargetRows : listFomoTargetRows;
  const out: AccountCapacity[] = [];
  for (const account of accounts) {
    try {
      const { rows, limit } = await list(account.jwt);
      out.push({
        username: account.username,
        cap: limit ?? DEFAULT_CAP,
        actual: rows.map((r) => ({ removeAs: r.id, identifiers: r.identifiers })),
      });
    } catch (err) {
      console.warn(
        `[J7] (${account.username}) ${tracker} list failed: ${(err as Error)?.message} — skipping this reconcile.`,
      );
      return null;
    }
  }
  return out;
}

/**
 * Apply one account's plan. Removals run BEFORE additions so an account sitting
 * at its cap frees the slot it is about to need — an add into a full account is
 * a hard server-side rejection, a brief unsubscribe is not.
 *
 * Returns true when at least one call succeeded, i.e. the account's upstream set
 * really moved and its socket needs re-scoping.
 */
async function applyAccount(
  account: J7Account,
  tracker: Tracker,
  toAdd: string[],
  toRemove: string[],
): Promise<boolean> {
  const add = tracker === 'pump' ? addPumpTarget : addFomoTarget;
  const remove = tracker === 'pump' ? removePumpTarget : removeFomoTarget;
  let changed = false;

  for (const target of toRemove) {
    try {
      await remove(account.jwt, target);
      changed = true;
    } catch (err) {
      console.warn(`[J7] (${account.username}) ${tracker} remove "${target}" failed: ${(err as Error)?.message}`);
    }
  }
  for (const target of toAdd) {
    try {
      await add(account.jwt, target);
      changed = true;
    } catch (err) {
      console.warn(`[J7] (${account.username}) ${tracker} add "${target}" failed: ${(err as Error)?.message}`);
    }
  }
  return changed;
}

/**
 * Reconcile one tracker across every account.
 *
 * Returns the set of account INDICES whose upstream target set changed — the
 * caller unions pump's and fomo's and reconnects each such socket exactly once.
 */
async function reconcileTracker(
  accounts: J7Account[],
  tracker: Tracker,
  desired: DesiredTarget[],
): Promise<Set<number>> {
  const changedAccounts = new Set<number>();

  const capacities = await readCapacities(accounts, tracker);
  if (!capacities) return changedAccounts;

  const plan = planRoster(desired, capacities);
  warnOverCapacity(tracker, plan);
  if (tracker === 'pump') _dropped.pump = plan.dropped;
  else _dropped.fomo = plan.dropped;

  for (const [i, accountPlan] of plan.accounts.entries()) {
    if (!accountPlan.changed) continue;
    const moved = await applyAccount(accounts[i], tracker, accountPlan.toAdd, accountPlan.toRemove);
    if (moved) {
      changedAccounts.add(i);
      console.log(
        `[J7] (${accountPlan.username}) ${tracker} roster: +${accountPlan.toAdd.length} ` +
          `-${accountPlan.toRemove.length} → ${accountPlan.assigned.length}/${accountPlan.cap} tracked.`,
      );
    }
  }
  return changedAccounts;
}

let _timer: NodeJS.Timeout | null = null;
let _bootTimer: NodeJS.Timeout | null = null;
let _running = false;

/**
 * One full reconcile: both trackers, then one reconnect per account that moved.
 *
 * Exported for tests and for a future manual "reconcile now" control. Guarded
 * against overlap — a slow cycle must not be re-entered by the timer, or the
 * two runs would plan from the same stale list and double-apply.
 */
export async function reconcileJ7Roster(accounts: J7Account[], consumer: J7Consumer | null): Promise<void> {
  if (_running) return;
  _running = true;
  try {
    const [pumpDemand, fomoDemand] = await Promise.all([loadPumpDemand(), loadFomoDemand()]);
    // No demand at all almost always means "Supabase is not configured" (local
    // mode). Removing every upstream target on the strength of an empty read
    // would be destructive and wrong, so treat it as nothing to do.
    if (pumpDemand.length === 0 && fomoDemand.length === 0) return;

    const changed = new Set<number>();
    for (const i of await reconcileTracker(accounts, 'pump', pumpDemand)) changed.add(i);
    for (const i of await reconcileTracker(accounts, 'fomo', fomoDemand)) changed.add(i);
    _dropped.at = new Date().toISOString();

    // See header note 3: j7 scopes a socket at connect time, so a changed
    // target set only takes effect on the next connection.
    for (const i of changed) {
      consumer?.reconnectAccount(i, 'roster changed');
    }
  } catch (err) {
    console.error('[J7] roster reconcile failed:', (err as Error)?.message);
  } finally {
    _running = false;
  }
}

/** Start the boot-delayed + interval reconcile loop. Idempotent. */
export function startJ7RosterReconciler(accounts: J7Account[], consumer: J7Consumer): void {
  if (_timer || accounts.length === 0) return;

  const run = (): void => {
    void reconcileJ7Roster(accounts, consumer);
  };

  _bootTimer = setTimeout(run, BOOT_DELAY_MS);
  _timer = setInterval(run, INTERVAL_MS);
  console.log(
    `[J7] Roster reconciler armed (first run in ${Math.round(BOOT_DELAY_MS / 1000)}s, ` +
      `then every ${Math.round(INTERVAL_MS / 1000)}s).`,
  );
}

/** Stop the loop (clean shutdown / tests) — including a boot run not yet fired. */
export function stopJ7RosterReconciler(): void {
  if (_timer) clearInterval(_timer);
  if (_bootTimer) clearTimeout(_bootTimer);
  _timer = null;
  _bootTimer = null;
  _dropped = { pump: [], fomo: [], at: null };
}
