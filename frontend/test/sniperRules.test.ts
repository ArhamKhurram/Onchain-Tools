import { describe, it, expect } from 'vitest';
import {
  computeLegsPreview,
  describeAbortReason,
  estimateFeesPreview,
  isSolAddress,
  parseLadderSplit,
  triggerTotalPreview,
  validateLadderSplit,
  type FeeShape,
  type LegShape,
} from '../src/types/sniper';

// These helpers mirror backend/src/sniper/{legs,fees}.ts. The point of testing
// them is that the rule form must warn about exactly what the server rejects at
// arm time — a preview that disagrees with the backend is worse than no preview,
// because it tells an operator a number they will then authorise.

const legShape = (over: Partial<LegShape> = {}): LegShape => ({
  entryStyle: 'single',
  ladderSplit: null,
  sizeTotal: 1,
  walletIds: ['w1'],
  ...over,
});

const feeShape = (over: Partial<FeeShape> = {}): FeeShape => ({
  venue: 'slotshark',
  exec: { kind: 'sol', antimev: true },
  ...over,
});

describe('isSolAddress', () => {
  const VALID = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

  it('accepts a base58 pubkey', () => {
    expect(isSolAddress(VALID)).toBe(true);
  });

  it('returns the same answer on repeated calls with the same address', () => {
    // The bug this guards: SOL_ADDRESS_REGEX in @oct/shared carries the /g flag,
    // and .test() on a /g regex is stateful through lastIndex — alternate calls
    // on the same valid address return false. Reusing it here would reject every
    // second wallet an operator pasted, with no explanation.
    expect(isSolAddress(VALID)).toBe(true);
    expect(isSolAddress(VALID)).toBe(true);
    expect(isSolAddress(VALID)).toBe(true);
  });

  it('rejects base58-ambiguous characters and out-of-range lengths', () => {
    expect(isSolAddress('0OIl' + VALID.slice(4))).toBe(false);
    expect(isSolAddress('abc')).toBe(false);
    expect(isSolAddress('')).toBe(false);
  });

  it('rejects an address with anything appended', () => {
    // Anchoring matters: an unanchored match would accept a pasted address with
    // a trailing fragment and send funds to a truncated key.
    expect(isSolAddress(`${VALID}!!`)).toBe(false);
  });
});

describe('parseLadderSplit', () => {
  it('parses a comma or whitespace separated list', () => {
    expect(parseLadderSplit('0.5, 0.3, 0.2')).toEqual([0.5, 0.3, 0.2]);
    expect(parseLadderSplit('0.5 0.5')).toEqual([0.5, 0.5]);
  });

  it('returns null for empty or non-numeric input', () => {
    expect(parseLadderSplit('   ')).toBeNull();
    expect(parseLadderSplit('half, half')).toBeNull();
  });
});

describe('validateLadderSplit', () => {
  it('accepts weights summing to 1 within float tolerance', () => {
    expect(validateLadderSplit([0.2, 0.2, 0.2, 0.2, 0.2])).toEqual({ ok: true });
  });

  it('rejects weights that do not sum to 1', () => {
    // The bug this guards: a tolerance loose enough to accept 1.5 would spend
    // 50% over sizeTotal on every trigger, silently.
    expect(validateLadderSplit([0.5, 1.0])).toEqual({ ok: false, reason: 'not_normalized' });
  });

  it('rejects empty, negative and over-long splits', () => {
    expect(validateLadderSplit(null)).toEqual({ ok: false, reason: 'empty' });
    expect(validateLadderSplit([])).toEqual({ ok: false, reason: 'empty' });
    expect(validateLadderSplit([1.5, -0.5])).toEqual({ ok: false, reason: 'negative' });
    expect(validateLadderSplit(Array.from({ length: 11 }, () => 1 / 11))).toEqual({ ok: false, reason: 'too_many' });
  });
});

describe('computeLegsPreview', () => {
  it('emits one full-size leg per wallet for a single entry', () => {
    const legs = computeLegsPreview(legShape({ walletIds: ['w1', 'w2'], sizeTotal: 2 }));
    expect(legs).toEqual([
      { walletId: 'w1', legNo: 0, amount: 2 },
      { walletId: 'w2', legNo: 0, amount: 2 },
    ]);
  });

  it('splits sizeTotal across ladder steps, per wallet', () => {
    const legs = computeLegsPreview(
      legShape({ entryStyle: 'ladder', ladderSplit: [0.5, 0.5], sizeTotal: 2, walletIds: ['w1', 'w2'] }),
    );
    expect(legs).toHaveLength(4);
    expect(legs.every((l) => l.amount === 1)).toBe(true);
  });

  it('collapses an INVALID ladder split to one full-size leg rather than scaling down', () => {
    // The bug this guards: an invalid split does not scale spend down
    // (backend legs.ts:30-35) — it falls back to a single leg of the whole
    // sizeTotal. A preview that instead divided by split.length would under-report
    // the true spend by a factor of split.length.
    const legs = computeLegsPreview(
      legShape({ entryStyle: 'ladder', ladderSplit: [0.5, 0.9], sizeTotal: 4, walletIds: ['w1'] }),
    );
    expect(legs).toEqual([{ walletId: 'w1', legNo: 0, amount: 4 }]);
  });
});

describe('estimateFeesPreview', () => {
  it('charges the venue rate', () => {
    expect(estimateFeesPreview(feeShape(), 10)).toBeCloseTo(0.05, 12);
  });

  it('adds the Solana tip and priority fee', () => {
    // The bug this guards: tip and priorityFee are part of what the reservation
    // debits. Leaving them out of the preview makes the daily cap look softer
    // than it is by exactly those amounts.
    const fees = estimateFeesPreview(feeShape({ exec: { kind: 'sol', tip: 0.01, priorityFee: 0.002, antimev: true } }), 10);
    expect(fees).toBeCloseTo(0.05 + 0.01 + 0.002, 12);
  });
});

describe('triggerTotalPreview', () => {
  it('multiplies by wallet count, because sizeTotal is spend PER WALLET', () => {
    // The bug this guards: sizeTotal is per wallet, so a 2-wallet rule spends 2x
    // sizeTotal. A preview reporting sizeTotal alone lets an operator approve
    // half the true spend in the fire modal.
    const rule = { ...legShape({ sizeTotal: 1, walletIds: ['w1', 'w2'] }), ...feeShape() };
    expect(triggerTotalPreview(rule)).toBeCloseTo(2 * (1 + 0.005), 12);
  });

  it('includes fees on every leg of a ladder', () => {
    const rule = {
      ...legShape({ entryStyle: 'ladder', ladderSplit: [0.5, 0.5], sizeTotal: 2, walletIds: ['w1'] }),
      ...feeShape({ exec: { kind: 'sol', tip: 0.01, antimev: true } }),
    };
    // Two legs of 1, each carrying its own 0.5% plus its own tip.
    expect(triggerTotalPreview(rule)).toBeCloseTo(2 * (1 + 0.005 + 0.01), 12);
  });

  it('is zero when no wallets are selected', () => {
    expect(triggerTotalPreview({ ...legShape({ walletIds: [] }), ...feeShape() })).toBe(0);
  });
});

describe('describeAbortReason', () => {
  it('spells out the refusal vocabulary in plain words', () => {
    expect(describeAbortReason('daily_cap')).toMatch(/daily/i);
    expect(describeAbortReason('kill_switch')).toMatch(/kill switch/i);
  });

  it('falls through to the raw reason rather than a generic message', () => {
    // The bug this guards: mapping an unknown reason to "something went wrong"
    // destroys the one string an operator could search the docs for. A money log
    // must stay greppable even when the UI has not caught up with the backend.
    expect(describeAbortReason('some_future_reason')).toBe('some_future_reason');
  });
});
