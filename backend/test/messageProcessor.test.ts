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

// Deliberately EIP-55 checksummed, the way a scanner bot prints it. Detection
// canonicalises EVM addresses to lowercase so a checksummed embed and the
// caller's own lowercase post describe the same token.
const EVM = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';
const EVM_CANON = EVM.toLowerCase();

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
    expect(r.contractAddresses).toContain(EVM_CANON);
  });

  it('skips contract detection when the flag is off', () => {
    const r = processDiscordMessage(gateway, rawMsg({ content: `buy ${EVM}` }), undefined, undefined, undefined, ctx({ contractDetection: false }));
    expect(r.hasContractAddress).toBe(false);
  });

  // Bots post the CA inside an embed and leave content empty. Scanning content
  // alone meant only Rick's calls were detected (it has a dedicated parser), so
  // every other scanner's contracts were unclickable.
  it('detects a contract in an embed description when content is empty', () => {
    const r = processDiscordMessage(
      gateway,
      rawMsg({ content: '', embeds: [{ description: `New pair detected\nCA: ${EVM}` }] }),
      undefined, undefined, undefined, ctx({}),
    );
    expect(r.hasContractAddress).toBe(true);
    expect(r.contractAddresses).toContain(EVM_CANON);
  });

  it('detects a contract in embed title, fields, footer and author', () => {
    const inField = processDiscordMessage(
      gateway,
      rawMsg({ content: '', embeds: [{ title: 'PEPE/WETH', fields: [{ name: 'Contract', value: EVM }] }] }),
      undefined, undefined, undefined, ctx({}),
    );
    expect(inField.contractAddresses).toContain(EVM_CANON);

    const inFooter = processDiscordMessage(
      gateway,
      rawMsg({ content: '', embeds: [{ footer: { text: EVM } }] }),
      undefined, undefined, undefined, ctx({}),
    );
    expect(inFooter.contractAddresses).toContain(EVM_CANON);

    const inAuthor = processDiscordMessage(
      gateway,
      rawMsg({ content: '', embeds: [{ author: { name: `scanner ${EVM}` } }] }),
      undefined, undefined, undefined, ctx({}),
    );
    expect(inAuthor.contractAddresses).toContain(EVM_CANON);
  });

  it('still honours the detection flag for embed contracts', () => {
    const r = processDiscordMessage(
      gateway,
      rawMsg({ content: '', embeds: [{ description: EVM }] }),
      undefined, undefined, undefined, ctx({ contractDetection: false }),
    );
    expect(r.hasContractAddress).toBe(false);
  });

  it('does not invent a contract for embeds without one', () => {
    const r = processDiscordMessage(
      gateway,
      rawMsg({ content: '', embeds: [{ title: 'Daily recap', description: 'no addresses here' }] }),
      undefined, undefined, undefined, ctx({}),
    );
    expect(r.hasContractAddress).toBe(false);
    expect(r.contractAddresses).toEqual([]);
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

// A Discord forward puts the forwarded body in `message_snapshots` and leaves
// `content` to the forwarder's own comment (usually empty). Reading `content`
// alone rendered the message blank in the feed AND hid whatever contract the
// person was forwarding, which is normally the entire point of forwarding it.
describe('processDiscordMessage — forwards', () => {
  const forwarded = (snapshot: Record<string, unknown>, over: Partial<DiscordMessage> = {}): DiscordMessage =>
    rawMsg({
      content: '',
      message_reference: { type: 1, message_id: 'src-1', channel_id: '999', guild_id: 'g2' },
      message_snapshots: [{ message: snapshot }],
      ...over,
    } as Partial<DiscordMessage>);

  it('surfaces the forwarded body instead of leaving the message blank', () => {
    const r = processDiscordMessage(
      gateway, forwarded({ content: 'gm, this one is running', timestamp: '2026-01-01T00:00:00.000Z' }),
      undefined, undefined, undefined, ctx({}),
    );
    // The message's own content stays the forwarder's comment — the forwarded
    // text is a separate field so the UI can label it as forwarded.
    expect(r.content).toBe('');
    expect(r.forwardedMessage?.content).toBe('gm, this one is running');
    expect(r.forwardedMessage?.timestamp).toBe('2026-01-01T00:00:00.000Z');
  });

  it('leaves forwardedMessage null on an ordinary message', () => {
    const r = processDiscordMessage(gateway, rawMsg(), undefined, undefined, undefined, ctx({}));
    expect(r.forwardedMessage).toBeNull();
  });

  it('detects a contract that only appears in the forwarded body', () => {
    const r = processDiscordMessage(
      gateway, forwarded({ content: `CA: ${EVM}` }), undefined, undefined, undefined, ctx({}),
    );
    expect(r.hasContractAddress).toBe(true);
    expect(r.contractAddresses).toContain(EVM_CANON);
  });

  it('detects a contract inside a forwarded embed', () => {
    const r = processDiscordMessage(
      gateway, forwarded({ content: '', embeds: [{ description: `New pair
CA: ${EVM}` }] }),
      undefined, undefined, undefined, ctx({}),
    );
    expect(r.hasContractAddress).toBe(true);
    expect(r.contractAddresses).toContain(EVM_CANON);
    expect(r.forwardedMessage?.embeds).toHaveLength(1);
  });

  it('still honours the detection flag for forwarded contracts', () => {
    const r = processDiscordMessage(
      gateway, forwarded({ content: `CA: ${EVM}` }), undefined, undefined, undefined, ctx({ contractDetection: false }),
    );
    expect(r.hasContractAddress).toBe(false);
  });

  it('matches keywords against the forwarded body', () => {
    const r = processDiscordMessage(
      gateway, forwarded({ content: 'stealth launch incoming' }), undefined, undefined, undefined,
      ctx({ globalKeywordPatterns: [{ pattern: 'stealth', matchMode: 'includes' }] }),
    );
    expect(r.matchedKeywords).toEqual(['stealth']);
  });

  it('keeps the forwarder’s own comment scannable alongside the forwarded body', () => {
    const r = processDiscordMessage(
      gateway, forwarded({ content: 'and the chart' }, { content: `first look ${EVM}` }),
      undefined, undefined, undefined, ctx({}),
    );
    expect(r.content).toBe(`first look ${EVM}`);
    expect(r.contractAddresses).toContain(EVM_CANON);
    expect(r.forwardedMessage?.content).toBe('and the chart');
  });

  it('resolves mentions and channel/role tokens from inside the forwarded body', () => {
    const r = processDiscordMessage(
      gateway,
      forwarded({
        content: 'ping <@u9> in <#999> cc <@&42>',
        mentions: [{ id: 'u9', username: 'vitalik', global_name: 'Vitalik', avatar: null }],
      }),
      undefined, undefined, undefined, ctx({}),
    );
    expect(r.mentions['u9']).toBe('Vitalik');
    expect(r.mentions['ch:999']).toBe('linked-chan');
    expect(r.mentions['role:42']).toBe('Admins');
  });

  it('labels the origin when the source channel is known, and stays quiet when it is not', () => {
    const known = processDiscordMessage(
      gateway, forwarded({ content: 'x' }), undefined, undefined, undefined, ctx({}),
    );
    expect(known.forwardedMessage?.origin).toBe('My Guild / #linked-chan');

    // Forwards routinely come from servers this client isn't in. Printing the
    // gateway's "unknown" placeholder there would be worse than saying nothing.
    const unknown = processDiscordMessage(
      gateway,
      forwarded({ content: 'x' }, {
        message_reference: { type: 1, message_id: 'src-1', channel_id: 'not-cached' },
      } as Partial<DiscordMessage>),
      undefined, undefined, undefined, ctx({}),
    );
    expect(unknown.forwardedMessage?.origin).toBeNull();
  });

  it('renders a forward that carries only an attachment', () => {
    const r = processDiscordMessage(
      gateway,
      forwarded({ content: '', attachments: [{ id: 'a1', filename: 'chart.png', url: 'u', proxy_url: 'p', size: 1 }] }),
      undefined, undefined, undefined, ctx({}),
    );
    expect(r.forwardedMessage?.content).toBe('');
    expect(r.forwardedMessage?.attachments).toHaveLength(1);
  });
});
