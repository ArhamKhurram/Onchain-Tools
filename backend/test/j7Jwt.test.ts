// The j7 credential watch. j7 has no refresh flow OCT can drive — a human clears
// a Turnstile every ~15 days — so the whole value of this code is warning early
// and never being the thing that breaks: a malformed token must degrade to a
// warning, not throw on the boot path.
import { describe, expect, it } from 'vitest';
import { decodeJwtExpiry, describeJwtStatus, inspectJwt } from '../src/j7/jwt.js';

const NOW = Date.parse('2026-08-31T00:00:00.000Z');

/** A structurally real HS256 token with the given payload. Signature is filler. */
function jwt(payload: Record<string, unknown>): string {
  const seg = (o: Record<string, unknown>) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg(payload)}.c2ln`;
}

function inDays(days: number): number {
  return Math.floor((NOW + days * 86_400_000) / 1000);
}

describe('decodeJwtExpiry', () => {
  it('reads exp (seconds) as epoch ms', () => {
    expect(decodeJwtExpiry(jwt({ exp: 1_760_000_000 }))).toBe(1_760_000_000_000);
  });

  it('returns null for every malformed shape rather than throwing', () => {
    expect(decodeJwtExpiry('')).toBeNull();
    expect(decodeJwtExpiry('not-a-jwt')).toBeNull();
    expect(decodeJwtExpiry('one.two')).toBeNull();
    expect(decodeJwtExpiry('a.!!!not-base64!!!.c')).toBeNull();
    expect(decodeJwtExpiry(`a.${Buffer.from('not json').toString('base64url')}.c`)).toBeNull();
    expect(decodeJwtExpiry(jwt({ sub: 'x' }))).toBeNull(); // no exp
    expect(decodeJwtExpiry(jwt({ exp: 'soon' }))).toBeNull(); // exp not numeric
  });
});

describe('inspectJwt', () => {
  it('leaves a healthy token alone', () => {
    const s = inspectJwt({ username: 'acct', jwt: jwt({ exp: inDays(12) }) }, NOW);
    expect(s.needsAttention).toBe(false);
    expect(s.expired).toBe(false);
    expect(Math.round(s.daysLeft ?? 0)).toBe(12);
  });

  it('flags a token inside the 3-day window', () => {
    const s = inspectJwt({ username: 'acct', jwt: jwt({ exp: inDays(2) }) }, NOW);
    expect(s.needsAttention).toBe(true);
    expect(s.expired).toBe(false);
  });

  it('flags an already-expired token', () => {
    const s = inspectJwt({ username: 'acct', jwt: jwt({ exp: inDays(-1) }) }, NOW);
    expect(s.expired).toBe(true);
    expect(s.needsAttention).toBe(true);
  });

  it('flags an undecodable token — we cannot promise it will last', () => {
    const s = inspectJwt({ username: 'acct', jwt: 'garbage' }, NOW);
    expect(s.expiresAt).toBeNull();
    expect(s.needsAttention).toBe(true);
  });
});

describe('describeJwtStatus', () => {
  it('names the account, the date, and what a human must do — never the token', () => {
    const token = jwt({ exp: inDays(2) });
    const line = describeJwtStatus(inspectJwt({ username: 'primary', jwt: token }, NOW));

    expect(line).toContain('primary');
    expect(line).toContain('2026-09-02');
    expect(line).toMatch(/Turnstile/);
    expect(line).toMatch(/J7_JWTS_JSON/);
    // The credential itself must never reach a log line.
    expect(line).not.toContain(token);
  });

  it('says the feed is down once expired', () => {
    const line = describeJwtStatus(inspectJwt({ username: 'primary', jwt: jwt({ exp: inDays(-2) }) }, NOW));
    expect(line).toMatch(/EXPIRED/);
  });
});
