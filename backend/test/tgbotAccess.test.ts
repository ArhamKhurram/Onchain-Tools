import { describe, it, expect, afterEach, vi } from 'vitest';
import { isChatAllowed, parseAllowedChatIds, readAllowedChatIds } from '../src/tgbot/access';

// The allowlist is the production posture for the alpha: one approved chat.
// Both failure directions are bugs — a parse that widens it hands OCT's feed to
// a stranger, and one that narrows it takes the promised chat offline.
describe('parseAllowedChatIds', () => {
  it('returns null when unset — "no allowlist", not "empty allowlist"', () => {
    expect(parseAllowedChatIds(undefined)).toBeNull();
  });

  it('treats a blank or comma-only value as unset rather than as a lockout', () => {
    expect(parseAllowedChatIds('')).toBeNull();
    expect(parseAllowedChatIds('   ')).toBeNull();
    expect(parseAllowedChatIds(',,  ,')).toBeNull();
  });

  it('parses a single id', () => {
    expect(parseAllowedChatIds('12345')).toEqual(new Set([12345]));
  });

  it('parses negative group and supergroup ids', () => {
    // Groups are negative and supergroups are large negatives (-100…); a
    // parser that rejected the sign would serve nothing but DMs.
    expect(parseAllowedChatIds('-1001234567890,-500')).toEqual(new Set([-1001234567890, -500]));
  });

  it('tolerates whitespace and trailing commas', () => {
    expect(parseAllowedChatIds(' 1, 2 ,3, ')).toEqual(new Set([1, 2, 3]));
  });

  it('drops junk instead of turning it into a chat id nothing can match', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseAllowedChatIds('1,abc,2.5,3')).toEqual(new Set([1, 3]));
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('drops an id beyond safe-integer range', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseAllowedChatIds('99999999999999999999')).toBeNull();
    warn.mockRestore();
  });

  it('deduplicates', () => {
    expect(parseAllowedChatIds('7,7,7')).toEqual(new Set([7]));
  });
});

describe('isChatAllowed', () => {
  it('serves everyone when there is no allowlist', () => {
    expect(isChatAllowed(-1, null)).toBe(true);
    expect(isChatAllowed(123456, null)).toBe(true);
  });

  it('serves only listed chats when there is one', () => {
    const list = new Set([-1001234567890]);
    expect(isChatAllowed(-1001234567890, list)).toBe(true);
    expect(isChatAllowed(-1009999999999, list)).toBe(false);
    expect(isChatAllowed(42, list)).toBe(false);
  });
});

describe('readAllowedChatIds', () => {
  const saved = {
    primary: process.env.TG_BOT_ALLOWED_CHAT_IDS,
    fallback: process.env.OCT_TG_BOT_ALLOWED_CHAT_IDS,
  };

  afterEach(() => {
    if (saved.primary === undefined) delete process.env.TG_BOT_ALLOWED_CHAT_IDS;
    else process.env.TG_BOT_ALLOWED_CHAT_IDS = saved.primary;
    if (saved.fallback === undefined) delete process.env.OCT_TG_BOT_ALLOWED_CHAT_IDS;
    else process.env.OCT_TG_BOT_ALLOWED_CHAT_IDS = saved.fallback;
  });

  it('reads the primary variable', () => {
    process.env.TG_BOT_ALLOWED_CHAT_IDS = '-42';
    expect(readAllowedChatIds()).toEqual(new Set([-42]));
  });

  it('falls back to the OCT_-prefixed name', () => {
    delete process.env.TG_BOT_ALLOWED_CHAT_IDS;
    process.env.OCT_TG_BOT_ALLOWED_CHAT_IDS = '-43';
    expect(readAllowedChatIds()).toEqual(new Set([-43]));
  });

  it('is null when neither is set', () => {
    delete process.env.TG_BOT_ALLOWED_CHAT_IDS;
    delete process.env.OCT_TG_BOT_ALLOWED_CHAT_IDS;
    expect(readAllowedChatIds()).toBeNull();
  });
});
