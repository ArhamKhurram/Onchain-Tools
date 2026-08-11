// Unit coverage for the public Discord-channel delivery of pump.fun callouts.
// Discord is mocked entirely — no client is ever constructed and no request
// leaves the process. See backend/src/pumpfun/calloutDiscord.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { REFERRALS } from '@oct/shared';
import {
  CalloutDiscordPoster,
  PostBudget,
  SeenCallouts,
  buildCalloutPostComponents,
  calloutSourceLabel,
  callerDisplayName,
  coinDisplayName,
  isCalloutDiscordEnabled,
  resolveCalloutDiscordConfig,
  throttleNote,
  type CalloutDiscordConfig,
  type CalloutDiscordDeps,
  type CalloutPostInput,
} from '../src/pumpfun/calloutDiscord';
import type { RecentCallout } from '../src/pumpfun/calloutFeedClient';

const CALLER = 'Ca11erWa11etAddre55Aaaaaaaaaaaaaaaaaaaaaaaaa';
const MINT = 'A13oRB9FFaiUjfi6LdCg6p9ka1u8SfGkUFs4SKvPpump';

function callout(over: Partial<RecentCallout> = {}): RecentCallout {
  return {
    calloutId: 'callout-1',
    callerAddress: CALLER,
    coinMint: MINT,
    marketCapUsd: 412_500,
    thesis: 'dudas committed + working with cto team',
    multiple: 1,
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

function config(over: Partial<CalloutDiscordConfig> = {}): CalloutDiscordConfig {
  return {
    enabled: true,
    channelId: 'chan-1',
    allowlist: new Set([CALLER]),
    maxPerWindow: 5,
    windowMs: 60_000,
    boardLimit: 25,
    boardMinCalls: 3,
    boardWindowMs: 7 * 24 * 60 * 60 * 1000,
    sourceTtlMs: 600_000,
    ...over,
  };
}

interface Harness {
  deps: CalloutDiscordDeps;
  send: ReturnType<typeof vi.fn>;
  fetchChannel: ReturnType<typeof vi.fn>;
  getClient: ReturnType<typeof vi.fn>;
  loadBoardAddresses: ReturnType<typeof vi.fn>;
  setNow: (t: number) => void;
  sentPayloads: () => string[];
}

function harness(over: Partial<CalloutDiscordDeps> = {}): Harness {
  const send = vi.fn().mockResolvedValue(undefined);
  const fetchChannel = vi.fn().mockResolvedValue({ send });
  const getClient = vi.fn().mockReturnValue({ channels: { fetch: fetchChannel } });
  const loadBoardAddresses = vi.fn().mockResolvedValue([CALLER]);
  let now = 1_000_000;

  const deps: CalloutDiscordDeps = {
    getClient: getClient as unknown as CalloutDiscordDeps['getClient'],
    loadBoardAddresses,
    resolveUsers: vi
      .fn()
      .mockResolvedValue(
        new Map([[CALLER, { address: CALLER, username: 'papipablo', avatar: 'https://img/pfp.png' }]]),
      ),
    resolveCoins: vi
      .fn()
      .mockResolvedValue(new Map([[MINT, { mint: MINT, symbol: 'TOAD', name: 'Toad', image: null }]])),
    now: () => now,
    ...over,
  };

  return {
    deps,
    send,
    fetchChannel,
    getClient,
    loadBoardAddresses,
    setNow: (t) => {
      now = t;
    },
    sentPayloads: () => send.mock.calls.map((c) => JSON.stringify(c[0])),
  };
}

// --- Config gating ---------------------------------------------------------

describe('resolveCalloutDiscordConfig', () => {
  it('defaults to OFF with no channel when nothing is set', () => {
    const cfg = resolveCalloutDiscordConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.channelId).toBeNull();
    expect(isCalloutDiscordEnabled(cfg)).toBe(false);
  });

  it('needs BOTH the flag and a channel id to be considered enabled', () => {
    expect(isCalloutDiscordEnabled(resolveCalloutDiscordConfig({ OCT_CALLOUT_DISCORD_ENABLED: 'true' }))).toBe(false);
    expect(isCalloutDiscordEnabled(resolveCalloutDiscordConfig({ OCT_CALLOUT_DISCORD_CHANNEL_ID: 'c1' }))).toBe(false);
    expect(
      isCalloutDiscordEnabled(
        resolveCalloutDiscordConfig({ OCT_CALLOUT_DISCORD_ENABLED: 'true', OCT_CALLOUT_DISCORD_CHANNEL_ID: 'c1' }),
      ),
    ).toBe(true);
  });

  it('honours the TRENCHCORD_ fallback branding', () => {
    const cfg = resolveCalloutDiscordConfig({
      TRENCHCORD_CALLOUT_DISCORD_ENABLED: '1',
      TRENCHCORD_CALLOUT_DISCORD_CHANNEL_ID: 'legacy-chan',
    });
    expect(isCalloutDiscordEnabled(cfg)).toBe(true);
    expect(cfg.channelId).toBe('legacy-chan');
  });

  it('prefers the OCT_ var over the TRENCHCORD_ one', () => {
    const cfg = resolveCalloutDiscordConfig({
      OCT_CALLOUT_DISCORD_CHANNEL_ID: 'new',
      TRENCHCORD_CALLOUT_DISCORD_CHANNEL_ID: 'old',
    });
    expect(cfg.channelId).toBe('new');
  });

  it('treats only truthy words as on', () => {
    for (const raw of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(resolveCalloutDiscordConfig({ OCT_CALLOUT_DISCORD_ENABLED: raw }).enabled).toBe(true);
    }
    for (const raw of ['0', 'false', 'no', '', 'off', 'maybe']) {
      expect(resolveCalloutDiscordConfig({ OCT_CALLOUT_DISCORD_ENABLED: raw }).enabled).toBe(false);
    }
  });

  it('parses a comma-separated operator allowlist, ignoring blanks', () => {
    const cfg = resolveCalloutDiscordConfig({ OCT_CALLOUT_DISCORD_CALLERS: ` ${CALLER} , , addr2 ` });
    expect(cfg.allowlist).toEqual(new Set([CALLER, 'addr2']));
    expect(calloutSourceLabel(cfg)).toBe('Operator watchlist');
  });

  it('falls back to the global board when no allowlist is configured', () => {
    const cfg = resolveCalloutDiscordConfig({ OCT_CALLOUT_DISCORD_CALLERS: '  ,  ' });
    expect(cfg.allowlist).toBeNull();
    expect(calloutSourceLabel(cfg)).toBe('Top callers board');
  });

  it('rejects non-positive numeric overrides and keeps the defaults', () => {
    const cfg = resolveCalloutDiscordConfig({ OCT_CALLOUT_DISCORD_MAX_PER_WINDOW: '-3', OCT_CALLOUT_DISCORD_WINDOW_MS: 'abc' });
    expect(cfg.maxPerWindow).toBe(5);
    expect(cfg.windowMs).toBe(60_000);
  });
});

describe('CalloutDiscordPoster config gating', () => {
  it('makes no attempt at all when the feature is disabled', async () => {
    const h = harness();
    await new CalloutDiscordPoster(config({ enabled: false }), h.deps).post([callout()]);
    expect(h.getClient).not.toHaveBeenCalled();
    expect(h.fetchChannel).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('makes no attempt when the channel id is unset', async () => {
    const h = harness();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const poster = new CalloutDiscordPoster(config({ channelId: null }), h.deps);
    await poster.post([callout()]);
    await poster.post([callout({ calloutId: 'callout-2' })]);
    expect(h.getClient).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    // Half-configured is worth exactly one warning, not one per poll.
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('does nothing when the bot client is not connected', async () => {
    const h = harness({ getClient: vi.fn().mockReturnValue(null) as unknown as CalloutDiscordDeps['getClient'] });
    await new CalloutDiscordPoster(config(), h.deps).post([callout()]);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('posts nothing for a caller outside the operator-configured set', async () => {
    const h = harness();
    await new CalloutDiscordPoster(config({ allowlist: new Set(['someone-else']) }), h.deps).post([callout()]);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('drives the caller set from the global board when no allowlist is set', async () => {
    const h = harness();
    await new CalloutDiscordPoster(config({ allowlist: null }), h.deps).post([callout()]);
    expect(h.loadBoardAddresses).toHaveBeenCalledOnce();
    expect(h.send).toHaveBeenCalledOnce();
  });

  it('caches the board caller set for the configured TTL', async () => {
    const h = harness();
    const poster = new CalloutDiscordPoster(config({ allowlist: null, sourceTtlMs: 10_000 }), h.deps);
    await poster.post([callout({ calloutId: 'a' })]);
    h.setNow(1_005_000);
    await poster.post([callout({ calloutId: 'b' })]);
    expect(h.loadBoardAddresses).toHaveBeenCalledOnce();
    h.setNow(1_020_000);
    await poster.post([callout({ calloutId: 'c' })]);
    expect(h.loadBoardAddresses).toHaveBeenCalledTimes(2);
  });

  it('posts nothing when the board comes back empty (e.g. local mode)', async () => {
    const h = harness({ loadBoardAddresses: vi.fn().mockResolvedValue([]) });
    await new CalloutDiscordPoster(config({ allowlist: null }), h.deps).post([callout()]);
    expect(h.send).not.toHaveBeenCalled();
  });
});

// --- Dedupe ----------------------------------------------------------------

describe('SeenCallouts', () => {
  it('yields each callout id exactly once', () => {
    const seen = new SeenCallouts();
    expect(seen.take([callout({ calloutId: 'x' }), callout({ calloutId: 'y' })])).toHaveLength(2);
    expect(seen.take([callout({ calloutId: 'y' }), callout({ calloutId: 'z' })])).toEqual([
      expect.objectContaining({ calloutId: 'z' }),
    ]);
  });

  it('collapses duplicates inside a single batch', () => {
    const seen = new SeenCallouts();
    expect(seen.take([callout({ calloutId: 'x' }), callout({ calloutId: 'x' })])).toHaveLength(1);
  });

  it('stays bounded, evicting the oldest ids', () => {
    const seen = new SeenCallouts(3);
    seen.take(['a', 'b', 'c', 'd'].map((id) => callout({ calloutId: id })));
    expect(seen.size).toBe(3);
    // 'a' was evicted, so it is postable again; 'd' is still remembered.
    expect(seen.take([callout({ calloutId: 'a' }), callout({ calloutId: 'd' })])).toEqual([
      expect.objectContaining({ calloutId: 'a' }),
    ]);
  });
});

describe('CalloutDiscordPoster dedupe', () => {
  it('posts one message per callout even though many users follow that caller', async () => {
    // The poller fans out per (callout × follower). This path is driven from the
    // deduped `fresh` list instead, so subscriber count cannot multiply posts.
    const h = harness();
    await new CalloutDiscordPoster(config(), h.deps).post([callout()]);
    expect(h.send).toHaveBeenCalledOnce();
  });

  it('does not repost a callout id already posted (cursor write failed, ids replayed)', async () => {
    const h = harness();
    const poster = new CalloutDiscordPoster(config(), h.deps);
    await poster.post([callout({ calloutId: 'dupe' })]);
    await poster.post([callout({ calloutId: 'dupe' })]);
    expect(h.send).toHaveBeenCalledOnce();
  });

  it('does not let a duplicate consume the burst budget', async () => {
    const h = harness();
    const poster = new CalloutDiscordPoster(config({ maxPerWindow: 2 }), h.deps);
    await poster.post([callout({ calloutId: 'a' })]);
    await poster.post([callout({ calloutId: 'a' })]); // deduped before the budget
    await poster.post([callout({ calloutId: 'b' })]);
    expect(h.send).toHaveBeenCalledTimes(2);
  });
});

// --- Throttle --------------------------------------------------------------

describe('PostBudget', () => {
  it('admits up to the cap inside one window, then drops', () => {
    const budget = new PostBudget(2, 1000);
    expect(budget.admit(0)).toBe(true);
    expect(budget.admit(100)).toBe(true);
    expect(budget.admit(200)).toBe(false);
    expect(budget.dropped).toBe(1);
  });

  it('counts every drop', () => {
    const budget = new PostBudget(1, 1000);
    budget.admit(0);
    budget.admit(1);
    budget.admit(2);
    budget.admit(3);
    expect(budget.dropped).toBe(3);
  });

  it('admits again once the window rolls past', () => {
    const budget = new PostBudget(1, 1000);
    expect(budget.admit(0)).toBe(true);
    expect(budget.admit(500)).toBe(false);
    expect(budget.admit(1500)).toBe(true);
  });

  it('drains the drop counter exactly once', () => {
    const budget = new PostBudget(1, 1000);
    budget.admit(0);
    budget.admit(1);
    budget.admit(2);
    expect(budget.drainDropped()).toBe(2);
    expect(budget.drainDropped()).toBe(0);
    expect(budget.dropped).toBe(0);
  });
});

describe('CalloutDiscordPoster throttle', () => {
  const bursty = () => ['a', 'b', 'c', 'd', 'e'].map((id) => callout({ calloutId: id }));

  it('caps a burst at maxPerWindow posts', async () => {
    const h = harness();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await new CalloutDiscordPoster(config({ maxPerWindow: 2 }), h.deps).post(bursty());
    expect(h.send).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('logs the drop count instead of dropping silently', async () => {
    const h = harness();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await new CalloutDiscordPoster(config({ maxPerWindow: 2 }), h.deps).post(bursty());
    const line = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(line).toContain('3 callout(s) dropped');
    expect(line).toContain('burst cap hit');
    warn.mockRestore();
  });

  it('surfaces the suppressed count on the next post that gets through', async () => {
    const h = harness();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const poster = new CalloutDiscordPoster(config({ maxPerWindow: 2, windowMs: 1000 }), h.deps);
    await poster.post(bursty()); // 2 posted, 3 dropped
    h.setNow(1_002_000); // window has rolled
    await poster.post([callout({ calloutId: 'f' })]);
    expect(h.sentPayloads()[2]).toContain('+3 more callouts held back');
    warn.mockRestore();
  });

  it('recovers after the window rolls past', async () => {
    const h = harness();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const poster = new CalloutDiscordPoster(config({ maxPerWindow: 1, windowMs: 1000 }), h.deps);
    await poster.post([callout({ calloutId: 'a' }), callout({ calloutId: 'b' })]);
    expect(h.send).toHaveBeenCalledOnce();
    h.setNow(1_002_000);
    await poster.post([callout({ calloutId: 'c' })]);
    expect(h.send).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('throttleNote', () => {
  it('is absent when nothing was dropped', () => {
    expect(throttleNote(0)).toBeNull();
    expect(throttleNote(-1)).toBeNull();
  });

  it('reads naturally for one and for many', () => {
    expect(throttleNote(1)).toContain('+1 more callout held back');
    expect(throttleNote(4)).toContain('+4 more callouts held back');
  });
});

// --- Failure isolation -----------------------------------------------------

describe('CalloutDiscordPoster failure isolation', () => {
  it('never rejects when the channel send fails', async () => {
    const h = harness();
    h.send.mockRejectedValue(Object.assign(new Error('Missing Permissions'), { code: 50013 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(new CalloutDiscordPoster(config(), h.deps).post([callout()])).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('never rejects when the channel cannot be fetched', async () => {
    const h = harness({});
    h.fetchChannel.mockRejectedValue({ code: 50001 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(new CalloutDiscordPoster(config(), h.deps).post([callout()])).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it('never rejects when the resolved channel is not postable', async () => {
    const h = harness();
    h.fetchChannel.mockResolvedValue({ isVoiceBased: () => true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(new CalloutDiscordPoster(config(), h.deps).post([callout()])).resolves.toBeUndefined();
    expect(h.send).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('never rejects when the board lookup fails', async () => {
    const h = harness({ loadBoardAddresses: vi.fn().mockRejectedValue(new Error('supabase down')) });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      new CalloutDiscordPoster(config({ allowlist: null }), h.deps).post([callout()]),
    ).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it('still posts when pump identity enrichment fails', async () => {
    const h = harness({
      resolveUsers: vi.fn().mockRejectedValue(new Error('pump down')),
      resolveCoins: vi.fn().mockRejectedValue(new Error('pump down')),
    });
    await new CalloutDiscordPoster(config(), h.deps).post([callout()]);
    expect(h.send).toHaveBeenCalledOnce();
    // Falls back to the short wallet/mint rather than dropping the post.
    expect(h.sentPayloads()[0]).toContain(MINT);
  });

  it('rate-limits repeated failure logging to one line per minute', async () => {
    const h = harness();
    h.send.mockRejectedValue(new Error('boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const poster = new CalloutDiscordPoster(config(), h.deps);
    await poster.post([callout({ calloutId: 'a' })]);
    await poster.post([callout({ calloutId: 'b' })]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

// --- Rendering -------------------------------------------------------------

describe('buildCalloutPostComponents', () => {
  const input = (over: Partial<CalloutPostInput> = {}): CalloutPostInput => ({
    callerAddress: CALLER,
    callerName: 'papipablo',
    callerAvatar: 'https://img/pfp.png',
    mint: MINT,
    symbol: 'TOAD',
    coinName: 'Toad',
    thesis: 'dudas committed + working with cto team\nslingoor adding all fees to LP',
    marketCapUsd: 412_500,
    multiple: 1,
    sourceLabel: 'Top callers board',
    ...over,
  });

  it('renders the mint inside a fenced code block', () => {
    const text = JSON.stringify(buildCalloutPostComponents(input()));
    expect(text).toContain(`\`\`\`\\n${MINT}\\n\`\`\``);
  });

  it('leads with who called what', () => {
    const text = JSON.stringify(buildCalloutPostComponents(input()));
    expect(text).toContain('papipablo called out $TOAD');
  });

  it('formats the market cap at call time compactly', () => {
    expect(JSON.stringify(buildCalloutPostComponents(input()))).toContain('MC at call $412.5K');
    expect(JSON.stringify(buildCalloutPostComponents(input({ marketCapUsd: 2_400_000 })))).toContain(
      'MC at call $2.40M',
    );
    expect(JSON.stringify(buildCalloutPostComponents(input({ marketCapUsd: 850 })))).toContain('MC at call $850');
  });

  it('shows an em dash rather than a broken figure when the market cap is unknown', () => {
    const text = JSON.stringify(buildCalloutPostComponents(input({ marketCapUsd: null })));
    expect(text).toContain('MC at call —');
    expect(text).not.toContain('null');
    expect(text).not.toContain('NaN');
  });

  it('quotes the thesis verbatim, line by line', () => {
    const text = JSON.stringify(buildCalloutPostComponents(input()));
    expect(text).toContain('> dudas committed + working with cto team');
    expect(text).toContain('> slingoor adding all fees to LP');
  });

  it('handles a missing thesis without rendering an empty quote', () => {
    for (const thesis of [null, '', '   ']) {
      const text = JSON.stringify(buildCalloutPostComponents(input({ thesis })));
      expect(text).toContain('No thesis given');
      expect(text).not.toContain('null');
      expect(text).not.toContain('undefined');
    }
  });

  it('truncates a very long thesis', () => {
    const text = JSON.stringify(buildCalloutPostComponents(input({ thesis: 'x'.repeat(5000) })));
    expect(text).toContain('…');
    expect(text.length).toBeLessThan(2000);
  });

  it('falls back to short forms when the caller handle and ticker are unknown', () => {
    const text = JSON.stringify(
      buildCalloutPostComponents(input({ callerName: null, symbol: null, coinName: null })),
    );
    expect(text).toContain('Ca11..aaaa called out A13o..pump');
    expect(text).toContain(MINT); // the full mint is still in the code block
  });

  it('adds a chart link on the app contract-link convention plus the pump.fun page', () => {
    const text = JSON.stringify(buildCalloutPostComponents(input()));
    // buildContractUrl (@oct/shared) — the Solana default is Axiom, referral and all.
    expect(text).toContain(`https://axiom.trade/t/${MINT}/@${REFERRALS.axiom}?chain=sol`);
    expect(text).toContain(`https://pump.fun/coin/${MINT}`);
  });

  it("floats the caller's avatar as a section thumbnail when there is one", () => {
    const withAvatar = buildCalloutPostComponents(input()) as any[];
    const section = withAvatar[0].components[0];
    expect(section.type).toBe(9);
    expect(section.accessory).toEqual({ type: 11, media: { url: 'https://img/pfp.png' } });
  });

  it('renders plain text lines when the caller has no avatar', () => {
    const noAvatar = buildCalloutPostComponents(input({ callerAvatar: null })) as any[];
    expect(noAvatar[0].components[0].type).toBe(10);
    expect(JSON.stringify(noAvatar)).not.toContain('"type":11');
  });

  it('is a single branded Components V2 container', () => {
    const components = buildCalloutPostComponents(input()) as any[];
    expect(components).toHaveLength(1);
    expect(components[0].type).toBe(17);
    expect(components[0].accent_color).toBe(0xfee75c);
    expect(JSON.stringify(components)).toContain('OCT 👀');
  });

  it('names the caller source so readers know why the post is here', () => {
    expect(JSON.stringify(buildCalloutPostComponents(input()))).toContain('Top callers board');
    expect(JSON.stringify(buildCalloutPostComponents(input({ sourceLabel: 'Operator watchlist' })))).toContain(
      'Operator watchlist',
    );
  });

  it('shows the multiple only once the coin has actually moved', () => {
    expect(JSON.stringify(buildCalloutPostComponents(input({ multiple: 1 })))).not.toContain('× since');
    expect(JSON.stringify(buildCalloutPostComponents(input({ multiple: 3.2 })))).toContain('3.20× since');
    expect(JSON.stringify(buildCalloutPostComponents(input({ multiple: null })))).not.toContain('× since');
  });

  it('omits the throttle note unless callouts were actually held back', () => {
    expect(JSON.stringify(buildCalloutPostComponents(input()))).not.toContain('held back');
    expect(JSON.stringify(buildCalloutPostComponents(input({ suppressedCount: 2 })))).toContain(
      '+2 more callouts held back',
    );
  });
});

describe('display helpers', () => {
  it('prefers a handle, falling back to the short wallet', () => {
    expect(callerDisplayName({ callerName: 'papipablo', callerAddress: CALLER })).toBe('papipablo');
    expect(callerDisplayName({ callerName: '  ', callerAddress: CALLER })).toBe('Ca11..aaaa');
    expect(callerDisplayName({ callerName: null, callerAddress: CALLER })).toBe('Ca11..aaaa');
  });

  it('prefixes a ticker with exactly one dollar sign', () => {
    expect(coinDisplayName({ symbol: 'TOAD', mint: MINT })).toBe('$TOAD');
    expect(coinDisplayName({ symbol: '$TOAD', mint: MINT })).toBe('$TOAD');
    expect(coinDisplayName({ symbol: null, mint: MINT })).toBe('A13o..pump');
  });
});

// The poster mounts on the real bot client by default; make sure importing this
// module never reached for a live Discord connection during these tests.
describe('test isolation', () => {
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => spy.mockRestore());

  it('did not log a Discord client error', () => {
    expect(spy).not.toHaveBeenCalled();
  });
});
