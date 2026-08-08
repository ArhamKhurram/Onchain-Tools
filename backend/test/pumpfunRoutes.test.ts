import { describe, it, expect } from 'vitest';
import { isValidMint, isValidAddress } from '../src/pumpfun/routes';

// A real Solana mint (WSOL) and wallet, plus a real EVM address, as the accepted
// cases; junk of every wrong shape as the rejected cases. The route calls these
// BEFORE touching the network, so a bad param must never reach the client.
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SOL_WALLET = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const EVM = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';

describe('isValidMint', () => {
  it('accepts a base58 Solana mint', () => {
    expect(isValidMint(SOL_MINT)).toBe(true);
  });

  it('accepts an EVM 0x-address mint', () => {
    expect(isValidMint(EVM)).toBe(true);
  });

  it('rejects junk, empty, path traversal, and out-of-alphabet input', () => {
    for (const bad of [
      '',
      'nope',
      '../../etc/passwd',
      '0x1234', // too-short hex
      'l0OI00000000000000000000000000000', // 0/O/I/l are not in the base58 alphabet
      `${SOL_MINT}/callouts`, // a param carrying a slash
    ]) {
      expect(isValidMint(bad)).toBe(false);
    }
  });

  it('rejects a base58 string shorter than 32 chars', () => {
    expect(isValidMint('abc')).toBe(false);
  });

  it('rejects a base58 string longer than 44 chars', () => {
    expect(isValidMint('1'.repeat(45))).toBe(false);
  });
});

describe('isValidAddress', () => {
  it('accepts a base58 Solana wallet', () => {
    expect(isValidAddress(SOL_WALLET)).toBe(true);
  });

  it('rejects an EVM address (wallets are Solana-only here)', () => {
    expect(isValidAddress(EVM)).toBe(false);
  });

  it('rejects junk and out-of-alphabet input', () => {
    for (const bad of ['', 'nope', '../secrets', 'IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII']) {
      expect(isValidAddress(bad)).toBe(false);
    }
  });
});
