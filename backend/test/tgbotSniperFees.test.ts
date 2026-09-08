// `/fees` from Telegram — the refusals first, the happy path last.
//
// This is a surface onto the sniper, the one subsystem that spends money, so
// the tests that matter most are the ones that pin what it will NOT do: no
// group write, no unnamed operator, no coerced amount, and no write at all on
// a deployment that has not opted in. The store is a fake with the real
// normalization behind it (`normalizeFeeSettings`), so a value that reaches it
// is a value the production store would have accepted.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { TgChatRecord } from '../src/tgbot/chatStore';
import { DEFAULT_CHAT_SETTINGS } from '../src/tgbot/alertPolicy';
import { MAX_FEE_COMPONENT, normalizeFeeSettings, parseFeeComponent } from '../src/sniper/fees';
import type { SniperFeeSettings } from '../src/sniper/types';
import { decideSniperAccess, parseSniperOperators } from '../src/tgbot/sniperAccess';

const roster = vi.hoisted(() => new Map<number, TgChatRecord>());
const stored = vi.hoisted(() => new Map<string, SniperFeeSettings>());

vi.mock('../src/tgbot/chatStore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tgbot/chatStore')>();
  return {
    ...actual,
    getChatStore: () => ({
      listEnabled: async (): Promise<TgChatRecord[]> => [...roster.values()],
      get: async (chatId: number): Promise<TgChatRecord | null> => roster.get(chatId) ?? null,
      updateSettings: async (): Promise<boolean> => true,
    }),
  };
});

vi.mock('../src/sniper/runtime.js', async () => {
  const fees = await import('../src/sniper/fees');
  return {
    getSniperRuntime: () => ({
      store: {
        getFeeSettings: async (userId: string): Promise<SniperFeeSettings> =>
          fees.normalizeFeeSettings(stored.get(userId)),
        setFeeSettings: async (userId: string, next: SniperFeeSettings): Promise<void> => {
          stored.set(userId, fees.normalizeFeeSettings(next));
        },
      },
    }),
  };
});

const { fees: feesCommand, parseFeesCommand } = await import('../src/tgbot/commands/fees');

const OPERATOR = 424242;
const PRIVATE_CHAT = OPERATOR; // in a private chat the chat id IS the user id
const GROUP_CHAT = -1001234567890;

function seedChat(chatId: number, chatType: string, sourceUserId: string | null): void {
  roster.set(chatId, {
    chatId,
    chatType,
    title: 'Chat',
    addedByTgUserId: OPERATOR,
    enabled: true,
    sourceUserId,
    settings: DEFAULT_CHAT_SETTINGS,
    plan: 'free',
    entitlements: {},
    createdAt: new Date().toISOString(),
  });
}

/** A command context that records replies instead of calling Telegram. */
function ctxFor(
  chatId: number,
  chatType: 'private' | 'group' | 'supergroup',
  fromId: number | null,
  args: string[],
) {
  const replies: string[] = [];
  return {
    replies,
    ctx: {
      chatId,
      chat: { id: chatId, type: chatType },
      from: fromId === null ? null : { id: fromId, is_bot: false, first_name: 'Op' },
      command: { name: 'fees', args, raw: `/fees ${args.join(' ')}` },
      botUsername: 'octbot',
      authorizeWrite: async () => ({ allow: true, message: '' }),
      reply: async (text: string) => {
        replies.push(text);
        return true;
      },
    },
  };
}

beforeEach(() => {
  roster.clear();
  stored.clear();
  delete process.env.TG_BOT_SNIPER_OPERATORS;
  delete process.env.OCT_TG_BOT_SNIPER_OPERATORS;
  delete process.env.TG_BOT_ALERT_SOURCE_USER_ID;
  delete process.env.OCT_MODE;
});

describe('parseSniperOperators', () => {
  it('is null — i.e. NOBODY — when unset or blank, unlike the chat allowlist', () => {
    expect(parseSniperOperators(undefined)).toBeNull();
    expect(parseSniperOperators('')).toBeNull();
    expect(parseSniperOperators('  , ,')).toBeNull();
  });

  it('rejects a negative id: that is a chat, not a user', () => {
    expect(parseSniperOperators('-1001234567890')).toBeNull();
  });

  it('parses a list and drops the unusable entries', () => {
    expect([...(parseSniperOperators('1, 2 ,oops,3') ?? [])]).toEqual([1, 2, 3]);
  });
});

describe('decideSniperAccess', () => {
  const chat = { sourceUserId: 'operator-account' };
  const operators = new Set([OPERATOR]);

  it('REFUSES a group, even for an operator who is an admin there', () => {
    const verdict = decideSniperAccess({
      actor: { chatId: GROUP_CHAT, chatType: 'supergroup', userId: OPERATOR, isAdmin: true },
      chat,
      operators,
      fallbackUserId: null,
    });
    expect(verdict).toMatchObject({ allow: false, reason: 'not_private' });
  });

  it('refuses a plain group too — the rule is chat type, not privilege', () => {
    const verdict = decideSniperAccess({
      actor: { chatId: GROUP_CHAT, chatType: 'group', userId: OPERATOR, isAdmin: true },
      chat,
      operators,
      fallbackUserId: null,
    });
    expect(verdict).toMatchObject({ allow: false, reason: 'not_private' });
  });

  it('refuses a private chat whose sender is not its owner (a forged sender)', () => {
    const verdict = decideSniperAccess({
      actor: { chatId: PRIVATE_CHAT, chatType: 'private', userId: 999, isAdmin: false },
      chat,
      operators: new Set([999]),
      fallbackUserId: null,
    });
    expect(verdict).toMatchObject({ allow: false, reason: 'not_owner' });
  });

  it('refuses everyone when the allowlist is unset — fail closed by default', () => {
    const verdict = decideSniperAccess({
      actor: { chatId: PRIVATE_CHAT, chatType: 'private', userId: OPERATOR, isAdmin: false },
      chat,
      operators: null,
      fallbackUserId: null,
    });
    expect(verdict).toMatchObject({ allow: false, reason: 'not_operator' });
  });

  it('refuses an operator whose chat resolves to no OCT account', () => {
    const verdict = decideSniperAccess({
      actor: { chatId: PRIVATE_CHAT, chatType: 'private', userId: OPERATOR, isAdmin: false },
      chat: { sourceUserId: null },
      operators,
      fallbackUserId: null,
    });
    expect(verdict).toMatchObject({ allow: false, reason: 'no_account' });
  });

  it('allows the owner-operator of a linked private chat, naming the account', () => {
    const verdict = decideSniperAccess({
      actor: { chatId: PRIVATE_CHAT, chatType: 'private', userId: OPERATOR, isAdmin: false },
      chat,
      operators,
      fallbackUserId: 'instance-default',
    });
    expect(verdict).toEqual({ allow: true, userId: 'operator-account' });
  });

  it('falls back to the instance default when the row names nobody', () => {
    const verdict = decideSniperAccess({
      actor: { chatId: PRIVATE_CHAT, chatType: 'private', userId: OPERATOR, isAdmin: false },
      chat: { sourceUserId: null },
      operators,
      fallbackUserId: 'instance-default',
    });
    expect(verdict).toEqual({ allow: true, userId: 'instance-default' });
  });
});

describe('parseFeesCommand', () => {
  it('reads with no arguments', () => {
    expect(parseFeesCommand([])).toEqual({ kind: 'show' });
  });

  it('accepts every spelling of the priority fee', () => {
    for (const alias of ['priority', 'prio', 'priorityFee']) {
      expect(parseFeesCommand([alias, '0.01'])).toEqual({
        kind: 'set',
        component: 'priorityFee',
        raw: '0.01',
      });
    }
  });

  it('refuses an unknown setting rather than guessing', () => {
    expect(parseFeesCommand(['slippage', '5'])).toMatchObject({ kind: 'usage' });
  });

  it('refuses a component with no amount', () => {
    expect(parseFeesCommand(['tip'])).toMatchObject({ kind: 'usage' });
  });
});

describe('the bounds come from the shared validator', () => {
  it('refuses anything isValidFeeComponent refuses, and coerces nothing', () => {
    expect(parseFeeComponent('-1', 0)).toBeNull();
    expect(parseFeeComponent('abc', 0)).toBeNull();
    expect(parseFeeComponent(String(MAX_FEE_COMPONENT + 1), 0)).toBeNull();
    expect(parseFeeComponent(null, 0)).toBeNull();
    expect(parseFeeComponent('', 0)).toBeNull();
    expect(parseFeeComponent('0.0005', 0)).toBe(0.0005);
    expect(parseFeeComponent(String(MAX_FEE_COMPONENT), 0)).toBe(MAX_FEE_COMPONENT);
  });

  it('leaves the other component alone when one is patched', () => {
    expect(parseFeeComponent(undefined, 0.25)).toBe(0.25);
  });
});

describe('/fees end to end', () => {
  it('REFUSES A WRITE FROM A GROUP and stores nothing', async () => {
    process.env.TG_BOT_SNIPER_OPERATORS = String(OPERATOR);
    seedChat(GROUP_CHAT, 'supergroup', 'operator-account');

    const { ctx, replies } = ctxFor(GROUP_CHAT, 'supergroup', OPERATOR, ['tip', '0.01']);
    await feesCommand.execute(ctx);

    expect(replies[0]).toContain('private-chat only');
    expect(stored.size).toBe(0);
  });

  it('refuses a read from a group too — account settings do not belong in a room', async () => {
    process.env.TG_BOT_SNIPER_OPERATORS = String(OPERATOR);
    seedChat(GROUP_CHAT, 'supergroup', 'operator-account');

    const { ctx, replies } = ctxFor(GROUP_CHAT, 'supergroup', OPERATOR, []);
    await feesCommand.execute(ctx);

    expect(replies[0]).toContain('private-chat only');
  });

  it('refuses in a private chat when no operator is configured', async () => {
    seedChat(PRIVATE_CHAT, 'private', 'operator-account');

    const { ctx, replies } = ctxFor(PRIVATE_CHAT, 'private', OPERATOR, ['tip', '0.01']);
    await feesCommand.execute(ctx);

    expect(replies[0]).toContain('not authorized');
    expect(stored.size).toBe(0);
  });

  it('refuses before touching the store when the chat has never run /start', async () => {
    process.env.TG_BOT_SNIPER_OPERATORS = String(OPERATOR);

    const { ctx, replies } = ctxFor(PRIVATE_CHAT, 'private', OPERATOR, ['tip', '0.01']);
    await feesCommand.execute(ctx);

    expect(replies[0]).toContain('not registered');
    expect(stored.size).toBe(0);
  });

  it('reads the account fees for an authorized operator', async () => {
    process.env.TG_BOT_SNIPER_OPERATORS = String(OPERATOR);
    seedChat(PRIVATE_CHAT, 'private', 'operator-account');
    stored.set('operator-account', normalizeFeeSettings({ tip: 0.002, priorityFee: 0.0005 }));

    const { ctx, replies } = ctxFor(PRIVATE_CHAT, 'private', OPERATOR, []);
    await feesCommand.execute(ctx);

    expect(replies[0]).toContain('0.002 SOL');
    expect(replies[0]).toContain('0.0005 SOL');
  });

  it('writes one component and leaves the other untouched', async () => {
    process.env.TG_BOT_SNIPER_OPERATORS = String(OPERATOR);
    seedChat(PRIVATE_CHAT, 'private', 'operator-account');
    stored.set('operator-account', normalizeFeeSettings({ tip: 0.002, priorityFee: 0.0005 }));

    const { ctx } = ctxFor(PRIVATE_CHAT, 'private', OPERATOR, ['tip', '0.01']);
    await feesCommand.execute(ctx);

    expect(stored.get('operator-account')).toEqual({ tip: 0.01, priorityFee: 0.0005 });
  });

  it('refuses an out-of-range amount rather than coercing it to zero', async () => {
    process.env.TG_BOT_SNIPER_OPERATORS = String(OPERATOR);
    seedChat(PRIVATE_CHAT, 'private', 'operator-account');
    stored.set('operator-account', normalizeFeeSettings({ tip: 0.002, priorityFee: 0 }));

    for (const bad of ['-1', 'lots', String(MAX_FEE_COMPONENT + 1)]) {
      const { ctx, replies } = ctxFor(PRIVATE_CHAT, 'private', OPERATOR, ['tip', bad]);
      await feesCommand.execute(ctx);
      expect(replies[0]).toContain(`between 0 and ${MAX_FEE_COMPONENT}`);
      expect(stored.get('operator-account')?.tip).toBe(0.002);
    }
  });

  it('refuses when Telegram supplied no sender', async () => {
    process.env.TG_BOT_SNIPER_OPERATORS = String(OPERATOR);
    seedChat(PRIVATE_CHAT, 'private', 'operator-account');

    const { ctx, replies } = ctxFor(PRIVATE_CHAT, 'private', null, ['tip', '0.01']);
    await feesCommand.execute(ctx);

    expect(replies[0]).toContain('signed-in Telegram sender');
    expect(stored.size).toBe(0);
  });
});
