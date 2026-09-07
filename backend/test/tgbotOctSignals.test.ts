// "OCT Alerts": forwarded algorithm-scan signals, end to end.
//
// The hard requirements this suite pins:
//   • recognise a message ONLY from a configured source channel (by id, per
//     chain), never a non-configured one, and never by title;
//   • the card is white-labelled "OCT Alerts · SOL/EVM", carries the CA as
//     tap-to-copy code, and gets the owner referral quick-buy buttons from the
//     SHARED machinery (REFERRALS), never a hardcoded code;
//   • the scan text is untrusted and is escaped, and any upstream signature is
//     stripped (the vendor string lives only in operator env, never in code);
//   • delivery is default-on for fresh AND existing chats, respects the hourly
//     ceiling and an existing mute, but CANNOT trip the circuit breaker and mute
//     a chat's other subscriptions;
//   • the vendor word appears NOWHERE in the new code or rendered output.

import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { REFERRALS } from '@oct/shared';
import {
  buildOctSignalView,
  resolveOctSignalChain,
  stripUpstreamSignature,
  hasSignalSources,
} from '../src/tgbot/octSignals';
import { renderOctSignalCard } from '../src/tgbot/render';
import { ALERT_CATALOG, DEFAULT_CHAT_SETTINGS, readSettings } from '../src/tgbot/alertPolicy';
import type { TgChatRecord } from '../src/tgbot/chatStore';
import type { TgChatSettings } from '../src/tgbot/alertPolicy';
import type { TgInlineKeyboardMarkup } from '../src/tgbot/types';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A base58 Solana mint and a canonical 0x EVM address.
const SOL_ADDR = 'So11111111111111111111111111111111111111112';
const EVM_ADDR = '0x1234567890123456789012345678901234567890';

// The two source channels, by id, per chain — never by title.
const SOL_CHANNEL = '-1001111111111';
const EVM_CHANNEL = '-1002222222222';

function configureSources(): void {
  vi.stubEnv('OCT_SIGNAL_SOURCE_CHANNEL_IDS_SOL', SOL_CHANNEL);
  vi.stubEnv('OCT_SIGNAL_SOURCE_CHANNEL_IDS_EVM', EVM_CHANNEL);
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------

describe('source recognition — by id, per chain, never by title', () => {
  it('resolves a configured SOL / EVM channel and nothing else', () => {
    configureSources();
    expect(resolveOctSignalChain(SOL_CHANNEL)).toBe('sol');
    expect(resolveOctSignalChain(EVM_CHANNEL)).toBe('evm');
    expect(resolveOctSignalChain('-1009999999999')).toBeNull();
  });

  it('matches the FULL id, not a shared prefix', () => {
    configureSources();
    // Shares the '-100111111111' prefix with SOL_CHANNEL but is a different
    // channel — the two source channels sharing a prefix is exactly the case
    // title-matching and prefix-matching both get wrong.
    expect(resolveOctSignalChain('-1001111111119')).toBeNull();
  });

  it('tolerates the bare id and a :topic suffix, still exact', () => {
    configureSources();
    expect(resolveOctSignalChain('1111111111')).toBe('sol');
    expect(resolveOctSignalChain(`${SOL_CHANNEL}:42`)).toBe('sol');
  });

  it('is inert when nothing is configured', () => {
    expect(hasSignalSources()).toBe(false);
    expect(resolveOctSignalChain(SOL_CHANNEL)).toBeNull();
    expect(buildOctSignalView({ chatId: SOL_CHANNEL, text: `buy ${SOL_ADDR}` })).toBeNull();
  });
});

describe('buildOctSignalView', () => {
  it('shapes a SOL-source message: chain sol, network solana, CA extracted', () => {
    configureSources();
    const view = buildOctSignalView({ chatId: SOL_CHANNEL, text: `fresh scan ${SOL_ADDR} sending` });
    expect(view).not.toBeNull();
    expect(view!.chain).toBe('sol');
    expect(view!.network).toBe('solana');
    expect(view!.addresses).toContain(SOL_ADDR);
  });

  it('shapes an EVM-source message: chain evm, evm network from the hint', () => {
    configureSources();
    const view = buildOctSignalView({ chatId: EVM_CHANNEL, text: `scan ${EVM_ADDR}`, evmChainHint: 'bsc' });
    expect(view!.chain).toBe('evm');
    expect(view!.network).toBe('bsc');
    expect(view!.addresses).toContain(EVM_ADDR);
  });

  it('a non-configured channel yields nothing', () => {
    configureSources();
    expect(buildOctSignalView({ chatId: '-1008888888888', text: `buy ${SOL_ADDR}` })).toBeNull();
  });

  it('forwards a message with NO contract address rather than dropping it', () => {
    configureSources();
    const view = buildOctSignalView({ chatId: SOL_CHANNEL, text: 'market is heating up, watch closely' });
    expect(view).not.toBeNull();
    expect(view!.addresses).toEqual([]);
    expect(view!.text).toContain('market is heating up');
  });

  it('drops a truly empty message', () => {
    configureSources();
    expect(buildOctSignalView({ chatId: SOL_CHANNEL, text: '   ' })).toBeNull();
  });
});

describe('signature stripping — the vendor string lives only in operator env', () => {
  it('removes an operator-configured strip term but keeps the scan body', () => {
    const text = `Signal: strong buy\nEntry good\nPOWERED BY ACMESCAN\n@acmescan_alerts`;
    const stripped = stripUpstreamSignature(text, ['ACMESCAN']);
    expect(stripped).toContain('Signal: strong buy');
    expect(stripped).toContain('Entry good');
    expect(stripped).not.toContain('ACMESCAN');
    expect(stripped).not.toContain('@acmescan_alerts');
  });

  it('strips a bare handle / link footer with no configured term', () => {
    const stripped = stripUpstreamSignature('great entry here\nhttps://t.me/somepromo', []);
    expect(stripped).toBe('great entry here');
  });

  it('applies the env strip term through buildOctSignalView, keeping the CA', () => {
    configureSources();
    vi.stubEnv('OCT_SIGNAL_STRIP_TERMS', 'ACMESCAN');
    const view = buildOctSignalView({
      chatId: SOL_CHANNEL,
      text: `scan hit ${SOL_ADDR}\n— powered by ACMESCAN`,
    });
    expect(view!.text).not.toContain('ACMESCAN');
    // The CA is extracted independently, so stripping text never loses it.
    expect(view!.addresses).toContain(SOL_ADDR);
  });
});

describe('the card — white-labelled, CA-bearing, referral-linked, escaped', () => {
  it('is attributed "OCT Alerts · SOL" and keeps the CA as tap-to-copy code', () => {
    const card = renderOctSignalCard({ chain: 'sol', network: 'solana', addresses: [SOL_ADDR], text: 'buy' });
    expect(card).toContain('OCT Alerts · SOL');
    expect(card).toContain(`<code>${SOL_ADDR}</code>`);
  });

  it('labels an EVM signal "OCT Alerts · EVM"', () => {
    const card = renderOctSignalCard({ chain: 'evm', network: 'bsc', addresses: [EVM_ADDR], text: '' });
    expect(card).toContain('OCT Alerts · EVM');
  });

  it('embeds the owner referral (from REFERRALS) in the chart link, not a literal', () => {
    const sol = renderOctSignalCard({ chain: 'sol', network: 'solana', addresses: [SOL_ADDR], text: 'x' });
    // The card's inline chart link uses OCT's shipped defaults: Solana → Axiom
    // (axiom.trade/t/<addr>/@<ref>), so the owner's Axiom referral rides it.
    expect(sol).toContain(`@${REFERRALS.axiom}`);
    // EVM default is GMGN (gmgn.ai/<chain>/token/<ref>_<addr>).
    const evm = renderOctSignalCard({ chain: 'evm', network: 'bsc', addresses: [EVM_ADDR], text: 'x' });
    expect(evm).toContain(`${REFERRALS.gmgn}_`);
  });

  it('escapes untrusted scan text — an unescaped < is a 400 and a dropped signal', () => {
    const card = renderOctSignalCard({
      chain: 'sol',
      network: 'solana',
      addresses: [SOL_ADDR],
      text: '<script>alert(1)</script>',
    });
    expect(card).toContain('&lt;script&gt;');
    expect(card).not.toContain('<script>');
  });

  it('the type label is "OCT Alerts" and the keyword is "signals" (not "alerts")', () => {
    expect(ALERT_CATALOG.octSignals.label).toBe('OCT Alerts');
    expect(ALERT_CATALOG.octSignals.keyword).toBe('signals');
    expect(ALERT_CATALOG.octSignals.instantAllowed).toBe(true);
  });
});

// --- delivery, with the roster mocked (mirrors tgbotDelivery.test.ts) --------

const roster = vi.hoisted(() => new Map<number, TgChatRecord>());

vi.mock('../src/tgbot/chatStore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tgbot/chatStore')>();
  return {
    ...actual,
    getChatStore: () => ({
      listEnabled: async (): Promise<TgChatRecord[]> => [...roster.values()].filter((r) => r.enabled),
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

const CHAT = -1001234567890;

interface Sent {
  chatId: number;
  text: string;
  replyMarkup?: TgInlineKeyboardMarkup;
}

function fakeSender() {
  const sent: Sent[] = [];
  return {
    sent,
    send: async (chatId: number, text: string, opts?: { replyMarkup?: TgInlineKeyboardMarkup }): Promise<boolean> => {
      sent.push({ chatId, text, replyMarkup: opts?.replyMarkup });
      return true;
    },
  };
}

function seed(settings: TgChatSettings): void {
  roster.set(CHAT, {
    chatId: CHAT,
    chatType: 'supergroup',
    title: 'A group',
    addedByTgUserId: 1,
    enabled: true,
    sourceUserId: null,
    settings,
    plan: 'free',
    entitlements: {},
    createdAt: '2026-09-07T00:00:00.000Z',
  });
}

const solView = (addr = SOL_ADDR) => ({ chain: 'sol' as const, network: 'solana', addresses: [addr], text: 'scan' });
const runner = (symbol: string) => ({
  type: 'missed_runner',
  reason: `Missed runner: ${symbol}`,
  message: { content: '', hasContractAddress: false, contractAddresses: [] } as never,
});

beforeEach(() => {
  roster.clear();
  vi.unstubAllEnvs();
});

describe('delivery', () => {
  it('a fresh chat receives OCT Alerts by default, with CA and referral buttons', async () => {
    // DEFAULT_CHAT_SETTINGS is exactly what a chat that only ran /start has.
    seed({ ...DEFAULT_CHAT_SETTINGS, alerts: { ...DEFAULT_CHAT_SETTINGS.alerts } });
    const sender = fakeSender();
    const router = new TgAlertRouter(() => sender as never);

    await router.handleOctSignal(solView(), 1000);

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.text).toContain('OCT Alerts · SOL');
    expect(sender.sent[0]!.text).toContain(`<code>${SOL_ADDR}</code>`);
    // Referral quick-buy buttons, code from the shared REFERRALS constant.
    const buttons = sender.sent[0]!.replyMarkup!.inline_keyboard.flat();
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.find((b) => b.text === 'GMGN')!.url).toContain(`${REFERRALS.gmgn}_`);
  });

  it('an existing chat keeps its other settings and gains OCT Alerts on (no regression)', () => {
    // A row written before octSignals existed: keyword on, contract off, no
    // octSignals key. readSettings must preserve those and default octSignals on.
    const stored = readSettings({ alerts: { keyword: 'digest', contract: 'off' } });
    expect(stored.alerts.keyword).toBe('digest');
    expect(stored.alerts.contract).toBe('off');
    expect(stored.alerts.octSignals).toBe('instant');
  });

  it('a chat that turned OCT Alerts off receives nothing', async () => {
    seed({ ...DEFAULT_CHAT_SETTINGS, alerts: { ...DEFAULT_CHAT_SETTINGS.alerts, octSignals: 'off' } });
    const sender = fakeSender();
    const router = new TgAlertRouter(() => sender as never);

    await router.handleOctSignal(solView(), 1000);
    expect(sender.sent).toHaveLength(0);
  });

  it('respects the hourly ceiling — a burst cannot flood', async () => {
    vi.stubEnv('TG_BOT_MAX_MESSAGES_PER_HOUR', '2');
    seed({ ...DEFAULT_CHAT_SETTINGS, alerts: { ...DEFAULT_CHAT_SETTINGS.alerts } });
    const sender = fakeSender();
    const router = new TgAlertRouter(() => sender as never);

    for (let i = 0; i < 6; i += 1) {
      await router.handleOctSignal(
        { chain: 'sol', network: 'solana', addresses: [`So1111111111111111111111111111111111111${String(i).padStart(3, '1')}`], text: 'x' },
        1000 + i,
      );
    }
    expect(sender.sent).toHaveLength(2);
  });

  it('respects an existing mute — a muted chat gets no OCT Alerts', async () => {
    seed({
      ...DEFAULT_CHAT_SETTINGS,
      alerts: { ...DEFAULT_CHAT_SETTINGS.alerts },
      mutedUntil: 9_000_000,
      mutedReason: 'flooded',
    });
    const sender = fakeSender();
    const router = new TgAlertRouter(() => sender as never);

    await router.handleOctSignal(solView(), 1000);
    expect(sender.sent).toHaveLength(0);
  });

  it('does NOT trip the circuit breaker — a burst never mutes the chat or its other classes', async () => {
    vi.stubEnv('TG_BOT_BREAKER_MAX_EVENTS', '3');
    vi.stubEnv('TG_BOT_MAX_MESSAGES_PER_HOUR', '1000');
    // OCT Alerts on (default) AND missed runners on instant.
    seed({
      ...DEFAULT_CHAT_SETTINGS,
      alerts: { ...DEFAULT_CHAT_SETTINGS.alerts, missedRunner: 'instant' },
    });
    const sender = fakeSender();
    const router = new TgAlertRouter(() => sender as never);

    // A burst well past the breaker threshold.
    for (let i = 0; i < 20; i += 1) {
      await router.handleOctSignal(
        { chain: 'sol', network: 'solana', addresses: [`So111111111111111111111111111111111111${String(i).padStart(4, '1')}`], text: 'x' },
        1000 + i,
      );
    }

    // The chat is NOT muted — the breaker never counted the signals.
    expect(roster.get(CHAT)!.settings.mutedUntil).toBe(0);

    // And a missed-runner instant still lands: OCT Alerts did not kill it.
    const before = sender.sent.length;
    await router.handle(runner('TOK'), undefined, 1100);
    expect(sender.sent.length).toBe(before + 1);
    expect(sender.sent.at(-1)!.text).toContain('TOK');
  });
});

// ---------------------------------------------------------------------------

describe('the vendor word appears NOWHERE in the new code or output', () => {
  const VENDOR = /cipher/i;

  it('is absent from the new source modules', () => {
    for (const rel of ['octSignals.ts', 'render.ts', 'alertPolicy.ts', 'alerts.ts']) {
      const src = readFileSync(join(__dirname, '../src/tgbot', rel), 'utf-8');
      expect(VENDOR.test(src), `${rel} must not name the vendor`).toBe(false);
    }
  });

  it('is absent from a fully rendered card', () => {
    const card = renderOctSignalCard({ chain: 'evm', network: 'bsc', addresses: [EVM_ADDR], text: 'strong buy signal' });
    expect(VENDOR.test(card)).toBe(false);
    expect(card).toContain('OCT Alerts');
  });
});
