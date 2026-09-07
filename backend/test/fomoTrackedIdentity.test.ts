import { describe, it, expect } from 'vitest';
import { parseSuppliedFomoIdentity, sanitizeForEcho } from '../src/fomo/trackedIdentity';

// A caller-supplied identity is the one value on POST /api/fomo/tracked that
// used to be server-chosen and is now request data written straight into
// fomo_tracked_users. These are the boundary tests for that: what is accepted,
// and — more importantly — that everything malformed is REJECTED rather than
// trimmed, truncated or coerced into a row.

const UUID = '6d8c0bf3-5d42-506c-a0ea-9e1e75ff38af';

describe('parseSuppliedFomoIdentity — accepted shapes', () => {
  it('accepts a full identity', () => {
    const result = parseSuppliedFomoIdentity({
      fomoUserId: UUID,
      fomoHandle: 'kp',
      displayName: 'KP',
    });
    expect(result).toEqual({
      kind: 'ok',
      identity: { fomoUserId: UUID, fomoHandle: 'kp', displayName: 'KP' },
    });
  });

  it('accepts an id-only identity — handle and name are optional', () => {
    const result = parseSuppliedFomoIdentity({ fomoUserId: UUID });
    expect(result).toEqual({
      kind: 'ok',
      identity: { fomoUserId: UUID, fomoHandle: null, displayName: null },
    });
  });

  it('normalises the id case and strips a leading @ from the handle', () => {
    const result = parseSuppliedFomoIdentity({ fomoUserId: UUID.toUpperCase(), fomoHandle: ' @kp ' });
    expect(result).toMatchObject({ kind: 'ok', identity: { fomoUserId: UUID, fomoHandle: 'kp' } });
  });

  it('treats empty handle/name strings as absent rather than rejecting', () => {
    const result = parseSuppliedFomoIdentity({ fomoUserId: UUID, fomoHandle: '  ', displayName: '' });
    expect(result).toMatchObject({ kind: 'ok', identity: { fomoHandle: null, displayName: null } });
  });
});

describe('parseSuppliedFomoIdentity — falls through to free text', () => {
  it('reports none when no id is supplied', () => {
    expect(parseSuppliedFomoIdentity({ query: 'kp' })).toEqual({ kind: 'none' });
    expect(parseSuppliedFomoIdentity({ fomoUserId: '   ' })).toEqual({ kind: 'none' });
    expect(parseSuppliedFomoIdentity({ fomoUserId: null })).toEqual({ kind: 'none' });
  });

  it('reports none for a non-object body', () => {
    for (const body of [undefined, null, 'kp', 42, ['kp']]) {
      expect(parseSuppliedFomoIdentity(body)).toEqual({ kind: 'none' });
    }
  });

  it('ignores a handle sent without an id rather than half-trusting it', () => {
    expect(parseSuppliedFomoIdentity({ query: 'kp', fomoHandle: 'someone-else' })).toEqual({ kind: 'none' });
  });
});

describe('parseSuppliedFomoIdentity — rejects hostile input', () => {
  it('rejects an id that is not a UUID', () => {
    for (const bad of [
      'kp',
      '../../etc/passwd',
      "' or 1=1--",
      `${UUID} `.repeat(50),
      '6d8c0bf3-5d42-506c-a0ea',
      `${UUID}x`,
    ]) {
      expect(parseSuppliedFomoIdentity({ fomoUserId: bad }).kind, bad).toBe('invalid');
    }
  });

  it('rejects a non-string id (including an object that would reach the insert)', () => {
    for (const bad of [42, true, { $ne: null }, [UUID]]) {
      expect(parseSuppliedFomoIdentity({ fomoUserId: bad }).kind).toBe('invalid');
    }
  });

  it('rejects a handle with markup, whitespace or path characters', () => {
    for (const bad of ['<img src=x onerror=alert(1)>', 'a b', 'a/b', 'a\nb', '../x', "a'b"]) {
      expect(parseSuppliedFomoIdentity({ fomoUserId: UUID, fomoHandle: bad }).kind, bad).toBe('invalid');
    }
  });

  it('rejects an over-long handle instead of truncating it', () => {
    const result = parseSuppliedFomoIdentity({ fomoUserId: UUID, fomoHandle: 'a'.repeat(65) });
    expect(result.kind).toBe('invalid');
  });

  it('rejects an over-long display name instead of truncating it', () => {
    const result = parseSuppliedFomoIdentity({ fomoUserId: UUID, displayName: 'a'.repeat(65) });
    expect(result.kind).toBe('invalid');
  });

  it('rejects a display name carrying control characters (log injection)', () => {
    const result = parseSuppliedFomoIdentity({
      fomoUserId: UUID,
      displayName: 'ok\n[FomoAPI] forged log line',
    });
    expect(result.kind).toBe('invalid');
  });

  it('rejects non-string handle and display name', () => {
    expect(parseSuppliedFomoIdentity({ fomoUserId: UUID, fomoHandle: 1 }).kind).toBe('invalid');
    expect(parseSuppliedFomoIdentity({ fomoUserId: UUID, displayName: {} }).kind).toBe('invalid');
  });

  it('never surfaces a caller-supplied user_id — the row owner is not body data', () => {
    const result = parseSuppliedFomoIdentity({ fomoUserId: UUID, user_id: 'someone-else', userId: 'someone-else' });
    expect(result).toEqual({
      kind: 'ok',
      identity: { fomoUserId: UUID, fomoHandle: null, displayName: null },
    });
    expect(JSON.stringify(result)).not.toContain('someone-else');
  });

  it('allows a display name with punctuation and emoji — only control chars are barred', () => {
    const result = parseSuppliedFomoIdentity({ fomoUserId: UUID, displayName: 'KP 🐋 (the model)' });
    expect(result).toMatchObject({ kind: 'ok', identity: { displayName: 'KP 🐋 (the model)' } });
  });
});

describe('sanitizeForEcho', () => {
  it('flattens control characters so an echoed query cannot forge a log line', () => {
    expect(sanitizeForEcho('kp\n[FomoAPI] forged')).toBe('kp [FomoAPI] forged');
  });

  it('caps length', () => {
    expect(sanitizeForEcho('a'.repeat(200)).length).toBeLessThanOrEqual(65);
  });
});
