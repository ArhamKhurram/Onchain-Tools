import { describe, expect, it } from 'vitest';
import type { AuditRecordLike } from '../src/lp/auditReader.js';
import { buildTaxExportRows, taxExportRowsToCsv } from '../src/lp/taxExport.js';

function record(over: Partial<AuditRecordLike> & Pick<AuditRecordLike, 'id'>): AuditRecordLike {
  return {
    phase: 'success',
    timestamp: 1_700_000_000_000,
    action: 'compound',
    rule: 'test',
    snapshot: {},
    txHash: '0xabc',
    error: null,
    ...over,
  };
}

describe('buildTaxExportRows', () => {
  it('skips intent rows and non-actionable outcomes', () => {
    const rows = buildTaxExportRows([
      record({
        id: 'intent',
        phase: 'intent',
        action: 'enter',
        snapshot: { tokenId: '1', pool: '0x10cc6bd38112cac182db90b6a71d8bb5939526ba' },
        txHash: null,
      }),
      record({
        id: 'fail',
        phase: 'failure',
        action: 'exit',
        error: 'reverted',
        snapshot: { tokenId: '1' },
      }),
      record({
        id: 'lineage',
        action: 'none',
        rule: 'lifecycle.rebalance.lineage',
        snapshot: { oldTokenId: '1', newTokenId: '2' },
      }),
      record({
        id: 'ok',
        action: 'compound',
        snapshot: {
          tokenId: '419551',
          pool: '0x10cc6bd38112cac182db90b6a71d8bb5939526ba',
          valueUsd: 60,
          gasSpentUsd: 0.05,
        },
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'compound',
      tokenId: '419551',
      pool: '0x10cc6bd38112cac182db90b6a71d8bb5939526ba',
      valueUsd: 60,
      gasSpentUsd: 0.05,
      txHash: '0xabc',
    });
  });

  it('derives depositValueUsd for enter/increase via pnl helpers', () => {
    const rows = buildTaxExportRows(
      [
        record({
          id: 'enter',
          timestamp: 1_700_000_001_000,
          action: 'enter',
          snapshot: {
            tokenId: '100',
            poolAddress: '0x10cc6bd38112cac182db90b6a71d8bb5939526ba',
            amountIn: '10000000000000000',
            valueUsd: 50,
            gasUsed: '100000',
            effectiveGasPriceWei: '1000000000',
            nativeTokenUsd: 3000,
          },
        }),
        record({
          id: 'increase',
          timestamp: 1_700_000_002_000,
          action: 'increase',
          snapshot: {
            tokenId: '100',
            pool: '0x10cc6bd38112cac182db90b6a71d8bb5939526ba',
            depositValueUsd: 12.5,
            valueUsd: 62.5,
          },
        }),
      ],
      { fallbackNativeTokenUsd: 2500 },
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]?.action).toBe('enter');
    expect(rows[0]?.amountIn).toBe('10000000000000000');
    expect(rows[0]?.depositValueUsd).toBeCloseTo(30, 5);
    expect(rows[1]?.depositValueUsd).toBe(12.5);
  });

  it('sorts rows by timestamp ascending', () => {
    const rows = buildTaxExportRows([
      record({
        id: 'later',
        timestamp: 2,
        action: 'exit',
        snapshot: { tokenId: '2', valueUsd: 10 },
      }),
      record({
        id: 'earlier',
        timestamp: 1,
        action: 'enter',
        snapshot: { tokenId: '1', valueUsd: 20 },
      }),
    ]);

    expect(rows.map((row) => row.action)).toEqual(['enter', 'exit']);
  });
});

describe('taxExportRowsToCsv', () => {
  it('writes a header row and escapes commas', () => {
    const csv = taxExportRowsToCsv([
      {
        timestamp: '2024-01-01T00:00:00.000Z',
        action: 'exit',
        tokenId: '1',
        pool: '0x10cc6bd38112cac182db90b6a71d8bb5939526ba',
        amountIn: null,
        depositValueUsd: null,
        gasSpentUsd: 0.1,
        valueUsd: 55,
        txHash: '0xhash,with,comma',
      },
    ]);

    expect(csv.startsWith('timestamp,action,tokenId,pool,amountIn,depositValueUsd,gasSpentUsd,valueUsd,txHash\n')).toBe(
      true,
    );
    expect(csv).toContain('"0xhash,with,comma"');
    expect(csv.endsWith('\n')).toBe(true);
  });
});
