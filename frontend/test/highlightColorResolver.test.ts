import { describe, it, expect } from 'vitest';
import { createHighlightColorResolver } from '../src/utils/userIdentifiers';

// Highlight colours are keyed by whatever identifier the user added — a bare
// Discord snowflake or an @handle. The chat pane used to look up colours by
// author id only, so a colour saved against "@handle" highlighted the row but
// painted the default colour. The resolver must mirror the highlight matcher:
// ids exactly, handles case-insensitively.

describe('createHighlightColorResolver', () => {
  const colors = {
    '123456789012345678': '#ff0000',
    '@Alice_TG': '#00ff00',
  };

  it('resolves an id-keyed colour by author id', () => {
    const resolve = createHighlightColorResolver(colors);
    expect(resolve('123456789012345678', 'whoever')).toBe('#ff0000');
  });

  it('resolves an @handle-keyed colour by username, case-insensitively', () => {
    const resolve = createHighlightColorResolver(colors);
    expect(resolve('999', 'alice_tg')).toBe('#00ff00');
    expect(resolve('999', 'ALICE_TG')).toBe('#00ff00');
  });

  it('prefers the id-keyed entry when both could match', () => {
    const resolve = createHighlightColorResolver({
      ...colors,
      '@bob': '#0000ff',
      '111': '#ffffff',
    });
    expect(resolve('111', 'bob')).toBe('#ffffff');
  });

  it('returns undefined without a username for handle-only entries', () => {
    const resolve = createHighlightColorResolver({ '@carol': '#123456' });
    expect(resolve('42')).toBeUndefined();
  });

  it('does not match a bare (non-@) key against a username', () => {
    // A bare entry means "this exact id" to the matcher; a username must not
    // silently pick up its colour.
    const resolve = createHighlightColorResolver({ alice: '#654321' });
    expect(resolve('42', 'alice')).toBeUndefined();
  });

  it('handles an absent colour map', () => {
    const resolve = createHighlightColorResolver(undefined);
    expect(resolve('42', 'alice')).toBeUndefined();
  });
});
