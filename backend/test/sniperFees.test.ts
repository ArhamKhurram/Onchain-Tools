// Account-level fee settings: resolution precedence, backwards compatibility,
// and the invalid-value cases.
//
// These are the tests that make the caps real. `estimateFees` is what turns a
// leg amount into the number the reservation debits, so every case here is a
// case where getting it wrong makes a daily cap soft (under-reserving) or turns
// it off entirely (a NaN, against which every `>` comparison is false).

import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_FEE_SETTINGS,
  MAX_FEE_COMPONENT,
  estimateFees,
  isValidFeeComponent,
  normalizeFeeSettings,
  resolveExecFees,
} from '../src/sniper/fees.js';
import { InMemorySniperStore } from '../src/sniper/store.js';
import { executeFire } from '../src/sniper/executeFire.js';
import { ExecutorRegistry } from '../src/sniper/executors/registry.js';
import { DryRunExecutor } from '../src/sniper/executors/dryRun.js';
import { IdempotencyLedger } from '../src/sniper/idempotency.js';
import { validateRule } from '../src/sniper/validateRule.js';
import type {
  ExecParams,
  NormalizedTweet,
  SnipeRule,
  SniperFeeSettings,
  WalletConfig,
} from '../src/sniper/types.js';

const RATE = 0.005;

function rule(over: Partial<SnipeRule> = {}): SnipeRule {
  return {
    id: 'r1',
    userId: 'u1',
    name: 'r',
    state: 'armed',
    chain: 'sol',
    venue: 'slotshark',
    handles: ['elon'],
    interactionTypes: ['tweet'],
    matcher: { op: 'leaf', pattern: { pattern: 'doge', matchMode: 'includes' } },
    phase: 1,
    mint: 'MINT1',
    entryStyle: 'single',
    ladderSplit: null,
    sizeUnit: 'SOL',
    sizeTotal: 1,
    walletIds: ['w1'],
    perFireCap: 2,
    perTriggerCap: 10,
    slippageBps: 500,
    exec: { kind: 'sol', antimev: true },
    maxTweetAgeMs: 60_000,
    fireWindowMs: 30_000,
    maxAttempts: 3,
    mcapCeiling: null,
    autoDisableAfterFire: false,
    dryRun: true,
    ...over,
  };
}

function wallet(over: Partial<WalletConfig> = {}): WalletConfig {
  return {
    walletId: 'w1',
    label: 'main',
    venue: 'slotshark',
    address: 'So11111111111111111111111111111111111111112',
    chain: 'sol',
    unit: 'SOL',
    perFireCap: 2,
    dailyCap: 10,
    maxOpen: 5,
    ...over,
  };
}

const fees = (tip: number, priorityFee: number): SniperFeeSettings => ({ tip, priorityFee });

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------

describe('fee resolution precedence', () => {
  it('inherits the global when the rule sets neither component', () => {
    // The whole point of the setting: configure once, every rule bids it.
    expect(resolveExecFees(rule(), fees(0.01, 0.002))).toEqual({ tip: 0.01, priorityFee: 0.002 });
    expect(estimateFees(rule(), 10, fees(0.01, 0.002))).toBeCloseTo(10 * RATE + 0.012, 12);
  });

  it('lets an EXPLICIT rule value win over the global, per component', () => {
    const r = rule({ exec: { kind: 'sol', tip: 0.05, antimev: true } });
    // tip is overridden; priorityFee was never set on the rule, so it still
    // inherits. Precedence is per component, not all-or-nothing.
    expect(resolveExecFees(r, fees(0.01, 0.002))).toEqual({ tip: 0.05, priorityFee: 0.002 });
  });

  it('treats an explicit ZERO as an override, not as "unset"', () => {
    // The distinction that makes the feature usable: an operator who has
    // deliberately zeroed a rule's tip must not have the global put back.
    const r = rule({ exec: { kind: 'sol', tip: 0, priorityFee: 0, antimev: true } });
    expect(resolveExecFees(r, fees(0.01, 0.002))).toEqual({ tip: 0, priorityFee: 0 });
    expect(estimateFees(r, 10, fees(0.01, 0.002))).toBeCloseTo(10 * RATE, 12);
  });

  it('never leaks the Solana global into an EVM rule', () => {
    // The global is denominated in SOL; an EVM rule prices gas in wei on a
    // different asset, so inheriting would add SOL to a BNB budget.
    const r = rule({ chain: 'bsc', exec: { kind: 'evm' } as ExecParams });
    expect(resolveExecFees(r, fees(0.01, 0.002))).toEqual({ tip: 0, priorityFee: 0 });
  });
});

// ---------------------------------------------------------------------------
// Backwards compatibility
// ---------------------------------------------------------------------------

describe('backwards compatibility', () => {
  it('reproduces the pre-global arithmetic exactly on a default account', () => {
    // An install that never touches the setting must reserve what it always
    // reserved. DEFAULT_FEE_SETTINGS is zero on both components for this.
    expect(DEFAULT_FEE_SETTINGS).toEqual({ tip: 0, priorityFee: 0 });
    expect(estimateFees(rule(), 10, DEFAULT_FEE_SETTINGS)).toBeCloseTo(10 * RATE, 12);
    const withTip = rule({ exec: { kind: 'sol', tip: 0.01, priorityFee: 0.002, antimev: true } });
    expect(estimateFees(withTip, 10, DEFAULT_FEE_SETTINGS)).toBeCloseTo(10 * RATE + 0.012, 12);
  });

  it('does not change an existing rule that already carries its own fees', () => {
    // The migration rewrites no rule row. A rule with explicit exec fees keeps
    // spending exactly what it spent, whatever the operator later sets globally.
    const existing = rule({ exec: { kind: 'sol', tip: 0.01, priorityFee: 0.002, antimev: true } });
    const before = estimateFees(existing, 10, DEFAULT_FEE_SETTINGS);
    const after = estimateFees(existing, 10, fees(0.5, 0.5));
    expect(after).toBe(before);
  });

  it('a store row written before this feature reads as the default', async () => {
    const store = new InMemorySniperStore();
    expect(await store.getFeeSettings('never-set')).toEqual(DEFAULT_FEE_SETTINGS);
  });
});

// ---------------------------------------------------------------------------
// Invalid values — the cases that would DISABLE cap accounting
// ---------------------------------------------------------------------------

describe('invalid fee values', () => {
  const bad = [NaN, Infinity, -Infinity, -1, -0.0001, MAX_FEE_COMPONENT + 1];

  it.each(bad)('normalizes %p to zero rather than propagating it', (v) => {
    const n = normalizeFeeSettings({ tip: v, priorityFee: v });
    expect(n).toEqual({ tip: 0, priorityFee: 0 });
  });

  it.each([undefined, null, {}, [], 'abc', true])('normalizes non-numeric %p to zero', (v) => {
    const n = normalizeFeeSettings({ tip: v, priorityFee: v });
    expect(Number.isFinite(n.tip)).toBe(true);
    expect(n.tip).toBe(0);
    expect(n.priorityFee).toBe(0);
  });

  it('normalizes a missing settings object entirely', () => {
    expect(normalizeFeeSettings(undefined)).toEqual(DEFAULT_FEE_SETTINGS);
    expect(normalizeFeeSettings(null)).toEqual(DEFAULT_FEE_SETTINGS);
  });

  it('coerces the numeric-as-string a Postgres numeric column returns', () => {
    expect(normalizeFeeSettings({ tip: '0.01', priorityFee: '0.002' })).toEqual({
      tip: 0.01,
      priorityFee: 0.002,
    });
  });

  it.each(bad)('never lets a bad GLOBAL (%p) produce NaN or a negative fee', (v) => {
    const fee = estimateFees(rule(), 10, { tip: v, priorityFee: 0 } as SniperFeeSettings);
    expect(Number.isFinite(fee)).toBe(true);
    expect(fee).toBeGreaterThanOrEqual(0);
    // And specifically: the venue rate is still charged. A bad global must not
    // wipe out the fee entirely, only its own component.
    expect(fee).toBeCloseTo(10 * RATE, 12);
  });

  it.each(bad)('never lets a bad RULE OVERRIDE (%p) produce NaN or a negative fee', (v) => {
    const r = rule({ exec: { kind: 'sol', tip: v, antimev: true } });
    const fee = estimateFees(r, 10, fees(0.01, 0));
    expect(Number.isFinite(fee)).toBe(true);
    expect(fee).toBeGreaterThanOrEqual(10 * RATE);
  });

  it('bounds what counts as a storable component', () => {
    expect(isValidFeeComponent(0)).toBe(true);
    expect(isValidFeeComponent(MAX_FEE_COMPONENT)).toBe(true);
    expect(isValidFeeComponent(-0.1)).toBe(false);
    expect(isValidFeeComponent(NaN)).toBe(false);
    expect(isValidFeeComponent('0.1')).toBe(false);
  });

  it('a NaN amountWithFees would turn caps OFF — the reason all of the above matters', () => {
    // Documentation-as-test: NaN fails every comparison, so an un-normalized
    // fee does not raise the cap, it removes it.
    expect(NaN > 1).toBe(false);
    expect(NaN + 1 > 1).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Store round trip
// ---------------------------------------------------------------------------

describe('SniperStore fee settings', () => {
  let store: InMemorySniperStore;
  beforeEach(() => {
    store = new InMemorySniperStore();
  });

  it('round-trips per user and never bleeds across tenants', async () => {
    await store.setFeeSettings('u1', fees(0.01, 0.002));
    expect(await store.getFeeSettings('u1')).toEqual({ tip: 0.01, priorityFee: 0.002 });
    expect(await store.getFeeSettings('u2')).toEqual(DEFAULT_FEE_SETTINGS);
  });

  it('normalizes on write, so a bad value can never be read back', async () => {
    await store.setFeeSettings('u1', { tip: -5, priorityFee: NaN });
    expect(await store.getFeeSettings('u1')).toEqual(DEFAULT_FEE_SETTINGS);
  });

  it('survives the kill switch, which shares the same row', async () => {
    // The bug this guards: kill/resume rebuilding the state object and silently
    // resetting the operator's tip to zero — an under-reservation on every
    // subsequent fire.
    await store.setFeeSettings('u1', fees(0.01, 0.002));
    await store.setKillSwitch('u1', true, 'test');
    await store.setKillSwitch('u1', false, null);
    expect(await store.getFeeSettings('u1')).toEqual({ tip: 0.01, priorityFee: 0.002 });
  });

  it('preserves the kill switch when the fees are set', async () => {
    await store.setKillSwitch('u1', true, 'test');
    await store.setFeeSettings('u1', fees(0.01, 0));
    expect(await store.isKilled('u1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateRule
// ---------------------------------------------------------------------------

describe('validateRule with inherited fees', () => {
  it('refuses to arm a rule whose inherited fees push it past its own cap', () => {
    // Without this the rule arms and then aborts `per_trigger_cap` on every
    // fire — armed, inert and looking healthy.
    const r = rule({ sizeTotal: 1, perFireCap: 1.01, perTriggerCap: 1.01 });
    expect(validateRule(r, [wallet()], DEFAULT_FEE_SETTINGS)).toEqual({ ok: true });
    const res = validateRule(r, [wallet()], fees(0.5, 0));
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe('size_over_trigger_cap');
  });

  it.each([-1, NaN, Infinity, MAX_FEE_COMPONENT + 1])('rejects an out-of-range rule override %p', (v) => {
    const r = rule({ exec: { kind: 'sol', tip: v, antimev: true } });
    const res = validateRule(r, [wallet()], DEFAULT_FEE_SETTINGS);
    expect(res.ok === false && res.reason).toBe('exec_fee_out_of_range');
  });

  it('still accepts an unset (inheriting) override', () => {
    expect(validateRule(rule(), [wallet()], DEFAULT_FEE_SETTINGS)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// executeFire — the only function that spends
// ---------------------------------------------------------------------------

const tweet: NormalizedTweet = {
  tweetId: 't1',
  rootTweetId: null,
  handle: 'elon',
  interaction: 'tweet',
  text: 'doge',
  createdAt: 1,
  firstSeenAt: 1,
};

function deps(store: InMemorySniperStore) {
  return {
    store,
    ledger: new IdempotencyLedger(),
    registry: new ExecutorRegistry(new DryRunExecutor()),
    clock: () => 1_700_000_000_000,
  };
}

describe('executeFire and the global fees', () => {
  it('debits the leg amount PLUS the inherited global against the daily cap', async () => {
    const store = new InMemorySniperStore();
    // A dry-run fill releases its own reservation, so measure with a rule that
    // is refused by the RULE-level per-fire cap instead: the refusal reason is
    // itself the proof that the inherited fee reached amountWithFees.
    await store.putWallet('u1', wallet());
    const r = rule({ sizeTotal: 1, perFireCap: 1.006, dryRun: true });
    await store.putRule('u1', r);

    // 1 + 0.5% = 1.005, inside the 1.006 cap.
    const clean = await executeFire(r, tweet, deps(store));
    expect(clean.legs[0].state).toBe('filled');

    // Set a global tip of 0.01: the same leg is now 1.015 and must be refused.
    await store.setFeeSettings('u1', fees(0.01, 0));
    const refused = await executeFire(r, { ...tweet, tweetId: 't2', text: 'doge 2' }, deps(store));
    expect(refused.legs[0].state).toBe('aborted');
    expect(refused.legs[0].reason).toBe('per_fire_cap');
  });

  it('ABORTS rather than firing when the fee settings cannot be read', async () => {
    // Falling back to zero here would under-reserve every leg by the tip. The
    // safe direction on an unreadable control is always "do not spend".
    const store = new InMemorySniperStore();
    await store.putWallet('u1', wallet());
    const r = rule();
    await store.putRule('u1', r);
    store.getFeeSettings = async () => {
      throw new Error('supabase down');
    };
    const res = await executeFire(r, tweet, deps(store));
    expect(res.outcome).toBe('aborted');
    expect(res.reason).toBe('fee_settings_unavailable');
    expect(res.legs).toEqual([]);
  });
});
