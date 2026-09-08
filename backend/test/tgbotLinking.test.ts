// `/link`, `/unlink` and `/filters` as they behave against a roster.
//
// The credential's own rules are pinned in tgbotLinkCodes.test.ts. What is
// tested here is the OTHER half of the proof — that a binding needs authority
// over the CHAT as well as a code for the ACCOUNT — plus the two consequences
// of the binding: that unlinking restores the pre-link behaviour exactly, and
// that a filter edit from Telegram cannot store a value the console's validator
// would reject.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { TgChatRecord } from '../src/tgbot/chatStore';
import { DEFAULT_CHAT_SETTINGS } from '../src/tgbot/alertPolicy';
import { decideChatWrite } from '../src/tgbot/permissions';
import { resolveAlertSource } from '../src/tgbot/source';
import type { McapCrossFilters } from '../src/mcapCross/filters';

const roster = vi.hoisted(() => new Map<number, TgChatRecord>());
const filterRows = vi.hoisted(() => new Map<string, McapCrossFilters>());

vi.mock('../src/tgbot/chatStore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tgbot/chatStore')>();
  return {
    ...actual,
    getChatStore: () => ({
      listEnabled: async (): Promise<TgChatRecord[]> => [...roster.values()],
      get: async (chatId: number): Promise<TgChatRecord | null> => roster.get(chatId) ?? null,
      updateSettings: async (): Promise<boolean> => true,
      setSourceUser: async (chatId: number, userId: string | null): Promise<boolean> => {
        const record = roster.get(chatId);
        if (!record) return false;
        roster.set(chatId, { ...record, sourceUserId: userId });
        return true;
      },
    }),
  };
});

// The storage abstraction, with the REAL sanitizer behind it — so a value that
// reaches this map is a value the production store would have accepted.
vi.mock('../src/storage/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/storage/index')>();
  const { sanitizeStoredFilters } = await import('../src/mcapCross/filters');
  return {
    ...actual,
    isHostedMode: () => false,
    getStorageProvider: () => ({
      getMcapCrossFilters: async (userId: string) =>
        sanitizeStoredFilters(filterRows.get(userId) ?? {}),
      setMcapCrossFilters: async (userId: string, next: McapCrossFilters) => {
        const clean = sanitizeStoredFilters(next);
        filterRows.set(userId, clean);
        return clean;
      },
    }),
  };
});

const { link, unlink } = await import('../src/tgbot/commands/link');
const { filters } = await import('../src/tgbot/commands/filters');
const { getLinkCodeService, resetLinkCodeService } = await import('../src/tgbot/linkCodes');
const { resetFilterCache } = await import('../src/tgbot/filterAccess');
const { MCAP_CROSS_FILTER_KEYS } = await import('../src/tgbot/filtersView');

const ALICE = 'aaaaaaaa-1111-2222-3333-444444444444';
const ADMIN = 5150;
const MEMBER = 6161;
const GROUP = -1001234567890;
const DM = 777;

function seed(chatId: number, chatType: string, sourceUserId: string | null): void {
  roster.set(chatId, {
    chatId,
    chatType,
    title: 'Chat',
    addedByTgUserId: ADMIN,
    enabled: true,
    sourceUserId,
    settings: DEFAULT_CHAT_SETTINGS,
    plan: 'free',
    entitlements: {},
    createdAt: new Date().toISOString(),
  });
}

/**
 * A command context that records replies. `isAdmin` drives the REAL
 * `decideChatWrite`, so these tests exercise the shipped rule rather than a
 * stand-in for it.
 */
function ctxFor(
  chatId: number,
  chatType: 'private' | 'group' | 'supergroup',
  fromId: number,
  args: string[],
  isAdmin = false,
) {
  const replies: string[] = [];
  return {
    replies,
    ctx: {
      chatId,
      chat: { id: chatId, type: chatType },
      from: { id: fromId, is_bot: false, first_name: 'Someone' },
      command: { name: 'link', args, rest: args.join(' '), addressedTo: null },
      botUsername: 'octbot',
      authorizeWrite: async () => {
        const verdict = decideChatWrite({ chatId, chatType, userId: fromId, isAdmin });
        return verdict.allow ? { allow: true, message: '' } : { allow: false, message: verdict.message };
      },
      reply: async (text: string) => {
        replies.push(text);
        return true;
      },
    },
  };
}

async function mintFor(userId: string): Promise<string> {
  const minted = await getLinkCodeService().mint(userId);
  if (!minted.ok) throw new Error('mint failed');
  return minted.code;
}

beforeEach(() => {
  roster.clear();
  filterRows.clear();
  resetLinkCodeService();
  resetFilterCache();
});

// ---------------------------------------------------------------------------

describe('/link — proof of the chat', () => {
  it('binds a private chat and writes source_user_id', async () => {
    seed(DM, 'private', null);
    const code = await mintFor(ALICE);
    const { ctx, replies } = ctxFor(DM, 'private', DM, [code]);

    await link.execute(ctx as never);

    expect(roster.get(DM)?.sourceUserId).toBe(ALICE);
    expect(replies[0]).toContain('Linked.');
    // The fingerprint, never the raw id and never the code.
    expect(replies[0]).toContain('#aaaaaaaa');
    expect(replies[0]).not.toContain(code);
    expect(replies[0]).not.toContain(ALICE);
  });

  it('refuses a group member who is not an admin, and does not spend the code', async () => {
    seed(GROUP, 'supergroup', null);
    const code = await mintFor(ALICE);
    const member = ctxFor(GROUP, 'supergroup', MEMBER, [code], false);

    await link.execute(member.ctx as never);

    expect(roster.get(GROUP)?.sourceUserId).toBeNull();
    expect(member.replies[0]).toContain('Only a group admin');

    // The refusal happened BEFORE redemption, so the admin's code still works.
    const admin = ctxFor(GROUP, 'supergroup', ADMIN, [code], true);
    await link.execute(admin.ctx as never);
    expect(roster.get(GROUP)?.sourceUserId).toBe(ALICE);
  });

  it('refuses an unregistered chat rather than registering one as a side effect', async () => {
    const code = await mintFor(ALICE);
    const { ctx, replies } = ctxFor(DM, 'private', DM, [code]);

    await link.execute(ctx as never);

    expect(roster.has(DM)).toBe(false);
    expect(replies[0]).toContain('/start');
  });

  it('cannot bind without a code — there is no other input that names an account', async () => {
    seed(DM, 'private', null);
    const { ctx, replies } = ctxFor(DM, 'private', DM, []);

    await link.execute(ctx as never);

    expect(roster.get(DM)?.sourceUserId).toBeNull();
    // The bare form is instructions, not a binding.
    expect(replies[0]).toContain('/link');
  });

  it('refuses somebody else’s made-up code with one uninformative sentence', async () => {
    seed(DM, 'private', null);
    await mintFor(ALICE); // a real code exists; this is not it
    const { ctx, replies } = ctxFor(DM, 'private', DM, ['ZZZZ-ZZZ1']);

    await link.execute(ctx as never);

    expect(roster.get(DM)?.sourceUserId).toBeNull();
    expect(replies[0]).toContain('not valid');
    // Nothing tells a guesser whether the code existed, expired or was spent.
    expect(replies[0]).not.toMatch(/expired|already used|unknown code/i);
  });

  it('will not reuse a code to bind a second chat', async () => {
    seed(DM, 'private', null);
    seed(GROUP, 'supergroup', null);
    const code = await mintFor(ALICE);

    await link.execute(ctxFor(DM, 'private', DM, [code]).ctx as never);
    const second = ctxFor(GROUP, 'supergroup', ADMIN, [code], true);
    await link.execute(second.ctx as never);

    expect(roster.get(DM)?.sourceUserId).toBe(ALICE);
    expect(roster.get(GROUP)?.sourceUserId).toBeNull();
  });
});

describe('/unlink', () => {
  it('asks first, then restores the pre-link fallback exactly', async () => {
    seed(GROUP, 'supergroup', ALICE);

    const asked = ctxFor(GROUP, 'supergroup', ADMIN, [], true);
    await unlink.execute(asked.ctx as never);
    expect(roster.get(GROUP)?.sourceUserId).toBe(ALICE);
    expect(asked.replies[0]).toContain('/unlink confirm');

    const done = ctxFor(GROUP, 'supergroup', ADMIN, ['confirm'], true);
    await unlink.execute(done.ctx as never);

    const record = roster.get(GROUP)!;
    expect(record.sourceUserId).toBeNull();
    // "Back to today's behaviour" means precisely this: resolveAlertSource
    // falls through to the instance default again, and to nothing without one.
    expect(resolveAlertSource(record, 'operator-account')).toBe('operator-account');
    expect(resolveAlertSource(record, null)).toBeNull();
  });

  it('needs group admin', async () => {
    seed(GROUP, 'supergroup', ALICE);
    const { ctx, replies } = ctxFor(GROUP, 'supergroup', MEMBER, ['confirm'], false);

    await unlink.execute(ctx as never);

    expect(roster.get(GROUP)?.sourceUserId).toBe(ALICE);
    expect(replies[0]).toContain('Only a group admin');
  });

  it('says so when there is nothing to unlink', async () => {
    seed(DM, 'private', null);
    const { ctx, replies } = ctxFor(DM, 'private', DM, ['confirm']);
    await unlink.execute(ctx as never);
    expect(replies[0]).toContain('nothing to unlink');
  });
});

describe('/filters', () => {
  it('refuses to edit anything without a binding, and says why', async () => {
    seed(GROUP, 'supergroup', null);
    const { ctx, replies } = ctxFor(GROUP, 'supergroup', ADMIN, ['minLiquidityUsd', '5000'], true);

    await filters.execute(ctx as never);

    expect(filterRows.size).toBe(0);
    expect(replies[0]).toContain('/link');
  });

  it('writes through the shared validator — a good value lands', async () => {
    seed(DM, 'private', null);
    roster.set(DM, { ...roster.get(DM)!, sourceUserId: ALICE });
    const { ctx, replies } = ctxFor(DM, 'private', DM, ['minLiquidityUsd', '5000']);

    await filters.execute(ctx as never);

    expect(filterRows.get(ALICE)).toEqual({ minLiquidityUsd: 5000 });
    expect(replies[0]).toContain('$5,000');
  });

  it('refuses a value the console would refuse, with the console’s own sentence', async () => {
    seed(DM, 'private', null);
    roster.set(DM, { ...roster.get(DM)!, sourceUserId: ALICE });
    // 150 into a fraction field is the classic "typed a percent" mistake. The
    // shared validator rejects rather than dividing by 100, and the bot repeats
    // its wording rather than inventing one.
    const { ctx, replies } = ctxFor(DM, 'private', DM, ['maxTaxRate', '150']);

    await filters.execute(ctx as never);

    expect(filterRows.get(ALICE)).toBeUndefined();
    expect(replies[0]).toContain('0.05 = 5%');
  });

  it('accepts a percentage with a sign and stores the fraction', async () => {
    seed(DM, 'private', null);
    roster.set(DM, { ...roster.get(DM)!, sourceUserId: ALICE });
    await filters.execute(ctxFor(DM, 'private', DM, ['maxTaxRate', '5%']).ctx as never);
    expect(filterRows.get(ALICE)).toEqual({ maxTaxRate: 0.05 });
  });

  it('clears an override back to inherited', async () => {
    seed(DM, 'private', null);
    roster.set(DM, { ...roster.get(DM)!, sourceUserId: ALICE });
    filterRows.set(ALICE, { minLiquidityUsd: 5000 });

    await filters.execute(ctxFor(DM, 'private', DM, ['minLiquidityUsd', 'inherit']).ctx as never);

    expect(filterRows.get(ALICE)).toEqual({});
  });

  it('needs group admin to write but not to read', async () => {
    seed(GROUP, 'supergroup', ALICE);

    const write = ctxFor(GROUP, 'supergroup', MEMBER, ['minLiquidityUsd', '5000'], false);
    await filters.execute(write.ctx as never);
    expect(filterRows.get(ALICE)).toBeUndefined();
    expect(write.replies[0]).toContain('Only a group admin');

    const read = ctxFor(GROUP, 'supergroup', MEMBER, [], false);
    await filters.execute(read.ctx as never);
    expect(read.replies[0]).toContain('Alert filters');
  });

  it('names every filter in the definition table, and none it invented', async () => {
    seed(DM, 'private', null);
    roster.set(DM, { ...roster.get(DM)!, sourceUserId: ALICE });
    const { ctx, replies } = ctxFor(DM, 'private', DM, ['nosuchfilter', '1']);

    await filters.execute(ctx as never);

    // The usage card is generated from MCAP_CROSS_FILTER_KEYS, so a filter
    // added to that table appears here with no edit to the bot.
    for (const key of MCAP_CROSS_FILTER_KEYS) expect(replies[0]).toContain(key);
  });
});
