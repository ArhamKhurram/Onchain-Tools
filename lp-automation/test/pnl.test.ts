import { describe, expect, it } from 'vitest';
import {
  deriveLineagePnl,
  extractLineageLinks,
  gasSpentUsdFromSnapshot,
  lineageMembersFromLinks,
  type AuditRecordLike,
} from '../src/audit/pnl.js';

function record(over: Partial<AuditRecordLike> & Pick<AuditRecordLike, 'id'>): AuditRecordLike {
  return {
    phase: 'success',
    timestamp: 1_700_000_000_000,
    action: 'none',
    rule: 'test',
    snapshot: {},
    txHash: null,
    error: null,
    ...over,
  };
}

describe('gasSpentUsdFromSnapshot', () => {
  it('reads gasSpentUsd directly when present', () => {
    expect(gasSpentUsdFromSnapshot({ gasSpentUsd: 0.075 })).toBe(0.075);
  });

  it('derives from gasUsed and effectiveGasPriceWei', () => {
    const usd = gasSpentUsdFromSnapshot({
      gasUsed: '100000',
      effectiveGasPriceWei: '1000000000',
      nativeTokenUsd: 3000,
    });
    expect(usd).toBeCloseTo(0.3, 5);
  });
});

describe('extractLineageLinks', () => {
  it('pulls rebalance lineage entries from the audit log', () => {
    const links = extractLineageLinks([
      record({
        id: '1',
        rule: 'lifecycle.rebalance.lineage',
        snapshot: {
          oldTokenId: '100',
          newTokenId: '200',
          pool: '0x10cc6bd38112cac182db90b6a71d8bb5939526ba',
          withdrawnValueUsd: 55,
          remintedValueUsd: 54,
        },
      }),
    ]);
    expect(links).toHaveLength(1);
    expect(links[0]?.oldTokenId).toBe('100');
    expect(links[0]?.newTokenId).toBe('200');
  });
});

describe('lineageMembersFromLinks', () => {
  it('walks old→new chain from the head', () => {
    const members = lineageMembersFromLinks('300', [
      {
        oldTokenId: '100',
        newTokenId: '200',
        poolAddress: '0xabc',
        withdrawnValueUsd: null,
        remintedValueUsd: null,
        timestamp: 1,
      },
      {
        oldTokenId: '200',
        newTokenId: '300',
        poolAddress: '0xabc',
        withdrawnValueUsd: null,
        remintedValueUsd: null,
        timestamp: 2,
      },
    ]);
    expect(members).toEqual(['300', '200', '100']);
  });
});

describe('deriveLineagePnl', () => {
  const baseInput = {
    lineageKey: '0xpool',
    headTokenId: '200',
    memberTokenIds: ['200', '100'],
    currentValueUsd: 60,
    unclaimedFeesUsd: 1,
  };

  it('computes net PnL from enter deposit, compounds, and gas', () => {
    const records: AuditRecordLike[] = [
      record({
        id: 'enter',
        action: 'enter',
        snapshot: { tokenId: '100', valueUsd: 50 },
      }),
      record({
        id: 'compound',
        action: 'compound',
        snapshot: { tokenId: '100', unclaimedFeesUsd: 2, valueUsd: 52 },
      }),
      record({
        id: 'gas',
        action: 'compound',
        snapshot: { tokenId: '200', gasSpentUsd: 0.1, valueUsd: 58 },
      }),
    ];

    const pnl = deriveLineagePnl(records, baseInput);
    expect(pnl.costBasisKnown).toBe(false);
    expect(pnl.costBasisUsd).toBe(50);
    expect(pnl.lifetimeFeesUsd).toBe(2);
    expect(pnl.gasPaidUsd).toBe(0.1);
    expect(pnl.netPnlUsd).toBeCloseTo(60 + 1 - 50 - 0.1, 5);
    expect(pnl.netPnlPercent).toBeCloseTo(((11 - 0.1) / 50) * 100, 5);
  });

  it('labels unknown deposit as since first observation', () => {
    const records: AuditRecordLike[] = [
      record({
        id: 'snap',
        phase: 'intent',
        action: 'compound',
        timestamp: 1_800_000_000_000,
        snapshot: { tokenId: '200', valueUsd: 56 },
      }),
    ];
    const ts = 1_800_000_000_000;
    const pnl = deriveLineagePnl(records, {
      ...baseInput,
      memberTokenIds: ['200'],
    });
    expect(pnl.costBasisKnown).toBe(false);
    expect(pnl.costBasisSince).toBe(new Date(ts).toISOString().slice(0, 10));
    expect(pnl.costBasisUsd).toBe(56);
  });

  it('adds increase deposits to cost basis after the opening snapshot', () => {
    const t0 = 1_800_000_000_000;
    const t1 = t0 + 60_000;
    const records: AuditRecordLike[] = [
      record({
        id: 'open',
        phase: 'intent',
        timestamp: t0,
        action: 'compound',
        snapshot: { tokenId: '419551', valueUsd: 58 },
      }),
      record({
        id: 'inc',
        timestamp: t1,
        action: 'increase',
        snapshot: {
          tokenId: '419551',
          valueUsd: 58,
          amountIn: '10000000000000000',
          nativeTokenUsd: 2000,
        },
      }),
    ];
    const pnl = deriveLineagePnl(records, {
      lineageKey: '0xpool:419551',
      headTokenId: '419551',
      memberTokenIds: ['419551'],
      currentValueUsd: 77,
      unclaimedFeesUsd: 0,
    });
    expect(pnl.costBasisKnown).toBe(true);
    expect(pnl.costBasisUsd).toBeCloseTo(58 + 20, 5);
    expect(pnl.netPnlUsd).toBeCloseTo(77 - (58 + 20), 5);
  });

  it('skips flat post-increase polls when inferring deposit from value delta', () => {
    const t0 = 1_800_000_000_000;
    const t1 = t0 + 60_000;
    const t2 = t1 + 1;
    const t3 = t1 + 120_000;
    const records: AuditRecordLike[] = [
      record({
        id: 'open',
        timestamp: t0,
        action: 'none',
        snapshot: { tokenId: '419551', valueUsd: 60 },
      }),
      record({
        id: 'inc',
        timestamp: t1,
        action: 'increase',
        snapshot: {
          tokenId: '419551',
          valueUsd: 61,
          amountIn: '30000000000000000',
        },
      }),
      record({
        id: 'flat',
        timestamp: t2,
        action: 'none',
        snapshot: { tokenId: '419551', valueUsd: 61 },
      }),
      record({
        id: 'after',
        timestamp: t3,
        action: 'none',
        snapshot: { tokenId: '419551', valueUsd: 119 },
      }),
    ];
    const pnl = deriveLineagePnl(records, {
      lineageKey: '0xpool:419551',
      headTokenId: '419551',
      memberTokenIds: ['419551'],
      currentValueUsd: 119,
      unclaimedFeesUsd: 0,
    });
    expect(pnl.costBasisUsd).toBeCloseTo(60 + 58, 5);
  });

  it('uses amountIn with fallback native price for receipt-confirmed increases', () => {
    const t0 = 1_800_000_000_000;
    const t1 = t0 + 60_000;
    const records: AuditRecordLike[] = [
      record({
        id: 'open',
        timestamp: t0,
        action: 'none',
        snapshot: { tokenId: '1', valueUsd: 50 },
      }),
      record({
        id: 'inc',
        timestamp: t1,
        action: 'increase',
        snapshot: {
          tokenId: '1',
          valueUsd: 50,
          amountIn: '10000000000000000',
          gasUsed: '500000',
          effectiveGasPriceWei: '1000000000',
        },
      }),
    ];
    const pnl = deriveLineagePnl(
      records,
      {
        lineageKey: '0xpool:1',
        headTokenId: '1',
        memberTokenIds: ['1'],
        currentValueUsd: 70,
        unclaimedFeesUsd: 0,
      },
      { fallbackNativeTokenUsd: 2000 },
    );
    expect(pnl.costBasisUsd).toBeCloseTo(70, 5);
  });
});
