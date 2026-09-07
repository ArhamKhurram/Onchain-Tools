// The link-code credential: expiry, single use, and the two rate limits.
//
// WHY THESE AND NOT OTHERS. A link code is the only thing standing between "a
// Telegram chat" and "somebody's private OCT alert feed plus their alert
// thresholds". Every property below is a way that guarantee could be lost
// quietly — a code that outlives its window, a code that works twice, a chat
// that can grind through the keyspace, an account that can mint forever — and
// none of them would show up as a failure in production. They would show up as
// somebody else reading your alerts.

import { describe, it, expect } from 'vitest';
import {
  generateLinkCode,
  hashLinkCode,
  LinkCodeService,
  LINK_CODE_TTL_MS,
  MemoryLinkCodeBackend,
  MINT_MAX_IN_WINDOW,
  MINT_WINDOW_MS,
  normalizeLinkCode,
  REDEEM_MAX_IN_WINDOW,
  REDEEM_WINDOW_MS,
} from '../src/tgbot/linkCodes';

const T0 = Date.parse('2026-09-08T12:00:00.000Z');
const ALICE = '11111111-2222-3333-4444-555555555555';
const BOB = '99999999-8888-7777-6666-555555555555';

const service = () => new LinkCodeService(new MemoryLinkCodeBackend());

describe('code shape', () => {
  it('is unambiguous, grouped and 8 characters of the reduced alphabet', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateLinkCode();
      expect(code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}$/);
      // I, L, O and U are absent so no pair of glyphs can be confused when a
      // code is read off one screen and typed into another.
      expect(code).not.toMatch(/[ILOU]/);
    }
  });

  it('does not repeat itself over a large sample', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) seen.add(generateLinkCode());
    expect(seen.size).toBe(2000);
  });

  it('forgives transcription noise and nothing else', () => {
    expect(normalizeLinkCode('abcd-efgh')).toBe('ABCD-EFGH');
    expect(normalizeLinkCode('  ABCDEFGH ')).toBe('ABCD-EFGH');
    // The three glyphs the alphabet omits are folded to what they look like.
    expect(normalizeLinkCode('O1LO-234I')).toBe('0110-2341');
    // Everything else is rejected rather than repaired.
    expect(normalizeLinkCode('ABCD-EFG')).toBeNull();
    expect(normalizeLinkCode('ABCD-EFGHI')).toBeNull();
    expect(normalizeLinkCode('ABCD-EF@H')).toBeNull();
    expect(normalizeLinkCode('')).toBeNull();
    expect(normalizeLinkCode(undefined)).toBeNull();
  });

  it('stores a digest, never the code', () => {
    const code = generateLinkCode();
    const hash = hashLinkCode(code);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(code.replace('-', ''));
  });
});

describe('redemption', () => {
  it('binds to the account that minted it, and to no other', async () => {
    const svc = service();
    const minted = await svc.mint(ALICE, T0);
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    const redeemed = await svc.redeem(minted.code, -100, T0 + 1000);
    expect(redeemed).toEqual({ ok: true, userId: ALICE });
  });

  it('works exactly once', async () => {
    const svc = service();
    const minted = await svc.mint(ALICE, T0);
    if (!minted.ok) throw new Error('mint failed');

    expect((await svc.redeem(minted.code, -100, T0 + 1000)).ok).toBe(true);
    // The second attempt is indistinguishable from an unknown code — which is
    // the point: nothing about a spent code tells a holder it was ever real.
    expect(await svc.redeem(minted.code, -100, T0 + 2000)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('cannot be redeemed twice from two chats racing each other', async () => {
    const svc = service();
    const minted = await svc.mint(ALICE, T0);
    if (!minted.ok) throw new Error('mint failed');

    const [a, b] = await Promise.all([
      svc.redeem(minted.code, -100, T0 + 1000),
      svc.redeem(minted.code, -200, T0 + 1000),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it('expires, and expiry is not a near miss', async () => {
    const svc = service();
    const minted = await svc.mint(ALICE, T0);
    if (!minted.ok) throw new Error('mint failed');
    expect(minted.expiresAt).toBe(T0 + LINK_CODE_TTL_MS);

    // One millisecond inside the window still works…
    const early = service();
    const other = await early.mint(ALICE, T0);
    if (!other.ok) throw new Error('mint failed');
    expect((await early.redeem(other.code, -100, T0 + LINK_CODE_TTL_MS - 1)).ok).toBe(true);

    // …and the boundary itself does not.
    expect(await svc.redeem(minted.code, -100, T0 + LINK_CODE_TTL_MS)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('measures its lifetime in minutes, not hours', () => {
    expect(LINK_CODE_TTL_MS).toBeLessThanOrEqual(15 * 60_000);
  });

  it('refuses a code that never existed', async () => {
    const svc = service();
    expect(await svc.redeem('ZZZZ-ZZZZ', -100, T0)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses a code-shaped string that is not code-shaped', async () => {
    const svc = service();
    // Wrong length and an illegal glyph — neither can be repaired into a code.
    expect(await svc.redeem('nope', -100, T0)).toEqual({ ok: false, reason: 'malformed' });
    expect(await svc.redeem('ABCD-EF@H', -100, T0)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('cannot bind to an account nobody proved they own', async () => {
    // There is no input to `redeem` other than a code, so the only way to reach
    // an account is to hold a code minted FOR it. Minting Bob's code and then
    // redeeming it can only ever produce Bob — there is no path from Alice's
    // chat to Bob's account without Bob's code, and no path from any code to a
    // DIFFERENT account than the one that minted it.
    const svc = service();
    const bobs = await svc.mint(BOB, T0);
    if (!bobs.ok) throw new Error('mint failed');
    const redeemed = await svc.redeem(bobs.code, -100, T0 + 1);
    expect(redeemed).toEqual({ ok: true, userId: BOB });
  });
});

describe('rate limits', () => {
  it('bounds guessing per chat, counting failures', async () => {
    const svc = service();
    for (let i = 0; i < REDEEM_MAX_IN_WINDOW; i += 1) {
      expect((await svc.redeem('ZZZZ-ZZZ1', -100, T0)).reason).toBe('invalid');
    }
    expect(await svc.redeem('ZZZZ-ZZZ1', -100, T0)).toEqual({ ok: false, reason: 'throttled' });

    // A throttled chat does not throttle the room next door.
    expect((await svc.redeem('ZZZZ-ZZZ1', -200, T0)).reason).toBe('invalid');

    // And the window rolls off.
    expect((await svc.redeem('ZZZZ-ZZZ1', -100, T0 + REDEEM_WINDOW_MS + 1)).reason).toBe('invalid');
  });

  it('spends attempt budget even on a valid code, so it always bounds guessing', async () => {
    const svc = service();
    const minted = await svc.mint(ALICE, T0);
    if (!minted.ok) throw new Error('mint failed');
    for (let i = 0; i < REDEEM_MAX_IN_WINDOW; i += 1) {
      await svc.redeem('ZZZZ-ZZZ1', -100, T0);
    }
    // Even the right code is refused once the chat has burned its attempts —
    // the budget is not a filter that a correct guess walks past.
    expect(await svc.redeem(minted.code, -100, T0)).toEqual({ ok: false, reason: 'throttled' });
  });

  it('bounds minting per account and rolls off', async () => {
    const svc = service();
    for (let i = 0; i < MINT_MAX_IN_WINDOW; i += 1) {
      expect((await svc.mint(ALICE, T0 + i)).ok).toBe(true);
    }
    expect(await svc.mint(ALICE, T0 + MINT_MAX_IN_WINDOW)).toEqual({
      ok: false,
      reason: 'rate_limited',
    });
    // Another account is unaffected.
    expect((await svc.mint(BOB, T0)).ok).toBe(true);
    // And the window rolls off.
    expect((await svc.mint(ALICE, T0 + MINT_WINDOW_MS + 1)).ok).toBe(true);
  });

  it('fails closed when the budget cannot be counted', async () => {
    const broken = new MemoryLinkCodeBackend();
    broken.countRecent = async () => {
      throw new Error('down');
    };
    const svc = new LinkCodeService(broken);
    await expect(svc.mint(ALICE, T0)).rejects.toThrow('down');
  });

  it('reports an unavailable backend rather than a phantom binding', async () => {
    const broken = new MemoryLinkCodeBackend();
    broken.insert = async () => false;
    const svc = new LinkCodeService(broken);
    expect(await svc.mint(ALICE, T0)).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('survives a throwing backend on redeem', async () => {
    const broken = new MemoryLinkCodeBackend();
    broken.consume = async () => {
      throw new Error('down');
    };
    const svc = new LinkCodeService(broken);
    expect(await svc.redeem('ABCD-EFGH', -100, T0)).toEqual({ ok: false, reason: 'unavailable' });
  });
});
