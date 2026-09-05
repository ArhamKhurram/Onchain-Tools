import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FEED_CHROME_PRESET,
  DEFAULT_FEED_ROW_DENSITY,
  FEED_CHROME_PRESETS,
  FEED_PRESET_DENSITY,
  FEED_ROW_DENSITY_STYLE,
  FEED_ROW_HEIGHT_ESTIMATE,
  normalizeFeedChromePreset,
} from '../src/components/feed/feedChromeContract';

// The preset → density → row-class chain is pure data; these pin the two
// things that would silently misrender if someone edited one table without
// the other: every preset resolves to a styled density, and `default` still
// means "exactly what the rows looked like before density existed", because
// that is what every pane outside the Feed shell (popout, workspace) renders.

describe('feed row density', () => {
  it('maps every preset to a density that has a style and an estimate', () => {
    for (const preset of FEED_CHROME_PRESETS) {
      const density = FEED_PRESET_DENSITY[preset];
      expect(FEED_ROW_DENSITY_STYLE[density]).toBeDefined();
      expect(FEED_ROW_HEIGHT_ESTIMATE[density]).toBeGreaterThan(0);
    }
  });

  it('packs terminal tightest and masthead loosest', () => {
    const est = (p: (typeof FEED_CHROME_PRESETS)[number]) => FEED_ROW_HEIGHT_ESTIMATE[FEED_PRESET_DENSITY[p]];
    expect(est('terminal')).toBeLessThan(est('rail'));
    expect(est('rail')).toBeLessThan(est('masthead'));
  });

  it('keeps the default density on the pre-density row classes', () => {
    expect(FEED_ROW_DENSITY_STYLE[DEFAULT_FEED_ROW_DENSITY]).toEqual({
      compactPad: 'py-[1px]',
      contPad: 'py-[2px]',
      firstPad: 'pt-[1.0625rem] pb-[2px]',
      lead: 'leading-[1.375rem]',
      minH: 'min-h-[1.375rem]',
      compactText: 'text-[0.9375rem]',
      text: 'text-base',
      avatarTop: 'top-[1.1875rem]',
    });
    expect(FEED_ROW_HEIGHT_ESTIMATE[DEFAULT_FEED_ROW_DENSITY]).toBe(48);
  });

  it('never renders row text below the 12px floor', () => {
    for (const style of Object.values(FEED_ROW_DENSITY_STYLE)) {
      for (const cls of [style.text, style.compactText]) {
        expect(cls).not.toMatch(/text-\[(?:[0-9]|1[01])px\]|text-2xs/);
      }
    }
  });
});

describe('normalizeFeedChromePreset', () => {
  it('passes known presets through', () => {
    for (const preset of FEED_CHROME_PRESETS) expect(normalizeFeedChromePreset(preset)).toBe(preset);
  });

  it('falls back to the default for anything else', () => {
    expect(normalizeFeedChromePreset(undefined)).toBe(DEFAULT_FEED_CHROME_PRESET);
    expect(normalizeFeedChromePreset('bogus')).toBe(DEFAULT_FEED_CHROME_PRESET);
    expect(normalizeFeedChromePreset(42)).toBe(DEFAULT_FEED_CHROME_PRESET);
  });
});
