import { describe, it, expect } from 'vitest';
import { matchKeywords } from '../src/utils/keywordMatcher';
import type { KeywordPattern } from '../src/discord/types.js';

const kw = (p: Partial<KeywordPattern> & { pattern: string }): KeywordPattern =>
  ({ pattern: p.pattern, label: p.label, matchMode: p.matchMode, isRegex: p.isRegex } as KeywordPattern);

describe('matchKeywords', () => {
  it('returns [] for empty content or no patterns', () => {
    expect(matchKeywords('', [kw({ pattern: 'x' })])).toEqual([]);
    expect(matchKeywords('hello', [])).toEqual([]);
  });

  it('includes mode is case-insensitive (default)', () => {
    expect(matchKeywords('PUMP it up', [kw({ pattern: 'pump' })])).toEqual(['pump']);
  });

  it('returns the label when provided, else the pattern', () => {
    expect(matchKeywords('send it', [kw({ pattern: 'send', label: 'SEND-SIGNAL' })])).toEqual(['SEND-SIGNAL']);
    expect(matchKeywords('send it', [kw({ pattern: 'send' })])).toEqual(['send']);
  });

  it('exact mode respects word boundaries', () => {
    expect(matchKeywords('ape in', [kw({ pattern: 'ape', matchMode: 'exact' })])).toEqual(['ape']);
    expect(matchKeywords('apex predator', [kw({ pattern: 'ape', matchMode: 'exact' })])).toEqual([]);
  });

  it('regex mode matches patterns', () => {
    expect(matchKeywords('did a 100x', [kw({ pattern: '\\d+x', matchMode: 'regex' })])).toEqual(['\\d+x']);
  });

  it('falls back to regex mode when isRegex is set without matchMode', () => {
    expect(matchKeywords('50x gain', [kw({ pattern: '\\d+x', isRegex: true })])).toEqual(['\\d+x']);
  });

  it('does not throw on an invalid regex (returns no match)', () => {
    expect(() => matchKeywords('text', [kw({ pattern: '(', matchMode: 'regex' })])).not.toThrow();
    expect(matchKeywords('text', [kw({ pattern: '(', matchMode: 'regex' })])).toEqual([]);
  });

  it('collects multiple matched labels in order', () => {
    const patterns = [kw({ pattern: 'buy' }), kw({ pattern: 'now' }), kw({ pattern: 'never' })];
    expect(matchKeywords('buy it now', patterns)).toEqual(['buy', 'now']);
  });
});
