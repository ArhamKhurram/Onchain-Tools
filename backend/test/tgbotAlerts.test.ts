import { describe, it, expect } from 'vitest';
import {
  buildContractAlertView,
  isContractDetection,
  type AlertLike,
} from '../src/tgbot/alerts';
import { renderContractAlert, renderStatus, renderTokenSnapshot } from '../src/tgbot/render';
import { alertMatchesSource, resolveAlertSource } from '../src/tgbot/source';
import type { TgChatRecord } from '../src/tgbot/chatStore';
import { DEFAULT_CHAT_SETTINGS } from '../src/tgbot/alertPolicy';

const msg = (over: Record<string, unknown> = {}) =>
  ({
    id: 'm1',
    channelName: 'alpha-no-yap',
    guildName: 'Trenches',
    source: 'discord',
    author: { id: 'u1', username: 'satoshi', displayName: 'Satoshi' },
    content: 'sending it',
    hasContractAddress: false,
    contractAddresses: [],
    ...over,
  }) as never;

const alert = (type: string, over: Record<string, unknown> = {}): AlertLike => ({
  type,
  reason: `${type} fired`,
  message: msg(over),
});

describe('isContractDetection', () => {
  it('matches a plain contract scan', () => {
    expect(isContractDetection(alert('contract_address'))).toBe(true);
  });

  it('ALSO matches a highlighted user who posted a contract', () => {
    // frontendAlerts.ts emits highlighted_user and returns, so a contract from
    // a highlighted author never produces a contract_address alert. Matching
    // only that type would drop the highest-signal case in the product.
    expect(isContractDetection(alert('highlighted_user', { hasContractAddress: true }))).toBe(true);
  });

  it('does not match a highlighted user with no contract', () => {
    expect(isContractDetection(alert('highlighted_user'))).toBe(false);
  });

  it('does not match the other alert classes', () => {
    expect(isContractDetection(alert('keyword_match'))).toBe(false);
    expect(isContractDetection(alert('missed_runner'))).toBe(false);
    expect(isContractDetection(alert('signal_convergence'))).toBe(false);
  });
});

describe('buildContractAlertView', () => {
  it('flattens the fields the card needs', () => {
    const view = buildContractAlertView(
      alert('contract_address', { contractAddresses: ['So11111111111111111111111111111111111111112'] }),
    );
    expect(view).toEqual({
      reason: 'contract_address fired',
      author: 'Satoshi',
      guildName: 'Trenches',
      channelName: 'alpha-no-yap',
      source: 'discord',
      content: 'sending it',
      addresses: ['So11111111111111111111111111111111111111112'],
    });
  });

  it('survives a message missing every optional field', () => {
    const view = buildContractAlertView({ type: 'contract_address', reason: 'x', message: {} as never });
    expect(view.author).toBeNull();
    expect(view.addresses).toEqual([]);
    expect(view.content).toBe('');
  });
});

describe('renderContractAlert', () => {
  const base = {
    reason: 'Contract scan: 7xKX…pump · alpha',
    author: 'Satoshi',
    guildName: 'Trenches',
    channelName: 'alpha-no-yap',
    source: 'discord',
    content: 'sending it',
    addresses: ['So11111111111111111111111111111111111111112'],
  };

  it('renders the address as tap-to-copy code with a chart link', () => {
    const out = renderContractAlert(base);
    expect(out).toContain('<code>So11111111111111111111111111111111111111112</code>');
    expect(out).toContain('<a href="https://axiom.trade/t/So11111111111111111111111111111111111111112');
  });

  it('escapes hostile author, channel and body text', () => {
    const out = renderContractAlert({
      ...base,
      author: '<b>pwn</b>',
      channelName: 'a&b',
      content: '</blockquote><script>x</script>',
    });
    expect(out).toContain('&lt;b&gt;pwn&lt;/b&gt;');
    expect(out).toContain('a&amp;b');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;/blockquote&gt;');
  });

  it('caps at three addresses and says how many were held back', () => {
    const many = Array.from({ length: 5 }, (_, i) => `So1111111111111111111111111111111111111111${i}`);
    const out = renderContractAlert({ ...base, addresses: many });
    expect(out).toContain('+2 more in the same message');
    expect(out.match(/<code>/g)).toHaveLength(3);
  });

  it('omits the quote block entirely for an empty message body', () => {
    expect(renderContractAlert({ ...base, content: '   ' })).not.toContain('<blockquote>');
  });

  it('stays inside Telegram\'s message limit for an absurd payload', () => {
    const out = renderContractAlert({
      ...base,
      content: 'x'.repeat(20_000),
      author: 'y'.repeat(500),
      reason: 'z'.repeat(2_000),
    });
    expect(out.length).toBeLessThanOrEqual(4096);
  });
});

describe('renderTokenSnapshot', () => {
  it('renders a miss without pretending it found something', () => {
    const out = renderTokenSnapshot({
      found: false,
      address: 'So11111111111111111111111111111111111111112',
      chain: 'sol',
      symbol: null,
      name: null,
      marketCap: null,
      marketCapDisplay: null,
      priceUsd: null,
      liquidityUsd: null,
      source: null,
      stale: false,
    });
    expect(out).toContain('No enrichment data');
  });

  it('escapes a hostile token name and symbol', () => {
    const out = renderTokenSnapshot({
      found: true,
      address: '0xdead',
      chain: 'eth',
      symbol: '<img>',
      name: 'a & b',
      marketCap: 1_250_000,
      marketCapDisplay: null,
      priceUsd: 0.000123,
      liquidityUsd: 98_000,
      source: 'gmgn',
      stale: false,
    });
    expect(out).not.toContain('<img>');
    expect(out).toContain('&lt;IMG&gt;');
    expect(out).toContain('a &amp; b');
    expect(out).toContain('$1.25M');
  });
});

describe('renderStatus', () => {
  // Subscribed to something, so the "no source bound" warning is reachable —
  // a chat subscribed to nothing is told that instead, which is its own test.
  const record: TgChatRecord = {
    chatId: -100,
    chatType: 'supergroup',
    title: 'Trenches',
    addedByTgUserId: 1,
    enabled: true,
    sourceUserId: null,
    settings: {
      ...DEFAULT_CHAT_SETTINGS,
      alerts: { ...DEFAULT_CHAT_SETTINGS.alerts, missedRunner: 'digest' },
    },
    plan: 'free',
    entitlements: {},
    createdAt: '2026-09-03T00:00:00.000Z',
  };
  const now = Date.parse('2026-09-04T12:00:00.000Z');

  it('tells an unregistered chat what to run', () => {
    expect(renderStatus(null, { alertsRouted: false, allowlisted: false, now })).toContain('/start');
  });

  it('says out loud when a subscribed chat has no alert source bound', () => {
    // The one silent failure mode: enabled, alerts "on", nothing will arrive.
    const out = renderStatus(record, { alertsRouted: false, allowlisted: true, now });
    expect(out).toContain('No alert source is bound');
    expect(out).toContain('approved chat');
  });

  it('omits the warning once alerts are routed', () => {
    expect(renderStatus(record, { alertsRouted: true, allowlisted: false, now })).not.toContain(
      'No alert source is bound',
    );
  });

  it('tells a chat subscribed to nothing that it is, rather than looking healthy', () => {
    const out = renderStatus(
      { ...record, settings: DEFAULT_CHAT_SETTINGS },
      { alertsRouted: true, allowlisted: false, now },
    );
    expect(out).toContain('subscribed to nothing');
    expect(out).toContain('/alerts');
  });

  it('leads with the mute and the command that lifts it', () => {
    const out = renderStatus(
      {
        ...record,
        settings: { ...record.settings, mutedUntil: now + 3_600_000, mutedReason: '40 alerts in under a minute' },
      },
      { alertsRouted: true, allowlisted: false, now },
    );
    expect(out).toContain('Muted');
    expect(out).toContain('40 alerts in under a minute');
    expect(out).toContain('/alerts unmute');
  });
});

describe('alert source resolution', () => {
  const record = (sourceUserId: string | null): TgChatRecord => ({
    chatId: -100,
    chatType: 'supergroup',
    title: null,
    addedByTgUserId: null,
    enabled: true,
    sourceUserId,
    settings: DEFAULT_CHAT_SETTINGS,
    plan: 'free',
    entitlements: {},
    createdAt: '2026-09-03T00:00:00.000Z',
  });

  it('prefers the chat row over the instance default', () => {
    expect(resolveAlertSource(record('user-a'), 'user-b')).toBe('user-a');
  });

  it('falls back to the instance default', () => {
    expect(resolveAlertSource(record(null), 'user-b')).toBe('user-b');
  });

  it('resolves to null when neither is set', () => {
    expect(resolveAlertSource(record(null), null)).toBeNull();
  });

  it('fails CLOSED: an unrouted chat matches no alert at all', () => {
    // The privacy-critical case — without this a group would receive every
    // hosted user's feed.
    expect(alertMatchesSource('user-a', null)).toBe(false);
    expect(alertMatchesSource(undefined, null)).toBe(false);
  });

  it('matches only the bound user in hosted mode', () => {
    expect(alertMatchesSource('user-a', 'user-a')).toBe(true);
    expect(alertMatchesSource('user-b', 'user-a')).toBe(false);
  });

  it('treats a userId-less alert as local mode', () => {
    // broadcastAlert omits userId in local mode; that is the 'local' user.
    expect(alertMatchesSource(undefined, 'local')).toBe(true);
    expect(alertMatchesSource(undefined, 'user-a')).toBe(false);
  });
});
