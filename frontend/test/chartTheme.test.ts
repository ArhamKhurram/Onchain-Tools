import { describe, it, expect } from 'vitest';
import { rgbFromTriplet, rgbWithAlpha } from '../src/lib/chartTheme';

// The `--oct-*` tokens are bare channel triplets so Tailwind can add alpha. A
// canvas needs a whole colour, so the bridge must wrap them — and refuse
// anything that is not a triplet rather than hand the canvas garbage.
describe('rgbFromTriplet', () => {
  it('wraps a bare triplet', () => {
    expect(rgbFromTriplet('45 210 122')).toBe('rgb(45 210 122)');
    expect(rgbFromTriplet('  45 210 122  ')).toBe('rgb(45 210 122)');
  });

  it('keeps a slash-alpha', () => {
    expect(rgbFromTriplet('45 210 122 / 0.14')).toBe('rgb(45 210 122 / 0.14)');
  });

  it('rejects empty, unset and non-triplet values', () => {
    for (const bad of ['', null, undefined, '#fff', 'rgb(1 2 3)', '1 2', 'a b c', 'var(--oct-good)']) {
      expect(rgbFromTriplet(bad)).toBeNull();
    }
  });
});

describe('rgbWithAlpha', () => {
  it('applies an alpha, replacing any the token carried', () => {
    expect(rgbWithAlpha('44 47 56', 0.6)).toBe('rgb(44 47 56 / 0.6)');
    expect(rgbWithAlpha('44 47 56 / 0.14', 0.6)).toBe('rgb(44 47 56 / 0.6)');
  });

  it('rejects a malformed token', () => {
    expect(rgbWithAlpha('', 0.5)).toBeNull();
    expect(rgbWithAlpha('#fff', 0.5)).toBeNull();
  });
});
