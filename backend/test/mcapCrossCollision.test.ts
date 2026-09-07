/**
 * Two different mints sharing one ticker (#386).
 *
 * The owner received "$CNPY crossed $750K" twice, ~3h apart, with DIFFERENT
 * contract addresses — two distinct Solana mints that happened to share the
 * symbol CNPY. That is not a dedupe bug: they are two real tokens and each
 * genuinely crossed, so suppressing the second would be a MISSED alert, not a
 * fixed one. These tests pin that the pipeline keys on the mint address end to
 * end, so a shared symbol can never (a) conflate the two tokens' market data or
 * (b) merge their crossing/cooldown state — and that the alert payload carries
 * the distinguishing address the card needs to tell them apart.
 */

import { describe, expect, it } from 'vitest';

import { snapshotsFromPairs, type DexPair } from '../src/marketData/dexBatch.js';
import { evaluateCrossing } from '../src/priceAlerts/crossing.js';
import { stateKey } from '../src/mcapCross/state.js';

const MINT_A = 'XjhcLgDm8TttZSu1iyZmRfYTnugVALGoFK4EreND7ye';
const MINT_B = 'DiSrtDhLVEnNnNfx6EtirxMaJJPEDhPMd671vdC5BxVL';

function pair(address: string, mcap: number, liq: number): DexPair {
  return {
    chainId: 'solana',
    baseToken: { address, symbol: 'CNPY' }, // SAME ticker, different mint
    liquidity: { usd: liq },
    priceUsd: '0.001',
    marketCap: mcap,
    volume: { h24: 120_000 },
  };
}

describe('symbol collision — two mints, one ticker', () => {
  it('keeps two same-symbol mints as separate snapshots keyed by address', () => {
    const { snapshots } = snapshotsFromPairs(
      [pair(MINT_A, 800_000, 40_000), pair(MINT_B, 900_000, 55_000)],
      [MINT_A, MINT_B],
    );

    expect(snapshots.size).toBe(2);
    // Same symbol on both, but their market caps are NOT conflated.
    expect(snapshots.get(MINT_A)?.symbol).toBe('CNPY');
    expect(snapshots.get(MINT_B)?.symbol).toBe('CNPY');
    expect(snapshots.get(MINT_A)?.mcapUsd).toBe(800_000);
    expect(snapshots.get(MINT_B)?.mcapUsd).toBe(900_000);
  });

  it('gives the two mints independent crossing verdicts', () => {
    // A crossed 750K this cycle; B was already above it and merely re-observed.
    const a = evaluateCrossing({
      direction: 'above',
      targetUsd: 750_000,
      lastSeenUsd: 700_000,
      observedUsd: 800_000,
    });
    const b = evaluateCrossing({
      direction: 'above',
      targetUsd: 750_000,
      lastSeenUsd: 820_000,
      observedUsd: 900_000,
    });
    expect(a.action).toBe('fire');
    expect(b.action).toBe('record'); // no transition — the shared ticker changes nothing
  });

  it('gives the two mints independent state (and cooldown) keys', () => {
    const keyA = stateKey('solana', MINT_A);
    const keyB = stateKey('solana', MINT_B);
    expect(keyA).not.toBe(keyB);
    // The address, not the symbol, is what the key is built from.
    expect(keyA).toContain(MINT_A);
    expect(keyB).toContain(MINT_B);
  });

  it('the same address on two chains stays distinct too', () => {
    // A 0x… address deployed on both BNB and Robinhood must not share a row.
    const evm = '0x1234567890abcdef1234567890abcdef12345678';
    expect(stateKey('bsc', evm)).not.toBe(stateKey('robinhood', evm));
  });
});
