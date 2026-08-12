import { describe, it, expect } from 'vitest';
import {
  parseCompactUsd,
  parseGlobalFirstCall,
  parseRelativeAgeMs,
  parseRickEmbeds,
} from '../src/utils/rickEmbedParser.js';

const MELON = '9AwZKiUicugQ7hNdoKJEmV1psybm7yQMMsBb4hTnpump';
const MSG_TS = '2026-08-12T12:00:00.000Z';

describe('parseRelativeAgeMs', () => {
  it('parses the units Rick prints', () => {
    expect(parseRelativeAgeMs('47s')).toBe(47_000);
    expect(parseRelativeAgeMs('10h')).toBe(36_000_000);
    expect(parseRelativeAgeMs('3d')).toBe(259_200_000);
    expect(parseRelativeAgeMs('2w')).toBe(1_209_600_000);
    expect(parseRelativeAgeMs('1mo')).toBe(2_592_000_000);
  });

  it('rejects junk', () => {
    expect(parseRelativeAgeMs('')).toBeUndefined();
    expect(parseRelativeAgeMs('10x')).toBeUndefined();
    expect(parseRelativeAgeMs('h10')).toBeUndefined();
    expect(parseRelativeAgeMs('soon')).toBeUndefined();
  });
});

describe('parseGlobalFirstCall', () => {
  it('parses the dot-separated footer: "espadabtw @ 49.3K · 86x · 10h"', () => {
    const r = parseGlobalFirstCall('espadabtw @ 49.3K · 86x · 10h', MSG_TS);
    expect(r?.firstCallerName).toBe('espadabtw');
    expect(r?.firstCallMcapUsd).toBe(49_300);
    expect(r?.firstCallAt).toBe('2026-08-12T02:00:00.000Z'); // message time - 10h
  });

  it('parses the emoji-separated footer Rick actually sends', () => {
    const r = parseGlobalFirstCall('jace444444 @ 341.3K 📈 2x - 47s 👀 41', MSG_TS);
    expect(r?.firstCallerName).toBe('jace444444');
    expect(r?.firstCallMcapUsd).toBe(341_300);
    expect(r?.firstCallAt).toBe('2026-08-12T11:59:13.000Z'); // message time - 47s
  });

  it('parses M suffixes: "whale.hunter @ 1.2M · 3x · 2d"', () => {
    const r = parseGlobalFirstCall('whale.hunter @ 1.2M · 3x · 2d', MSG_TS);
    expect(r?.firstCallerName).toBe('whale.hunter');
    expect(r?.firstCallMcapUsd).toBe(1_200_000);
    expect(r?.firstCallAt).toBe('2026-08-10T12:00:00.000Z');
  });

  it('finds the line inside a multi-line embed blob', () => {
    const blob = [
      'Melon Dog [816K/1.7K%] - MELON/SOL',
      'Solana @ Pump',
      'FDV: 816K -> 816K [now!]',
      'Liq: 34.2K',
      'espadabtw @ 49.3K · 86x · 10h',
    ].join('\n');
    const r = parseGlobalFirstCall(blob, MSG_TS);
    expect(r?.firstCallerName).toBe('espadabtw');
    expect(r?.firstCallMcapUsd).toBe(49_300);
  });

  it('tolerates a missing age: caller + mcap survive, timestamp stays undefined', () => {
    const r = parseGlobalFirstCall('espadabtw @ 49.3K · 86x', MSG_TS);
    expect(r?.firstCallerName).toBe('espadabtw');
    expect(r?.firstCallMcapUsd).toBe(49_300);
    expect(r?.firstCallAt).toBeUndefined();
  });

  it('anchors on now when no message timestamp is supplied', () => {
    const before = Date.now();
    const r = parseGlobalFirstCall('espadabtw @ 49.3K · 86x · 10h');
    const after = Date.now();
    const at = new Date(r?.firstCallAt ?? 0).getTime();
    expect(at).toBeGreaterThanOrEqual(before - 36_000_000);
    expect(at).toBeLessThanOrEqual(after - 36_000_000 + 1);
  });

  it('ignores a bare "name @ mcap" line (that is the per-caller entry footer)', () => {
    expect(parseGlobalFirstCall('jace444444 @ 341.3K', MSG_TS)).toBeNull();
  });

  it('returns null on absent or malformed lines, never throws', () => {
    expect(parseGlobalFirstCall('', MSG_TS)).toBeNull();
    expect(parseGlobalFirstCall('FDV: 816K\nLiq: 34.2K\nAge: 32m', MSG_TS)).toBeNull();
    expect(parseGlobalFirstCall('@ 49.3K · 86x · 10h', MSG_TS)).toBeNull(); // no caller name
    expect(parseGlobalFirstCall('espadabtw @ soon · 86x · 10h', MSG_TS)).toBeNull(); // no mcap
    expect(parseGlobalFirstCall('Buy @ 0.5 x leverage now', MSG_TS)).toBeNull();
  });

  it('survives an unparseable message timestamp', () => {
    const r = parseGlobalFirstCall('espadabtw @ 49.3K · 86x · 10h', 'not-a-date');
    expect(r?.firstCallerName).toBe('espadabtw');
    expect(r?.firstCallAt).toBeUndefined();
  });
});

describe('parseRickEmbeds — global-first fields flow into the enrichment', () => {
  const embeds = [{
    title: 'Melon Dog · MELON/SOL',
    description: 'Solana @ Pump\nFDV: 816K -> 816K [now!]\nLiq: 34.2K\nVol: 296K\nAge: 32m',
    footer: { text: 'espadabtw @ 49.3K · 86x · 10h' },
  }];

  it('carries firstCaller fields alongside the existing enrichment', () => {
    const r = parseRickEmbeds(embeds, 'Rick', {
      addressOverride: MELON,
      messageTimestamp: MSG_TS,
    });
    expect(r?.address).toBe(MELON);
    expect(r?.tokenSymbol).toBe('MELON');
    expect(r?.firstCallerName).toBe('espadabtw');
    expect(r?.firstCallMcapUsd).toBe(49_300);
    expect(r?.firstCallAt).toBe('2026-08-12T02:00:00.000Z');
    expect(r?.enrichmentSource).toBe('rick');
  });

  it('leaves the fields undefined when the footer is absent', () => {
    const bare = [{
      title: 'Melon Dog [816K/1.7K%] - MELON/SOL',
      description: 'FDV: 816K\nLiq: 34.2K',
    }];
    const r = parseRickEmbeds(bare, 'Rick', { addressOverride: MELON, messageTimestamp: MSG_TS });
    expect(r).not.toBeNull();
    expect(r?.firstCallerName).toBeUndefined();
    expect(r?.firstCallMcapUsd).toBeUndefined();
    expect(r?.firstCallAt).toBeUndefined();
  });
});

describe('parseCompactUsd', () => {
  it('handles the suffixes the footer uses', () => {
    expect(parseCompactUsd('49.3K')).toBe(49_300);
    expect(parseCompactUsd('1.2M')).toBe(1_200_000);
    expect(parseCompactUsd('2.5B')).toBe(2_500_000_000);
    expect(parseCompactUsd('$341.3K')).toBe(341_300);
  });
});
