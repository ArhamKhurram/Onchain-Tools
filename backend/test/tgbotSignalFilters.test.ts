// Per-user market-cap filters, applied where the bot DELIVERS.
//
// The claim this suite exists to disprove is "the bot's roster is chats, not
// OCT user ids, so there is no owner whose filters apply". Every chat row
// carries `source_user_id` and `resolveAlertSource` already turns it into a
// user (or into a documented fallback, or into nothing). These tests pin all
// three branches, and pin the two properties that make the layer safe: an
// abstain is never delivered, and a chat that resolves to nobody keeps exactly
// the behaviour it had before filters existed.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { TgChatRecord } from '../src/tgbot/chatStore';
import {
  applyAlertSetting,
  DEFAULT_CHAT_SETTINGS,
  type TgChatSettings,
} from '../src/tgbot/alertPolicy';
import {
  chatsPassingSignalFilters,
  resolveAlertSource,
  readDefaultAlertSource,
  type SignalFilterGate,
} from '../src/tgbot/source';

const roster = vi.hoisted(() => new Map<number, TgChatRecord>());

vi.mock('../src/tgbot/chatStore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tgbot/chatStore')>();
  return {
    ...actual,
    getChatStore: () => ({
      listEnabled: async (): Promise<TgChatRecord[]> =>
        [...roster.values()].filter((r) => r.enabled),
      get: async (chatId: number): Promise<TgChatRecord | null> => roster.get(chatId) ?? null,
      updateSettings: async (): Promise<boolean> => true,
    }),
  };
});

const { TgAlertRouter } = await import('../src/tgbot/alerts');

const CROSSING = {
  address: 'So11111111111111111111111111111111111111112',
  network: 'solana',
  symbol: 'TEST',
  mcapUsd: 800_000,
  targetUsd: 750_000,
  liquidityUsd: 60_000,
  liquidityRatio: 0.075,
};

function subscribed(): TgChatSettings {
  return applyAlertSetting(DEFAULT_CHAT_SETTINGS, 'mcapCross', 'instant');
}

function seed(chatId: number, sourceUserId: string | null): void {
  roster.set(chatId, {
    chatId,
    chatType: 'supergroup',
    title: 'Trenches',
    addedByTgUserId: 1,
    enabled: true,
    sourceUserId,
    settings: subscribed(),
    plan: 'free',
    entitlements: {},
    createdAt: new Date().toISOString(),
  });
}

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

/** A gate that answers from a table, and counts how often it was asked. */
function fakeGate(baselinePass: boolean, passes: Record<string, boolean>) {
  const asked: string[] = [];
  const gate: SignalFilterGate = {
    baselinePass,
    passesFor: async (userId) => {
      asked.push(userId);
      return passes[userId] ?? false;
    },
  };
  return { gate, asked };
}

beforeEach(() => {
  roster.clear();
  delete process.env.TG_BOT_ALERT_SOURCE_USER_ID;
  delete process.env.OCT_TG_BOT_ALERT_SOURCE_USER_ID;
  delete process.env.OCT_MODE;
  delete process.env.TRENCHCORD_MODE;
});

describe('chat → OCT user resolution', () => {
  it('prefers the row s explicit source_user_id over the instance default', () => {
    expect(resolveAlertSource({ sourceUserId: 'user-a' }, 'operator')).toBe('user-a');
  });

  it('falls back to the instance default when the row names nobody', () => {
    expect(resolveAlertSource({ sourceUserId: null }, 'operator')).toBe('operator');
  });

  it('resolves to nothing when neither the row nor the env names anyone (hosted)', () => {
    process.env.OCT_MODE = 'hosted';
    expect(resolveAlertSource({ sourceUserId: null }, readDefaultAlertSource())).toBeNull();
  });

  it("resolves to 'local' in local mode, where there is one implicit user", () => {
    expect(readDefaultAlertSource()).toBe('local');
    expect(resolveAlertSource({ sourceUserId: null }, readDefaultAlertSource())).toBe('local');
  });
});

describe('chatsPassingSignalFilters', () => {
  it("applies the owner's filters to a linked chat", async () => {
    const { gate } = fakeGate(true, { alice: false, bob: true });
    const kept = await chatsPassingSignalFilters(
      [{ sourceUserId: 'alice' }, { sourceUserId: 'bob' }],
      null,
      gate,
    );
    expect(kept).toEqual([{ sourceUserId: 'bob' }]);
  });

  it('falls back to the operator baseline when NOTHING resolves — the no-regression rule', async () => {
    const pass = await chatsPassingSignalFilters(
      [{ sourceUserId: null }],
      null,
      fakeGate(true, {}).gate,
    );
    expect(pass).toHaveLength(1);

    const drop = await chatsPassingSignalFilters(
      [{ sourceUserId: null }],
      null,
      fakeGate(false, {}).gate,
    );
    expect(drop).toHaveLength(0);
  });

  it('asks once per USER, not once per chat — the egress rule', async () => {
    const { gate, asked } = fakeGate(true, { operator: true });
    const kept = await chatsPassingSignalFilters(
      [{ sourceUserId: null }, { sourceUserId: null }, { sourceUserId: 'operator' }],
      'operator',
      gate,
    );
    expect(kept).toHaveLength(3);
    expect(asked).toEqual(['operator']);
  });

  it('does NOT let the instance default filter an unlinked chat by default', async () => {
    // TG_BOT_ALERT_SOURCE_USER_ID names whose STREAM a chat follows; that
    // account's console thresholds are a personal reading preference and must
    // not silently mute every group on the instance. An unlinked chat keeps the
    // baseline even when the default account would have rejected the signal.
    delete process.env.TG_BOT_DEFAULT_SOURCE_FILTERS;
    const { gate, asked } = fakeGate(true, { operator: false });
    const kept = await chatsPassingSignalFilters([{ sourceUserId: null }], 'operator', gate);
    expect(kept).toHaveLength(1);
    expect(asked).toEqual([]); // and it costs no lookup at all
  });

  it('still personalises a chat that was EXPLICITLY linked', async () => {
    // Linking is a deliberate act, so inheriting that owner's thresholds is a
    // fair consequence — this is the half of the feature that must keep working.
    delete process.env.TG_BOT_DEFAULT_SOURCE_FILTERS;
    const { gate } = fakeGate(true, { operator: false });
    expect(await chatsPassingSignalFilters([{ sourceUserId: 'operator' }], 'operator', gate)).toEqual(
      [],
    );
  });

  it('lets an operator opt the instance default back in', async () => {
    process.env.TG_BOT_DEFAULT_SOURCE_FILTERS = '1';
    try {
      const { gate, asked } = fakeGate(true, { operator: false });
      const kept = await chatsPassingSignalFilters([{ sourceUserId: null }], 'operator', gate);
      expect(kept).toEqual([]);
      expect(asked).toEqual(['operator']);
    } finally {
      delete process.env.TG_BOT_DEFAULT_SOURCE_FILTERS;
    }
  });

  it('never delivers an abstain: a gate that cannot say yes is a no', async () => {
    // `passesFor` is documented to be true ONLY for a `pass`; an abstain
    // arrives here as false and must drop, whatever the baseline said.
    const { gate } = fakeGate(true, { alice: false });
    expect(await chatsPassingSignalFilters([{ sourceUserId: 'alice' }], null, gate)).toEqual([]);
  });
});

describe('TgAlertRouter.handleSignal with a filter gate', () => {
  it('delivers to a chat whose owner passes and not to one whose owner does not', async () => {
    seed(-100, 'alice');
    seed(-200, 'bob');
    const sender = fakeSender();
    const router = new TgAlertRouter(() => sender);

    await router.handleSignal(CROSSING, fakeGate(true, { alice: true, bob: false }).gate);

    expect(sender.sent.map((s) => s.chatId)).toEqual([-100]);
  });

  it('keeps the baseline for an unlinked chat, both ways', async () => {
    seed(-100, null);
    process.env.OCT_MODE = 'hosted'; // no env default → resolves to nothing

    const passing = fakeSender();
    await new TgAlertRouter(() => passing).handleSignal(CROSSING, fakeGate(true, {}).gate);
    expect(passing.sent).toHaveLength(1);

    const rejecting = fakeSender();
    await new TgAlertRouter(() => rejecting).handleSignal(CROSSING, fakeGate(false, {}).gate);
    expect(rejecting.sent).toHaveLength(0);
  });

  it('delivers everything when no gate is supplied — the pre-filter behaviour', async () => {
    seed(-100, 'alice');
    const sender = fakeSender();
    await new TgAlertRouter(() => sender).handleSignal(CROSSING);
    expect(sender.sent).toHaveLength(1);
  });

  it('never consults a filter for a chat that did not subscribe', async () => {
    roster.set(-300, {
      chatId: -300,
      chatType: 'supergroup',
      title: 'Silent',
      addedByTgUserId: 1,
      enabled: true,
      sourceUserId: 'alice',
      settings: DEFAULT_CHAT_SETTINGS, // subscribed to nothing
      plan: 'free',
      entitlements: {},
      createdAt: new Date().toISOString(),
    });
    const sender = fakeSender();
    const { gate, asked } = fakeGate(true, { alice: true });

    await new TgAlertRouter(() => sender).handleSignal(CROSSING, gate);

    expect(sender.sent).toHaveLength(0);
    expect(asked).toEqual([]);
  });
});
