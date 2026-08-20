import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RADAR_MULTIPLE_EMOJI_RULES,
  MAX_RADAR_EMOJI_LENGTH,
  MAX_RADAR_EMOJI_RULES,
  radarEmojiForMultiple,
  resolveRadarEmojiRules,
  sanitizeRadarEmoji,
  sanitizeRadarEmojiRules,
  type RadarMultipleEmojiRule,
} from '@oct/shared';

const ICE = '\u{1F9CA}';
const FIRE = '\u{1F525}';
const DEFAULTS = [...DEFAULT_RADAR_MULTIPLE_EMOJI_RULES];

describe('radarEmojiForMultiple — highest match wins', () => {
  it('ships 3x ice / 5x fire as the default ladder', () => {
    expect(DEFAULTS).toEqual([
      { threshold: 3, emoji: ICE },
      { threshold: 5, emoji: FIRE },
    ]);
  });

  it('shows nothing below the lowest threshold', () => {
    expect(radarEmojiForMultiple(1, DEFAULTS)).toBeUndefined();
    expect(radarEmojiForMultiple(2.9, DEFAULTS)).toBeUndefined();
    expect(radarEmojiForMultiple(0.4, DEFAULTS)).toBeUndefined();
  });

  it('matches at the threshold itself, not just above it', () => {
    expect(radarEmojiForMultiple(3, DEFAULTS)).toBe(ICE);
    expect(radarEmojiForMultiple(5, DEFAULTS)).toBe(FIRE);
  });

  it('returns only the highest matching rule, never an accumulation', () => {
    // The whole point: 6x is fire, not ice+fire.
    expect(radarEmojiForMultiple(6, DEFAULTS)).toBe(FIRE);
    expect(radarEmojiForMultiple(4.9, DEFAULTS)).toBe(ICE);
    expect(radarEmojiForMultiple(500, DEFAULTS)).toBe(FIRE);
  });

  it('still picks the top rung when the rules arrive out of order', () => {
    const jumbled: RadarMultipleEmojiRule[] = [
      { threshold: 10, emoji: '🚀' },
      { threshold: 2, emoji: '🌱' },
      { threshold: 5, emoji: FIRE },
    ];
    expect(radarEmojiForMultiple(11, jumbled)).toBe('🚀');
    expect(radarEmojiForMultiple(5, jumbled)).toBe(FIRE);
    expect(radarEmojiForMultiple(2, jumbled)).toBe('🌱');
    expect(radarEmojiForMultiple(1.9, jumbled)).toBeUndefined();
  });

  it('handles an empty ladder and a missing multiple', () => {
    expect(radarEmojiForMultiple(50, [])).toBeUndefined();
    expect(radarEmojiForMultiple(null, DEFAULTS)).toBeUndefined();
    expect(radarEmojiForMultiple(undefined, DEFAULTS)).toBeUndefined();
    expect(radarEmojiForMultiple(NaN, DEFAULTS)).toBeUndefined();
    expect(radarEmojiForMultiple(Infinity, DEFAULTS)).toBeUndefined();
  });
});

describe('sanitizeRadarEmoji', () => {
  it('keeps ordinary emoji, including multi-codepoint sequences', () => {
    expect(sanitizeRadarEmoji(FIRE)).toBe(FIRE);
    expect(sanitizeRadarEmoji('❤️')).toBe('❤️');
    expect(sanitizeRadarEmoji('🇺🇸')).toBe('🇺🇸');
  });

  it('keeps a plain-text marker', () => {
    expect(sanitizeRadarEmoji('!!')).toBe('!!');
  });

  it('strips markup so a pasted value cannot inject anything', () => {
    // Inert leftovers are fine (React escapes text anyway); what matters is that
    // no angle bracket, ampersand, quote or backslash survives to be rendered.
    for (const attack of [
      '<img src=x onerror=alert(1)>',
      '</td><script>alert(1)</script>',
      '&lt;svg onload=alert(1)&gt;',
      '"\'`\\',
      '{{constructor}}',
    ]) {
      expect(sanitizeRadarEmoji(attack)).not.toMatch(/[<>&"'`\\{}]/);
    }
    expect(sanitizeRadarEmoji('"\'`\\')).toBe('');
  });

  // Built from code points rather than pasted literally: a raw NUL or bidi
  // override sitting in this source would make git treat the whole test file
  // as binary and hide it from diffs.
  it('strips control characters and bidi overrides', () => {
    const cp = (...codes: number[]) => String.fromCodePoint(...codes);
    const NUL = 0x00;
    const ESC = 0x1b;
    const RLO = 0x202e;
    const PDF = 0x202c;
    const ZWSP = 0x200b;
    const BOM = 0xfeff;
    const ZWJ = 0x200d;

    expect(sanitizeRadarEmoji(cp(NUL, ESC) + '[31m')).toBe('[31m');
    // RLO ... PDF around the glyph: the pair that can visually reorder a row.
    expect(sanitizeRadarEmoji(cp(RLO) + FIRE + cp(PDF))).toBe(FIRE);
    expect(sanitizeRadarEmoji(cp(ZWSP) + ICE + cp(BOM))).toBe(ICE);

    // ZWJ and the variation selectors are the exception: they build emoji
    // rather than hide text, so they survive or a man+laptop sequence would
    // come apart into two separate glyphs.
    const zwjPair = cp(0x1f468, ZWJ, 0x1f4bb);
    expect(sanitizeRadarEmoji(zwjPair)).toBe(zwjPair);
  });

  it('drops whitespace rather than storing a phrase', () => {
    expect(sanitizeRadarEmoji(`  ${FIRE}  `)).toBe(FIRE);
    expect(sanitizeRadarEmoji('\n\t')).toBe('');
  });

  it('caps length so a pasted paragraph cannot land in the column', () => {
    const long = 'a paragraph of text pasted into the emoji box'.repeat(20);
    expect(sanitizeRadarEmoji(long).length).toBeLessThanOrEqual(MAX_RADAR_EMOJI_LENGTH);
    const manyEmoji = FIRE.repeat(30);
    const capped = sanitizeRadarEmoji(manyEmoji);
    expect(capped.length).toBeLessThanOrEqual(MAX_RADAR_EMOJI_LENGTH);
    // Never a lone surrogate: the cap breaks between code points.
    expect(capped).toBe(FIRE.repeat(MAX_RADAR_EMOJI_LENGTH / 2));
  });

  it('rejects non-strings', () => {
    expect(sanitizeRadarEmoji(undefined)).toBe('');
    expect(sanitizeRadarEmoji(null)).toBe('');
    expect(sanitizeRadarEmoji(5)).toBe('');
    expect(sanitizeRadarEmoji({ emoji: FIRE })).toBe('');
  });
});

describe('sanitizeRadarEmojiRules', () => {
  it('sorts ascending by threshold', () => {
    expect(
      sanitizeRadarEmojiRules([
        { threshold: 5, emoji: FIRE },
        { threshold: 2, emoji: '🌱' },
      ]),
    ).toEqual([
      { threshold: 2, emoji: '🌱' },
      { threshold: 5, emoji: FIRE },
    ]);
  });

  it('drops rules with no usable emoji or no usable threshold', () => {
    expect(
      sanitizeRadarEmojiRules([
        { threshold: 3, emoji: '   ' },
        { threshold: 'abc', emoji: FIRE },
        { threshold: 1, emoji: FIRE }, // below the 1.1 floor: 1x is not a move
        { threshold: 1e9, emoji: FIRE },
        { threshold: -4, emoji: FIRE },
        { threshold: 4, emoji: FIRE },
      ]),
    ).toEqual([{ threshold: 4, emoji: FIRE }]);
  });

  it('rounds thresholds to the precision the column actually renders', () => {
    expect(sanitizeRadarEmojiRules([{ threshold: 3.14159, emoji: FIRE }])).toEqual([
      { threshold: 3.1, emoji: FIRE },
    ]);
  });

  it('dedupes on threshold, last one wins', () => {
    expect(
      sanitizeRadarEmojiRules([
        { threshold: 3, emoji: ICE },
        { threshold: 3, emoji: FIRE },
      ]),
    ).toEqual([{ threshold: 3, emoji: FIRE }]);
  });

  it('bounds the ladder length', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ threshold: 2 + i, emoji: FIRE }));
    expect(sanitizeRadarEmojiRules(many)).toHaveLength(MAX_RADAR_EMOJI_RULES);
  });

  it('tolerates junk input', () => {
    expect(sanitizeRadarEmojiRules(null)).toEqual([]);
    expect(sanitizeRadarEmojiRules('🔥')).toEqual([]);
    expect(sanitizeRadarEmojiRules([null, 3, 'x', {}])).toEqual([]);
  });
});

describe('resolveRadarEmojiRules', () => {
  it('falls back to the defaults when never configured', () => {
    expect(resolveRadarEmojiRules(undefined)).toEqual(DEFAULTS);
    expect(resolveRadarEmojiRules(null)).toEqual(DEFAULTS);
  });

  it('honours an explicit empty ladder as "markers off"', () => {
    expect(resolveRadarEmojiRules([])).toEqual([]);
  });

  it('sanitises whatever was stored', () => {
    expect(
      resolveRadarEmojiRules([
        { threshold: 9, emoji: '"' }, // nothing renderable survives → dropped
        { threshold: 4, emoji: FIRE },
      ]),
    ).toEqual([{ threshold: 4, emoji: FIRE }]);
  });

  it('returns a mutable copy of the defaults, not the shared constant', () => {
    const a = resolveRadarEmojiRules(undefined);
    a[0].emoji = 'x';
    expect(resolveRadarEmojiRules(undefined)[0].emoji).toBe(ICE);
  });
});
