import { describe, expect, it } from 'vitest';
import { findRebalanceSuccessor, parseMintedTokenIdFromLogs } from '../src/lifecycle/lineage.js';
import type { Address, LpPosition } from '../src/types.js';

const POOL = '0x69bfaf19d1f3f0c0a1b8f0a8a4c5d6e7f8091a2b' as Address;
const MANAGER = '0x73991a25c818bf1f1128deaab1492d45638de0d3' as Address;
const SAFE = '0x2222222222222222222222222222222222222222' as Address;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function pos(tokenId: string, over: Partial<LpPosition> = {}): LpPosition {
  return {
    tokenId,
    pool: {
      address: POOL,
      chainId: 4663,
      platform: 'uniswapv3',
      feeTierBps: 10_000,
      token0: { address: '0x1', symbol: 'A', decimals: 18 },
      token1: { address: '0x2', symbol: 'B', decimals: 6 },
      tvlUsd: 1,
      volume24hUsd: 1,
      feeApr: 0.1,
    },
    status: 'in_range',
    tickLower: 0,
    tickUpper: 100,
    currentTick: 50,
    valueUsd: 100,
    unclaimedFeesUsd: 0,
    openedAt: 0,
    lastCompoundedAt: 0,
    ...over,
  };
}

describe('findRebalanceSuccessor', () => {
  it('picks the highest open token id in the same pool above the old id', () => {
    const successor = findRebalanceSuccessor(
      [pos('100'), pos('250'), pos('200', { status: 'closed' }), pos('300')],
      '100',
      POOL,
    );
    expect(successor?.tokenId).toBe('300');
  });

  it('ignores lower token ids and other pools', () => {
    const otherPool = { ...pos('500').pool, address: '0xabc' as Address };
    expect(findRebalanceSuccessor([pos('50'), pos('500', { pool: otherPool })], '100', POOL)).toBeUndefined();
  });
});

describe('parseMintedTokenIdFromLogs', () => {
  it('reads the highest mint Transfer log to the safe', () => {
    const tokenId = parseMintedTokenIdFromLogs(
      [
        {
          address: MANAGER,
          topics: [
            TRANSFER,
            '0x0000000000000000000000000000000000000000000000000000000000000000',
            `0x000000000000000000000000${SAFE.slice(2)}`,
            '0x000000000000000000000000000000000000000000000000000000000001f4',
          ],
        },
        {
          address: MANAGER,
          topics: [
            TRANSFER,
            '0x0000000000000000000000000000000000000000000000000000000000000000',
            `0x000000000000000000000000${SAFE.slice(2)}`,
            '0x00000000000000000000000000000000000000000000000000000000000258',
          ],
        },
      ],
      MANAGER,
      SAFE,
    );
    expect(tokenId).toBe('600');
  });
});
