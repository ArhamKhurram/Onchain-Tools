import { describe, it, expect } from 'vitest';
import { mapTheses } from '../src/bot/service';

// Realistic /feed/token/thesis envelope (responseObject array of thesis rows).
// Field aliases are best-effort until confirmed against a live response, so the
// fixture exercises the ones mapTheses reads.
const thesesFixture = {
  responseObject: [
    {
      user: { displayName: 'Vee', userHandle: 'vee_x', profilePictureLink: 'https://img/vee.png' },
      value: 125000,
      pnl: 42000,
      comment: 'Strong narrative, tight float.',
    },
    {
      // no `comment` → falls back to `text`; string numbers coerced; @-prefixed handle
      user: { userHandle: '@shrimp', twitterHandle: 'shrimp_trades' },
      value: '999.5',
      pnl: '-120.25',
      text: 'Just aping the momentum.',
    },
    {
      // no user → dropped
      value: 5,
      pnl: 0,
      comment: 'anon thesis',
    },
  ],
};

describe('mapTheses', () => {
  it('narrows thesis rows to display-facing fields with numeric coercion', () => {
    const rows = mapTheses(thesesFixture);
    expect(rows).toHaveLength(2); // the userless row is dropped

    expect(rows[0]).toEqual({
      handle: 'Vee',
      xHandle: 'vee_x',
      xUrl: 'https://x.com/vee_x',
      avatar: 'https://img/vee.png',
      valueUsd: 125000,
      pnlUsd: 42000,
      thesis: 'Strong narrative, tight float.',
    });

    // string value/pnl coerced; explicit twitterHandle wins for xHandle; @ stripped
    expect(rows[1].valueUsd).toBe(999.5);
    expect(rows[1].pnlUsd).toBe(-120.25);
    expect(rows[1].xHandle).toBe('shrimp_trades');
    expect(rows[1].xUrl).toBe('https://x.com/shrimp_trades');
    expect(rows[1].avatar).toBeNull();
  });

  it('prefers comment over text, and falls back to text when comment is absent', () => {
    expect(mapTheses(thesesFixture)[0].thesis).toBe('Strong narrative, tight float.');
    expect(mapTheses(thesesFixture)[1].thesis).toBe('Just aping the momentum.');

    // comment present but empty → falls through to text
    const both = mapTheses({
      responseObject: [{ user: { userHandle: 'a' }, comment: '', text: 'from text' }],
    });
    expect(both[0].thesis).toBe('from text');
  });

  it('drops rows with no user object', () => {
    const rows = mapTheses({
      responseObject: [
        { value: 1, pnl: 1, comment: 'no user here' },
        { user: null, comment: 'null user' },
        { user: { userHandle: 'keeper' }, comment: 'kept' },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].handle).toBe('keeper');
  });

  it('defaults value/pnl to 0 and thesis to "" for a userful row missing them', () => {
    const rows = mapTheses({ responseObject: [{ user: { displayName: 'Naked' } }] });
    expect(rows[0]).toMatchObject({ handle: 'Naked', valueUsd: 0, pnlUsd: 0, thesis: '' });
  });

  it('accepts a bare array envelope and returns [] for foreign/empty payloads', () => {
    expect(mapTheses([{ user: { userHandle: 'z' }, comment: 'hi' }])).toHaveLength(1);
    expect(mapTheses({})).toEqual([]);
    expect(mapTheses(null)).toEqual([]);
    expect(mapTheses({ responseObject: [] })).toEqual([]);
  });
});
