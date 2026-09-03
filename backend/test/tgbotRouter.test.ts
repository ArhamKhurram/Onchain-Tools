import { describe, it, expect } from 'vitest';
import { classifyUpdate, nextOffset, parseCommand } from '../src/tgbot/router';
import type { TgChat, TgUpdate } from '../src/tgbot/types';

const BOT = 'oct_alerts_bot';

const chat = (over: Partial<TgChat> = {}): TgChat => ({
  id: -1001234567890,
  type: 'supergroup',
  title: 'Trenches',
  ...over,
});

const update = (text: string, over: Record<string, unknown> = {}): TgUpdate => ({
  update_id: 1,
  message: {
    message_id: 10,
    chat: chat(),
    date: 0,
    from: { id: 99, is_bot: false, first_name: 'Sat' },
    text,
    ...over,
  },
});

describe('parseCommand', () => {
  it('parses a bare command', () => {
    expect(parseCommand('/help', BOT)).toMatchObject({ name: 'help', args: [], addressedTo: null });
  });

  it('parses a command addressed to this bot', () => {
    expect(parseCommand(`/help@${BOT}`, BOT)).toMatchObject({ name: 'help', addressedTo: BOT });
  });

  it('IGNORES a command addressed to a different bot', () => {
    // Privacy mode still delivers `/cmd@otherbot` to every bot in the group, so
    // this rejection is the thing that keeps OCT out of other bots' traffic.
    expect(parseCommand('/help@some_other_bot', BOT)).toBeNull();
  });

  it('matches the @suffix case-insensitively', () => {
    expect(parseCommand('/HELP@OCT_Alerts_Bot', BOT)).toMatchObject({ name: 'help' });
  });

  it('splits arguments on any run of whitespace', () => {
    const parsed = parseCommand('/token   So111  sol ', BOT);
    expect(parsed).toMatchObject({ name: 'token', args: ['So111', 'sol'], rest: 'So111  sol' });
  });

  it('keeps the raw tail for commands that want it unsplit', () => {
    expect(parseCommand(`/token@${BOT} abc def`, BOT)?.rest).toBe('abc def');
  });

  it('rejects anything that is not a command at offset 0', () => {
    expect(parseCommand('hello /help', BOT)).toBeNull();
    expect(parseCommand(' /help', BOT)).toBeNull();
    expect(parseCommand('/', BOT)).toBeNull();
    expect(parseCommand('', BOT)).toBeNull();
    expect(parseCommand('/-bad', BOT)).toBeNull();
  });

  it('accepts a bot with no username configured', () => {
    // getMe can come back without a username; that must not make every
    // explicitly-addressed command unparseable.
    expect(parseCommand('/help@anything', '')).toMatchObject({ name: 'help' });
  });
});

describe('classifyUpdate', () => {
  const ctx = { botUsername: BOT, allowlist: null };

  it('routes a command in a group', () => {
    const decision = classifyUpdate(update(`/status@${BOT}`), ctx);
    expect(decision).toMatchObject({ kind: 'command', chatId: -1001234567890 });
  });

  it('routes a bare command in a group — Telegram treats it as addressed to us', () => {
    expect(classifyUpdate(update('/status'), ctx).kind).toBe('command');
  });

  it('ignores ordinary group chatter', () => {
    // The promise made to the group owner: nothing but commands is read.
    expect(classifyUpdate(update('gm everyone'), ctx)).toMatchObject({ kind: 'ignore' });
  });

  it('ignores a command aimed at another bot', () => {
    expect(classifyUpdate(update('/stats@rose'), ctx)).toMatchObject({ kind: 'ignore' });
  });

  it('ignores messages from other bots', () => {
    const u = update('/help', { from: { id: 5, is_bot: true, first_name: 'Rose' } });
    expect(classifyUpdate(u, ctx)).toMatchObject({ kind: 'ignore' });
  });

  it('ignores edited messages and channel posts', () => {
    const edited: TgUpdate = { update_id: 2, edited_message: update('/help').message };
    const channel: TgUpdate = { update_id: 3, channel_post: update('/help').message };
    expect(classifyUpdate(edited, ctx).kind).toBe('ignore');
    expect(classifyUpdate(channel, ctx).kind).toBe('ignore');
  });

  it('ignores a message with no text (photo, sticker, service message)', () => {
    const u: TgUpdate = { update_id: 4, message: { message_id: 1, chat: chat(), date: 0 } };
    expect(classifyUpdate(u, ctx).kind).toBe('ignore');
  });

  it('carries the sender through for /start attribution', () => {
    const decision = classifyUpdate(update('/start'), ctx);
    expect(decision.kind === 'command' && decision.from?.id).toBe(99);
  });

  it('declines a chat outside the allowlist', () => {
    const decision = classifyUpdate(update('/help'), { botUsername: BOT, allowlist: new Set([42]) });
    expect(decision).toEqual({ kind: 'decline', chatId: -1001234567890 });
  });

  it('serves a chat inside the allowlist', () => {
    const decision = classifyUpdate(update('/help'), {
      botUsername: BOT,
      allowlist: new Set([-1001234567890]),
    });
    expect(decision.kind).toBe('command');
  });

  it('never declines before checking that it was addressed at all', () => {
    // Chatter in a non-allowlisted chat must be silence, not a decline reply —
    // otherwise the bot answers every message in a room it was dropped into.
    const decision = classifyUpdate(update('hello'), { botUsername: BOT, allowlist: new Set([42]) });
    expect(decision.kind).toBe('ignore');
  });

  it('routes a private-chat command the same way', () => {
    const u = update('/help', { chat: chat({ id: 555, type: 'private', title: undefined }) });
    expect(classifyUpdate(u, ctx)).toMatchObject({ kind: 'command', chatId: 555 });
  });
});

describe('nextOffset', () => {
  it('advances past the highest update id in the batch', () => {
    expect(nextOffset([{ update_id: 7 }, { update_id: 9 }, { update_id: 8 }], 0)).toBe(10);
  });

  it('leaves the offset alone for an empty batch', () => {
    expect(nextOffset([], 12)).toBe(12);
    expect(nextOffset([], 0)).toBe(0);
  });

  it('never moves backwards on an out-of-order batch', () => {
    expect(nextOffset([{ update_id: 3 }], 12)).toBe(12);
  });
});
