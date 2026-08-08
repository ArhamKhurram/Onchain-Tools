import { describe, it, expect } from 'vitest';
import {
  addTrackedWallet,
  deriveTradeSide,
  formatMcap,
  formatMultiplier,
  isPumpMint,
  isPumpWallet,
  normalizeTrackedList,
  removeTrackedWallet,
  walletMintsFromTransactions,
  type PumpSwapTransaction,
  type PumpTransaction,
  type TrackedPumpWallet,
} from '../src/types/pumpfun';

// These helpers back the pump.fun tab. Each `it` guards a specific bug the way
// sniperRules.test.ts does — the tab's correctness (which wallets it will fetch,
// how a call reads, whether a missing key blanks trades) rides on them, and none
// touches the network.

const WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const EVM = '0x1234567890abcdef1234567890abcdef12345678';

describe('isPumpWallet', () => {
  it('accepts a base58 Solana address', () => {
    expect(isPumpWallet(WALLET)).toBe(true);
  });

  it('trims surrounding whitespace before validating', () => {
    // The bug this guards: a pasted address often carries a trailing newline or
    // space. Without the trim the paste is rejected as malformed and the operator
    // cannot track a perfectly good wallet.
    expect(isPumpWallet(`  ${WALLET}\n`)).toBe(true);
  });

  it('rejects an EVM address — wallets are Solana-only here', () => {
    // The bug this guards: the backend wallet routes validate base58 ONLY
    // (isValidAddress), so accepting an 0x address client-side would send a
    // request the API 400s, presenting as a wallet that tracks but never loads.
    expect(isPumpWallet(EVM)).toBe(false);
  });

  it('rejects junk and empty input', () => {
    expect(isPumpWallet('not-an-address')).toBe(false);
    expect(isPumpWallet('')).toBe(false);
  });
});

describe('isPumpMint', () => {
  it('accepts both a base58 mint and an EVM 0x-address', () => {
    // Mirrors the backend's isValidMint: a mint may be Solana base58 OR an EVM
    // address on the chains coin-communities indexes. Rejecting the 0x form would
    // make EVM tokens unlookupable in the token tab.
    expect(isPumpMint(WALLET)).toBe(true);
    expect(isPumpMint(EVM)).toBe(true);
  });

  it('rejects a malformed 0x address', () => {
    expect(isPumpMint('0xZZZ')).toBe(false);
  });
});

describe('addTrackedWallet', () => {
  const base: TrackedPumpWallet[] = [{ address: WALLET, addedAt: 100 }];

  it('prepends a new valid wallet newest-first', () => {
    const other = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    const res = addTrackedWallet(base, other, 200);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.list[0]).toEqual({ address: other, addedAt: 200 });
      expect(res.list).toHaveLength(2);
    }
  });

  it('refuses a duplicate rather than adding a second row', () => {
    // The bug this guards: a duplicate row would render twice and double every
    // per-wallet fetch. The refusal is typed so the UI can say "already tracking".
    const res = addTrackedWallet(base, WALLET);
    expect(res).toEqual({ ok: false, reason: 'duplicate' });
  });

  it('refuses an invalid address', () => {
    expect(addTrackedWallet(base, 'garbage')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('trims before checking for a duplicate', () => {
    // A padded paste of an already-tracked wallet must still be caught as a
    // duplicate, not slip in as a distinct row with whitespace baked into its key.
    const res = addTrackedWallet(base, `  ${WALLET} `);
    expect(res).toEqual({ ok: false, reason: 'duplicate' });
  });
});

describe('removeTrackedWallet', () => {
  it('drops the matching wallet and leaves the rest', () => {
    const list: TrackedPumpWallet[] = [
      { address: WALLET, addedAt: 1 },
      { address: EVM, addedAt: 2 },
    ];
    expect(removeTrackedWallet(list, WALLET)).toEqual([{ address: EVM, addedAt: 2 }]);
  });

  it('is a no-op when the address is not present', () => {
    const list: TrackedPumpWallet[] = [{ address: WALLET, addedAt: 1 }];
    expect(removeTrackedWallet(list, 'other')).toEqual(list);
  });
});

describe('normalizeTrackedList', () => {
  it('drops non-array, junk rows, invalid addresses and duplicates', () => {
    // The bug this guards: localStorage is attacker-adjacent (any script on the
    // origin, or a hand-edited value) and can hold anything. A junk row that
    // survived would be fetched as a wallet, and a duplicate would double-fetch.
    expect(normalizeTrackedList('nope')).toEqual([]);
    const parsed = [
      { address: WALLET, addedAt: 5 },
      { address: WALLET, addedAt: 9 }, // duplicate
      { address: 'bad', addedAt: 1 }, // invalid
      { nope: true }, // no address
      42, // not an object
    ];
    expect(normalizeTrackedList(parsed)).toEqual([{ address: WALLET, addedAt: 5 }]);
  });

  it('defaults a missing addedAt to 0 rather than dropping the row', () => {
    expect(normalizeTrackedList([{ address: WALLET }])).toEqual([{ address: WALLET, addedAt: 0 }]);
  });
});

describe('formatMultiplier', () => {
  it('renders a multiplier with an x suffix', () => {
    expect(formatMultiplier(2.5)).toBe('2.5x');
    expect(formatMultiplier(10)).toBe('10x');
  });

  it('renders null as an em dash, NOT 0x', () => {
    // The bug this guards: a callout with no price basis has a null multiplier.
    // Coercing that to 0x would read as "this call went to zero" — the opposite
    // of "unknown".
    expect(formatMultiplier(null)).toBe('—');
  });
});

describe('formatMcap', () => {
  it('compacts thousands, millions and billions', () => {
    expect(formatMcap(1_234_567)).toBe('$1.23M');
    expect(formatMcap(2_500_000_000)).toBe('$2.50B');
    expect(formatMcap(4_200)).toBe('$4.2K');
    expect(formatMcap(150)).toBe('$150');
  });

  it('renders null as an em dash', () => {
    expect(formatMcap(null)).toBe('—');
  });
});

describe('deriveTradeSide', () => {
  const swap = (side: string | null): PumpSwapTransaction => ({
    type: 'SWAP',
    txHash: 'sig',
    blockTime: 1,
    fee: 0,
    side,
    tokenIn: null,
    tokenOut: null,
    solValue: 1,
    token: 'mint',
    tokenSymbol: 'X',
    amount: 1,
  });

  it('reads BUY/SELL case-insensitively', () => {
    expect(deriveTradeSide(swap('BUY'))).toBe('buy');
    expect(deriveTradeSide(swap('sell'))).toBe('sell');
  });

  it('degrades an unknown or missing side to "unknown", never "buy"', () => {
    // The bug this guards: defaulting an unlabeled swap to 'buy' would silently
    // mislabel every row the venue did not tag as a purchase, inverting a
    // trader's read of their own activity.
    expect(deriveTradeSide(swap(null))).toBe('unknown');
    expect(deriveTradeSide(swap('weird'))).toBe('unknown');
  });
});

describe('walletMintsFromTransactions', () => {
  const swap = (token: string | null): PumpSwapTransaction => ({
    type: 'SWAP',
    txHash: `sig-${token}`,
    blockTime: 1,
    fee: 0,
    side: 'BUY',
    tokenIn: null,
    tokenOut: null,
    solValue: 1,
    token,
    tokenSymbol: null,
    amount: 1,
  });

  it('collects unique swap mints and skips non-swaps and null mints', () => {
    const txs: PumpTransaction[] = [
      swap('A'),
      swap('A'), // duplicate mint
      swap(null), // no coin leg
      { type: 'FEE_CLAIM', txHash: 'f', blockTime: 1, fee: 0, transactionType: null, direction: null, tokenTransferred: null, fromAddress: null, toAddress: null },
      swap('B'),
    ];
    expect(walletMintsFromTransactions(txs)).toEqual(['A', 'B']);
  });

  it('caps the list so the PnL POST cannot exceed the backend limit', () => {
    // The bug this guards: the backend caps the PnL body at MAX_PNL_MINTS (100).
    // An uncapped client list would build a body the API 400s, so the deliberate
    // PnL button would always fail on an active wallet.
    const many: PumpTransaction[] = Array.from({ length: 250 }, (_, i) => swap(`mint-${i}`));
    expect(walletMintsFromTransactions(many)).toHaveLength(100);
  });
});
