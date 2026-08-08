import { describe, it, expect } from 'vitest';
import { isValidMint, isValidAddress, parseMintsBody } from '../src/pumpfun/routes';

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

describe('parseMintsBody (POST /pnl body validation)', () => {
  it('accepts a body with an array of valid mints (base58 and EVM)', () => {
    const out = parseMintsBody({ mints: [SOL_MINT, EVM] });
    expect(out).toEqual({ mints: [SOL_MINT, EVM] });
  });

  it('rejects a non-object body', () => {
    for (const bad of [null, undefined, 'mints', 42, [SOL_MINT]]) {
      expect(parseMintsBody(bad)).toHaveProperty('error');
    }
  });

  it('rejects a missing or non-array mints field', () => {
    expect(parseMintsBody({})).toHaveProperty('error');
    expect(parseMintsBody({ mints: 'nope' })).toHaveProperty('error');
    expect(parseMintsBody({ mints: {} })).toHaveProperty('error');
  });

  it('rejects an empty mints array', () => {
    expect(parseMintsBody({ mints: [] })).toHaveProperty('error');
  });

  it('rejects an array carrying a junk mint (must never reach the upstream POST)', () => {
    for (const junk of ['nope', '', '../../etc/passwd', `${SOL_MINT}/x`, 42, null]) {
      expect(parseMintsBody({ mints: [SOL_MINT, junk] })).toHaveProperty('error');
    }
  });

  it('rejects an over-long mints array (amplification guard)', () => {
    const many = Array.from({ length: 101 }, () => SOL_MINT);
    expect(parseMintsBody({ mints: many })).toHaveProperty('error');
  });

  it('accepts a mints array exactly at the cap', () => {
    const capped = Array.from({ length: 100 }, () => SOL_MINT);
    expect(parseMintsBody({ mints: capped })).toEqual({ mints: capped });
  });
});
