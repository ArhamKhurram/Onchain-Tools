import { describe, it, expect, vi } from 'vitest';
import { processDiscordMessage, type MessageProcessorContext } from '../src/utils/messageProcessor';
import type { GatewayManager } from '../src/discord/gatewayManager';
import type { DiscordMessage, AppConfig } from '../src/discord/types.js';

// Minimal gateway stub satisfying the methods the transform calls.
const gateway = {
  getChannelName: (id: string) => (id === 'chan-1' ? 'alpha' : id === '999' ? 'linked-chan' : 'unknown'),
  getGuildName: (_id: string) => 'My Guild',
  getRoleName: (id: string) => (id === '42' ? 'Admins' : null),
  getMemberRoleColor: (_roles: string[] | undefined) => '#ff0000',
} as unknown as GatewayManager;

const EVM = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';

const rawMsg = (over: Partial<DiscordMessage> = {}): DiscordMessage =>
  ({
    id: 'm1',
    channel_id: 'chan-1',
    guild_id: 'g1',
    author: { id: 'u1', username: 'satoshi', global_name: 'Satoshi', avatar: null },
    content: 'hello',
    timestamp: '2026-01-01T00:00:00.000Z',
    ...over,
  } as unknown as DiscordMessage);

const ctx = (config: Partial<AppConfig>, over: Partial<MessageProcessorContext> = {}): MessageProcessorContext => ({
  config: { contractDetection: true, keywordAlertsEnabled: true, globalKeywordPatterns: [], ...config } as AppConfig,
  isHighlighted: false,
  cacheUserName: () => {},
  ...over,
});

describe('processDiscordMessage (shared via backend shim)', () => {
  it('detects a contract address when contractDetection is on', () => {
    const r = processDiscordMessage(gateway, rawMsg({ content: `buy ${EVM}` }), undefined, undefined, undefined, ctx({}));
    expect(r.hasContractAddress).toBe(true);
    expect(r.contractAddresses).toContain(EVM);
  });

  it('skips contract detection when the flag is off', () => {
    const r = processDiscordMessage(gateway, rawMsg({ content: `buy ${EVM}` }), undefined, undefined, undefined, ctx({ contractDetection: false }));
    expect(r.hasContractAddress).toBe(false);
  });

  it('matches global + room keyword patterns, else undefined', () => {
    const withKw = processDiscordMessage(
      gateway, rawMsg({ content: 'stealth launch incoming' }), undefined, undefined,
      [{ pattern: 'launch', matchMode: 'includes' }], ctx({ globalKeywordPatterns: [{ pattern: 'stealth', matchMode: 'includes' }] }),
    );
    expect(withKw.matchedKeywords).toEqual(['stealth', 'launch']);

    const noKw = processDiscordMessage(gateway, rawMsg({ content: 'nothing here' }), undefined, undefined, undefined, ctx({ keywordAlertsEnabled: false, globalKeywordPatterns: [{ pattern: 'launch', matchMode: 'includes' }] }));
    expect(noKw.matchedKeywords).toBeUndefined();
  });

  it('resolves channel + role mentions via the gateway', () => {
    const r = processDiscordMessage(gateway, rawMsg({ content: 'see <#999> ask <@&42>' }), undefined, undefined, undefined, ctx({}));
    expect(r.mentions['ch:999']).toBe('linked-chan');
    expect(r.mentions['role:42']).toBe('Admins');
  });

  it('falls back to the gateway for channel/guild names, and passes isHighlighted through', () => {
    const r = processDiscordMessage(gateway, rawMsg(), undefined, undefined, undefined, ctx({}, { isHighlighted: true }));
    expect(r.channelName).toBe('alpha');
    expect(r.guildName).toBe('My Guild');
    expect(r.isHighlighted).toBe(true);
    expect(r.author.roleColor).toBe('#ff0000');
  });

  it('caches the author display name', () => {
    const cacheUserName = vi.fn();
    processDiscordMessage(gateway, rawMsg(), undefined, undefined, undefined, ctx({}, { cacheUserName }));
    expect(cacheUserName).toHaveBeenCalledWith('u1', 'Satoshi');
  });
});
