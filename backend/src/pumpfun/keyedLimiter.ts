// Concurrency cap for the KEYED pump.fun host (api.coin-communities.xyz).
//
// WHY THIS EXISTS: that host is rate-limited per shared `x-api-key`, and the
// console can burst it without any user doing anything unusual — the token tab
// fires `/callouts` and `/community` for the same mint in one `Promise.all`, and
// in hosted mode several users can open the tab in the same tick. Two requests
// leaving at the same instant means one gets served and the other earns a 429,
// which used to surface as a hard error card. The retry in client.ts recovers
// from a 429; THIS is what stops us causing it in the first place.
//
// SCOPE: the keyed host ONLY. profile-api.pump.fun and frontend-api-v3.pump.fun
// are keyless, separately rate-limited origins with their own clients
// (`profileFetch`, holdersClient.ts, calloutFeedClient.ts) — queueing them behind
// the keyed budget would couple three unrelated failure domains. One limiter,
// one host.
//
// DEPENDENCY-FREE by intent: a queue of resolvers is the whole mechanism. No
// p-limit, no semaphore package.
//
// TIMEOUT SEMANTICS (deliberate, see runOnKeyedHost): the caller's per-request
// timeout budget is started INSIDE the critical section, after a slot is
// acquired — never while queued. A request that waits 3s for a slot still gets
// its full 10s on the wire rather than a confusing "timed out" it never spent on
// the network. The trade is that total latency is queue-wait + request budget;
// that wait is bounded in practice because every holder is itself bounded by the
// request timeout, so a slot frees within TIMEOUT_MS even in the worst case.

/**
 * FIFO concurrency gate. `limit` is re-read on every acquire so an env change is
 * picked up without a restart and tests can retune it between specs.
 *
 * INVARIANTS:
 * - Admission is strictly first-come-first-served (the queue is a plain FIFO).
 * - `inFlight` is incremented by the admitting code path (synchronously, inside
 *   the waiter callback), never by the woken caller, so two waiters resolved in
 *   the same tick cannot both slip past the cap.
 * - A slot is released in a `finally`, so a throwing task cannot wedge the queue.
 */
export class FifoSemaphore {
  private limit: number;
  private inFlight = 0;
  private readonly queue: Array<() => void> = [];

  constructor(limit: number) {
    this.limit = Math.max(1, limit);
  }

  /** In-flight and queued counts, for tests and a future /pumpfun/status. */
  stats(): { inFlight: number; queued: number; limit: number } {
    return { inFlight: this.inFlight, queued: this.queue.length, limit: this.limit };
  }

  /**
   * Run `task` with a slot held. `limit` updates the cap for this and subsequent
   * admissions. Always releases — on resolve and on throw alike.
   */
  async run<T>(limit: number, task: () => Promise<T>): Promise<T> {
    await this.acquire(limit);
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(limit: number): Promise<void> {
    this.limit = Math.max(1, limit);
    if (this.inFlight < this.limit) {
      this.inFlight += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.inFlight += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.inFlight -= 1;
    // Only admit while under the cap: the cap can have been LOWERED since this
    // holder was admitted, in which case the queue must simply wait longer.
    if (this.inFlight < this.limit) {
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

/**
 * How many keyed requests may be on the wire at once. Low by design: the budget
 * belongs to one shared key across every user of the deployment, so the cheapest
 * safe default is "barely parallel at all". Two lets the token tab's pair of
 * reads still overlap while a third caller queues.
 */
export const KEYED_MAX_IN_FLIGHT_DEFAULT = 2;

/**
 * Resolve the cap from env, honouring the OCT_/TRENCHCORD_ dual-brand fallback
 * chain used by `resolvePumpfunApiKey`. Read late (per acquire) for the same
 * reason the key is: env is configuration, not boot state. A non-numeric or
 * non-positive value falls back to the default rather than disabling the cap.
 */
export function resolveKeyedMaxInFlight(): number {
  const raw =
    process.env.PUMPFUN_MAX_CONCURRENT ||
    process.env.OCT_PUMPFUN_MAX_CONCURRENT ||
    process.env.TRENCHCORD_PUMPFUN_MAX_CONCURRENT ||
    '';
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : KEYED_MAX_IN_FLIGHT_DEFAULT;
}

/**
 * The process-wide gate for api.coin-communities.xyz. Module-level so EVERY
 * caller of the keyed `get()` shares one budget — a per-client or per-request
 * limiter would not stop the burst this exists to stop.
 */
const keyedHostLimiter = new FifoSemaphore(KEYED_MAX_IN_FLIGHT_DEFAULT);

/** Run one keyed-host request under the shared cap. */
export function runOnKeyedHost<T>(task: () => Promise<T>): Promise<T> {
  return keyedHostLimiter.run(resolveKeyedMaxInFlight(), task);
}

/** In-flight/queued counters for the shared keyed gate. */
export function getKeyedHostLimiterStats(): { inFlight: number; queued: number; limit: number } {
  return keyedHostLimiter.stats();
}
