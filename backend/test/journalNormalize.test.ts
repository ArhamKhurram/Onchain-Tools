import { describe, expect, it } from 'vitest';
import {
  normalizeWalletTransactions,
  txDeltas,
  WSOL_MINT,
  type HeliusEnhancedTx,
} from '../src/journal/normalize.js';

const W = 'JournalWa11etAddre55xxxxxxxxxxxxxxxxxxxxxxx';
const POOL = 'Poo1Addre55xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const TOK = 'TokenMintAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const TOK2 = 'TokenMintBxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

let sigCounter = 0;
function tx(partial: Partial<HeliusEnhancedTx>): HeliusEnhancedTx {
  return {
    signature: partial.signature ?? `sig-${++sigCounter}`,
    timestamp: partial.timestamp ?? 1_754_900_000,
    fee: 5_000,
    feePayer: W,
    ...partial,
  };
}

describe('txDeltas', () => {
  it('adds the tx fee back when the wallet was fee payer', () => {
    const t = tx({
      tokenTransfers: [{ mint: TOK, tokenAmount: 1000, fromUserAccount: POOL, toUserAccount: W }],
      // Spent 2 SOL on the swap + 0.001 fee.
      accountData: [{ account: W, nativeBalanceChange: -2_001_000_000 }],
      fee: 1_000_000,
      feePayer: W,
    });
    const { nativeSol } = txDeltas(t, W);
    expect(nativeSol).toBeCloseTo(-2.0, 9);
  });

  it('does not add the fee back when someone else paid it', () => {
    const t = tx({
      tokenTransfers: [{ mint: TOK, tokenAmount: 1000, fromUserAccount: POOL, toUserAccount: W }],
      accountData: [{ account: W, nativeBalanceChange: -2_000_000_000 }],
      fee: 1_000_000,
      feePayer: POOL,
    });
    const { nativeSol } = txDeltas(t, W);
    expect(nativeSol).toBeCloseTo(-2.0, 9);
  });

  it('does not double-count a same-tx wSOL wrap/unwrap (net wSOL change 0)', () => {
    // Jupiter route: 1.5 SOL wrapped → swapped → wSOL account closed. The
    // 1.5 wSOL tokenTransfer is transfer VOLUME already reflected in the
    // lamports change; folding it in would double the SOL leg.
    const t = tx({
      tokenTransfers: [
        { mint: WSOL_MINT, tokenAmount: 1.5, fromUserAccount: W, toUserAccount: POOL },
        { mint: TOK, tokenAmount: 500, fromUserAccount: POOL, toUserAccount: W },
      ],
      accountData: [
        {
          account: W,
          nativeBalanceChange: -1_500_005_000,
          tokenBalanceChanges: [],
        },
        {
          account: 'WSo1TokenAccountxxxxxxxxxxxxxxxxxxxxxxxxxxx',
          nativeBalanceChange: 0,
          // Created +1.5, closed -1.5 within the tx → net 0.
          tokenBalanceChanges: [
            { mint: WSOL_MINT, userAccount: W, rawTokenAmount: { tokenAmount: '0', decimals: 9 } },
          ],
        },
      ],
      fee: 5_000,
      feePayer: W,
    });
    const { tokenDelta, nativeSol } = txDeltas(t, W);
    expect(tokenDelta.get(TOK)).toBe(500);
    expect(tokenDelta.has(WSOL_MINT)).toBe(false);
    expect(nativeSol).toBeCloseTo(-1.5, 9);
  });

  it('folds a PERSISTENT wSOL balance change into the SOL leg', () => {
    // Sell where proceeds stay as wSOL: lamports barely move, but the wallet
    // genuinely received 0.9 SOL worth of wSOL.
    const t = tx({
      tokenTransfers: [
        { mint: TOK, tokenAmount: 800, fromUserAccount: W, toUserAccount: POOL },
        { mint: WSOL_MINT, tokenAmount: 0.9, fromUserAccount: POOL, toUserAccount: W },
      ],
      accountData: [
        { account: W, nativeBalanceChange: -5_000 },
        {
          account: 'WSo1TokenAccountxxxxxxxxxxxxxxxxxxxxxxxxxxx',
          nativeBalanceChange: 0,
          tokenBalanceChanges: [
            { mint: WSOL_MINT, userAccount: W, rawTokenAmount: { tokenAmount: '900000000', decimals: 9 } },
          ],
        },
      ],
      fee: 5_000,
      feePayer: W,
    });
    const { tokenDelta, nativeSol } = txDeltas(t, W);
    expect(tokenDelta.get(TOK)).toBe(-800);
    expect(nativeSol).toBeCloseTo(0.9, 9);
  });

  it('drops aggregator routing residue (both-ways flow, net < 1% of gross)', () => {
    const t = tx({
      tokenTransfers: [
        // TOK2 hops through the wallet: 200 in, 199.9 out → net 0.1 on gross
        // 399.9 → residue, not a position change.
        { mint: TOK2, tokenAmount: 200, fromUserAccount: POOL, toUserAccount: W },
        { mint: TOK2, tokenAmount: 199.9, fromUserAccount: W, toUserAccount: POOL },
        { mint: TOK, tokenAmount: 1000, fromUserAccount: POOL, toUserAccount: W },
      ],
      accountData: [{ account: W, nativeBalanceChange: -1_000_005_000 }],
    });
    const { tokenDelta } = txDeltas(t, W);
    expect(tokenDelta.has(TOK2)).toBe(false);
    expect(tokenDelta.get(TOK)).toBe(1000);
  });
});

describe('normalizeWalletTransactions', () => {
  it('decodes a pump.fun bonding-curve buy typed UNKNOWN from deltas', () => {
    const t = tx({
      type: 'UNKNOWN',
      source: 'PUMP_FUN',
      tokenTransfers: [{ mint: TOK, tokenAmount: 250_000, fromUserAccount: POOL, toUserAccount: W }],
      accountData: [{ account: W, nativeBalanceChange: -505_000_000 }],
      fee: 5_000_000,
      feePayer: W,
    });
    const { swaps } = normalizeWalletTransactions([t], W);
    expect(swaps).toHaveLength(1);
    expect(swaps[0]).toMatchObject({ side: 'buy', mint: TOK, amountToken: 250_000, dex: 'PUMP_FUN' });
    expect(swaps[0].amountSol).toBeCloseTo(0.5, 9);
  });

  it('classifies a sell for SOL', () => {
    const t = tx({
      tokenTransfers: [{ mint: TOK, tokenAmount: 250_000, fromUserAccount: W, toUserAccount: POOL }],
      accountData: [{ account: W, nativeBalanceChange: 1_200_000_000 }],
      fee: 5_000,
      feePayer: W,
    });
    const { swaps } = normalizeWalletTransactions([t], W);
    expect(swaps).toHaveLength(1);
    expect(swaps[0].side).toBe('sell');
    expect(swaps[0].amountSol).toBeCloseTo(1.200005, 9);
    expect(swaps[0].amountUsd).toBeNull();
  });

  it('prices a stable-paid buy at face value with no SOL leg', () => {
    const t = tx({
      tokenTransfers: [
        { mint: USDC, tokenAmount: 150, fromUserAccount: W, toUserAccount: POOL },
        { mint: TOK, tokenAmount: 3_000, fromUserAccount: POOL, toUserAccount: W },
      ],
      accountData: [{ account: W, nativeBalanceChange: -5_000 }],
    });
    const { swaps } = normalizeWalletTransactions([t], W);
    expect(swaps).toHaveLength(1);
    expect(swaps[0]).toMatchObject({ side: 'buy', mint: TOK, amountSol: null, amountUsd: 150 });
  });

  it('records token-in with nothing paid as a transfer-in, NOT a trade', () => {
    const t = tx({
      type: 'TRANSFER',
      tokenTransfers: [{ mint: TOK, tokenAmount: 10_000, fromUserAccount: POOL, toUserAccount: W }],
      accountData: [{ account: W, nativeBalanceChange: 0 }],
      fee: 0,
      feePayer: POOL,
    });
    const { swaps, transferIns } = normalizeWalletTransactions([t], W);
    expect(swaps).toHaveLength(0);
    expect(transferIns).toHaveLength(1);
    expect(transferIns[0]).toMatchObject({ mint: TOK, amountToken: 10_000 });
  });

  it('splits a token-to-token swap into a sell leg and a buy leg', () => {
    const t = tx({
      tokenTransfers: [
        { mint: TOK, tokenAmount: 500, fromUserAccount: W, toUserAccount: POOL },
        { mint: TOK2, tokenAmount: 900, fromUserAccount: POOL, toUserAccount: W },
      ],
      accountData: [{ account: W, nativeBalanceChange: -5_000 }],
    });
    const { swaps } = normalizeWalletTransactions([t], W);
    expect(swaps).toHaveLength(2);
    const sell = swaps.find((s) => s.side === 'sell');
    const buy = swaps.find((s) => s.side === 'buy');
    expect(sell).toMatchObject({ mint: TOK, amountToken: 500, amountSol: null });
    expect(buy).toMatchObject({ mint: TOK2, amountToken: 900, amountSol: null });
    expect(sell!.signature).toBe(buy!.signature);
  });

  it('skips failed txs, plain SOL transfers, and duplicate signatures', () => {
    const failed = tx({
      transactionError: { InstructionError: [0, 'Custom'] },
      tokenTransfers: [{ mint: TOK, tokenAmount: 100, fromUserAccount: POOL, toUserAccount: W }],
      accountData: [{ account: W, nativeBalanceChange: -1_000_000_000 }],
    });
    const plain = tx({
      type: 'TRANSFER',
      accountData: [{ account: W, nativeBalanceChange: -3_000_000_000 }],
    });
    const buy = tx({
      signature: 'dup-sig',
      tokenTransfers: [{ mint: TOK, tokenAmount: 100, fromUserAccount: POOL, toUserAccount: W }],
      accountData: [{ account: W, nativeBalanceChange: -1_000_005_000 }],
    });
    const { swaps } = normalizeWalletTransactions([failed, plain, buy, { ...buy }], W);
    expect(swaps).toHaveLength(1);
    expect(swaps[0].signature).toBe('dup-sig');
  });

  it('leaves the native split null on a multi-token buy instead of guessing', () => {
    const t = tx({
      tokenTransfers: [
        { mint: TOK, tokenAmount: 100, fromUserAccount: POOL, toUserAccount: W },
        { mint: TOK2, tokenAmount: 200, fromUserAccount: POOL, toUserAccount: W },
      ],
      accountData: [{ account: W, nativeBalanceChange: -2_000_005_000 }],
    });
    const { swaps } = normalizeWalletTransactions([t], W);
    expect(swaps).toHaveLength(2);
    for (const s of swaps) {
      expect(s.side).toBe('buy');
      expect(s.amountSol).toBeNull();
      expect(s.amountUsd).toBeNull();
    }
  });

  it('sorts output oldest-first regardless of input order', () => {
    const older = tx({
      signature: 'older',
      timestamp: 1_754_000_000,
      tokenTransfers: [{ mint: TOK, tokenAmount: 10, fromUserAccount: POOL, toUserAccount: W }],
      accountData: [{ account: W, nativeBalanceChange: -100_005_000 }],
    });
    const newer = tx({
      signature: 'newer',
      timestamp: 1_754_100_000,
      tokenTransfers: [{ mint: TOK, tokenAmount: 10, fromUserAccount: W, toUserAccount: POOL }],
      accountData: [{ account: W, nativeBalanceChange: 200_000_000 }],
    });
    const { swaps } = normalizeWalletTransactions([newer, older], W);
    expect(swaps.map((s) => s.signature)).toEqual(['older', 'newer']);
  });
});
