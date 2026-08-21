import { describe, it, expect } from 'vitest';
import { sanitizeUrl } from '../src/lib/analytics';

describe('sanitizeUrl (PostHog pageview scrubber)', () => {
  it('drops the query string', () => {
    expect(sanitizeUrl('https://onchaintools.tech/dashboard/feed?token=secret')).toBe(
      'https://onchaintools.tech/dashboard/feed',
    );
  });

  it('drops the hash', () => {
    expect(sanitizeUrl('https://onchaintools.tech/dashboard#0xdeadbeef')).toBe(
      'https://onchaintools.tech/dashboard',
    );
  });

  it('masks an EVM address in the path', () => {
    expect(
      sanitizeUrl('https://onchaintools.tech/dashboard/token/0x205812cdbed920aff76c6580abd681a46d11efc7'),
    ).toBe('https://onchaintools.tech/dashboard/token/:addr');
  });

  it('masks a Solana address in the path', () => {
    expect(
      sanitizeUrl('https://onchaintools.tech/t/Br3MCqduFMSzrdVvfdUQYXhwg11uLgmGFpfyzqrjqFEd'),
    ).toBe('https://onchaintools.tech/t/:addr');
  });

  it('leaves a plain dashboard path untouched', () => {
    expect(sanitizeUrl('https://onchaintools.tech/dashboard/callers')).toBe(
      'https://onchaintools.tech/dashboard/callers',
    );
  });

  it('handles a bare path with query', () => {
    expect(sanitizeUrl('/dashboard/portfolio?wallet=0xabc')).toBe('/dashboard/portfolio');
  });
});
