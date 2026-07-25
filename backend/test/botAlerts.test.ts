import { describe, it, expect } from 'vitest';
import { buildAlertDm, shouldDmAlert, triggerForAlert, type AlertLike } from '../src/bot/alerts';
import type { DiscordBotDmConfig } from '@oct/shared';

const msg = (over: Record<string, unknown> = {}) =>
  ({
    id: 'm1',
    channelName: 'alpha-no-yap',
    guildName: 'Trenches',
    author: { id: 'u1', username: 'satoshi', displayName: 'Satoshi' },
    content: 'sending it',
    hasContractAddress: false,
    contractAddresses: [],
    ...over,
  }) as any;

const alert = (type: string, over: Record<string, unknown> = {}): AlertLike => ({
  type,
  reason: `${type} fired`,
  message: msg(over),
});

const prefs = (
  enabled: boolean,
  triggers: Partial<DiscordBotDmConfig['triggers']> = {},
): { discordBotDm: DiscordBotDmConfig } => ({
  discordBotDm: {
    enabled,
    triggers: {
      highlightedUser: false,
      highlightedUserContract: false,
      contract: false,
      keyword: false,
      missedRunner: false,
      ...triggers,
    },
  },
});

describe('triggerForAlert', () => {
  it('splits highlighted-user by whether it carries a contract', () => {
    expect(triggerForAlert(alert('highlighted_user'))).toBe('highlightedUser');
    expect(triggerForAlert(alert('highlighted_user', { hasContractAddress: true }))).toBe(
      'highlightedUserContract',
    );
  });

  it('maps the remaining backend alert types', () => {
    expect(triggerForAlert(alert('contract_address'))).toBe('contract');
    expect(triggerForAlert(alert('keyword_match'))).toBe('keyword');
    expect(triggerForAlert(alert('missed_runner'))).toBe('missedRunner');
  });

  it('has no trigger for client-side convergence alerts', () => {
    expect(triggerForAlert(alert('signal_convergence'))).toBeNull();
    expect(triggerForAlert(alert('something_new'))).toBeNull();
  });
});

describe('shouldDmAlert — opt-in gating', () => {
  it('never DMs when the master switch is off, even with the trigger on', () => {
    expect(shouldDmAlert(alert('missed_runner'), prefs(false, { missedRunner: true }))).toBe(false);
  });

  it('never DMs when prefs are absent (the default for every existing user)', () => {
    expect(shouldDmAlert(alert('missed_runner'), null)).toBe(false);
    expect(shouldDmAlert(alert('missed_runner'), undefined)).toBe(false);
    expect(shouldDmAlert(alert('missed_runner'), {} as any)).toBe(false);
  });

  it('DMs only the alert types whose trigger is enabled', () => {
    const p = prefs(true, { missedRunner: true });
    expect(shouldDmAlert(alert('missed_runner'), p)).toBe(true);
    expect(shouldDmAlert(alert('contract_address'), p)).toBe(false);
    expect(shouldDmAlert(alert('keyword_match'), p)).toBe(false);
  });

  it('respects the highlighted-user contract split', () => {
    const p = prefs(true, { highlightedUserContract: true });
    expect(shouldDmAlert(alert('highlighted_user', { hasContractAddress: true }), p)).toBe(true);
    expect(shouldDmAlert(alert('highlighted_user'), p)).toBe(false);
  });

  it('never DMs convergence even when everything is enabled', () => {
    const p = prefs(true, {
      highlightedUser: true,
      highlightedUserContract: true,
      contract: true,
      keyword: true,
      missedRunner: true,
    });
    expect(shouldDmAlert(alert('signal_convergence'), p)).toBe(false);
  });
});

describe('buildAlertDm', () => {
  it('renders a container with the reason, location and author', () => {
    const components = buildAlertDm(alert('missed_runner'));
    const text = JSON.stringify(components);
    expect(text).toContain('Missed runner');
    expect(text).toContain('missed_runner fired');
    expect(text).toContain('Trenches');
    expect(text).toContain('Satoshi');
  });

  it('lists contract addresses shortened', () => {
    const components = buildAlertDm(
      alert('contract_address', {
        hasContractAddress: true,
        contractAddresses: ['So11111111111111111111111111111111111111112'],
      }),
    );
    expect(JSON.stringify(components)).toContain('So11..1112');
  });

  it('truncates very long message bodies', () => {
    const components = buildAlertDm(alert('keyword_match', { content: 'x'.repeat(900) }));
    expect(JSON.stringify(components)).toContain('...');
  });

  it('survives a sparse message without throwing', () => {
    const bare = { type: 'missed_runner', reason: 'r', message: {} as any };
    expect(() => buildAlertDm(bare)).not.toThrow();
  });
});
