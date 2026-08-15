// Unit tests for pump.fun callout DMs (backend/src/pumpfun/calloutDm.ts).
//
// The two things worth proving here are the ones a reviewer can't verify by
// reading: the OPT-IN GATING is genuinely fail-closed on every shape a stored
// config can take, and DELIVERY never throws, never lets one bad recipient
// abort the fan-out, and never sends past its cap.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Client } from 'discord.js';
import {
  buildCalloutDmComponents,
  callerLabel,
  coinLabel,
  deliverCalloutDms,
  isCalloutDmOptIn,
  shouldDmCallout,
  MAX_DMS_PER_DISPATCH,
  type CalloutDmDeps,
  type CalloutDmInput,
  type CalloutDmJob,
} from '../src/pumpfun/calloutDm.js';

const ON = { discordBotDm: { enabled: true, triggers: { pumpCallout: true } } };

const CALLOUT: CalloutDmInput = {
  callerAddress: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
  callerName: 'papipablo',
  callerAvatar: 'https://cdn.example/avatar.png',
  mint: 'So11111111111111111111111111111111111111112',
  symbol: 'TOAD',
  coinName: 'Toad Coin',
  thesis: 'clean chart, dev doxxed',
  marketCapUsd: 1_250_000,
  multiple: 2.5,
};

describe('isCalloutDmOptIn — fail-closed on every stored shape', () => {
  it('accepts only master switch AND pumpCallout trigger both true', () => {
    expect(isCalloutDmOptIn(ON)).toBe(true);
  });

  it('rejects when the master switch is off, however keen the trigger', () => {
    expect(isCalloutDmOptIn({ discordBotDm: { enabled: false, triggers: { pumpCallout: true } } })).toBe(false);
  });

  it('rejects when the trigger is off', () => {
    expect(isCalloutDmOptIn({ discordBotDm: { enabled: true, triggers: { pumpCallout: false } } })).toBe(false);
  });

  it('rejects a stored config that predates the trigger (the migration case)', () => {
    // This is THE case that keeps a deploy from silently DMing existing users:
    // an account with bot DMs already on, whose triggers object has no
    // pumpCallout key at all, must read as opted OUT.
    const legacy = { discordBotDm: { enabled: true, triggers: { contract: true, missedRunner: true } } };
    expect(isCalloutDmOptIn(legacy)).toBe(false);
  });

  it('rejects junk rather than throwing', () => {
    for (const bad of [null, undefined, 0, '', 'yes', [], {}, { discordBotDm: null }, { discordBotDm: 'on' }]) {
      expect(isCalloutDmOptIn(bad)).toBe(false);
    }
    expect(isCalloutDmOptIn({ discordBotDm: { enabled: true } })).toBe(false);
    expect(isCalloutDmOptIn({ discordBotDm: { enabled: true, triggers: 'all' } })).toBe(false);
  });

  it('treats a truthy-but-not-true value as off', () => {
    expect(isCalloutDmOptIn({ discordBotDm: { enabled: 1, triggers: { pumpCallout: 1 } } })).toBe(false);
  });
});

describe('shouldDmCallout — the per-caller mute is the third gate', () => {
  it('passes only when the follow row and both settings agree', () => {
    expect(shouldDmCallout(true, ON)).toBe(true);
  });

  it('a muted caller blocks the DM even with settings fully on', () => {
    expect(shouldDmCallout(false, ON)).toBe(false);
  });

  it('an unmuted caller still cannot override the settings gates', () => {
    expect(shouldDmCallout(true, { discordBotDm: { enabled: false, triggers: { pumpCallout: true } } })).toBe(false);
  });
});

describe('label helpers', () => {
  it('prefixes a handle with @ and falls back to a short address', () => {
    expect(callerLabel({ callerName: 'papipablo', callerAddress: 'abcdefghijkl' })).toBe('@papipablo');
    expect(callerLabel({ callerName: '@papipablo', callerAddress: 'abcdefghijkl' })).toBe('@papipablo');
    expect(callerLabel({ callerName: '  ', callerAddress: 'abcdefghijkl' })).toBe('abcd..ijkl');
    expect(callerLabel({ callerName: null, callerAddress: 'abcdefghijkl' })).toBe('abcd..ijkl');
  });

  it('prefixes a ticker with a single $ and falls back to the short mint', () => {
    expect(coinLabel({ symbol: 'TOAD', mint: 'abcdefghijkl' })).toBe('$TOAD');
    expect(coinLabel({ symbol: '$TOAD', mint: 'abcdefghijkl' })).toBe('$TOAD');
    expect(coinLabel({ symbol: null, mint: 'abcdefghijkl' })).toBe('abcd..ijkl');
  });
});

describe('buildCalloutDmComponents', () => {
  const flatten = (components: unknown[]): string =>
    JSON.stringify(components);

  it('carries handle, coin, MC at call, thesis and the mint', () => {
    const text = flatten(buildCalloutDmComponents(CALLOUT));
    expect(text).toContain('@papipablo');
    expect(text).toContain('$TOAD');
    expect(text).toContain('$1.25M'); // MC at the moment of the call
    expect(text).toContain('clean chart, dev doxxed');
    expect(text).toContain(CALLOUT.mint);
  });

  it('links to a chart and to pump.fun', () => {
    const text = flatten(buildCalloutDmComponents(CALLOUT));
    expect(text).toContain('axiom.trade');
    expect(text).toContain(`pump.fun/coin/${CALLOUT.mint}`);
  });

  it('floats the avatar in a section when there is one, and omits it otherwise', () => {
    const withAvatar = buildCalloutDmComponents(CALLOUT) as Array<{ components: Array<{ type: number }> }>;
    expect(withAvatar[0].components[0].type).toBe(9); // section

    const without = buildCalloutDmComponents({ ...CALLOUT, callerAvatar: null }) as Array<{
      components: Array<{ type: number }>;
    }>;
    expect(without[0].components[0].type).toBe(10); // plain text
  });

  it('says so out loud when there is no thesis rather than rendering a blank', () => {
    expect(flatten(buildCalloutDmComponents({ ...CALLOUT, thesis: null }))).toContain('No thesis given');
  });

  it('renders an em dash for an unknown market cap, never a zero', () => {
    const text = flatten(buildCalloutDmComponents({ ...CALLOUT, marketCapUsd: null }));
    expect(text).toContain('MC at call —');
    expect(text).not.toContain('MC at call $0');
  });

  it('shows the since-multiple only when it actually moved', () => {
    expect(flatten(buildCalloutDmComponents(CALLOUT))).toContain('2.50× since');
    expect(flatten(buildCalloutDmComponents({ ...CALLOUT, multiple: 1.0 }))).not.toContain('since');
    expect(flatten(buildCalloutDmComponents({ ...CALLOUT, multiple: null }))).not.toContain('since');
  });

  it('truncates a runaway thesis instead of blowing the component limit', () => {
    const text = flatten(buildCalloutDmComponents({ ...CALLOUT, thesis: 'x'.repeat(5000) }));
    expect(text).toContain('…');
    expect(text.length).toBeLessThan(2000);
  });

  it('names the caller in the footer so the DM explains why it arrived', () => {
    expect(flatten(buildCalloutDmComponents(CALLOUT))).toContain('you follow @papipablo');
  });
});

describe('deliverCalloutDms', () => {
  const fakeClient = {} as Client;

  function makeDeps(overrides: Partial<CalloutDmDeps> = {}): CalloutDmDeps & { sent: string[] } {
    const sent: string[] = [];
    return {
      sent,
      getClient: () => fakeClient,
      loadSettings: async () => ON,
      resolveDiscordId: async (userId) => `discord-${userId}`,
      send: async (_client, discordId) => {
        sent.push(discordId);
        return { outcome: 'delivered' as const };
      },
      sleep: async () => {},
      ...overrides,
    };
  }

  const job = (userId: string, notifyDiscord = true): CalloutDmJob => ({
    userId,
    notifyDiscord,
    callout: CALLOUT,
  });

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('delivers to every opted-in follower', async () => {
    const deps = makeDeps();
    const result = await deliverCalloutDms([job('a'), job('b')], deps);
    expect(result).toMatchObject({ eligible: 2, delivered: 2, blocked: 0, failed: 0, dropped: 0 });
    expect(deps.sent).toEqual(['discord-a', 'discord-b']);
  });

  it('skips a muted caller without even reading settings', async () => {
    const loadSettings = vi.fn(async () => ON);
    const deps = makeDeps({ loadSettings });
    const result = await deliverCalloutDms([job('a', false)], deps);
    expect(result.delivered).toBe(0);
    expect(loadSettings).not.toHaveBeenCalled();
  });

  it('skips a follower who never opted in', async () => {
    const deps = makeDeps({ loadSettings: async () => ({ discordBotDm: { enabled: false, triggers: {} } }) });
    const result = await deliverCalloutDms([job('a')], deps);
    expect(result).toMatchObject({ eligible: 0, delivered: 0 });
    expect(deps.sent).toEqual([]);
  });

  it('skips a follower with no linked Discord identity', async () => {
    const deps = makeDeps({ resolveDiscordId: async () => null });
    const result = await deliverCalloutDms([job('a')], deps);
    expect(result).toMatchObject({ eligible: 0, delivered: 0 });
  });

  it('reads settings and identity ONCE per user across a burst', async () => {
    const loadSettings = vi.fn(async () => ON);
    const resolveDiscordId = vi.fn(async (u: string) => `discord-${u}`);
    const deps = makeDeps({ loadSettings, resolveDiscordId });
    await deliverCalloutDms([job('a'), job('a'), job('a')], deps);
    expect(loadSettings).toHaveBeenCalledTimes(1);
    expect(resolveDiscordId).toHaveBeenCalledTimes(1);
    expect(deps.sent).toHaveLength(3);
  });

  it('counts a blocked user separately and keeps going for everyone else', async () => {
    const deps = makeDeps({
      send: async (_c, discordId) => ({
        outcome: discordId === 'discord-a' ? ('blocked' as const) : ('delivered' as const),
      }),
    });
    const result = await deliverCalloutDms([job('a'), job('b')], deps);
    expect(result).toMatchObject({ blocked: 1, delivered: 1, failed: 0 });
  });

  it('warns once per blocked user, not once per callout', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = makeDeps({ send: async () => ({ outcome: 'blocked' as const }) });
    await deliverCalloutDms([job('a'), job('a'), job('a')], deps);
    const blockedWarnings = warn.mock.calls.filter((c) => String(c[0]).includes('Cannot DM a follower'));
    expect(blockedWarnings).toHaveLength(1);
  });

  it('counts a hard failure and still delivers the rest', async () => {
    const deps = makeDeps({
      send: async (_c, discordId) => ({
        outcome: discordId === 'discord-a' ? ('failed' as const) : ('delivered' as const),
      }),
    });
    const result = await deliverCalloutDms([job('a'), job('b')], deps);
    expect(result).toMatchObject({ failed: 1, delivered: 1 });
  });

  it('never rejects when a dependency throws — the poller must not see it', async () => {
    const deps = makeDeps({
      loadSettings: async () => {
        throw new Error('supabase down');
      },
    });
    await expect(deliverCalloutDms([job('a')], deps)).resolves.toMatchObject({ delivered: 0 });
  });

  it('never rejects when the send itself throws', async () => {
    const deps = makeDeps({
      send: async () => {
        throw new Error('discord exploded');
      },
    });
    await expect(deliverCalloutDms([job('a')], deps)).resolves.toBeTruthy();
  });

  it('no-ops without a connected bot client', async () => {
    const deps = makeDeps({ getClient: () => null });
    const result = await deliverCalloutDms([job('a')], deps);
    expect(result.delivered).toBe(0);
    expect(deps.sent).toEqual([]);
  });

  it('no-ops on an empty job list', async () => {
    const deps = makeDeps();
    await expect(deliverCalloutDms([], deps)).resolves.toMatchObject({ eligible: 0, delivered: 0 });
  });

  it('caps one dispatch and counts the overflow instead of spraying', async () => {
    const deps = makeDeps();
    const jobs = Array.from({ length: MAX_DMS_PER_DISPATCH + 5 }, (_, i) => job(`u${i}`));
    const result = await deliverCalloutDms(jobs, deps);
    expect(result.delivered).toBe(MAX_DMS_PER_DISPATCH);
    expect(result.dropped).toBe(5);
    expect(result.eligible).toBe(MAX_DMS_PER_DISPATCH + 5);
    expect(deps.sent).toHaveLength(MAX_DMS_PER_DISPATCH);
  });

  it('paces sends so a burst cannot look like DM spam to Discord', async () => {
    const sleep = vi.fn(async () => {});
    const deps = makeDeps({ sleep });
    await deliverCalloutDms([job('a'), job('b')], deps);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls.every((c) => (c[0] as unknown as number) > 0)).toBe(true);
  });
});
