import { describe, it, expect } from 'vitest';
import { compactUsd, signedUsd, shortAddress, networkLabel } from '../src/components/fomo/thesisFormat';

describe('compactUsd', () => {
  it('formats magnitudes with B/M/K suffixes', () => {
    expect(compactUsd(2_500_000_000)).toBe('$2.50B');
    expect(compactUsd(1_250_000)).toBe('$1.3M');
    expect(compactUsd(9_990)).toBe('$10.0K');
    expect(compactUsd(999)).toBe('$999');
  });
  it('renders an em-dash for null/undefined', () => {
    expect(compactUsd(null)).toBe('—');
    expect(compactUsd(undefined)).toBe('—');
  });
});

describe('signedUsd', () => {
  it('prefixes the sign and formats the magnitude', () => {
    expect(signedUsd(42_000)).toBe('+$42.0K');
    expect(signedUsd(-120)).toBe('-$120');
    expect(signedUsd(0)).toBe('+$0');
  });
});

describe('shortAddress', () => {
  it('middle-truncates long addresses and leaves short ones alone', () => {
    expect(shortAddress('So11111111111111111111111111111111111111112')).toBe('So1111…1112');
    expect(shortAddress('0xabc')).toBe('0xabc');
  });
});

describe('networkLabel', () => {
  it('maps known FOMO network ids and falls back to the raw id', () => {
    expect(networkLabel(1399811149)).toBe('SOL');
    expect(networkLabel(56)).toBe('BSC');
    expect(networkLabel(143)).toBe('HOOD');
    expect(networkLabel(99999)).toBe('99999');
  });
});
