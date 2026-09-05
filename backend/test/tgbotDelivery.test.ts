// The fan-out, end to end: alert in, message (or silence) out.
//
// tgbotPolicy.test.ts pins the pieces; this pins the thing that actually
// matters — that a chat which has only run /start receives NOTHING, and that a
// subscribed chat cannot be flooded however loud the feed gets.
//
// The chat roster is mocked rather than reached: TgChatStore is a Supabase/JSON
// store, and this suite is about delivery policy, not persistence. Everything
// else — the router, the guard, the digest buffer, the renderers — is the real
// code, and the clock is injected so a "one hour later" test takes no time.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { TgChatRecord } from '../src/tgbot/chatStore';
import {
  applyAlertSetting,
  DEFAULT_CHAT_SETTINGS,
  type TgAlertType,
  type TgChatSettings,
} from '../src/tgbot/alertPolicy';

const roster = vi.hoisted(() => new Map<number, TgChatRecord>());

vi.mock('../src/tgbot/chatStore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tgbot/chatStore')>();
  return {
    ...actual,
    getChatStore: () => ({
      listEnabled: async (): Promise<TgChatRecord[]> =>
        [...roster.values()].filter((r) => r.enabled),
      get: async (chatId: number): Promise<TgChatRecord | null> => roster.get(chatId) ?? null,
      updateSettings: async (chatId: number, settings: TgChatSettings): Promise<boolean> => {
        const record = roster.get(chatId);
        if (!record) return false;
        roster.set(chatId, { ...record, settings });
        return true;
      },
    }),
  };
});

const { TgAlertRouter } = await import('../src/tgbot/alerts');
const { alerts: alertsCommand } = await import('../src/tgbot/commands/alerts');
const { renderStatus } = await import('../src/tgbot/render');

const CHAT = -1001234567890;

/** A sender that records instead of calling Telegram. */
function fakeSender() {
  const sent: { chatId: number; text: string }[] = [];
  return {
    sent,
    send: async (chatId: number, text: string): Promise<boolean> => {
      sent.push({ chatId, text });
      return true;
    },
  };
}

function seed(settings: TgChatSettings = DEFAULT_CHAT_SETTINGS): void {
  roster.set(CHAT, {
    chatId: CHAT,
    chatType: 'supergroup',
    title: 'Trenches',
    addedByTgUserId: 1,
    enabled: true,
    // Local mode resolves the instance default to 'local', which is what a
    // userId-less broadcastAlert matches.
    sourceUserId: null,
    settings,
    plan: 'free',
    entitlements: {},
    createdAt: '2026-09-03T00:00:00.000Z',
  });
}

/** One contract detection, as broadcastAlert would hand it over. */
function detection(address: string) {
  return {
    type: 'contract_address',
    reason: `Contract scan: ${address.slice(0, 6)} · alpha`,
    message: {
      channelName: 'alpha-no-yap',
      guildName: 'Trenches',
      source: 'discord',
      author: { id: 'u1', username: 'satoshi', displayName: 'Satoshi' },
      content: 'sending it',
      hasContractAddress: true,
      contractAddresses: [address],
    } as never,
  };
}

function runner(symbol: string) {
  return {
    type: 'missed_runner',
    reason: `Missed runner: ${symbol} (12x)`,
    message: { content: '', hasContractAddress: false, contractAddresses: [] } as never,
  };
}

const addr = (i: number) => `So111111111111111111111111111111111111111${String(i).padStart(2, '0')}`;

beforeEach(() => {
  roster.clear();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------

describe('fail closed', () => {
  // The guarantee the incident was about: a bot newly added to somebody's
  // group is silent until a human deliberately turns something on.
  it('a chat that has only run /start receives NO alert of any class', async () => {
    seed(DEFAULT_CHAT_SETTINGS);
    const sender = fakeSender();
    const router = new TgAlertRouter(() => sender as never);

    for (let i = 0; i < 20; i += 1) {
      await router.handle(detection(addr(i)), undefined, 1000 + i);
      await router.handle(runner(`TOK${i}`), undefined, 1000 + i);
      await router.handle(
        { type: 'keyword_match', reason: 'Keyword match: moon', message: {} as never },
        undefined,
        1000 + i,
      );
      await router.handle(
        { type: 'highlighted_user', reason: 'Highlighted user: Satoshi', message: {} as never },
        undefined,
        1000 + i,
      );
    }
    await router.flush(100_000);

    expect(sender.sent).toHaveLength(0);
  });

  it('delivers nothing to a chat subscribed to a DIFFERENT class', async () => {
    seed(applyAlertSetting(DEFAULT_CHAT_SETTINGS, 'missedRunner', 'digest'));
    const sender = fakeSender();
    const router = new TgAlertRouter(() => sender as never);

    await router.handle(detection(addr(1)), undefined, 1000);
    await router.flush(2000);

    expect(sender.sent).toHaveLength(0);
  });
});

describe('digest batching', () => {
  it('turns N events in one window into exactly ONE message', async () => {
    seed(applyAlertSetting(DEFAULT_CHAT_SETTINGS, 'contract', 'digest'));
    const sender = fakeSender();
    const router = new TgAlertRouter(() => sender as never);

    for (let i = 0; i < 8; i += 1) await router.handle(detection(addr(i)), undefined, 1000 + i);
    expect(sender.sent).toHaveLength(0); // nothing until the flush

    await router.flush(600_000);

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.chatId).toBe(CHAT);
    expect(sender.sent[0]?.text).toContain('8 alerts');
    expect(sender.sent[0]?.text).toContain(addr(3));
  });

  it('produces no message for an empty window', async () => {
    seed(applyAlertSetting(DEFAULT_CHAT_SETTINGS, 'contract', 'digest'));
    const sender = fakeSender();
    const router = new TgAlertRouter(() => sender as never);

    await router.flush(600_000);
    await router.flush(1_200_000);

    expect(sender.sent).toHaveLength(0);
  });

  it('coalesces the same mint seen repeatedly into one counted line', async () => {
    seed(applyAlertSetting(DEFAULT_CHAT_SETTINGS, 'contract', 'digest'));
    const sender = fakeSender();
    const router = new TgAlertRouter(() => sender as never);

    for (let i = 0; i < 5; i += 1) await router.handle(detection(addr(1)), undefined, 1000 + i);
    await router.flush(600_000);

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.text).toContain('×5');
    expect(sender.sent[0]?.text.match(new RegExp(addr(1), 'g'))).toHaveLength(1);
  });

  it('starts a clean window after a flush', async () => {
    seed(applyAlertSetting(DEFAULT_CHAT_SETTINGS, 'contract', 'digest'));
    const sender = fakeSender();
    const router = new TgAlertRouter(() => sender as never);

    await router.handle(detection(addr(1)), undefined, 1000);
    await router.flush(600_000);
    await router.flush(1_200_000);
    await router.handle(detection(addr(2)), undefined, 1_300_000);
    await router.flush(1_800_000);

    expect(sender.sent).toHaveLength(2);
    expect(sender.sent[1]?.text).toContain(addr(2));
    expect(sender.sent[1]?.text).not.toContain(addr(1));
  });
});

describe('the hourly ceiling', () => {
  it('drops digests past the ceiling and resets in the next hour', async () => {
    vi.stubEnv('TG_BOT_MAX_MESSAGES_PER_HOUR', '2');
    seed(applyAlertSetting(DEFAULT_CHAT_SETTINGS, 'missedRunner', 'instant'));
    const sender = fakeSender();
    const router = new TgAlertRouter(() => sender as never);

    // Five events inside one hour; the ceiling admits two.
    for (let i = 0; i < 5; i += 1) await router.handle(runner(`TOK${i}`), undefined, 1000 + i);
    expect(sender.sent).toHaveLength(2);

    // An hour and change later the window has slid and the budget is back.
    await router.handle(runner('LATER'), undefined, 1000 + 3_700_000);
    expect(sender.sent).toHaveLength(3);
    expect(sender.sent[2]?.text).toContain('LATER');
  });

  it('never queues the overflow — a dropped alert stays dropped', async () => {
    vi.stubEnv('TG_BOT_MAX_MESSAGES_PER_HOUR', '1');
    seed(applyAlertSetting(DEFAULT_CHAT_SETTINGS, 'contract', 'digest'));
    const sender = fakeSender();
    const router = new TgAlertRouter(() => sender as never);

    await router.handle(detection(addr(1)), undefined, 1000);
    await router.flush(600_000);
    expect(sender.sent).toHaveLength(1);

    // Second digest in the same hour: refused, and NOT carried forward.
    await router.handle(detection(addr(2)), undefined, 1_200_000);
    await router.flush(1_800_000);
    expect(sender.sent).toHaveLength(1);

    // Once the first send ages out of the hour (it landed at t=600_000, so it
    // frees a slot at t=4_200_000) the next digest goes — carrying only what
    // arrived after the drop.
    await router.handle(detection(addr(3)), undefined, 3_800_000);
    await router.flush(4_300_000);
    expect(sender.sent).toHaveLength(2);
    expect(sender.sent[1]?.text).toContain(addr(3));
    expect(sender.sent[1]?.text).not.toContain(addr(2));
  });
});

describe('the circuit breaker', () => {
  it('auto-mutes a flooded chat, persists it, and stops sending', async () => {
    vi.stubEnv('TG_BOT_BREAKER_MAX_EVENTS', '5');
    vi.stubEnv('TG_BOT_BREAKER_WINDOW_MS', '60000');
    seed(applyAlertSetting(DEFAULT_CHAT_SETTINGS, 'contract', 'digest'));
    const sender = fakeSender();
    const router = new TgAlertRouter(() => sender as never);

    for (let i = 0; i < 40; i += 1) await router.handle(detection(addr(i)), undefined, 1000 + i);

    const record = roster.get(CHAT);
    expect(record?.settings.mutedUntil).toBeGreaterThan(1000);
    expect(record?.settings.mutedReason).toContain('5');

    // Whatever was buffered belonged to the flood and is discarded with it.
    await router.flush(600_000);
    expect(sender.sent).toHaveLength(0);
  });

  it('/status reports the mute and how to lift it', async () => {
    vi.stubEnv('TG_BOT_BREAKER_MAX_EVENTS', '3');
    seed(applyAlertSetting(DEFAULT_CHAT_SETTINGS, 'contract', 'digest'));
    const router = new TgAlertRouter(() => fakeSender() as never);

    for (let i = 0; i < 5; i += 1) await router.handle(detection(addr(i)), undefined, 1000 + i);

    const record = roster.get(CHAT);
    expect(record).toBeDefined();
    const out = renderStatus(record ?? null, {
      alertsRouted: true,
      allowlisted: false,
      now: 2000,
    });
    expect(out).toContain('Muted');
    expect(out).toContain('/alerts unmute');
  });

  it('a muted chat receives nothing even while subscribed', async () => {
    seed({
      ...applyAlertSetting(DEFAULT_CHAT_SETTINGS, 'missedRunner', 'instant'),
      mutedUntil: 9_000_000,
      mutedReason: 'flooded',
    });
    const sender = fakeSender();
    const router = new TgAlertRouter(() => sender as never);

    await router.handle(runner('TOK'), undefined, 1000);
    await router.flush(2000);

    expect(sender.sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('/alerts round-trip', () => {
  const ctx = (args: string[], replies: string[]) => ({
    chatId: CHAT,
    chat: { id: CHAT, type: 'supergroup' as const, title: 'Trenches' },
    from: { id: 1, is_bot: false, first_name: 'A' },
    command: { name: 'alerts', args, rest: args.join(' '), addressedTo: null },
    reply: async (text: string): Promise<boolean> => {
      replies.push(text);
      return true;
    },
  });

  const settingsOf = (): TgChatSettings => {
    const record = roster.get(CHAT);
    if (!record) throw new Error('chat vanished');
    return record.settings;
  };

  it('refuses to configure a chat that has not registered', async () => {
    const replies: string[] = [];
    await alertsCommand.execute(ctx([], replies));
    expect(replies[0]).toContain('/start');
    expect(roster.has(CHAT)).toBe(false);
  });

  it('opts in as a digest and persists it', async () => {
    seed();
    const replies: string[] = [];
    await alertsCommand.execute(ctx(['on', 'runners'], replies));

    expect(settingsOf().alerts.missedRunner).toBe('digest');
    expect(replies[0]).toContain('Missed runners');
  });

  it('opts out again and persists that too', async () => {
    seed(applyAlertSetting(DEFAULT_CHAT_SETTINGS, 'missedRunner', 'digest'));
    const replies: string[] = [];
    await alertsCommand.execute(ctx(['off', 'runners'], replies));

    expect(settingsOf().alerts.missedRunner).toBe('off');
  });

  it('does NOT subscribe to contracts without the confirmation word', async () => {
    seed();
    const replies: string[] = [];
    await alertsCommand.execute(ctx(['on', 'contracts'], replies));

    // The whole point: the loudest class costs a second, deliberate command.
    expect(settingsOf().alerts.contract).toBe('off');
    expect(replies[0]).toContain('loudest');
    expect(replies[0]).toContain('confirm');
  });

  it('subscribes to contracts once confirmed — as a digest, never per-event', async () => {
    seed();
    const replies: string[] = [];
    await alertsCommand.execute(ctx(['on', 'contracts', 'confirm'], replies));

    expect(settingsOf().alerts.contract).toBe('digest');
  });

  it('never needs confirmation to turn something OFF', async () => {
    seed(applyAlertSetting(DEFAULT_CHAT_SETTINGS, 'contract', 'digest'));
    const replies: string[] = [];
    await alertsCommand.execute(ctx(['off', 'contracts'], replies));

    expect(settingsOf().alerts.contract).toBe('off');
  });

  it('shows the board without changing anything', async () => {
    const before = applyAlertSetting(DEFAULT_CHAT_SETTINGS, 'keyword', 'digest');
    seed(before);
    const replies: string[] = [];
    await alertsCommand.execute(ctx([], replies));

    expect(settingsOf()).toEqual(before);
    expect(replies[0]).toContain('Keyword matches');
    expect(replies[0]).toContain('Contract detections');
  });

  it('lifts a circuit-breaker mute, and says so when there is none', async () => {
    seed({ ...DEFAULT_CHAT_SETTINGS, mutedUntil: Date.now() + 60_000, mutedReason: 'flooded' });
    const replies: string[] = [];
    await alertsCommand.execute(ctx(['unmute'], replies));
    expect(settingsOf().mutedUntil).toBe(0);
    expect(replies[0]).toContain('Unmuted');

    await alertsCommand.execute(ctx(['unmute'], replies));
    expect(replies[1]).toContain('not muted');
  });

  it('answers a malformed command with usage rather than a change', async () => {
    seed();
    const replies: string[] = [];
    await alertsCommand.execute(ctx(['on', 'everything'], replies));

    expect(settingsOf()).toEqual(DEFAULT_CHAT_SETTINGS);
    expect(replies[0]).toContain('Usage');
  });

  it('delivers what it just subscribed to, and nothing it did not', async () => {
    // The round-trip that matters: the command writes, the fan-out reads.
    seed();
    const replies: string[] = [];
    await alertsCommand.execute(ctx(['on', 'runners'], replies));

    const sender = fakeSender();
    const router = new TgAlertRouter(() => sender as never);
    await router.handle(runner('TOK'), undefined, 1000);
    await router.handle(detection(addr(1)), undefined, 1001);
    await router.flush(600_000);

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.text).toContain('TOK');
  });
});

describe('classes the seam does not carry', () => {
  it('drops an alert type nobody has decided a volume for', async () => {
    const everythingOn = ([
      'missedRunner',
      'keyword',
      'highlighted',
      'contract',
    ] as TgAlertType[]).reduce(
      (acc, type) => applyAlertSetting(acc, type, 'digest'),
      DEFAULT_CHAT_SETTINGS,
    );
    seed(everythingOn);
    const sender = fakeSender();
    const router = new TgAlertRouter(() => sender as never);

    await router.handle(
      { type: 'signal_convergence', reason: 'convergence', message: {} as never },
      undefined,
      1000,
    );
    await router.flush(600_000);

    expect(sender.sent).toHaveLength(0);
  });
});
