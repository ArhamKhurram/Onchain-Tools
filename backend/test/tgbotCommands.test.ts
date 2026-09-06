// The pure half of the Telegram bot's command surface: the bot's own identity,
// the command catalog Telegram's `/` menu is built from, the write-permission
// rule the panel and the typed commands now share, and the two new parsers.
//
// Everything asserted here is a function of its arguments. The I/O around them
// (getMe, setMyCommands, getChatMember, the roster) is exercised in
// tgbotDelivery.test.ts and tgbotPanel.test.ts.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MUTE_MS,
  MAX_MUTE_MS,
  MIN_MUTE_MS,
  parseMuteCommand,
} from '../src/tgbot/alertPolicy.js';
import {
  COMMAND_GROUPS,
  COMMAND_SPECS,
  MAX_MENU_DESCRIPTION,
  TELEGRAM_COMMAND_NAME,
  telegramCommandMenu,
  type CommandSpec,
} from '../src/tgbot/commandCatalog.js';
import { botMention, groupMentionNote, normalizeBotUsername } from '../src/tgbot/identity.js';
import { decideChatWrite } from '../src/tgbot/permissions.js';
import { bareAddressCommand, classifyUpdate } from '../src/tgbot/router.js';
import { formatAgo, renderHelp, renderQueued, renderRecentCrossings } from '../src/tgbot/render.js';
import { renderPanelHelp } from '../src/tgbot/panel.js';

// ---------------------------------------------------------------------------

describe('the bot knows its own name', () => {
  it('normalizes whatever getMe handed us', () => {
    expect(normalizeBotUsername('OnchainToolsAppBot')).toBe('OnchainToolsAppBot');
    expect(normalizeBotUsername('  @OnchainToolsAppBot ')).toBe('OnchainToolsAppBot');
  });

  it('treats an absent or malformed username as no username', () => {
    // `me.result.username ?? ''` is exactly what index.ts passes through.
    for (const raw of ['', '   ', undefined, null, '@', 'bad name', 'four']) {
      expect(normalizeBotUsername(raw)).toBe('');
      expect(botMention(raw)).toBeNull();
      expect(groupMentionNote(raw)).toBeNull();
    }
  });

  it('names the real bot in the group note', () => {
    expect(groupMentionNote('OctTestBot')).toBe(
      'In a group, add @OctTestBot to any command if other bots are present.',
    );
  });

  it('never renders the placeholder, in either help card', () => {
    for (const card of [renderHelp('OctTestBot'), renderPanelHelp('OctTestBot')]) {
      expect(card).not.toContain('thebotname');
      expect(card).toContain('@OctTestBot');
    }
  });

  it('drops the line rather than rendering a bare @ when getMe gave no username', () => {
    for (const card of [renderHelp(''), renderPanelHelp('')]) {
      expect(card).not.toContain('thebotname');
      expect(card).not.toContain('add @');
      expect(card).not.toMatch(/@\s/);
      // The card is still a card: the command list survives losing one line.
      expect(card).toContain('/token');
    }
  });
});

// ---------------------------------------------------------------------------

describe('the command catalog', () => {
  it('groups every command exactly once', () => {
    const names = COMMAND_SPECS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(COMMAND_GROUPS.flatMap((g) => g.commands.map((c) => c.name)));
  });

  it("satisfies Telegram's rules for every entry it will publish", () => {
    for (const entry of telegramCommandMenu()) {
      expect(entry.command).toMatch(TELEGRAM_COMMAND_NAME);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeLessThanOrEqual(MAX_MENU_DESCRIPTION);
    }
    expect(telegramCommandMenu()).toHaveLength(COMMAND_SPECS.length);
  });

  it('drops an illegal entry instead of failing the whole menu', () => {
    // One 400 from setMyCommands rejects the ENTIRE payload, so a bad entry
    // must cost only itself.
    const spec = (name: string, description: string): CommandSpec => ({
      name,
      description,
      usage: `/${name}`,
      blurb: 'x',
      adminOnly: false,
    });
    const problems: string[] = [];
    const menu = telegramCommandMenu(
      [
        spec('good', 'fine'),
        spec('Shouty', 'uppercase is not menu-legal'),
        spec('has-dash', 'dashes are not menu-legal'),
        spec('good', 'a duplicate'),
        spec('blank', '   '),
        spec('long', 'x'.repeat(400)),
      ],
      (p) => problems.push(p),
    );

    expect(menu.map((m) => m.command)).toEqual(['good', 'long']);
    expect(problems).toHaveLength(4);
    expect(menu[1]?.description).toHaveLength(MAX_MENU_DESCRIPTION);
  });
});

// ---------------------------------------------------------------------------

describe('who may change a chat', () => {
  const group = { chatId: -100123, chatType: 'supergroup' as const };

  it('lets a group admin write and refuses everyone else', () => {
    expect(decideChatWrite({ ...group, userId: 7, isAdmin: true })).toEqual({ allow: true });
    const refused = decideChatWrite({ ...group, userId: 7, isAdmin: false });
    expect(refused.allow).toBe(false);
    if (!refused.allow) expect(refused.reason).toBe('not_admin');
  });

  it('refuses a group write when the admin question could not be answered', () => {
    // admin.ts resolves an unanswerable getChatMember to false; this is the
    // other half of that contract.
    expect(decideChatWrite({ ...group, userId: 7, isAdmin: false }).allow).toBe(false);
  });

  it('lets a private chat owner write, and nobody else', () => {
    const priv = { chatId: 42, chatType: 'private' as const, isAdmin: false };
    expect(decideChatWrite({ ...priv, userId: 42 })).toEqual({ allow: true });
    const forged = decideChatWrite({ ...priv, userId: 43 });
    expect(forged.allow).toBe(false);
    if (!forged.allow) expect(forged.reason).toBe('not_owner');
  });

  it('treats a channel as a group with no admin', () => {
    expect(
      decideChatWrite({ chatId: -1, chatType: 'channel', userId: 1, isAdmin: false }).allow,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('/mute parsing', () => {
  it('defaults to an hour', () => {
    expect(parseMuteCommand([])).toEqual({ kind: 'mute', durationMs: DEFAULT_MUTE_MS });
  });

  it('reads the units it documents', () => {
    expect(parseMuteCommand(['30m'])).toEqual({ kind: 'mute', durationMs: 30 * 60_000 });
    expect(parseMuteCommand(['2h'])).toEqual({ kind: 'mute', durationMs: 2 * 3_600_000 });
    expect(parseMuteCommand(['1d'])).toEqual({ kind: 'mute', durationMs: 86_400_000 });
    expect(parseMuteCommand([' 2 HOURS '])).toEqual({ kind: 'mute', durationMs: 2 * 3_600_000 });
  });

  it('reads a bare number as minutes', () => {
    expect(parseMuteCommand(['45'])).toEqual({ kind: 'mute', durationMs: 45 * 60_000 });
  });

  it('clamps rather than refusing an out-of-range duration', () => {
    expect(parseMuteCommand(['1m'])).toEqual({ kind: 'mute', durationMs: MIN_MUTE_MS });
    expect(parseMuteCommand(['400d'])).toEqual({ kind: 'mute', durationMs: MAX_MUTE_MS });
  });

  it('names the problem rather than guessing', () => {
    expect(parseMuteCommand(['soon']).kind).toBe('usage');
    expect(parseMuteCommand(['0']).kind).toBe('usage');
    expect(parseMuteCommand(['-5m']).kind).toBe('usage');
    expect(parseMuteCommand(['2', 'hours']).kind).toBe('usage');
    expect(parseMuteCommand(['5x']).kind).toBe('usage');
    expect(parseMuteCommand(['1s']).kind).toBe('usage');
  });
});

// ---------------------------------------------------------------------------

describe('a bare address in a DM', () => {
  it('becomes a /token lookup', () => {
    const sol = 'So11111111111111111111111111111111111111112';
    expect(bareAddressCommand(sol)).toEqual({
      name: 'token',
      args: [sol],
      rest: sol,
      addressedTo: null,
    });
    const evm = '0x' + 'a'.repeat(40);
    expect(bareAddressCommand(` ${evm} `)?.args).toEqual([evm]);
  });

  it('is not a sentence that happens to contain one', () => {
    expect(bareAddressCommand('buy So11111111111111111111111111111111111111112 now')).toBeNull();
    expect(bareAddressCommand('gm')).toBeNull();
    expect(bareAddressCommand('0xdeadbeef')).toBeNull();
    // Base58 excludes 0, O, I and l — a lookalike is not an address.
    expect(bareAddressCommand('0'.repeat(40))).toBeNull();
  });

  const message = (type: 'private' | 'supergroup', text: string) => ({
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat: { id: type === 'private' ? 42 : -100123, type },
      from: { id: 42, is_bot: false, first_name: 'A' },
      text,
    },
  });

  const ctx = { botUsername: 'OctTestBot', allowlist: null };
  const address = 'So11111111111111111111111111111111111111112';

  it('is routed as /token in a private chat', () => {
    const decision = classifyUpdate(message('private', address), ctx);
    expect(decision.kind).toBe('command');
    if (decision.kind === 'command') expect(decision.command.name).toBe('token');
  });

  it('is IGNORED in a group — the bot answers only what is addressed to it', () => {
    expect(classifyUpdate(message('supergroup', address), ctx).kind).toBe('ignore');
  });
});

// ---------------------------------------------------------------------------

describe('the new cards', () => {
  it('reads ages without arithmetic', () => {
    const now = 1_000_000_000_000;
    expect(formatAgo(now - 10_000, now)).toBe('just now');
    expect(formatAgo(now - 12 * 60_000, now)).toBe('12m ago');
    expect(formatAgo(now - 4 * 3_600_000, now)).toBe('4h ago');
    expect(formatAgo(now - 5 * 86_400_000, now)).toBe('5d ago');
    // A clock skew must not render "-3m ago".
    expect(formatAgo(now + 60_000, now)).toBe('just now');
  });

  it('says the crossing feed is off rather than showing an empty market', () => {
    const off = renderRecentCrossings([], { targetUsd: 750_000, now: 0, enabled: false });
    expect(off).toContain('not running');
    const empty = renderRecentCrossings([], { targetUsd: 750_000, now: 0, enabled: true });
    expect(empty).toContain('750');
  });

  it('renders a crossing as a tap-to-copy address with a chart link', () => {
    const now = 1_000_000_000_000;
    const card = renderRecentCrossings(
      [
        {
          address: 'So11111111111111111111111111111111111111112',
          network: 'solana',
          mcapUsd: 1_200_000,
          firedAt: now - 3 * 3_600_000,
        },
      ],
      { targetUsd: 750_000, now, enabled: true },
    );
    expect(card).toContain('<code>So11111111111111111111111111111111111111112</code>');
    expect(card).toContain('3h ago');
    expect(card).toContain('Chart');
  });

  it('distinguishes "nothing is coming" from "nothing will ever come"', () => {
    const unsubscribed = renderQueued(
      { lines: [], dropped: 0 },
      { digestMinutes: 10, subscribed: 0 },
    );
    expect(unsubscribed).toContain('subscribed to nothing');

    const idle = renderQueued({ lines: [], dropped: 0 }, { digestMinutes: 10, subscribed: 2 });
    expect(idle).toContain('Nothing buffered');

    const busy = renderQueued(
      { lines: [{ line: 'a', count: 3 }], dropped: 2 },
      { digestMinutes: 10, subscribed: 1 },
    );
    expect(busy).toContain('×3');
    expect(busy).toContain('+2 more');
  });
});
