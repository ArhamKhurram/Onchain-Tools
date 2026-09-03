import { describe, it, expect } from 'vitest';
import {
  MAX_MESSAGE_LENGTH,
  bold,
  code,
  escapeHtml,
  escapeHtmlAttribute,
  italic,
  joinLines,
  link,
  truncate,
} from '../src/tgbot/html';

// Telegram rejects a malformed body with a 400, so an escaping bug does not
// look like a rendering glitch — it looks like an alert that never arrived.
describe('escapeHtml', () => {
  it('escapes the three characters Telegram HTML mode reserves', () => {
    expect(escapeHtml('a < b > c & d')).toBe('a &lt; b &gt; c &amp; d');
  });

  it('escapes & FIRST so entities are not double-escaped', () => {
    // The classic bug: replacing < before & turns "&lt;" into "&amp;lt;".
    expect(escapeHtml('<b>')).toBe('&lt;b&gt;');
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves everything else alone, including MarkdownV2 metacharacters', () => {
    // The whole reason for choosing HTML: MarkdownV2 would need a backslash
    // before nearly every character in this ticker, and one miss is a 400.
    expect(escapeHtml('$WHY.SO_SERIOUS! [x](y) *_~`#+-=|{}')).toBe(
      '$WHY.SO_SERIOUS! [x](y) *_~`#+-=|{}',
    );
  });

  it('handles an empty string', () => {
    expect(escapeHtml('')).toBe('');
  });
});

describe('escapeHtmlAttribute', () => {
  it('also escapes the quote that would close the attribute early', () => {
    expect(escapeHtmlAttribute('https://x.test/?a="><b>')).toBe(
      'https://x.test/?a=&quot;&gt;&lt;b&gt;',
    );
  });
});

describe('tag helpers', () => {
  it('escape their content', () => {
    expect(bold('a<b')).toBe('<b>a&lt;b</b>');
    expect(italic('a&b')).toBe('<i>a&amp;b</i>');
    expect(code('<script>')).toBe('<code>&lt;script&gt;</code>');
  });

  it('code() escapes too — Telegram does not exempt code blocks', () => {
    expect(code('a & b')).toBe('<code>a &amp; b</code>');
  });
});

describe('link', () => {
  it('renders http(s) as an anchor with both parts escaped', () => {
    expect(link('Chart ↗', 'https://axiom.trade/t/abc')).toBe(
      '<a href="https://axiom.trade/t/abc">Chart ↗</a>',
    );
  });

  it('refuses non-http schemes and degrades to escaped text', () => {
    // tg:// links can drive in-app navigation on tap; a token's self-declared
    // website field is not something to render as a tappable link.
    expect(link('site', 'tg://resolve?domain=evil')).toBe('site');
    expect(link('site', 'javascript:alert(1)')).toBe('site');
    expect(link('a<b', 'ftp://x')).toBe('a&lt;b');
  });

  it('tolerates surrounding whitespace on the url', () => {
    expect(link('x', '  https://a.test  ')).toBe('<a href="https://a.test">x</a>');
  });
});

describe('truncate', () => {
  it('leaves short text untouched', () => {
    expect(truncate('hello', 10)).toBe('hello');
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('cuts to the budget with an ellipsis, never over it', () => {
    expect(truncate('hello world', 8)).toBe('hello w…');
    expect(truncate('hello world', 8)).toHaveLength(8);
  });

  it('trims a space left dangling before the ellipsis', () => {
    expect(truncate('hello world', 7)).toBe('hello…');
  });

  it('handles degenerate widths without throwing', () => {
    expect(truncate('hello', 0)).toBe('');
    expect(truncate('hello', 1)).toBe('h');
  });
});

describe('joinLines', () => {
  it('drops nullish sections but KEEPS a deliberate blank separator', () => {
    // The distinction the cards depend on: null = "section not applicable",
    // '' = "blank line here". Conflating them either welds the card into a
    // block or leaves a double gap where an optional section was omitted.
    expect(joinLines(['a', null, undefined, '', 'b'])).toBe('a\n\nb');
  });

  it('collapses a run of blanks left by omitted sections', () => {
    expect(joinLines(['a', '', null, '', 'b'])).toBe('a\n\nb');
  });

  it('never opens or closes with a blank line', () => {
    expect(joinLines(['', '', 'a', '', ''])).toBe('a');
    expect(joinLines([null, '', null])).toBe('');
  });

  it('clamps to Telegram\'s limit by dropping whole trailing lines', () => {
    // Cutting mid-markup would be a 400, so the backstop is line-granular.
    const long = 'x'.repeat(4000);
    const out = joinLines([long, long, 'tail']);
    expect(out).toBe(long);
    expect(out.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
  });

  it('keeps everything that fits', () => {
    expect(joinLines(['a'.repeat(2000), 'b'.repeat(2000)]).length).toBe(4001);
  });
});
