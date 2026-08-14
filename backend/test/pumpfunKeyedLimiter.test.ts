import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  FifoSemaphore,
  KEYED_MAX_IN_FLIGHT_DEFAULT,
  resolveKeyedMaxInFlight,
  runOnKeyedHost,
  getKeyedHostLimiterStats,
} from '../src/pumpfun/keyedLimiter';
import { PumpfunClient } from '../src/pumpfun/client';

// A task whose completion the test controls, so concurrency can be observed
// without any timing assumptions.
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every already-scheduled microtask settle. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const ENV_VARS = ['PUMPFUN_MAX_CONCURRENT', 'OCT_PUMPFUN_MAX_CONCURRENT', 'TRENCHCORD_PUMPFUN_MAX_CONCURRENT'];

beforeEach(() => {
  for (const v of ENV_VARS) delete process.env[v];
});

afterEach(() => {
  for (const v of ENV_VARS) delete process.env[v];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('FifoSemaphore — the cap', () => {
  it('never runs more than `limit` tasks at once', async () => {
    const sem = new FifoSemaphore(2);
    let running = 0;
    let peak = 0;
    const gates = Array.from({ length: 5 }, () => deferred());

    const tasks = gates.map((g) =>
      sem.run(2, async () => {
        running += 1;
        peak = Math.max(peak, running);
        await g.promise;
        running -= 1;
      }),
    );

    await flush();
    expect(running).toBe(2);
    expect(sem.stats().queued).toBe(3);

    // Release one at a time: the cap must hold at every step.
    for (const g of gates) {
      g.resolve();
      await flush();
      expect(running).toBeLessThanOrEqual(2);
    }

    await Promise.all(tasks);
    expect(peak).toBe(2);
    expect(sem.stats()).toEqual({ inFlight: 0, queued: 0, limit: 2 });
  });

  it('admits in FIFO order', async () => {
    const sem = new FifoSemaphore(1);
    const started: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred>>();

    const tasks = ['a', 'b', 'c', 'd'].map((name) => {
      const g = deferred();
      gates.set(name, g);
      return sem.run(1, async () => {
        started.push(name);
        await g.promise;
      });
    });

    await flush();
    expect(started).toEqual(['a']);

    for (const name of ['a', 'b', 'c', 'd']) {
      gates.get(name)!.resolve();
      await flush();
    }
    await Promise.all(tasks);
    // Strictly first-come-first-served, not reverse or arbitrary order.
    expect(started).toEqual(['a', 'b', 'c', 'd']);
  });

  it('releases the slot when a task throws (no wedged queue)', async () => {
    const sem = new FifoSemaphore(1);
    const boom = deferred();
    const second = deferred();
    let secondRan = false;

    const failing = sem.run(1, async () => {
      await boom.promise;
      throw new Error('upstream exploded');
    });
    const follower = sem.run(1, async () => {
      secondRan = true;
      await second.promise;
    });

    await flush();
    expect(secondRan).toBe(false); // still queued behind the failing task

    boom.resolve();
    await expect(failing).rejects.toThrow('upstream exploded');
    await flush();
    // The throw freed the slot rather than holding it forever.
    expect(secondRan).toBe(true);

    second.resolve();
    await follower;
    expect(sem.stats()).toEqual({ inFlight: 0, queued: 0, limit: 1 });
  });

  it('honours a raised limit on the next admission', async () => {
    const sem = new FifoSemaphore(1);
    let running = 0;
    const gates = Array.from({ length: 3 }, () => deferred());
    // All three are requested with a limit of 3, so all three run at once.
    const tasks = gates.map((g) =>
      sem.run(3, async () => {
        running += 1;
        await g.promise;
        running -= 1;
      }),
    );
    await flush();
    expect(running).toBe(3);
    for (const g of gates) g.resolve();
    await Promise.all(tasks);
  });

  it('treats a zero/negative limit as 1 rather than as "no concurrency at all"', async () => {
    const sem = new FifoSemaphore(0);
    expect(sem.stats().limit).toBe(1);
    await sem.run(-5, async () => undefined);
    expect(sem.stats()).toEqual({ inFlight: 0, queued: 0, limit: 1 });
  });
});

describe('resolveKeyedMaxInFlight', () => {
  it('defaults to the low shared-key cap when unset', () => {
    expect(resolveKeyedMaxInFlight()).toBe(KEYED_MAX_IN_FLIGHT_DEFAULT);
    expect(KEYED_MAX_IN_FLIGHT_DEFAULT).toBe(2);
  });

  it('reads the primary var, then the dual-brand fallbacks', () => {
    process.env.PUMPFUN_MAX_CONCURRENT = '5';
    expect(resolveKeyedMaxInFlight()).toBe(5);
    delete process.env.PUMPFUN_MAX_CONCURRENT;
    process.env.OCT_PUMPFUN_MAX_CONCURRENT = '4';
    expect(resolveKeyedMaxInFlight()).toBe(4);
    delete process.env.OCT_PUMPFUN_MAX_CONCURRENT;
    process.env.TRENCHCORD_PUMPFUN_MAX_CONCURRENT = '3';
    expect(resolveKeyedMaxInFlight()).toBe(3);
  });

  it('falls back to the default on junk or a non-positive value', () => {
    for (const bad of ['', 'lots', '0', '-2']) {
      process.env.PUMPFUN_MAX_CONCURRENT = bad;
      expect(resolveKeyedMaxInFlight()).toBe(KEYED_MAX_IN_FLIGHT_DEFAULT);
    }
  });
});

describe('runOnKeyedHost (the shared process-wide gate)', () => {
  it('queues past the cap and always releases', async () => {
    process.env.PUMPFUN_MAX_CONCURRENT = '1';
    const first = deferred();
    let secondStarted = false;

    const a = runOnKeyedHost(async () => {
      await first.promise;
    });
    const b = runOnKeyedHost(async () => {
      secondStarted = true;
    });

    await flush();
    expect(secondStarted).toBe(false);
    expect(getKeyedHostLimiterStats().queued).toBe(1);

    first.resolve();
    await Promise.all([a, b]);
    expect(secondStarted).toBe(true);
    expect(getKeyedHostLimiterStats()).toMatchObject({ inFlight: 0, queued: 0 });
  });
});

describe('the client shares the gate (the Promise.all burst that caused the 429s)', () => {
  it('serializes two parallel keyed reads when the cap is 1', async () => {
    process.env.PUMPFUN_API_KEY = 'pk-test';
    process.env.PUMPFUN_MAX_CONCURRENT = '1';
    process.env.PUMPFUN_READ_RETRIES = '0';

    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return new Response(JSON.stringify({ callouts: [], communities: [] }), { status: 200 });
      }),
    );

    const client = new PumpfunClient();
    const MINT = 'So11111111111111111111111111111111111111112';
    // Exactly the frontend's shape: both keyed reads for one mint, fired together.
    await Promise.all([client.getTokenCallouts(MINT), client.getCommunity(MINT)]);

    expect(peak).toBe(1);
    delete process.env.PUMPFUN_API_KEY;
    delete process.env.PUMPFUN_READ_RETRIES;
  });

  it('caps two parallel reads at the default of 2, not 3', async () => {
    process.env.PUMPFUN_API_KEY = 'pk-test';
    process.env.PUMPFUN_READ_RETRIES = '0';

    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return new Response(JSON.stringify({ callouts: [], communities: [], items: [] }), { status: 200 });
      }),
    );

    const client = new PumpfunClient();
    const MINT = 'So11111111111111111111111111111111111111112';
    await Promise.all([client.getTokenCallouts(MINT), client.getCommunity(MINT), client.getTrendingFeed()]);

    expect(peak).toBe(2);
    delete process.env.PUMPFUN_API_KEY;
    delete process.env.PUMPFUN_READ_RETRIES;
  });
});
