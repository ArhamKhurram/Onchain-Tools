import { describe, it, expect } from 'vitest';
import {
  normalizeUserIdentifier,
  classifyUserIdentifier,
  identifierDedupeKey,
  parseUserIdentifiers,
  appendUserIdentifiers,
  summarizeParse,
} from '../src/utils/userIdentifiers';

describe('normalizeUserIdentifier', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeUserIdentifier('  123456789012345678  ')).toBe('123456789012345678');
    expect(normalizeUserIdentifier('\t@alpha_caller\r')).toBe('@alpha_caller');
  });

  it('unwraps a pasted Discord mention to the bare snowflake', () => {
    expect(normalizeUserIdentifier('<@123456789012345678>')).toBe('123456789012345678');
    expect(normalizeUserIdentifier('<@!123456789012345678>')).toBe('123456789012345678');
  });

  it('leaves casing and the leading @ alone', () => {
    // `@Alice` matches a username; `Alice` does not, backend-side. Coercing
    // between them would silently retarget the entry.
    expect(normalizeUserIdentifier('@Alice')).toBe('@Alice');
    expect(normalizeUserIdentifier('Alice')).toBe('Alice');
  });
});

describe('classifyUserIdentifier', () => {
  it('recognises Discord snowflakes', () => {
    expect(classifyUserIdentifier('123456789012345678')).toBe('discordId');
  });

  it('recognises Telegram handles', () => {
    expect(classifyUserIdentifier('@alpha_caller')).toBe('telegramHandle');
    expect(classifyUserIdentifier('@Caller99')).toBe('telegramHandle');
  });

  it('accepts a bare username rather than rejecting it', () => {
    // The Filter tab explicitly invites plain usernames, so these must survive.
    expect(classifyUserIdentifier('alpha_caller')).toBe('username');
    expect(classifyUserIdentifier('some.caller')).toBe('username');
  });

  it('rejects things that cannot be an identifier at all', () => {
    expect(classifyUserIdentifier('Crypto Whale')).toBeNull(); // internal space
    expect(classifyUserIdentifier('https://t.me/alpha')).toBeNull();
    expect(classifyUserIdentifier('---')).toBeNull();
    expect(classifyUserIdentifier('@')).toBeNull();
    expect(classifyUserIdentifier('a'.repeat(80))).toBeNull();
  });
});

describe('identifierDedupeKey', () => {
  it('is case-insensitive', () => {
    expect(identifierDedupeKey('@Alice')).toBe(identifierDedupeKey('@alice'));
  });

  it('keeps the @ significant', () => {
    expect(identifierDedupeKey('@alice')).not.toBe(identifierDedupeKey('alice'));
  });
});

describe('parseUserIdentifiers', () => {
  it('splits on newlines and commas', () => {
    const result = parseUserIdentifiers('111111111111111111\n222222222222222222,333333333333333333');
    expect(result.added).toEqual([
      '111111111111111111',
      '222222222222222222',
      '333333333333333333',
    ]);
  });

  it('trims each entry and drops blank lines', () => {
    const pasted = '  111111111111111111  \n\n  @alpha  \n,,\n\n';
    const result = parseUserIdentifiers(pasted);
    expect(result.added).toEqual(['111111111111111111', '@alpha']);
    expect(result.duplicates).toEqual([]);
    expect(result.invalid).toEqual([]);
  });

  it('deduplicates within the pasted batch', () => {
    const result = parseUserIdentifiers('@alpha\n@Alpha\n@alpha');
    expect(result.added).toEqual(['@alpha']);
    expect(result.duplicates).toEqual(['@Alpha', '@alpha']);
  });

  it('deduplicates against users already on the list', () => {
    const result = parseUserIdentifiers('@alpha\n999999999999999999', ['@ALPHA']);
    expect(result.added).toEqual(['999999999999999999']);
    expect(result.duplicates).toEqual(['@alpha']);
  });

  it('reports unparseable entries instead of swallowing them', () => {
    const result = parseUserIdentifiers('111111111111111111\nCrypto Whale\nhttps://t.me/x');
    expect(result.added).toEqual(['111111111111111111']);
    expect(result.invalid).toEqual(['Crypto Whale', 'https://t.me/x']);
  });

  it('normalizes mentions before deduping them', () => {
    const result = parseUserIdentifiers('<@123456789012345678>\n123456789012345678');
    expect(result.added).toEqual(['123456789012345678']);
    expect(result.duplicates).toEqual(['123456789012345678']);
  });

  it('handles a realistic mixed paste', () => {
    const pasted = [
      '297153970613387264',
      '@degen_alerts',
      '',
      '  <@!155149108183695360> ',
      '297153970613387264',
      'Not A Username!!',
      '@Degen_Alerts',
      '456789012345678901, 567890123456789012',
      '',
    ].join('\n');
    const result = parseUserIdentifiers(pasted, ['567890123456789012']);
    expect(result.added).toEqual([
      '297153970613387264',
      '@degen_alerts',
      '155149108183695360',
      '456789012345678901',
    ]);
    expect(result.duplicates).toEqual(['297153970613387264', '@Degen_Alerts', '567890123456789012']);
    expect(result.invalid).toEqual(['Not A Username!!']);
  });

  it('returns empty buckets for empty input', () => {
    expect(parseUserIdentifiers('   \n\n  ')).toEqual({ added: [], duplicates: [], invalid: [] });
  });
});

describe('appendUserIdentifiers', () => {
  it('appends only what is missing, preserving order', () => {
    expect(appendUserIdentifiers(['a1'], ['b2', 'a1', 'c3'])).toEqual(['a1', 'b2', 'c3']);
  });

  it('is dedupe-safe against a stale snapshot (case-insensitive)', () => {
    expect(appendUserIdentifiers(['@Alpha'], ['@alpha'])).toEqual(['@Alpha']);
  });

  it('deduplicates within the incoming batch', () => {
    expect(appendUserIdentifiers([], ['x1', 'X1'])).toEqual(['x1']);
  });
});

describe('summarizeParse', () => {
  it('mentions only the buckets that have entries', () => {
    expect(summarizeParse({ added: ['a'], duplicates: [], invalid: [] })).toBe('Added 1');
    expect(summarizeParse({ added: ['a'], duplicates: ['b'], invalid: ['c'] })).toBe(
      'Added 1 · 1 already tracked · 1 skipped',
    );
  });

  it('still reports a zero add', () => {
    expect(summarizeParse({ added: [], duplicates: ['b', 'c'], invalid: [] })).toBe(
      'Added 0 · 2 already tracked',
    );
  });
});
