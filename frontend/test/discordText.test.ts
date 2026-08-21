import { describe, it, expect } from 'vitest';
import { stripDiscordCustomEmoji } from '../src/utils/discordText';

describe('stripDiscordCustomEmoji', () => {
  it('strips a leading static custom emoji and tidies the space', () => {
    expect(stripDiscordCustomEmoji('<:sol:941653282420576296> Solana @ Pump')).toBe(
      'Solana @ Pump',
    );
  });

  it('strips animated custom emoji too', () => {
    expect(stripDiscordCustomEmoji('<a:hyperevm:1344003708085735565> HyperEVM @ Hyperswap')).toBe(
      'HyperEVM @ Hyperswap',
    );
  });

  it('keeps unicode emoji intact', () => {
    expect(stripDiscordCustomEmoji('<:sol:123> Solana @ Pump 🔥 #1')).toBe('Solana @ Pump 🔥 #1');
  });

  it('strips multiple custom emojis and collapses the gap', () => {
    expect(stripDiscordCustomEmoji('<:a:1> mid <:b:2> end')).toBe('mid end');
  });

  it('returns empty for an emoji-only string (so the UI can fall back)', () => {
    expect(stripDiscordCustomEmoji('<:sol:941653282420576296>')).toBe('');
  });

  it('leaves plain text untouched', () => {
    expect(stripDiscordCustomEmoji('Solana @ Pump')).toBe('Solana @ Pump');
  });
});
