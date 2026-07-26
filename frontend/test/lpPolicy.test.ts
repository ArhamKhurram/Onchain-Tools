import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import LpSegmentedField from '../src/components/lp/LpSegmentedField';
import {
  DEFAULT_POLICY_DRAFT,
  draftFromPolicy,
  draftToPayload,
  draftsEqual,
  issuesByField,
  parseFieldIssues,
  toNumber,
  validatePolicyDraft,
  validatePolicyPayload,
  type PolicyDraft,
} from '../src/components/lp/policyDraft';
import {
  evaluateVisibleCriteria,
  isActiveForAutomation,
  isInAllowlist,
  poolRowStatus,
  sortCandidates,
  summarizeAllowlist,
  toggleAllowlist,
} from '../src/components/lp/selection';
import {
  describeDailyCapacity,
  formatAprFraction,
  formatFeeTier,
  formatHours,
  formatMinutes,
  formatRatio,
  formatUsdCompact,
  formatUsdExact,
  poolPairLabel,
  shortAddress,
} from '../src/components/lp/format';
import { describeCompound, describeSwitching } from '../src/components/lp/explain';
import { ROBINHOOD_CHAIN_ID, type PoolCandidate } from '../src/components/lp/types';

const ADDR_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ADDR_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ADDR_C = '0xcccccccccccccccccccccccccccccccccccccccc';

const draft = (over: Partial<PolicyDraft> = {}): PolicyDraft => ({
  ...DEFAULT_POLICY_DRAFT,
  ...over,
});

const pool = (over: Partial<PoolCandidate> = {}): PoolCandidate => ({
  address: ADDR_A,
  chainId: ROBINHOOD_CHAIN_ID,
  platform: 'uniswapv3',
  feeTierBps: 3000,
  token0: { address: ADDR_B, symbol: 'WETH', decimals: 18 },
  token1: { address: ADDR_C, symbol: 'USDC', decimals: 6 },
  tvlUsd: 1_000_000,
  volume24hUsd: 400_000,
  feeApr: 0.42,
  ...over,
});

// --- Validation mirror ------------------------------------------------------

describe('validatePolicyDraft', () => {
  it('accepts the shipped defaults', () => {
    expect(validatePolicyDraft(DEFAULT_POLICY_DRAFT)).toEqual([]);
  });

  it('accepts the defaults even with an empty allowlist — idle is valid, not an error', () => {
    const issues = validatePolicyDraft(draft({ allowedPools: [] }));
    expect(issues.some((i) => i.field.startsWith('allowedPools'))).toBe(false);
  });

  it('rejects a blank field rather than reading it as zero', () => {
    const issues = issuesByField(validatePolicyDraft(draft({ maxPositionSizeUsd: '' })));
    expect(issues.maxPositionSizeUsd).toMatch(/finite number/);
  });

  it('rejects non-numeric junk', () => {
    const issues = issuesByField(validatePolicyDraft(draft({ dailySpendCapUsd: 'lots' })));
    expect(issues.dailySpendCapUsd).toMatch(/finite number/);
  });

  it('rejects a zero or negative position cap', () => {
    expect(issuesByField(validatePolicyDraft(draft({ maxPositionSizeUsd: '0' }))).maxPositionSizeUsd).toMatch(
      /greater than 0/,
    );
    expect(issuesByField(validatePolicyDraft(draft({ maxPositionSizeUsd: '-5' }))).maxPositionSizeUsd).toMatch(
      /greater than 0/,
    );
  });

  it('rejects a daily cap smaller than one position', () => {
    const issues = issuesByField(
      validatePolicyDraft(draft({ maxPositionSizeUsd: '500', dailySpendCapUsd: '250' })),
    );
    expect(issues.dailySpendCapUsd).toMatch(/at least maxPositionSizeUsd/);
  });

  it('allows a daily cap exactly equal to one position', () => {
    expect(validatePolicyDraft(draft({ maxPositionSizeUsd: '250', dailySpendCapUsd: '250' }))).toEqual([]);
  });

  it('enforces the hard floor of 1.0 on the fees-vs-gas ratio', () => {
    const issues = issuesByField(
      validatePolicyDraft(draft({ compoundTrigger: { minFeesVsGasRatio: '0.5', maxIntervalHours: '24' } })),
    );
    expect(issues['compoundTrigger.minFeesVsGasRatio']).toMatch(/at least 1/);
  });

  it('accepts exactly 1.0 for the fees-vs-gas ratio', () => {
    expect(
      validatePolicyDraft(draft({ compoundTrigger: { minFeesVsGasRatio: '1', maxIntervalHours: '6' } })),
    ).toEqual([]);
  });

  it('rejects a zero compound interval', () => {
    const issues = issuesByField(
      validatePolicyDraft(draft({ compoundTrigger: { minFeesVsGasRatio: '3', maxIntervalHours: '0' } })),
    );
    expect(issues['compoundTrigger.maxIntervalHours']).toMatch(/greater than 0/);
  });

  it('bounds the IL risk score to 0-100', () => {
    const over = issuesByField(
      validatePolicyDraft(
        draft({
          poolSelectionCriteria: { minTvlUsd: '250000', min24hVolumeUsd: '50000', maxIlRiskScore: '101' },
        }),
      ),
    );
    expect(over['poolSelectionCriteria.maxIlRiskScore']).toMatch(/at most 100/);
  });

  it('permits a zero switching delta but not a negative one', () => {
    expect(
      validatePolicyDraft(
        draft({ switchingBuffer: { minEfficiencyDeltaPercent: '0', sustainedDurationMinutes: '60' } }),
      ),
    ).toEqual([]);
    const negative = issuesByField(
      validatePolicyDraft(
        draft({ switchingBuffer: { minEfficiencyDeltaPercent: '-1', sustainedDurationMinutes: '60' } }),
      ),
    );
    expect(negative['switchingBuffer.minEfficiencyDeltaPercent']).toMatch(/at least 0/);
  });

  it('rejects a zero sustained duration — that would remove the buffer entirely', () => {
    const issues = issuesByField(
      validatePolicyDraft(
        draft({ switchingBuffer: { minEfficiencyDeltaPercent: '5', sustainedDurationMinutes: '0' } }),
      ),
    );
    expect(issues['switchingBuffer.sustainedDurationMinutes']).toMatch(/greater than 0/);
  });

  it('rejects a malformed pool address, pointing at its index', () => {
    const issues = issuesByField(validatePolicyDraft(draft({ allowedPools: [ADDR_A, '0xnope'] })));
    expect(issues['allowedPools[1]']).toMatch(/0x-prefixed/);
    expect(issues['allowedPools[0]']).toBeUndefined();
  });

  it('reports every problem in one pass rather than failing fast', () => {
    const issues = validatePolicyDraft(
      draft({
        maxPositionSizeUsd: '',
        dailySpendCapUsd: '',
        rebalanceTrigger: { rangeExitPercent: '0' },
      }),
    );
    expect(issues.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects an unsupported chain', () => {
    const payload = draftToPayload(DEFAULT_POLICY_DRAFT);
    const issues = issuesByField(
      validatePolicyPayload({ ...payload, chain: 'base' as unknown as 'robinhood' }),
    );
    expect(issues.chain).toMatch(/robinhood/);
  });

  it('accepts every valid range strategy', () => {
    for (const strategy of ['narrow', 'wide', 'full'] as const) {
      expect(
        validatePolicyDraft(draft({ rebalanceTrigger: { rangeExitPercent: '5', rangeStrategy: strategy } })),
      ).toEqual([]);
    }
  });

  it('rejects a range strategy outside the enum', () => {
    const payload = draftToPayload(DEFAULT_POLICY_DRAFT);
    const issues = issuesByField(
      validatePolicyPayload({
        ...payload,
        rebalanceTrigger: {
          rangeExitPercent: 5,
          rangeStrategy: 'sideways' as unknown as 'narrow',
        },
      }),
    );
    expect(issues['rebalanceTrigger.rangeStrategy']).toMatch(/narrow.*wide.*full/);
  });
});

// --- Range strategy ---------------------------------------------------------

describe('range strategy', () => {
  it('defaults to narrow', () => {
    expect(DEFAULT_POLICY_DRAFT.rebalanceTrigger.rangeStrategy).toBe('narrow');
  });

  it('round-trips through a policy in both directions', () => {
    const wide = draft({ rebalanceTrigger: { rangeExitPercent: '8', rangeStrategy: 'wide' } });
    const restored = draftFromPolicy({ ...draftToPayload(wide), version: 3 });
    expect(restored.rebalanceTrigger.rangeStrategy).toBe('wide');
    expect(draftToPayload(restored).rebalanceTrigger.rangeStrategy).toBe('wide');
  });

  it('coerces a missing or unknown stored strategy back to narrow', () => {
    const restored = draftFromPolicy({
      ...draftToPayload(DEFAULT_POLICY_DRAFT),
      version: 1,
      rebalanceTrigger: { rangeExitPercent: 5, rangeStrategy: 'ultrawide' as unknown as 'narrow' },
    });
    expect(restored.rebalanceTrigger.rangeStrategy).toBe('narrow');
  });

  it('a strategy change makes the draft unequal to its baseline', () => {
    expect(draftsEqual(DEFAULT_POLICY_DRAFT, draft({ rebalanceTrigger: { rangeExitPercent: '5', rangeStrategy: 'full' } }))).toBe(false);
  });
});

describe('LpSegmentedField', () => {
  const options = [
    { value: 'narrow', label: 'Narrow' },
    { value: 'wide', label: 'Wide' },
    { value: 'full', label: 'Full range' },
  ] as const;

  const render = (value: 'narrow' | 'wide' | 'full') =>
    renderToStaticMarkup(
      createElement(LpSegmentedField, {
        label: 'Range strategy',
        field: 'rebalanceTrigger.rangeStrategy',
        value,
        onChange: () => {},
        options,
        help: 'help text',
      }),
    );

  it('marks exactly the option matching the value as checked', () => {
    const html = render('wide');
    // aria-checked precedes data-value in the same <button> tag.
    expect(html).toMatch(/aria-checked="true"[^>]*data-value="wide"/);
    expect(html).toMatch(/aria-checked="false"[^>]*data-value="narrow"/);
    expect((html.match(/aria-checked="true"/g) ?? []).length).toBe(1);
  });

  it('moves the checked option when the value changes', () => {
    expect(render('narrow')).toMatch(/aria-checked="true"[^>]*data-value="narrow"/);
    expect(render('full')).toMatch(/aria-checked="true"[^>]*data-value="full"/);
  });
});

describe('toNumber', () => {
  it('turns blank and junk into NaN, never 0', () => {
    expect(Number.isNaN(toNumber(''))).toBe(true);
    expect(Number.isNaN(toNumber('   '))).toBe(true);
    expect(Number.isNaN(toNumber('abc'))).toBe(true);
    expect(Number.isNaN(toNumber('Infinity'))).toBe(true);
  });
  it('parses ordinary values', () => {
    expect(toNumber(' 250 ')).toBe(250);
    expect(toNumber('3.5')).toBe(3.5);
    expect(toNumber('0')).toBe(0);
  });
});

describe('draft round-trip', () => {
  it('restores a policy into an equal draft', () => {
    const payload = draftToPayload(DEFAULT_POLICY_DRAFT);
    const restored = draftFromPolicy({ ...payload, version: 4 });
    expect(draftsEqual(restored, DEFAULT_POLICY_DRAFT)).toBe(true);
  });

  it('lowercases allowlist addresses on the way in and out', () => {
    const restored = draftFromPolicy({
      ...draftToPayload(DEFAULT_POLICY_DRAFT),
      version: 1,
      allowedPools: [ADDR_A.toUpperCase().replace('0X', '0x')],
    });
    expect(restored.allowedPools).toEqual([ADDR_A]);
    expect(draftToPayload(restored).allowedPools).toEqual([ADDR_A]);
  });

  it('falls back to defaults with an empty allowlist when there is no policy', () => {
    expect(draftFromPolicy(null).allowedPools).toEqual([]);
    expect(draftFromPolicy(null).maxPositionSizeUsd).toBe('250');
  });
});

describe('parseFieldIssues', () => {
  it('reads an { issues: [...] } envelope', () => {
    expect(parseFieldIssues({ issues: [{ field: 'chain', message: 'bad' }] })).toEqual([
      { field: 'chain', message: 'bad' },
    ]);
  });
  it('reads an { errors: [...] } envelope with a path key', () => {
    expect(parseFieldIssues({ errors: [{ path: 'dailySpendCapUsd', message: 'too small' }] })).toEqual([
      { field: 'dailySpendCapUsd', message: 'too small' },
    ]);
  });
  it('reads a { fieldErrors: { field: message } } map', () => {
    expect(parseFieldIssues({ fieldErrors: { chain: 'nope' } })).toEqual([{ field: 'chain', message: 'nope' }]);
  });
  it('reads a nested { error: { issues } } envelope', () => {
    expect(parseFieldIssues({ error: { issues: [{ field: 'a', message: 'b' }] } })).toEqual([
      { field: 'a', message: 'b' },
    ]);
  });
  it('degrades to an empty list rather than throwing', () => {
    expect(parseFieldIssues(null)).toEqual([]);
    expect(parseFieldIssues('boom')).toEqual([]);
    expect(parseFieldIssues({ error: 'plain string' })).toEqual([]);
  });
});

describe('issuesByField', () => {
  it('keeps the first message per field', () => {
    expect(
      issuesByField([
        { field: 'chain', message: 'first' },
        { field: 'chain', message: 'second' },
      ]),
    ).toEqual({ chain: 'first' });
  });
});

// --- Surfaced vs allowlisted ------------------------------------------------

describe('surfaced is not allowlisted', () => {
  it('a pool that clears every criterion is still only "surfaced" until it is ticked', () => {
    const candidate = pool({ tvlUsd: 9_000_000, volume24hUsd: 5_000_000, feeApr: 1.2 });
    expect(evaluateVisibleCriteria(candidate, 'robinhood', { minTvlUsd: 250_000, min24hVolumeUsd: 50_000 })).toEqual(
      [],
    );
    expect(poolRowStatus(candidate.address, [], [])).toBe('surfaced');
    expect(isActiveForAutomation(poolRowStatus(candidate.address, [], []))).toBe(false);
  });

  it('only the allowlist arrays decide status — criteria never promote a pool', () => {
    const candidate = pool();
    expect(poolRowStatus(candidate.address, [ADDR_A], [ADDR_A])).toBe('allowlisted');
    expect(isActiveForAutomation('allowlisted')).toBe(true);
  });

  it('distinguishes a saved tick from an unsaved one', () => {
    expect(poolRowStatus(ADDR_A, [ADDR_A], [])).toBe('pending_add');
    expect(poolRowStatus(ADDR_A, [], [ADDR_A])).toBe('pending_remove');
  });

  it('an unsaved tick is not yet active; an unsaved removal still is', () => {
    expect(isActiveForAutomation('pending_add')).toBe(false);
    expect(isActiveForAutomation('pending_remove')).toBe(true);
  });

  it('matches addresses case-insensitively', () => {
    expect(isInAllowlist([ADDR_A], ADDR_A.toUpperCase().replace('0X', '0x'))).toBe(true);
    expect(poolRowStatus(ADDR_A.toUpperCase().replace('0X', '0x'), [ADDR_A], [ADDR_A])).toBe('allowlisted');
  });

  it('treats a blank address as absent', () => {
    expect(isInAllowlist([ADDR_A], '')).toBe(false);
    expect(toggleAllowlist([ADDR_A], '  ')).toEqual([ADDR_A]);
  });
});

describe('toggleAllowlist', () => {
  it('adds normalized and removes case-insensitively, without mutating', () => {
    const before = [ADDR_A];
    const added = toggleAllowlist(before, ADDR_B.toUpperCase().replace('0X', '0x'));
    expect(added).toEqual([ADDR_A, ADDR_B]);
    expect(before).toEqual([ADDR_A]);
    expect(toggleAllowlist(added, ADDR_A)).toEqual([ADDR_B]);
  });
});

describe('summarizeAllowlist', () => {
  const candidates = [pool({ address: ADDR_A }), pool({ address: ADDR_B }), pool({ address: ADDR_C })];

  it('counts surfaced-but-ignored separately from admitted', () => {
    const summary = summarizeAllowlist(candidates, [ADDR_A], [ADDR_A]);
    expect(summary.surfacedCount).toBe(3);
    expect(summary.selectedCount).toBe(1);
    expect(summary.ignoredCount).toBe(2);
  });

  it('reports an all-ignored shortlist as zero admitted', () => {
    const summary = summarizeAllowlist(candidates, [], []);
    expect(summary.selectedCount).toBe(0);
    expect(summary.ignoredCount).toBe(3);
    expect(summary.draftAllowlistSize).toBe(0);
  });

  it('separates pending adds from pending removals', () => {
    const summary = summarizeAllowlist(candidates, [ADDR_A, ADDR_B], [ADDR_B, ADDR_C]);
    expect(summary.pendingAdds).toBe(1);
    expect(summary.pendingRemovals).toBe(1);
  });

  it('surfaces allowlisted pools discovery did not return, so they never vanish silently', () => {
    const summary = summarizeAllowlist([pool({ address: ADDR_A })], [ADDR_A, ADDR_C], [ADDR_A, ADDR_C]);
    expect(summary.allowlistedOffScreen).toEqual([ADDR_C]);
  });

  it('deduplicates the draft allowlist when sizing it', () => {
    const summary = summarizeAllowlist([], [ADDR_A, ADDR_A.toUpperCase().replace('0X', '0x')], []);
    expect(summary.draftAllowlistSize).toBe(1);
  });
});

describe('evaluateVisibleCriteria', () => {
  it('flags TVL, volume and chain failures by name', () => {
    const failures = evaluateVisibleCriteria(
      pool({ tvlUsd: 1_000, volume24hUsd: 10, chainId: 1 }),
      'robinhood',
      { minTvlUsd: 250_000, min24hVolumeUsd: 50_000 },
    );
    expect(failures).toEqual(['chain', 'minTvlUsd', 'min24hVolumeUsd']);
  });

  it('treats a non-finite TVL as a failure, not a pass', () => {
    const failures = evaluateVisibleCriteria(pool({ tvlUsd: Number.NaN }), 'robinhood', {
      minTvlUsd: 0,
      min24hVolumeUsd: 0,
    });
    expect(failures).toContain('minTvlUsd');
  });

  it('accepts a pool exactly on the threshold', () => {
    const failures = evaluateVisibleCriteria(pool({ tvlUsd: 250_000, volume24hUsd: 50_000 }), 'robinhood', {
      minTvlUsd: 250_000,
      min24hVolumeUsd: 50_000,
    });
    expect(failures).toEqual([]);
  });
});

describe('sortCandidates', () => {
  const candidates = [
    pool({ address: ADDR_A, tvlUsd: 1_000_000, feeApr: 0.1 }),
    pool({ address: ADDR_B, tvlUsd: 3_000_000, feeApr: 0.5 }),
    pool({ address: ADDR_C, tvlUsd: 2_000_000, feeApr: 0.9 }),
  ];

  it('sorts descending by TVL without mutating the input', () => {
    const sorted = sortCandidates(candidates, 'tvl', 'desc', [], []);
    expect(sorted.map((p) => p.address)).toEqual([ADDR_B, ADDR_C, ADDR_A]);
    expect(candidates[0].address).toBe(ADDR_A);
  });

  it('sorts ascending by APR', () => {
    expect(sortCandidates(candidates, 'apr', 'asc', [], []).map((p) => p.address)).toEqual([
      ADDR_A,
      ADDR_B,
      ADDR_C,
    ]);
  });

  it('ranks allowlisted above surfaced when sorting by status', () => {
    const sorted = sortCandidates(candidates, 'status', 'asc', [ADDR_C], [ADDR_C]);
    expect(sorted[0].address).toBe(ADDR_C);
  });

  it('breaks ties deterministically on address', () => {
    const flat = [pool({ address: ADDR_C, tvlUsd: 1 }), pool({ address: ADDR_A, tvlUsd: 1 })];
    expect(sortCandidates(flat, 'tvl', 'desc', [], []).map((p) => p.address)).toEqual([ADDR_A, ADDR_C]);
  });
});

// --- Formatting -------------------------------------------------------------

describe('formatting helpers', () => {
  it('formats exact USD for policy caps', () => {
    expect(formatUsdExact(250)).toBe('$250');
    expect(formatUsdExact(1250.5)).toBe('$1,250.50');
    expect(formatUsdExact(Number.NaN)).toBe('—');
    expect(formatUsdExact(undefined)).toBe('—');
  });

  it('formats compact USD for market numbers', () => {
    expect(formatUsdCompact(250_000)).toBe('$250.0K');
    expect(formatUsdCompact(1_250_000)).toBe('$1.25M');
    expect(formatUsdCompact(2_000_000_000)).toBe('$2.00B');
    expect(formatUsdCompact(950)).toBe('$950');
    expect(formatUsdCompact(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('renders feeApr as a fraction, not a raw number', () => {
    expect(formatAprFraction(0.42)).toBe('42.0%');
    expect(formatAprFraction(1.5)).toBe('150%');
    expect(formatAprFraction(null)).toBe('—');
  });

  it('converts fee tier bps to a percentage', () => {
    expect(formatFeeTier(3000)).toBe('0.30%');
    expect(formatFeeTier(500)).toBe('0.05%');
    expect(formatFeeTier(100)).toBe('0.01%');
    // Sub-basis-point tiers keep a third decimal rather than rounding to 0.00%.
    expect(formatFeeTier(50)).toBe('0.005%');
  });

  it('formats ratios, hours and minutes readably', () => {
    expect(formatRatio(3)).toBe('3.0×');
    expect(formatHours(24)).toBe('1d');
    expect(formatHours(6)).toBe('6h');
    expect(formatHours(36)).toBe('1d 12h');
    expect(formatMinutes(60)).toBe('1 h');
    expect(formatMinutes(45)).toBe('45 min');
  });

  it('shortens addresses and labels pairs', () => {
    expect(shortAddress(ADDR_A)).toBe('0xaaaa…aaaa');
    expect(shortAddress('0x12')).toBe('0x12');
    expect(poolPairLabel(pool())).toBe('WETH / USDC');
  });

  it('describes how many entries a daily cap funds', () => {
    expect(describeDailyCapacity(250, 500)).toBe('2 full-size entries per day');
    expect(describeDailyCapacity(250, 250)).toBe('1 full-size entry per day');
    expect(describeDailyCapacity(500, 250)).toBe('not even one full-size entry');
    expect(describeDailyCapacity(0, 500)).toBe('—');
  });
});

describe('plain-language readouts', () => {
  it('states the compound trigger as a sentence, not a number', () => {
    expect(describeCompound(DEFAULT_POLICY_DRAFT)).toBe(
      'Compound once claimable fees are worth 3.0× the gas it costs to claim them — or after 1d, whichever comes first.',
    );
  });

  it('names both halves of the switching buffer', () => {
    const text = describeSwitching(DEFAULT_POLICY_DRAFT);
    expect(text).toContain('5 percentage points');
    expect(text).toContain('1 h');
    expect(text).toContain('momentary crossover never moves capital');
  });

  it('asks for a value instead of rendering NaN', () => {
    expect(describeCompound(draft({ compoundTrigger: { minFeesVsGasRatio: '', maxIntervalHours: '24' } }))).toBe(
      'Set a value to see what this does.',
    );
  });
});
