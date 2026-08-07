// One case per rejection reason in the frozen `validateRule` vocabulary. The
// console renders these strings directly, so a reason that changes spelling
// changes what an operator is told about why their rule will not arm.

import { describe, it, expect } from 'vitest';
import { validateRule, validateRuleStructure } from '../src/sniper/validateRule';
import type { SnipeRule, WalletConfig } from '../src/sniper/types';

const ADDRESS = 'So11111111111111111111111111111111111111112';

function wallet(over: Partial<WalletConfig> = {}): WalletConfig {
  return {
    walletId: 'w1', label: 'main', venue: 'slotshark', address: ADDRESS,
    chain: 'sol', unit: 'SOL', perFireCap: 5, dailyCap: 100, maxOpen: 5, ...over,
  };
}

function rule(over: Partial<SnipeRule> = {}): SnipeRule {
  return {
    id: 'r1', userId: 'u1', name: 't', state: 'draft', chain: 'sol', venue: 'slotshark',
    handles: ['elon'], interactionTypes: ['tweet'],
    matcher: { op: 'leaf', pattern: { pattern: 'doge', matchMode: 'includes' } },
    phase: 1, mint: 'MINT1', entryStyle: 'single', ladderSplit: null,
    sizeUnit: 'SOL', sizeTotal: 1, walletIds: ['w1'], perFireCap: 5, perTriggerCap: 100,
    slippageBps: 500, exec: { kind: 'sol', antimev: true }, maxTweetAgeMs: 60_000,
    fireWindowMs: 30_000, maxAttempts: 3, mcapCeiling: null, autoDisableAfterFire: true,
    dryRun: true, ...over,
  };
}

const reasonOf = (r: ReturnType<typeof validateRule>) => (r.ok ? null : r.reason);

describe('validateRule — accepts a well-formed rule', () => {
  it('passes both halves', () => {
    expect(validateRuleStructure(rule())).toEqual({ ok: true });
    expect(validateRule(rule(), [wallet()])).toEqual({ ok: true });
  });
});

describe('validateRuleStructure — the half that runs on create and patch', () => {
  it('rejects phase 2, which has no resolver', () => {
    expect(reasonOf(validateRuleStructure(rule({ phase: 2 })))).toBe('phase_unsupported');
  });

  // The bug this guards: a phase-1 rule with no mint sits ARMED and INERT.
  // executeFire aborts it with `no_mint` on every trigger, so it looks healthy
  // in the rules table and fires nothing, forever.
  it('rejects a phase-1 rule with no mint', () => {
    expect(reasonOf(validateRuleStructure(rule({ mint: null })))).toBe('no_mint');
    expect(reasonOf(validateRuleStructure(rule({ mint: '   ' })))).toBe('no_mint');
  });

  // The bug this guards: without this, a bsc/slotshark rule only fails inside
  // ExecutorRegistry.resolve — i.e. in the fire path, not at configuration time.
  it('rejects slotshark on a non-solana chain', () => {
    expect(reasonOf(validateRuleStructure(rule({ chain: 'bsc' })))).toBe('venue_chain_mismatch');
  });

  // The bug this guards: a sol rule carrying EvmExecParams loses tip and
  // priorityFee from estimateFees, which makes the daily cap soft by exactly
  // those amounts — silently.
  it('rejects exec params whose kind disagrees with the chain', () => {
    expect(reasonOf(validateRuleStructure(rule({ exec: { kind: 'evm', mevRelay: null } })))).toBe('exec_kind_mismatch');
  });

  it('rejects slippage outside 1-10000 bps', () => {
    expect(reasonOf(validateRuleStructure(rule({ slippageBps: 0 })))).toBe('slippage_out_of_range');
    expect(reasonOf(validateRuleStructure(rule({ slippageBps: 10_001 })))).toBe('slippage_out_of_range');
  });

  // The bug these guard: `validateRuleStructure` claimed every check mirrored a
  // DB CHECK constraint and four did not exist here at all, so local mode
  // PERSISTED what hosted rejected — and hosted rejected it as a 500 carrying
  // raw Postgres error text (router.ts rule_create_failed) rather than as a
  // reason the console can render.
  //
  // maxAttempts is the one with money attached: runLeg's retry loop is bounded
  // by it and by fireWindowMs alone, so maxAttempts:5000 inside a one-hour
  // window retries a dead send five thousand times, holding the request open and
  // hammering the venue.
  it('rejects maxAttempts outside 1-10, mirroring the DB CHECK', () => {
    expect(reasonOf(validateRuleStructure(rule({ maxAttempts: 5000 })))).toBe('max_attempts_out_of_range');
    expect(reasonOf(validateRuleStructure(rule({ maxAttempts: 11 })))).toBe('max_attempts_out_of_range');
    expect(reasonOf(validateRuleStructure(rule({ maxAttempts: 0 })))).toBe('max_attempts_out_of_range');
    // `max_attempts integer` — a fractional value is not an int4 either.
    expect(reasonOf(validateRuleStructure(rule({ maxAttempts: 2.5 })))).toBe('max_attempts_out_of_range');
    expect(validateRuleStructure(rule({ maxAttempts: 10 }))).toEqual({ ok: true });
  });

  it('rejects a non-positive fire window', () => {
    expect(reasonOf(validateRuleStructure(rule({ fireWindowMs: 0 })))).toBe('fire_window_out_of_range');
    expect(reasonOf(validateRuleStructure(rule({ fireWindowMs: -1 })))).toBe('fire_window_out_of_range');
    // Past int4, which the `integer` column cannot hold.
    expect(reasonOf(validateRuleStructure(rule({ fireWindowMs: 3_000_000_000 })))).toBe('fire_window_out_of_range');
  });

  it('rejects a non-positive max tweet age', () => {
    expect(reasonOf(validateRuleStructure(rule({ maxTweetAgeMs: 0 })))).toBe('max_tweet_age_out_of_range');
    expect(reasonOf(validateRuleStructure(rule({ maxTweetAgeMs: -5 })))).toBe('max_tweet_age_out_of_range');
  });

  // Null means "no ceiling" and must stay legal; zero or negative would abort
  // every leg the moment any market cap is pushed.
  it('rejects a non-positive mcap ceiling but keeps null legal', () => {
    expect(reasonOf(validateRuleStructure(rule({ mcapCeiling: 0 })))).toBe('mcap_ceiling_out_of_range');
    expect(reasonOf(validateRuleStructure(rule({ mcapCeiling: -1 })))).toBe('mcap_ceiling_out_of_range');
    expect(validateRuleStructure(rule({ mcapCeiling: null }))).toEqual({ ok: true });
    expect(validateRuleStructure(rule({ mcapCeiling: 5_000_000 }))).toEqual({ ok: true });
  });

  // The bug this guards: a trigger cap below the fire cap makes the fire cap
  // unreachable. It is always a typo and never an intent, and a rule carrying it
  // aborts every trigger at step 2.
  it('rejects caps that contradict each other', () => {
    expect(reasonOf(validateRuleStructure(rule({ perFireCap: 10, perTriggerCap: 5 })))).toBe('caps_inconsistent');
    expect(reasonOf(validateRuleStructure(rule({ sizeTotal: 0 })))).toBe('caps_inconsistent');
    expect(reasonOf(validateRuleStructure(rule({ perFireCap: 0 })))).toBe('caps_inconsistent');
  });

  it('maps every ladder-split failure to its own reason', () => {
    const ladder = (split: number[] | null) => rule({ entryStyle: 'ladder', ladderSplit: split });
    expect(reasonOf(validateRuleStructure(ladder(null)))).toBe('ladder_split_empty');
    expect(reasonOf(validateRuleStructure(ladder([])))).toBe('ladder_split_empty');
    expect(reasonOf(validateRuleStructure(ladder([-1, 2])))).toBe('ladder_split_negative');
    expect(reasonOf(validateRuleStructure(ladder([0.8, 0.8])))).toBe('ladder_split_not_normalized');
    expect(reasonOf(validateRuleStructure(ladder(new Array(50).fill(0.02))))).toBe('ladder_split_too_many');
  });

  it('rejects a matcher tree past the depth and node caps', () => {
    let deep: SnipeRule['matcher'] = { op: 'leaf', pattern: { pattern: 'x', matchMode: 'includes' } };
    for (let i = 0; i < 12; i++) deep = { op: 'not', child: deep };
    expect(reasonOf(validateRuleStructure(rule({ matcher: deep })))).toBe('matcher_too_deep');

    const wide = {
      op: 'or' as const,
      children: new Array(80).fill(null).map(() => ({
        op: 'leaf' as const,
        pattern: { pattern: 'x', matchMode: 'includes' as const },
      })),
    };
    expect(reasonOf(validateRuleStructure(rule({ matcher: wide })))).toBe('matcher_too_many_nodes');
  });

  // The bug this guards: an invalid regex leaf throws inside matchKeywords at
  // EVALUATION time, i.e. mid-fire. Rejecting it at arm time keeps a broken
  // pattern out of storage entirely.
  it('rejects a regex leaf that fails the linear-safety heuristic', () => {
    const withPattern = (pattern: string) =>
      rule({ matcher: { op: 'leaf', pattern: { pattern, matchMode: 'regex' } } });
    expect(reasonOf(validateRuleStructure(withPattern('(')))).toBe('matcher_regex_invalid');
    expect(reasonOf(validateRuleStructure(withPattern('(a+)+b')))).toBe('matcher_regex_invalid');
    // A non-regex leaf carrying the same text is fine — the guard is scoped to
    // leaves that will actually be compiled.
    expect(validateRuleStructure(rule({ matcher: { op: 'leaf', pattern: { pattern: '(a+)+b', matchMode: 'includes' } } })))
      .toEqual({ ok: true });
  });
});

describe('validateRule — the arm-time half that needs wallet rows', () => {
  it('rejects a rule with no wallets', () => {
    expect(reasonOf(validateRule(rule({ walletIds: [] }), [wallet()]))).toBe('no_wallets');
  });

  it('rejects a walletId with no row', () => {
    const res = validateRule(rule({ walletIds: ['ghost'] }), [wallet()]);
    expect(reasonOf(res)).toBe('unknown_wallet');
    expect(res.ok === false && res.detail).toBe('ghost');
  });

  // The bug this guards: caps are denominated in native units precisely to keep
  // a price oracle out of the hot path. A SOL-sized rule spending from a USDC
  // wallet makes the reservation compare 5 SOL against a 1000-USDC cap.
  it('rejects a wallet whose unit differs from the rule size unit', () => {
    expect(reasonOf(validateRule(rule(), [wallet({ unit: 'USDC' })]))).toBe('unit_mismatch');
  });

  it('rejects a wallet on a different chain', () => {
    expect(reasonOf(validateRule(rule(), [wallet({ chain: 'bsc' })]))).toBe('wallet_chain_mismatch');
  });

  // The bug this guards: sizeTotal is spend PER WALLET, so a 2-wallet rule
  // spends 2x sizeTotal. A rule whose own legs cannot clear its own trigger cap
  // aborts at executeFire step 2 on EVERY trigger and must not sit armed.
  it('rejects a rule whose legs can never clear its own per-trigger cap', () => {
    const r = rule({ walletIds: ['w1', 'w2'], sizeTotal: 3, perFireCap: 4, perTriggerCap: 5 });
    expect(reasonOf(validateRule(r, [wallet(), wallet({ walletId: 'w2' })]))).toBe('size_over_trigger_cap');
  });

  it('accounts for fees when checking the trigger total', () => {
    // 2 wallets x 1 SOL + 0.5% each = 2.01. A cap of exactly 2 must refuse.
    const wallets = [wallet(), wallet({ walletId: 'w2' })];
    const tight = rule({ walletIds: ['w1', 'w2'], sizeTotal: 1, perFireCap: 2, perTriggerCap: 2 });
    expect(reasonOf(validateRule(tight, wallets))).toBe('size_over_trigger_cap');
    const roomy = rule({ walletIds: ['w1', 'w2'], sizeTotal: 1, perFireCap: 2, perTriggerCap: 2.5 });
    expect(validateRule(roomy, wallets)).toEqual({ ok: true });
  });
});
