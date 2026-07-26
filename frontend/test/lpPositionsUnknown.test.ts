import { describe, it, expect } from 'vitest';
import { positionCoverage, coverageRank } from '../src/components/lp/positions';

// A failed policy read must NOT read as "unmanaged". `unmanaged` is a positive
// claim that nothing is tending the position; telling someone their money is
// unprotected when it may be fine is its own wrong answer, and it pushes them
// to "fix" something that isn't broken.

const position = (over: Partial<Parameters<typeof positionCoverage>[0]> = {}) => ({
  poolAddress: '0x10cc6bd38112cac182db90b6a71d8bb5939526ba',
  status: 'in_range' as const,
  isAllowlisted: false,
  managedByAutomation: false,
  ...over,
});

describe('positionCoverage — policyReadFailed', () => {
  it('reports unknown, not unmanaged, when the policy could not be read', () => {
    expect(positionCoverage(position(), [], true)).toBe('unknown');
  });

  it('reports unknown even when the flags would otherwise say managed', () => {
    // The flags are defaults, not observations, so they must not be trusted.
    const p = position({ isAllowlisted: true, managedByAutomation: true });
    expect(positionCoverage(p, [p.poolAddress], true)).toBe('unknown');
  });

  it('still reports closed for a closed position — coverage is moot there', () => {
    expect(positionCoverage(position({ status: 'closed' }), [], true)).toBe('closed');
  });

  it('defaults to the normal reading when the flag is absent', () => {
    expect(positionCoverage(position(), [])).toBe('unmanaged');
  });

  it('does not affect the normal path when the read succeeded', () => {
    const p = position({ isAllowlisted: true, managedByAutomation: true });
    expect(positionCoverage(p, [p.poolAddress], false)).toBe('managed');
  });
});

describe('coverageRank', () => {
  it('sorts unknown above everything already handled', () => {
    expect(coverageRank('unknown')).toBeLessThan(coverageRank('managed'));
    expect(coverageRank('unknown')).toBeLessThan(coverageRank('closed'));
  });

  it('still sorts a confirmed gap above an unknown one', () => {
    expect(coverageRank('unmanaged')).toBeLessThan(coverageRank('unknown'));
  });
});
