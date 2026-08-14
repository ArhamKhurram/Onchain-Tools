// Unit coverage for the FOMO new-join alert logic (backend/src/fomo/joinFeed.ts):
// envelope extraction, normalization, cursor/seen-set dedupe, the notability
// gate, the per-cycle burst cap, and env resolution. Pure functions only — the
// polling loop and fan-out (joinWatcher.ts) are I/O and stay untested here,
// per the repo's unit-tests-over-pure-functions policy.

import { describe, it, expect } from 'vitest';
import {
  JOIN_FEED_TYPE,
  buildJoinPayload,
  buildJoinPushoverText,
  diffNewJoins,
  extractJoinFeedItems,
  joinDisplayLabel,
  joinProfileUrl,
  mergeSeenUserIds,
  normalizeJoinItem,
  partitionJoinBurst,
  passesNotability,
  resolveJoinDiscordConfig,
  resolveJoinMinFollowers,
  resolveJoinPollIntervalMs,
  type FomoJoinEvent,
} from '../src/fomo/joinFeed';

function rawItem(over: Record<string, unknown> = {}, bodyOver: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'feed-1',
    type: JOIN_FEED_TYPE,
    createdAt: '2026-08-11T12:00:00.000Z',
    body: {
      userId: 'user-1',
      userHandle: 'dkceo',
      displayName: 'DraftKings CEO',
      userImageUrl: 'https://img/pfp.png',
      followers: [{ id: 'smart-1' }, { id: 'smart-2' }],
      ...bodyOver,
    },
    ...over,
  };
}

function event(over: Partial<FomoJoinEvent> = {}): FomoJoinEvent {
  return {
    feedId: 'feed-1',
    fomoUserId: 'user-1',
    fomoHandle: 'dkceo',
    displayName: 'DraftKings CEO',
    imageUrl: null,
    smartFollowerCount: 2,
    followerCount: null,
    createdAt: null,
    ...over,
  };
}

describe('extractJoinFeedItems', () => {
  it('reads the responseObject.feed envelope the site itself uses', () => {
    const items = extractJoinFeedItems({ success: true, responseObject: { feed: [rawItem()] } });
    expect(items).toHaveLength(1);
  });

  it('accepts a bare array and an items alias', () => {
    expect(extractJoinFeedItems([rawItem(), rawItem()])).toHaveLength(2);
    expect(extractJoinFeedItems({ responseObject: { items: [rawItem()] } })).toHaveLength(1);
  });

  it('degrades to empty on junk instead of throwing', () => {
    expect(extractJoinFeedItems(null)).toEqual([]);
    expect(extractJoinFeedItems('nope')).toEqual([]);
    expect(extractJoinFeedItems({ responseObject: { feed: 'not-an-array' } })).toEqual([]);
  });
});

describe('normalizeJoinItem', () => {
  it('normalizes a full join item', () => {
    const e = normalizeJoinItem(rawItem());
    expect(e).not.toBeNull();
    expect(e!.feedId).toBe('feed-1');
    expect(e!.fomoUserId).toBe('user-1');
    expect(e!.fomoHandle).toBe('dkceo');
    expect(e!.displayName).toBe('DraftKings CEO');
    expect(e!.imageUrl).toBe('https://img/pfp.png');
    expect(e!.smartFollowerCount).toBe(2);
    expect(e!.followerCount).toBeNull();
    expect(e!.createdAt).toBe(Date.parse('2026-08-11T12:00:00.000Z'));
  });

  it('drops items of any other feed type (never trusts the server filter)', () => {
    expect(normalizeJoinItem(rawItem({ type: 'multi_user_buy' }))).toBeNull();
    expect(normalizeJoinItem(rawItem({ type: 'new_token_listing' }))).toBeNull();
  });

  it('drops items missing the feed id or user id (cannot dedupe them)', () => {
    expect(normalizeJoinItem(rawItem({ id: undefined }))).toBeNull();
    expect(normalizeJoinItem(rawItem({}, { userId: undefined }))).toBeNull();
    expect(normalizeJoinItem(null)).toBeNull();
  });

  it('parses numeric createdAt and tolerates a missing one', () => {
    expect(normalizeJoinItem(rawItem({ createdAt: 1_700_000_000_000 }))!.createdAt).toBe(1_700_000_000_000);
    expect(normalizeJoinItem(rawItem({ createdAt: undefined }))!.createdAt).toBeNull();
    expect(normalizeJoinItem(rawItem({ createdAt: 'garbage' }))!.createdAt).toBeNull();
  });

  it('tolerates a missing followers array', () => {
    expect(normalizeJoinItem(rawItem({}, { followers: undefined }))!.smartFollowerCount).toBe(0);
  });
});

describe('diffNewJoins', () => {
  const a = event({ feedId: 'f-3', fomoUserId: 'u-3' });
  const b = event({ feedId: 'f-2', fomoUserId: 'u-2' });
  const c = event({ feedId: 'f-1', fomoUserId: 'u-1' });

  it('takes everything newer than the cursor, returned oldest first', () => {
    const diff = diffNewJoins([a, b, c], { lastFeedId: 'f-1', seenUserIds: [] });
    expect(diff.fresh.map((e) => e.feedId)).toEqual(['f-2', 'f-3']);
    expect(diff.newestFeedId).toBe('f-3');
  });

  it('returns nothing when the newest item IS the cursor', () => {
    const diff = diffNewJoins([a, b, c], { lastFeedId: 'f-3', seenUserIds: [] });
    expect(diff.fresh).toEqual([]);
    expect(diff.newestFeedId).toBe('f-3');
  });

  it('with no cursor match, everything on the page is fresh', () => {
    const diff = diffNewJoins([a, b], { lastFeedId: 'f-gone', seenUserIds: [] });
    expect(diff.fresh.map((e) => e.feedId)).toEqual(['f-2', 'f-3']);
  });

  it('drops users already in the persisted seen-set (re-surfaced feed id)', () => {
    const diff = diffNewJoins([a, b], { lastFeedId: null, seenUserIds: ['u-3'] });
    expect(diff.fresh.map((e) => e.fomoUserId)).toEqual(['u-2']);
  });

  it('dedupes the same user appearing twice in one page (newest entry wins)', () => {
    const dup = event({ feedId: 'f-9', fomoUserId: 'u-3' });
    const diff = diffNewJoins([dup, a, b], { lastFeedId: null, seenUserIds: [] });
    expect(diff.fresh.map((e) => e.feedId)).toEqual(['f-2', 'f-9']);
    expect(diff.fresh.filter((e) => e.fomoUserId === 'u-3')).toHaveLength(1);
  });

  it('handles an empty page', () => {
    const diff = diffNewJoins([], { lastFeedId: 'f-1', seenUserIds: [] });
    expect(diff.fresh).toEqual([]);
    expect(diff.newestFeedId).toBeNull();
  });
});

describe('passesNotability', () => {
  it('passes everyone when the gate is off (min 0)', () => {
    expect(passesNotability(event({ followerCount: 0 }), 0)).toBe(true);
    expect(passesNotability(event({ followerCount: null }), 0)).toBe(true);
  });

  it('fails open when the follower count is unknown', () => {
    expect(passesNotability(event({ followerCount: null }), 10_000)).toBe(true);
  });

  it('filters below the floor, passes at and above it', () => {
    expect(passesNotability(event({ followerCount: 9_999 }), 10_000)).toBe(false);
    expect(passesNotability(event({ followerCount: 10_000 }), 10_000)).toBe(true);
    expect(passesNotability(event({ followerCount: 250_000 }), 10_000)).toBe(true);
  });
});

describe('partitionJoinBurst', () => {
  const events = Array.from({ length: 8 }, (_, i) => event({ feedId: `f-${i}`, fomoUserId: `u-${i}` }));

  it('leaves small batches alone', () => {
    const burst = partitionJoinBurst(events.slice(0, 3));
    expect(burst.alert).toHaveLength(3);
    expect(burst.suppressed).toBe(0);
  });

  it('caps at 5 and counts the rest, keeping the NEWEST (last) events', () => {
    const burst = partitionJoinBurst(events);
    expect(burst.alert).toHaveLength(5);
    expect(burst.suppressed).toBe(3);
    // Input is oldest-first, so the newest are at the tail.
    expect(burst.alert.map((e) => e.feedId)).toEqual(['f-3', 'f-4', 'f-5', 'f-6', 'f-7']);
  });

  it('exactly at the cap suppresses nothing', () => {
    const burst = partitionJoinBurst(events.slice(0, 5));
    expect(burst.alert).toHaveLength(5);
    expect(burst.suppressed).toBe(0);
  });
});

describe('mergeSeenUserIds', () => {
  it('appends new ids without duplicating existing ones', () => {
    const merged = mergeSeenUserIds(['u-1'], [event({ fomoUserId: 'u-1' }), event({ fomoUserId: 'u-2' })]);
    expect(merged).toEqual(['u-1', 'u-2']);
  });

  it('evicts oldest ids past the cap', () => {
    const merged = mergeSeenUserIds(['a', 'b', 'c'], [event({ fomoUserId: 'd' })], 3);
    expect(merged).toEqual(['b', 'c', 'd']);
  });
});

describe('env resolution (OCT_ with TRENCHCORD_ fallback)', () => {
  it('poll interval defaults to 120000 and honors both prefixes', () => {
    expect(resolveJoinPollIntervalMs({})).toBe(120_000);
    expect(resolveJoinPollIntervalMs({ OCT_FOMO_JOIN_POLL_MS: '300000' })).toBe(300_000);
    expect(resolveJoinPollIntervalMs({ TRENCHCORD_FOMO_JOIN_POLL_MS: '240000' })).toBe(240_000);
    expect(
      resolveJoinPollIntervalMs({ OCT_FOMO_JOIN_POLL_MS: '180000', TRENCHCORD_FOMO_JOIN_POLL_MS: '240000' }),
    ).toBe(180_000);
  });

  it('poll interval floors at 30s and ignores junk', () => {
    expect(resolveJoinPollIntervalMs({ OCT_FOMO_JOIN_POLL_MS: '5' })).toBe(30_000);
    expect(resolveJoinPollIntervalMs({ OCT_FOMO_JOIN_POLL_MS: 'soon' })).toBe(120_000);
    expect(resolveJoinPollIntervalMs({ OCT_FOMO_JOIN_POLL_MS: '-1' })).toBe(120_000);
  });

  it('min-followers defaults to 0 (alert all) and honors both prefixes', () => {
    expect(resolveJoinMinFollowers({})).toBe(0);
    expect(resolveJoinMinFollowers({ OCT_FOMO_JOIN_MIN_FOLLOWERS: '10000' })).toBe(10_000);
    expect(resolveJoinMinFollowers({ TRENCHCORD_FOMO_JOIN_MIN_FOLLOWERS: '5000' })).toBe(5_000);
    expect(resolveJoinMinFollowers({ OCT_FOMO_JOIN_MIN_FOLLOWERS: 'lots' })).toBe(0);
  });

  it('Discord posting is OFF by default and needs both switch and channel', () => {
    expect(resolveJoinDiscordConfig({})).toEqual({ enabled: false, channelId: null });
    expect(resolveJoinDiscordConfig({ OCT_FOMO_JOIN_DISCORD_ENABLED: 'true' }).enabled).toBe(true);
    expect(resolveJoinDiscordConfig({ OCT_FOMO_JOIN_DISCORD_ENABLED: 'true' }).channelId).toBeNull();
    expect(
      resolveJoinDiscordConfig({
        OCT_FOMO_JOIN_DISCORD_ENABLED: '1',
        TRENCHCORD_FOMO_JOIN_DISCORD_CHANNEL_ID: '123',
      }),
    ).toEqual({ enabled: true, channelId: '123' });
  });
});

describe('payload + display helpers', () => {
  it('builds the fomo_join WS frame with profile URL and suppressed count', () => {
    const payload = buildJoinPayload(event(), 3);
    expect(payload.type).toBe('fomo_join');
    const data = payload.data as Record<string, unknown>;
    expect(data.fomoUserId).toBe('user-1');
    expect(data.profileUrl).toBe('https://fomo.family/profile/dkceo');
    expect(data.suppressed).toBe(3);
  });

  it('falls back through displayName → handle → id for the label', () => {
    expect(joinDisplayLabel(event())).toBe('DraftKings CEO');
    expect(joinDisplayLabel(event({ displayName: null }))).toBe('@dkceo');
    expect(joinDisplayLabel(event({ displayName: null, fomoHandle: null }))).toBe('user-1');
  });

  it('has no profile URL without a handle', () => {
    expect(joinProfileUrl(event({ fomoHandle: null }))).toBeNull();
  });

  it('pushover text: single join reads as one headline', () => {
    const { title, message } = buildJoinPushoverText({ alert: [event()], suppressed: 0 });
    expect(title).toBe('FOMO: DraftKings CEO just joined');
    expect(message).toContain('DraftKings CEO just joined fomo.family');
  });

  it('pushover text: a burst collapses into one summary with the suppressed count', () => {
    const { title, message } = buildJoinPushoverText({
      alert: [event(), event({ fomoUserId: 'u-2', displayName: 'Someone Else' })],
      suppressed: 4,
    });
    expect(title).toBe('FOMO: 6 new notable joins');
    expect(message).toContain('DraftKings CEO');
    expect(message).toContain('Someone Else');
    expect(message).toContain('+4 more');
  });
});
