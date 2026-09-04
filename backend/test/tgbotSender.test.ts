import { describe, it, expect } from 'vitest';
import {
  PER_CHAT_MAX_IN_WINDOW,
  PER_CHAT_WINDOW_MS,
  PerChatRateLimiter,
  isPermanentChatFailure,
} from '../src/tgbot/sender';
import { looksLikeBotToken, redactToken } from '../src/tgbot/api';
import { DEFAULT_CHAT_SETTINGS, readSettings } from '../src/tgbot/chatStore';

// Telegram meters ~20 messages per minute into one group and throttles a bot
// that keeps overrunning it — which would take the command replies down with
// the alerts, so the window arithmetic is worth pinning.
describe('PerChatRateLimiter', () => {
  it('allows up to the cap inside one window', () => {
    const limiter = new PerChatRateLimiter(1000, 3);
    expect([limiter.tryConsume(1, 0), limiter.tryConsume(1, 1), limiter.tryConsume(1, 2)]).toEqual([
      true,
      true,
      true,
    ]);
    expect(limiter.tryConsume(1, 3)).toBe(false);
  });

  it('meters each chat separately', () => {
    const limiter = new PerChatRateLimiter(1000, 1);
    expect(limiter.tryConsume(1, 0)).toBe(true);
    expect(limiter.tryConsume(2, 0)).toBe(true);
    expect(limiter.tryConsume(1, 0)).toBe(false);
  });

  it('is a sliding window, not a fixed bucket', () => {
    const limiter = new PerChatRateLimiter(1000, 2);
    limiter.tryConsume(1, 0);
    limiter.tryConsume(1, 500);
    expect(limiter.tryConsume(1, 900)).toBe(false);
    // The first send ages out at t=1001, freeing exactly one slot.
    expect(limiter.tryConsume(1, 1001)).toBe(true);
    expect(limiter.tryConsume(1, 1002)).toBe(false);
  });

  it('reports usage without consuming', () => {
    const limiter = new PerChatRateLimiter(1000, 5);
    limiter.tryConsume(1, 0);
    limiter.tryConsume(1, 100);
    expect(limiter.used(1, 200)).toBe(2);
    expect(limiter.used(1, 2000)).toBe(0);
    expect(limiter.used(999, 0)).toBe(0);
  });

  it('prunes idle chats so the map cannot grow forever', () => {
    const limiter = new PerChatRateLimiter(1000, 5);
    limiter.tryConsume(1, 0);
    limiter.prune(5000);
    expect(limiter.used(1, 5000)).toBe(0);
  });

  it('ships with headroom under Telegram\'s documented per-group ceiling', () => {
    expect(PER_CHAT_MAX_IN_WINDOW).toBeLessThan(20);
    expect(PER_CHAT_WINDOW_MS).toBe(60_000);
  });
});

describe('isPermanentChatFailure', () => {
  it('treats 403 as permanent — blocked, kicked, or deactivated', () => {
    expect(isPermanentChatFailure({ ok: false, errorCode: 403, description: 'bot was blocked' })).toBe(
      true,
    );
  });

  it('treats a 400 "chat not found" as permanent', () => {
    expect(isPermanentChatFailure({ ok: false, errorCode: 400, description: 'Bad Request: chat not found' })).toBe(
      true,
    );
  });

  it('treats rate limits, 5xx and transport failures as transient', () => {
    expect(isPermanentChatFailure({ ok: false, errorCode: 429, retryAfterSec: 5 })).toBe(false);
    expect(isPermanentChatFailure({ ok: false, errorCode: 500 })).toBe(false);
    expect(isPermanentChatFailure({ ok: false, errorCode: 0, description: 'fetch failed' })).toBe(false);
  });

  it('does not treat an ordinary 400 as permanent', () => {
    // e.g. "can't parse entities" — our bug, not a dead chat. Disabling the
    // chat for it would silently take the tenant offline.
    expect(
      isPermanentChatFailure({ ok: false, errorCode: 400, description: "can't parse entities" }),
    ).toBe(false);
  });
});

describe('token hygiene', () => {
  it('redacts a bot token out of anything about to be logged', () => {
    const leaked = 'Error at https://api.telegram.org/bot123456789:AAH-abc_DEF/getUpdates';
    expect(redactToken(leaked)).toBe('Error at https://api.telegram.org/bot<redacted>/getUpdates');
    expect(redactToken(leaked)).not.toContain('AAH-abc_DEF');
  });

  it('accepts a real @BotFather token shape and rejects placeholders', () => {
    expect(looksLikeBotToken('123456789:AAHfaketokenfaketokenfaketoken1234')).toBe(true);
    expect(looksLikeBotToken('  123456789:AAHfaketokenfaketokenfaketoken1234  ')).toBe(true);
    expect(looksLikeBotToken('your-token-here')).toBe(false);
    expect(looksLikeBotToken('123:short')).toBe(false);
    expect(looksLikeBotToken('')).toBe(false);
  });
});

describe('chat settings', () => {
  it('defaults every absent key to OFF rather than reading it as on', () => {
    expect(readSettings({})).toEqual(DEFAULT_CHAT_SETTINGS);
    expect(readSettings(null)).toEqual(DEFAULT_CHAT_SETTINGS);
    expect(readSettings(undefined)).toEqual(DEFAULT_CHAT_SETTINGS);
  });

  it('honours an explicit stored value', () => {
    expect(readSettings({ alerts: { missedRunner: 'digest' } }).alerts.missedRunner).toBe('digest');
  });

  it('ignores a value of the wrong type instead of coercing it', () => {
    expect(readSettings({ alerts: { contract: 'yes' } })).toEqual(DEFAULT_CHAT_SETTINGS);
    expect(readSettings({ alerts: 'all' })).toEqual(DEFAULT_CHAT_SETTINGS);
  });
});
