import { describe, expect, it } from 'vitest';
import {
  deriveLineagePnl,
  extractLineageLinks,
  gasSpentUsdFromSnapshot,
} from '../src/lp/pnl.js';
import { buildLineagePnlInputs } from '../src/lp/lineagePnl.js';
import { auditLogPathFromEnv, defaultAuditLogCandidates } from '../src/lp/auditReader.js';
import type { LpPositionView } from '../src/api/routes/lp.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

describe('auditLogPathFromEnv', () => {
  it('prefers LP_AUDIT_LOG_PATH when set', () => {
    expect(auditLogPathFromEnv({ LP_AUDIT_LOG_PATH: '/custom/audit.jsonl' })).toBe('/custom/audit.jsonl');
  });

  it('falls back to the repo-local worker log when env is unset', () => {
    const candidates = defaultAuditLogCandidates();
    const path = auditLogPathFromEnv({});
    expect(path).toBeTruthy();
    expect(candidates).toContain(path!);
    const repoRelative = join('lp-automation', 'data', 'audit.jsonl');
    expect(
      candidates.some((candidate) => candidate.replace(/\\/g, '/').endsWith(repoRelative.replace(/\\/g, '/'))),
    ).toBe(true);
    if (path && existsSync(path)) {
      expect(existsSync(path)).toBe(true);
    }
  });
});

describe('backend lp pnl', () => {
  it('derives gas from snapshot fields', () => {
    expect(gasSpentUsdFromSnapshot({ gasSpentUsd: 1.25 })).toBe(1.25);
  });

  it('builds inputs and derives pnl for a lineage head', () => {
    const positions: LpPositionView[] = [
      {
        tokenId: '200',
        poolAddress: '0x10cc6bd38112cac182db90b6a71d8bb5939526ba',
        platform: 'uniswapv3',
        feeTierBps: 10_000,
        token0: { symbol: 'A', address: '0x1', decimals: 18 },
        token1: { symbol: 'B', address: '0x2', decimals: 18 },
        status: 'in_range',
        valueUsd: 60,
        unclaimedFeesUsd: 0.5,
        minPrice: 1,
        maxPrice: 2,
        currentPrice: 1.5,
        isAllowlisted: true,
        managedByAutomation: true,
      },
      {
        tokenId: '100',
        poolAddress: '0x10cc6bd38112cac182db90b6a71d8bb5939526ba',
        platform: 'uniswapv3',
        feeTierBps: 10_000,
        token0: { symbol: 'A', address: '0x1', decimals: 18 },
        token1: { symbol: 'B', address: '0x2', decimals: 18 },
        status: 'closed',
        valueUsd: 0,
        unclaimedFeesUsd: 0,
        minPrice: 1,
        maxPrice: 2,
        currentPrice: 1.5,
        isAllowlisted: true,
        managedByAutomation: false,
      },
    ];

    const links = extractLineageLinks([
      {
        id: '1',
        phase: 'success',
        timestamp: 1,
        action: 'none',
        rule: 'lifecycle.rebalance.lineage',
        snapshot: {
          oldTokenId: '100',
          newTokenId: '200',
          pool: '0x10cc6bd38112cac182db90b6a71d8bb5939526ba',
        },
        txHash: null,
        error: null,
      },
    ]);

    const inputs = buildLineagePnlInputs(positions, links);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.lineageKey).toBe(
      '0x10cc6bd38112cac182db90b6a71d8bb5939526ba:200',
    );
    expect(inputs[0]?.memberTokenIds).toEqual(['200', '100']);

    const pnl = deriveLineagePnl(
      [
        {
          id: 'e',
          phase: 'success',
          timestamp: 1,
          action: 'enter',
          rule: 'enter',
          snapshot: { tokenId: '100', valueUsd: 50 },
          txHash: '0x1',
          error: null,
        },
      ],
      inputs[0]!,
    );
    expect(pnl.costBasisUsd).toBe(50);
    expect(pnl.netPnlUsd).toBeCloseTo(10.5, 5);
  });

  it('builds separate inputs for concurrent open positions in the same pool', () => {
    const pool = '0x10cc6bd38112cac182db90b6a71d8bb5939526ba';
    const base = {
      poolAddress: pool,
      platform: 'uniswapv3' as const,
      feeTierBps: 10_000,
      token0: { symbol: 'A', address: '0x1', decimals: 18 },
      token1: { symbol: 'B', address: '0x2', decimals: 18 },
      minPrice: 1,
      maxPrice: 2,
      currentPrice: 1.5,
      isAllowlisted: true,
      managedByAutomation: true,
    };
    const positions: LpPositionView[] = [
      { ...base, tokenId: '419551', status: 'in_range', valueUsd: 60, unclaimedFeesUsd: 0.14 },
      { ...base, tokenId: '420479', status: 'in_range', valueUsd: 19, unclaimedFeesUsd: 0.01 },
    ];

    const inputs = buildLineagePnlInputs(positions, []);
    expect(inputs).toHaveLength(2);
    expect(inputs.map((i) => i.lineageKey).sort()).toEqual([
      `${pool}:419551`,
      `${pool}:420479`,
    ]);
    expect(inputs.find((i) => i.headTokenId === '419551')?.memberTokenIds).toEqual(['419551']);
    expect(inputs.find((i) => i.headTokenId === '420479')?.memberTokenIds).toEqual(['420479']);
  });
});
