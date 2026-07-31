import { describe, it, expect } from 'vitest';
import { compactUsd, shortAddress, usd, makeContainer, makeText, noticeCard, BRAND } from '../src/bot/layout';
import { commands, commandMap } from '../src/bot/commands/index';

describe('bot formatting helpers', () => {
  it('usd formats whole dollars with grouping', () => {
    expect(usd(1234567)).toBe('$1,234,567');
    expect(usd(0)).toBe('$0');
    expect(usd(999.7)).toBe('$1,000');
  });

  it('compactUsd abbreviates by magnitude', () => {
    expect(compactUsd(81_000_000_000)).toBe('$81.00B');
    expect(compactUsd(1_250_000)).toBe('$1.25M');
    expect(compactUsd(980_500)).toBe('$980.5K');
    expect(compactUsd(750)).toBe('$750');
  });

  it('shortAddress truncates only long addresses', () => {
    expect(shortAddress('So11111111111111111111111111111111111111112')).toBe('So11..1112');
    expect(shortAddress('short')).toBe('short');
  });
});

describe('components v2 builders', () => {
  it('makeText/makeContainer emit the expected component types', () => {
    expect(makeText('hi')).toEqual({ type: 10, content: 'hi' });
    const container = makeContainer(BRAND.red, [makeText('x')]);
    expect(container.type).toBe(17);
    expect(container.accent_color).toBe(BRAND.red);
  });

  it('noticeCard wraps a message in a single container', () => {
    const card = noticeCard('nope');
    expect(card).toHaveLength(1);
    expect((card[0] as any).components[0].content).toBe('nope');
  });
});

describe('command registry', () => {
  // The FOMO commands were retired once the console reached parity. This list
  // is what deployCommands.ts PUTs to Discord, so a stray re-add shows up here.
  it('registers the shipped commands', () => {
    expect(commands.map((c) => c.data.name).sort()).toEqual(['ping', 'token']);
  });

  it('no longer registers the retired FOMO commands', () => {
    for (const name of ['holders', 'leaderboard', 'tracked', 'wallet']) {
      expect(commandMap.has(name)).toBe(false);
    }
  });

  it('maps every command by name and exposes an execute fn', () => {
    for (const cmd of commands) {
      expect(commandMap.get(cmd.data.name)).toBe(cmd);
      expect(typeof cmd.execute).toBe('function');
    }
  });

  it('makes every command usable in guilds and DMs', () => {
    for (const cmd of commands) {
      const json = cmd.data.toJSON() as any;
      // 0 = Guild, 1 = BotDM, 2 = PrivateChannel
      expect(json.contexts).toEqual(expect.arrayContaining([0, 1]));
      // 0 = GuildInstall, 1 = UserInstall
      expect(json.integration_types).toEqual(expect.arrayContaining([0, 1]));
    }
  });
});
