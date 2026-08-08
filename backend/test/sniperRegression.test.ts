// Regression tests for defects found in the M1 pre-ship review. Each test here
// FAILS against the pre-fix code — that is the bar for being in this file.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { executeFire } from '../src/sniper/executeFire';
import { IdempotencyLedger } from '../src/sniper/idempotency';
import { InMemorySniperStore } from '../src/sniper/store';
import { ExecutorRegistry, processDryRun } from '../src/sniper/executors/registry';
import { DryRunExecutor } from '../src/sniper/executors/dryRun';
import { toVenueSlippagePercent } from '../src/sniper/executors/slotshark';
import { computeLegs, validateLadderSplit } from '../src/sniper/legs';
import type { SnipeRule, NormalizedTweet, SendOutcome } from '../src/sniper/types';

const NOW = 1_785_000_000_000;
const DAY = new Date(NOW).toISOString().slice(0, 10);
const U = 'u1';

function rule(over: Partial<SnipeRule> = {}): SnipeRule {
  return {
    id: 'r1', userId: U, name: 't', state: 'armed', chain: 'sol', venue: 'dryrun',
    handles: ['elon'], interactionTypes: ['tweet'],
    matcher: { op: 'leaf', pattern: { pattern: 'doge', matchMode: 'includes' } },
    phase: 1, mint: 'MINT1', entryStyle: 'single', ladderSplit: null,
    sizeUnit: 'SOL', sizeTotal: 1, walletIds: ['w1'], perFireCap: 5, perTriggerCap: 100,
    slippageBps: 500, exec: { kind: 'sol', antimev: true }, maxTweetAgeMs: 60_000,
    fireWindowMs: 30_000, maxAttempts: 3, mcapCeiling: null,
    autoDisableAfterFire: false, dryRun: false, ...over,
  };
}

const tweet: NormalizedTweet = {
  tweetId: 't1', rootTweetId: null, handle: 'elon', interaction: 'tweet',
  text: 'doge to the moon', createdAt: NOW, firstSeenAt: NOW,
};

async function harness(opts: { outcomeFor?: () => SendOutcome; walletCap?: number } = {}) {
  const store = new InMemorySniperStore();
  await store.putWallet(U, {
    walletId: 'w1', label: 'main', venue: 'slotshark',
    address: 'So11111111111111111111111111111111111111112',
    chain: 'sol', unit: 'SOL',
    perFireCap: opts.walletCap ?? 1000, dailyCap: 1000, maxOpen: 50,
  });
  return {
    store,
    ledger: new IdempotencyLedger(),
    registry: new ExecutorRegistry(new DryRunExecutor(opts.outcomeFor ? { outcomeFor: opts.outcomeFor } : {})),
    clock: () => NOW,
  };
}

describe('regression: rule.perFireCap is actually enforced', () => {
  it('aborts a leg exceeding the RULE cap even when the wallet budget would allow it', async () => {
    // Wallet cap is generous (1000); the rule cap is the binding one.
    const deps = await harness({ walletCap: 1000 });
    const r = rule({ sizeTotal: 10, perFireCap: 2, perTriggerCap: 1000 });
    await deps.store.putRule(U, r);
    const res = await executeFire(r, tweet, deps);
    expect(res.legs[0].state).toBe('aborted');
    expect(res.legs[0].reason).toBe('per_fire_cap');
    // Nothing was spent.
    expect((await deps.store.budgetSnapshot(U, 'w1', 'sol', DAY))?.spentToday ?? 0).toBe(0);
  });
});

describe('regression: an executor that THROWS must not leak a reservation', () => {
  it('records unknown and holds the reservation instead of escaping', async () => {
    const deps = await harness({
      outcomeFor: () => { throw new Error('kaboom'); },
    });
    const r = rule();
    await deps.store.putRule(U, r);
    // Must not reject.
    const res = await executeFire(r, tweet, deps);
    expect(res.legs[0].state).toBe('unknown');
    // Reservation intentionally held — the send may have landed.
    expect((await deps.store.budgetSnapshot(U, 'w1', 'sol', DAY))!.openPositions).toBe(1);
    // And the fire is recorded, so a reconciler has something to work from.
    expect((await deps.store.fireLog(U)).some((f) => f.state === 'unknown')).toBe(true);
  });
});

describe('regression: idempotency claim happens BEFORE any send', () => {
  it('a throwing executor still consumes the trigger claim', async () => {
    const deps = await harness({ outcomeFor: () => { throw new Error('kaboom'); } });
    const r = rule();
    await deps.store.putRule(U, r);
    await executeFire(r, tweet, deps);
    // Second delivery of the same trigger must be suppressed even though the
    // first one never completed a send. If the claim were taken after the send
    // loop, this would fire a second time.
    const second = await executeFire(r, tweet, deps);
    expect(second.outcome).toBe('suppressed');
  });
});

describe('regression: dry-run switch must not fail open', () => {
  const ORIGINAL = { ...process.env };
  beforeEach(() => { delete process.env.OCT_SNIPER_DRY_RUN; });
  afterEach(() => { process.env = { ...ORIGINAL }; });

  it.each(['1', 'true', 'TRUE', 'yes', 'on', ' true '])('treats %j as dry run', (v) => {
    process.env.OCT_SNIPER_DRY_RUN = v;
    expect(processDryRun()).toBe(true);
  });

  it.each(['0', 'false', '', 'no'])('treats %j as live', (v) => {
    process.env.OCT_SNIPER_DRY_RUN = v;
    expect(processDryRun()).toBe(false);
  });

  it('is live when unset', () => {
    expect(processDryRun()).toBe(false);
  });
});

describe('regression: slippage units', () => {
  // Slotshark's `slippage` is PERCENT. Confirmed on the wire from their own
  // dashboard: the field is labelled "SLIPPAGE (%)" and saving 50 sends
  // `"slippage": 50`. Their /sell range of 1-100 corroborates it — as basis
  // points that would cap a sell at 1% tolerance.
  //
  // These tests previously asserted the OPPOSITE (that bps passed through
  // verbatim was correct), which is why the bug survived a review: the suite
  // agreed with it. The default rule slippage is 500bps, so every fire was
  // being sent as 500 -> read as 500% -> no slippage protection whatsoever.
  it('converts basis points to percent', () => {
    expect(toVenueSlippagePercent(500)).toBe(5); // the 5% default, not 500
    expect(toVenueSlippagePercent(2_000)).toBe(20);
    expect(toVenueSlippagePercent(10_000)).toBe(100);
  });

  it('keeps sub-1% rules tight instead of rounding up to the venue minimum', () => {
    // Their documented minimum is 1. Rounding 0.3% up to 1% would loosen a
    // deliberately tight rule — the precise failure this regression is about.
    // If they reject the fraction the fire fails and no money moves.
    expect(toVenueSlippagePercent(30)).toBeCloseTo(0.3, 10);
    expect(toVenueSlippagePercent(1)).toBeCloseTo(0.01, 10);
  });

  it('fails closed on corrupt input rather than opening up', () => {
    expect(toVenueSlippagePercent(0)).toBe(0.01);
    expect(toVenueSlippagePercent(-5)).toBe(0.01);
    expect(toVenueSlippagePercent(Number.NaN)).toBe(0.01);
  });

  it('never sends a tolerance above 100%', () => {
    // Above 100% is not a tolerance, it is the absence of one. Their /buy
    // accepts up to 10000; we deliberately do not expose that.
    expect(toVenueSlippagePercent(99_999)).toBe(100);
  });
});

describe('regression: ladder weights are validated', () => {
  it('accepts a normalized split', () => {
    expect(validateLadderSplit([0.5, 0.5])).toEqual({ ok: true });
    expect(validateLadderSplit([0.2, 0.2, 0.2, 0.2, 0.2])).toEqual({ ok: true });
  });

  it('rejects weights that do not sum to 1 (a cap bypass)', () => {
    expect(validateLadderSplit([0.8, 0.8])).toEqual({ ok: false, reason: 'not_normalized' });
  });

  it('rejects negative, zero and non-finite weights', () => {
    expect(validateLadderSplit([-1, 2])).toEqual({ ok: false, reason: 'negative' });
    expect(validateLadderSplit([0, 1])).toEqual({ ok: false, reason: 'negative' });
  });

  it('rejects an empty split and an over-long one', () => {
    expect(validateLadderSplit([])).toEqual({ ok: false, reason: 'empty' });
    expect(validateLadderSplit(null)).toEqual({ ok: false, reason: 'empty' });
    expect(validateLadderSplit(new Array(50).fill(0.02))).toEqual({ ok: false, reason: 'too_many' });
  });

  it('an invalid split collapses to one full-size leg, never scales total spend', () => {
    const r = rule({ entryStyle: 'ladder', ladderSplit: [0.8, 0.8], sizeTotal: 10 });
    const legs = computeLegs(r);
    expect(legs).toHaveLength(1);
    expect(legs[0].amount).toBe(10); // not 8 + 8 = 16
  });
});
