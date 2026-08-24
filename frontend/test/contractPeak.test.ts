import { describe, it, expect } from 'vitest';
import { contractPeakView, formatCompactUsd } from '../src/utils/contractPeak';
import type { ContractEntry } from '../src/types';

const CALL_AT = '2026-08-20T12:00:00.000Z';
const AFTER_CALL = '2026-08-20T15:00:00.000Z';
const BEFORE_CALL = '2026-08-20T09:00:00.000Z';

function entry(overrides: Partial<ContractEntry> = {}): ContractEntry {
  return {
    address: 'So1anaMintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    chain: 'sol',
    authorId: 'u1',
    authorName: 'caller',
    channelId: 'c1',
    channelName: 'calls',
    guildId: null,
    guildName: null,
    roomIds: [],
    messageId: 'm1',
    timestamp: CALL_AT,
    ...overrides,
  };
}

describe('contractPeakView', () => {
  it('shows peak and a floored multiple when the peak came after the call', () => {
    const view = contractPeakView(
      entry({ fdvAtCall: 10_000, peakMc: 104_000, peakAt: AFTER_CALL }),
    );
    expect(view).not.toBeNull();
    expect(view!.peakDisplay).toBe('104.0K');
    expect(view!.multiple).toBeCloseTo(10.4);
    expect(view!.multipleDisplay).toBe('≥10×');
    expect(view!.belowCall).toBe(false);
  });

  it('keeps one decimal for small multiples', () => {
    const view = contractPeakView(
      entry({ fdvAtCall: 10_000, peakMc: 14_000, peakAt: AFTER_CALL }),
    );
    expect(view!.multipleDisplay).toBe('≥1.4×');
  });

  it('never attributes a peak observed before the call — missing beats wrong', () => {
    // The token ran to 1M before this caller ever posted it; crediting them
    // with a 10x would be exactly the misleading readout this guards against.
    const view = contractPeakView(
      entry({ fdvAtCall: 100_000, peakMc: 1_000_000, peakAt: BEFORE_CALL }),
    );
    expect(view).toBeNull();
  });

  it('marks a peak below the call MC as bleed, with no multiple', () => {
    const view = contractPeakView(
      entry({ fdvAtCall: 100_000, peakMc: 40_000, peakAt: AFTER_CALL }),
    );
    expect(view).not.toBeNull();
    expect(view!.belowCall).toBe(true);
    expect(view!.multiple).toBeUndefined();
    expect(view!.multipleDisplay).toBeUndefined();
    expect(view!.peakDisplay).toBe('40.0K');
  });

  it('renders nothing without an MC at call to compare against', () => {
    expect(contractPeakView(entry({ peakMc: 50_000, peakAt: AFTER_CALL }))).toBeNull();
    expect(
      contractPeakView(entry({ fdvAtCall: 0, peakMc: 50_000, peakAt: AFTER_CALL })),
    ).toBeNull();
  });

  it('renders nothing without a peak, a peak time, or with a junk peak', () => {
    expect(contractPeakView(entry({ fdvAtCall: 10_000 }))).toBeNull();
    expect(contractPeakView(entry({ fdvAtCall: 10_000, peakMc: 0, peakAt: AFTER_CALL }))).toBeNull();
    expect(contractPeakView(entry({ fdvAtCall: 10_000, peakMc: 50_000 }))).toBeNull();
    expect(
      contractPeakView(entry({ fdvAtCall: 10_000, peakMc: 50_000, peakAt: 'not-a-date' })),
    ).toBeNull();
  });

  it('treats a peak observed exactly at the call time as post-call', () => {
    const view = contractPeakView(
      entry({ fdvAtCall: 10_000, peakMc: 20_000, peakAt: CALL_AT }),
    );
    expect(view).not.toBeNull();
    expect(view!.multipleDisplay).toBe('≥2.0×');
  });
});

describe('formatCompactUsd', () => {
  it('scales through K/M/B', () => {
    expect(formatCompactUsd(950)).toBe('950');
    expect(formatCompactUsd(10_400)).toBe('10.4K');
    expect(formatCompactUsd(2_500_000)).toBe('2.5M');
    expect(formatCompactUsd(1_200_000_000)).toBe('1.2B');
  });
});
