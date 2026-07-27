import { describe, expect, it, vi } from 'vitest';
import type { OutcomeEnrichmentRequest } from '../src/lifecycle/executor.js';
import { enrichZapOutcomeSnapshot } from '../src/lifecycle/zapPnl.js';
import type { PositionFeed } from '../src/lifecycle/types.js';
import type { Address, Decision, LpPosition } from '../src/types.js';

const POOL = '0x69bfaf19d1f3f0c0a1b8f0a8a4c5d6e7f8091a2b' as Address;
const SAFE = '0x2222222222222222222222222222222222222222' as Address;
const TX_HASH = '0x0104b9f8a2fba119df32676093e7767c96ed29103446ae190b86806da4ac5949';

function lp(over: Partial<LpPosition> = {}): LpPosition {
  return {
    tokenId: '395774',
    pool: {
      address: POOL,
      chainId: 4663,
      platform: 'uniswapv3',
      feeTierBps: 10_000,
      token0: { address: SAFE, symbol: 'WETH', decimals: 18 },
      token1: { address: POOL, symbol: 'USDG', decimals: 6 },
      tvlUsd: 500_000,
      volume24hUsd: 100_000,
      feeApr: 0.4,
    },
    status: 'in_range',
    tickLower: 141_800,
    tickUpper: 148_800,
    currentTick: 145_000,
    valueUsd: 250,
    unclaimedFeesUsd: 5,
    openedAt: 1_800_000_000_000,
    lastCompoundedAt: 1_800_000_000_000,
    ...over,
  };
}

function enrichmentRequest(over: Partial<OutcomeEnrichmentRequest> = {}): OutcomeEnrichmentRequest {
  const position = lp(over.position ?? {});
  return {
    action: 'increase',
    position,
    decision: {
      action: 'increase',
      rule: 'manual.increase',
      reason: 'test',
      snapshot: { tokenId: position.tokenId, pool: POOL },
    } satisfies Decision,
    txHash: TX_HASH,
    receipt: { status: 'success', gasUsed: 100_000n, effectiveGasPrice: 1_000n },
    preValueUsd: position.valueUsd,
    ...over,
  };
}

function feed(positions: LpPosition[]): PositionFeed {
  return { loadPositions: async () => positions };
}

describe('enrichZapOutcomeSnapshot', () => {
  it('records depositValueUsd from refreshed position on increase', async () => {
    const position = lp({ tokenId: '395774', valueUsd: 100 });
    const refreshed = lp({ tokenId: '395774', valueUsd: 175 });

    const extra = await enrichZapOutcomeSnapshot(enrichmentRequest({ position, preValueUsd: 100 }), {
      positions: feed([refreshed]),
      lineagePollDelaysMs: [],
      knownTokenIds: new Set(['395774']),
      warn: () => {},
    });

    expect(extra).toEqual({ valueUsd: 175, depositValueUsd: 75 });
  });

  it('records mintedTokenId and depositValueUsd when enter mint appears in feed', async () => {
    const synthetic = lp({ tokenId: 'enter:cmd-1', valueUsd: 0 });
    const minted = lp({ tokenId: '500001', valueUsd: 320 });

    const extra = await enrichZapOutcomeSnapshot(
      enrichmentRequest({
        action: 'enter',
        position: synthetic,
        preValueUsd: 0,
        decision: {
          action: 'enter',
          rule: 'manual.enter',
          reason: 'test',
          snapshot: { tokenId: 'enter:cmd-1', pool: POOL },
        },
      }),
      {
        positions: feed([synthetic, minted]),
        lineagePollDelaysMs: [],
        knownTokenIds: new Set(['395774']),
        warn: () => {},
      },
    );

    expect(extra).toEqual({ mintedTokenId: '500001', valueUsd: 320, depositValueUsd: 320 });
  });

  it('falls back to receipt parser when feed has no new position', async () => {
    const synthetic = lp({ tokenId: 'enter:cmd-1', valueUsd: 0 });
    const parseMintFromReceipt = vi.fn(async () => '500002');

    const extra = await enrichZapOutcomeSnapshot(
      enrichmentRequest({
        action: 'enter',
        position: synthetic,
        preValueUsd: 0,
      }),
      {
        positions: feed([synthetic]),
        lineagePollDelaysMs: [],
        knownTokenIds: new Set(),
        parseMintFromReceipt,
        warn: () => {},
      },
    );

    expect(extra).toEqual({ mintedTokenId: '500002' });
    expect(parseMintFromReceipt).toHaveBeenCalledWith(TX_HASH);
  });

  it('ignores compound actions', async () => {
    const extra = await enrichZapOutcomeSnapshot(
      enrichmentRequest({ action: 'compound' }),
      {
        positions: feed([lp()]),
        lineagePollDelaysMs: [],
        knownTokenIds: new Set(),
        warn: () => {},
      },
    );
    expect(extra).toEqual({});
  });
});
