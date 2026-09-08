// The Flap detector's PURE core: factory→chain/resolver mapping, the event
// signature + getter selectors, ABI decoding, and — the security-relevant part
// — narrowing an UNTRUSTED eth_getLogs entry into a typed event or null.

import { describe, it, expect } from 'vitest';
import {
  FLAP_TOPIC0,
  RWA_ASSET_SELECTOR,
  SUPPORTED_ASSETS_SELECTOR,
  SYMBOL_SELECTOR,
  BSC_VAULTPORTAL,
  STOCK_FACTORIES,
  flapFactory,
  flapChainForFactory,
  factoryAddressesForChain,
  addressFromTopic,
  addressTopic,
  decodeAddressResult,
  decodeAddressArrayResult,
  decodeStringResult,
  parseVaultCreatedLog,
  type RawLog,
} from '../src/flap/detect';

const BSC_V1 = '0xf8aC088F06D155f3C3F531f1Ef80B14f1604530a';
const BSC_V2 = '0x40a9a2FDa017E0923EA0B403F2f063f9E51168Fb';
const BSC_V3 = '0x5418f7e8fF90354DB0eCD48c8b710219244Eb3C5';
const RH_V3 = '0xe6ca297D1d963b6F00d5b216986123CAeB883AF6';

/** A 32-byte ABI word (no 0x) for an address, for building call/log fixtures. */
function addrWord(addr: string): string {
  return addr.replace(/^0x/, '').toLowerCase().padStart(64, '0');
}

describe('flap constants', () => {
  it('pins the validated event topic0 and getter selectors', () => {
    expect(FLAP_TOPIC0).toBe(
      '0x1a9fe01bcb4855c926d7757a81014e36cae596a0e3047d297d2cf88ca298a77d',
    );
    expect(RWA_ASSET_SELECTOR).toBe('0xb84c8056');
    expect(SUPPORTED_ASSETS_SELECTOR).toBe('0xa80ce55c');
    expect(SYMBOL_SELECTOR).toBe('0x95d89b41');
    expect(BSC_VAULTPORTAL.toLowerCase()).toBe('0x90497450f2a706f1951b5bdda52b4e5d16f34c06');
  });
});

describe('factory allowlist → chain / resolver', () => {
  it('maps the three BNB factories to bsc, v1/v2 single and v3 array', () => {
    expect(flapFactory(BSC_V1)).toEqual({ chain: 'bsc', resolver: 'single' });
    expect(flapFactory(BSC_V2)).toEqual({ chain: 'bsc', resolver: 'single' });
    expect(flapFactory(BSC_V3)).toEqual({ chain: 'bsc', resolver: 'array' });
  });

  it('maps the Robinhood v3 factory to robinhood/array', () => {
    expect(flapFactory(RH_V3)).toEqual({ chain: 'robinhood', resolver: 'array' });
    expect(flapChainForFactory(RH_V3)).toBe('robinhood');
  });

  it('is case-insensitive and rejects unknown factories', () => {
    expect(flapChainForFactory(BSC_V1.toLowerCase())).toBe('bsc');
    expect(flapFactory('0x0000000000000000000000000000000000000001')).toBeNull();
    expect(flapChainForFactory('not-an-address')).toBeNull();
  });

  it('lists exactly the per-chain factory set (the eth_getLogs filter)', () => {
    const bsc = factoryAddressesForChain('bsc');
    expect(new Set(bsc)).toEqual(
      new Set([BSC_V1, BSC_V2, BSC_V3].map((a) => a.toLowerCase())),
    );
    expect(factoryAddressesForChain('robinhood')).toEqual([RH_V3.toLowerCase()]);
    // Every catalogued factory belongs to a watched chain.
    expect(Object.keys(STOCK_FACTORIES)).toHaveLength(4);
  });
});

describe('ABI decoding (untrusted RPC returns)', () => {
  it('addressFromTopic extracts a left-padded address, rejecting non-address words', () => {
    const addr = '0x1111111111111111111111111111111111111111';
    expect(addressFromTopic(`0x${addrWord(addr)}`)).toBe(addr);
    // Upper 12 bytes non-zero → not an address word.
    expect(addressFromTopic(`0x${'01'.repeat(32)}`)).toBeNull();
    // Zero address is never a real value.
    expect(addressFromTopic(`0x${'0'.repeat(64)}`)).toBeNull();
    expect(addressFromTopic('0xdeadbeef')).toBeNull();
    expect(addressFromTopic(123 as unknown)).toBeNull();
  });

  it('decodeAddressResult reads rwaAsset()', () => {
    const asset = '0xabababababababababababababababababababab';
    expect(decodeAddressResult(`0x${addrWord(asset)}`)).toBe(asset);
    expect(decodeAddressResult('0x')).toBeNull();
    expect(decodeAddressResult(null)).toBeNull();
  });

  it('decodeAddressArrayResult reads supportedAssets()', () => {
    const a = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const b = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const offset = (32).toString(16).padStart(64, '0');
    const len = (2).toString(16).padStart(64, '0');
    const data = `0x${offset}${len}${addrWord(a)}${addrWord(b)}`;
    expect(decodeAddressArrayResult(data)).toEqual([a, b]);
    // A truncated buffer must not read past the end.
    expect(decodeAddressArrayResult(`0x${offset}${len}${addrWord(a)}`)).toBeNull();
    expect(decodeAddressArrayResult('0x')).toBeNull();
  });

  it('decodeStringResult reads a dynamic string and a bytes32 fallback', () => {
    // Dynamic "FXIon".
    const sym = Buffer.from('FXIon', 'utf8').toString('hex');
    const offset = (32).toString(16).padStart(64, '0');
    const len = (5).toString(16).padStart(64, '0');
    const dyn = `0x${offset}${len}${sym.padEnd(64, '0')}`;
    expect(decodeStringResult(dyn)).toBe('FXIon');
    // bytes32 "NVDAB".
    const b32 = `0x${Buffer.from('NVDAB', 'utf8').toString('hex').padEnd(64, '0')}`;
    expect(decodeStringResult(b32)).toBe('NVDAB');
    // Control chars are stripped; empty → null.
    expect(decodeStringResult(`0x${'0'.repeat(64)}`)).toBeNull();
    expect(decodeStringResult('0x')).toBeNull();
  });
});

describe('parseVaultCreatedLog — untrusted-log narrowing', () => {
  const token = '0x1111111111111111111111111111111111111111';
  const vault = '0x2222222222222222222222222222222222222222';
  const goodLog = (): RawLog => ({
    address: BSC_VAULTPORTAL,
    topics: [FLAP_TOPIC0, addressTopic(token), addressTopic(vault), addressTopic(BSC_V3)],
    data: '0x',
    blockNumber: '0x1a2b3c',
  });

  it('accepts a well-formed event and lowercases every address', () => {
    const ev = parseVaultCreatedLog(goodLog(), BSC_VAULTPORTAL);
    expect(ev).toEqual({
      token,
      vault,
      factory: BSC_V3.toLowerCase(),
      blockNumber: 0x1a2b3c,
    });
  });

  it('rejects a log from a different emitter', () => {
    const log = { ...goodLog(), address: '0x9999999999999999999999999999999999999999' };
    expect(parseVaultCreatedLog(log, BSC_VAULTPORTAL)).toBeNull();
  });

  it('rejects a different topic0', () => {
    const log = goodLog();
    (log.topics as string[])[0] = `0x${'ff'.repeat(32)}`;
    expect(parseVaultCreatedLog(log, BSC_VAULTPORTAL)).toBeNull();
  });

  it('rejects missing indexed args and hostile shapes', () => {
    expect(parseVaultCreatedLog({ ...goodLog(), topics: [FLAP_TOPIC0] }, BSC_VAULTPORTAL)).toBeNull();
    expect(parseVaultCreatedLog({ ...goodLog(), topics: 'nope' }, BSC_VAULTPORTAL)).toBeNull();
    expect(parseVaultCreatedLog({ ...goodLog(), address: 42 }, BSC_VAULTPORTAL)).toBeNull();
    const badToken = goodLog();
    (badToken.topics as string[])[1] = `0x${'01'.repeat(32)}`; // not an address word
    expect(parseVaultCreatedLog(badToken, BSC_VAULTPORTAL)).toBeNull();
  });

  it('does not itself allowlist-check the factory (caller decides)', () => {
    const log = goodLog();
    const stranger = '0x0000000000000000000000000000000000009999';
    (log.topics as string[])[3] = addressTopic(stranger);
    const ev = parseVaultCreatedLog(log, BSC_VAULTPORTAL);
    expect(ev?.factory).toBe(stranger);
    expect(flapFactory(stranger)).toBeNull(); // …but the poller drops it
  });
});
