import { describe, it, expect } from 'vitest';
import {
  detectContractAddresses,
  detectEvmChainFromContent,
  extractEvmChainFromGmgnLinks,
  isEvmAddress,
  normalizeContractAddress,
} from '../src/utils/contract';

// A real-looking Solana mint: length 44, mixed case, contains digits.
const SOL_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
// EIP-55 checksummed, the way a scanner bot prints it.
const EVM_ADDR = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';
const EVM_CANON = EVM_ADDR.toLowerCase();

describe('detectContractAddresses', () => {
  it('detects a bare EVM address', () => {
    const r = detectContractAddresses(`buying ${EVM_ADDR} now`);
    expect(r.hasContract).toBe(true);
    expect(r.addresses).toContain(EVM_CANON);
  });

  it('detects a Solana mint (digits + mixed case + length >= 40)', () => {
    const r = detectContractAddresses(`ca: ${SOL_MINT}`);
    expect(r.hasContract).toBe(true);
    expect(r.addresses).toContain(SOL_MINT);
  });

  it('ignores addresses embedded in URLs', () => {
    const r = detectContractAddresses(`https://etherscan.io/token/${EVM_ADDR}`);
    expect(r.hasContract).toBe(false);
    expect(r.addresses).toHaveLength(0);
  });

  it('unwraps markdown links, keeping only the label text', () => {
    // The address is in the URL target, not the label, so it must be stripped.
    const r = detectContractAddresses(`[view chart](https://dex.com/${EVM_ADDR})`);
    expect(r.hasContract).toBe(false);
  });

  it('returns no contract for plain prose', () => {
    const r = detectContractAddresses('gm, wen lambo?');
    expect(r.hasContract).toBe(false);
    expect(r.addresses).toEqual([]);
  });

  it('does not duplicate a repeated address', () => {
    const r = detectContractAddresses(`${EVM_ADDR} ${EVM_ADDR}`);
    expect(r.addresses).toEqual([EVM_CANON]);
  });

  // The console raised two "Contract scan" toasts for one call because the
  // caller posted the address lowercase and Rick's embed reply carried it
  // EIP-55 checksummed — two different strings for the same token.
  it('canonicalises EVM addresses to lowercase regardless of source casing', () => {
    const fromCaller = detectContractAddresses('ca 0x2ec39b165e22944d2fee389219ee64e4924cffff');
    const fromRickEmbed = detectContractAddresses('NVDA RTX STOCKS 0x2Ec39B165e22944d2FEE389219ee64E4924cfffF');

    expect(fromCaller.addresses).toEqual(['0x2ec39b165e22944d2fee389219ee64e4924cffff']);
    expect(fromRickEmbed.addresses).toEqual(fromCaller.addresses);
  });

  // Base58 omits 0/O/I/l, so a checksummed address avoiding those characters is
  // a valid 41-char base58 run once its leading "0" is dropped — and mixed case,
  // so it passed the Solana heuristics. One address, two detections.
  it('does not report a phantom base58 mint inside a checksummed EVM address', () => {
    const r = detectContractAddresses('NVDA RTX STOCKS 0x2Ec39B165e22944d2FEE389219ee64E4924cfffF');
    expect(r.addresses).toEqual(['0x2ec39b165e22944d2fee389219ee64e4924cffff']);
  });

  it('still detects a real Solana mint alongside an EVM address', () => {
    const r = detectContractAddresses(`${EVM_ADDR} and ${SOL_MINT}`);
    expect(r.addresses).toEqual([EVM_CANON, SOL_MINT]);
  });

  it('collapses one message carrying the same EVM address in two casings', () => {
    const r = detectContractAddresses(`${EVM_ADDR} and again ${EVM_CANON}`);
    expect(r.addresses).toEqual([EVM_CANON]);
  });

  // Base58 is case-SENSITIVE: lowercasing a mint would point at a different
  // token (or nothing at all).
  it('never changes the casing of a Solana mint', () => {
    const r = detectContractAddresses(`ca: ${SOL_MINT}`);
    expect(r.addresses).toEqual([SOL_MINT]);
    expect(r.addresses[0]).not.toBe(SOL_MINT.toLowerCase());
  });
});

describe('normalizeContractAddress', () => {
  it('lowercases EVM addresses and trims surrounding whitespace', () => {
    expect(normalizeContractAddress(` ${EVM_ADDR} `)).toBe(EVM_CANON);
    expect(normalizeContractAddress(EVM_CANON)).toBe(EVM_CANON);
  });

  it('leaves base58 Solana mints untouched', () => {
    expect(normalizeContractAddress(SOL_MINT)).toBe(SOL_MINT);
  });

  it('leaves anything that is not a bare 0x address alone', () => {
    expect(normalizeContractAddress('0xNotAnAddress')).toBe('0xNotAnAddress');
    expect(normalizeContractAddress('0xABC')).toBe('0xABC');
  });

  it('classifies addresses by chain', () => {
    expect(isEvmAddress(EVM_ADDR)).toBe(true);
    expect(isEvmAddress(SOL_MINT)).toBe(false);
    expect(isEvmAddress(`${EVM_ADDR}00`)).toBe(false);
  });
});

describe('detectEvmChainFromContent', () => {
  it('reads the chain slug from a gmgn.ai token link', () => {
    expect(detectEvmChainFromContent(`https://gmgn.ai/base/token/${EVM_ADDR}`)).toBe('base');
  });

  it('maps a globe-labelled chain line (Rick-style embeds)', () => {
    expect(detectEvmChainFromContent('\u{1F310} Base @ Uniswap')).toBe('base');
  });

  it('normalizes chain aliases (bnb -> bsc)', () => {
    expect(detectEvmChainFromContent('\u{1F310} BNB')).toBe('bsc');
  });

  it('returns null when no chain is present (e.g. Solana)', () => {
    expect(detectEvmChainFromContent('just some text')).toBeNull();
  });
});

describe('extractEvmChainFromGmgnLinks', () => {
  it('pairs each gmgn link address with its chain, canonically cased', () => {
    const out = extractEvmChainFromGmgnLinks(`https://gmgn.ai/eth/token/${EVM_ADDR}`);
    expect(out).toEqual([{ address: EVM_CANON, chain: 'eth' }]);
  });

  it('ignores unknown chain slugs', () => {
    const out = extractEvmChainFromGmgnLinks(`https://gmgn.ai/notachain/token/${EVM_ADDR}`);
    expect(out).toEqual([]);
  });
});
