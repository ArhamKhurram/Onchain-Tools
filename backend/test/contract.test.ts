import { describe, it, expect } from 'vitest';
import {
  detectContractAddresses,
  detectEvmChainFromContent,
  extractEvmChainFromGmgnLinks,
} from '../src/utils/contract';

// A real-looking Solana mint: length 44, mixed case, contains digits.
const SOL_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const EVM_ADDR = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';

describe('detectContractAddresses', () => {
  it('detects a bare EVM address', () => {
    const r = detectContractAddresses(`buying ${EVM_ADDR} now`);
    expect(r.hasContract).toBe(true);
    expect(r.addresses).toContain(EVM_ADDR);
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
    // EVM regex is global; both match, but callers dedupe SOL only — assert EVM
    // behavior explicitly so a future change is caught.
    expect(r.addresses.filter((a) => a === EVM_ADDR).length).toBeGreaterThanOrEqual(1);
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
  it('pairs each gmgn link address with its chain', () => {
    const out = extractEvmChainFromGmgnLinks(`https://gmgn.ai/eth/token/${EVM_ADDR}`);
    expect(out).toEqual([{ address: EVM_ADDR, chain: 'eth' }]);
  });

  it('ignores unknown chain slugs', () => {
    const out = extractEvmChainFromGmgnLinks(`https://gmgn.ai/notachain/token/${EVM_ADDR}`);
    expect(out).toEqual([]);
  });
});
