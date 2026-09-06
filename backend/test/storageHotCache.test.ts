import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_STORAGE_CACHE_MS,
  HotCache,
  resolveStorageCacheMs,
} from '../src/storage/hotCache.js';
import { roomsForTelegramMessage } from '../src/telegram/messageProcessor.js';

/**
 * Covers the cache that fronts the per-message storage reads after the
 * 2026-09-06 Supabase connection-pool exhaustion. The property that actually
 * fixed the incident is single-flight, so that gets the most attention here:
 * a TTL alone provably does not help a burst, because a burst is entirely
 * made of misses.
 */

describe('resolveStorageCacheMs', () => {
  it('defaults to 30s when unset', () => {
    expect(resolveStorageCacheMs({})).toBe(DEFAULT_STORAGE_CACHE_MS);
    expect(DEFAULT_STORAGE_CACHE_MS).toBe(30_000);
  });

  it('reads OCT_STORAGE_CACHE_MS', () => {
    expect(resolveStorageCacheMs({ OCT_STORAGE_CACHE_MS: '45000' })).toBe(45_000);
  });

  it('falls back to the pre-rename TRENCHCORD_ branding', () => {
    expect(resolveStorageCacheMs({ TRENCHCORD_STORAGE_CACHE_MS: '15000' })).toBe(15_000);
  });

  it('prefers OCT_ over TRENCHCORD_ when both are set', () => {
    expect(
      resolveStorageCacheMs({ OCT_STORAGE_CACHE_MS: '1000', TRENCHCORD_STORAGE_CACHE_MS: '2000' }),
    ).toBe(1_000);
  });

  it('treats a non-numeric value as unset but honours an explicit 0', () => {
    expect(resolveStorageCacheMs({ OCT_STORAGE_CACHE_MS: 'nope' })).toBe(DEFAULT_STORAGE_CACHE_MS);
    expect(resolveStorageCacheMs({ OCT_STORAGE_CACHE_MS: '0' })).toBe(0);
  });
});

describe('HotCache hit / miss / expiry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves a hit within the TTL and re-loads after it', async () => {
    const cache = new HotCache({ ttlMs: 1_000 });
    const load = vi.fn(async () => 'v1');

    expect(await cache.getOrLoad('u1:config', load)).toBe('v1');
    expect(await cache.getOrLoad('u1:config', load)).toBe('v1');
    expect(load).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_001);
    expect(await cache.getOrLoad('u1:config', load)).toBe('v1');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('caches falsy and empty values rather than treating them as misses', async () => {
    const cache = new HotCache({ ttlMs: 1_000 });
    const empty = vi.fn(async () => [] as string[]);
    const nul = vi.fn(async () => null);

    await cache.getOrLoad('u1:tokens', empty);
    await cache.getOrLoad('u1:tokens', empty);
    await cache.getOrLoad('u1:tg_creds', nul);
    await cache.getOrLoad('u1:tg_creds', nul);

    expect(empty).toHaveBeenCalledTimes(1);
    expect(nul).toHaveBeenCalledTimes(1);
  });

  it('does not cache at all when the TTL is disabled', async () => {
    const cache = new HotCache({ ttlMs: 0 });
    const load = vi.fn(async () => 'v');
    await cache.getOrLoad('u1:config', load);
    await cache.getOrLoad('u1:config', load);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('HotCache single-flight', () => {
  it('collapses a burst of concurrent misses into one load', async () => {
    const cache = new HotCache({ ttlMs: 30_000 });
    let resolve!: (v: string) => void;
    const load = vi.fn(() => new Promise<string>((r) => { resolve = r; }));

    // 50 Telegram messages landing in the same tick on a cold key — the exact
    // shape that opened one Supabase connection per message before this.
    const waiters = Array.from({ length: 50 }, () => cache.getOrLoad('u1:rooms', load));
    expect(load).toHaveBeenCalledTimes(1);

    resolve('rooms');
    expect(await Promise.all(waiters)).toEqual(Array(50).fill('rooms'));
    expect(cache.stats().coalesced).toBe(49);
    expect(cache.stats().inFlight).toBe(0);
  });

  it('does not cache a rejection, and lets the next caller retry', async () => {
    const cache = new HotCache({ ttlMs: 30_000 });
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('pool timeout'))
      .mockResolvedValueOnce('ok');

    await expect(cache.getOrLoad('u1:rooms', load)).rejects.toThrow('pool timeout');
    expect(await cache.getOrLoad('u1:rooms', load)).toBe('ok');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps in-flight loads for different keys independent', async () => {
    const cache = new HotCache({ ttlMs: 30_000 });
    const rooms = vi.fn(async () => 'rooms');
    const config = vi.fn(async () => 'config');

    const [a, b] = await Promise.all([
      cache.getOrLoad('u1:rooms', rooms),
      cache.getOrLoad('u1:config', config),
    ]);
    expect([a, b]).toEqual(['rooms', 'config']);
    expect(cache.stats().coalesced).toBe(0);
  });
});

describe('HotCache invalidation', () => {
  it('drops a user entry immediately on invalidatePrefix', async () => {
    const cache = new HotCache({ ttlMs: 30_000 });
    const load = vi.fn().mockResolvedValueOnce('before').mockResolvedValueOnce('after');

    expect(await cache.getOrLoad('u1:keywords', load)).toBe('before');
    cache.invalidatePrefix('u1:');
    expect(await cache.getOrLoad('u1:keywords', load)).toBe('after');
  });

  it('does not cache a load that was invalidated mid-flight', async () => {
    // "I added a keyword and nothing happened": a write that lands while a read
    // is in flight must not be papered over by the read's stale result.
    const cache = new HotCache({ ttlMs: 30_000 });
    let resolve!: (v: string) => void;
    const slow = vi.fn(() => new Promise<string>((r) => { resolve = r; }));

    const inFlight = cache.getOrLoad('u1:keywords', slow);
    cache.invalidatePrefix('u1:'); // the user saves a new keyword
    resolve('stale');
    expect(await inFlight).toBe('stale');

    const fresh = vi.fn(async () => 'fresh');
    expect(await cache.getOrLoad('u1:keywords', fresh)).toBe('fresh');
    expect(fresh).toHaveBeenCalledTimes(1);
  });
});

describe('HotCache per-user isolation', () => {
  it('never serves one user the other user cached value', async () => {
    const cache = new HotCache({ ttlMs: 30_000 });
    const one = await cache.getOrLoad('user-a:config', async () => 'a-config');
    const two = await cache.getOrLoad('user-b:config', async () => 'b-config');
    expect(one).toBe('a-config');
    expect(two).toBe('b-config');
  });

  it('invalidating one user leaves other tenants cached', async () => {
    const cache = new HotCache({ ttlMs: 30_000 });
    const bLoad = vi.fn(async () => 'b-config');
    await cache.getOrLoad('user-a:config', async () => 'a-config');
    await cache.getOrLoad('user-b:config', bLoad);

    cache.invalidatePrefix('user-a:');

    expect(await cache.getOrLoad('user-b:config', bLoad)).toBe('b-config');
    expect(bLoad).toHaveBeenCalledTimes(1);
  });

  it('a user id that is a prefix of another does not invalidate it', async () => {
    // The trailing colon in the invalidation prefix is what guarantees this.
    const cache = new HotCache({ ttlMs: 30_000 });
    const longLoad = vi.fn(async () => 'long');
    await cache.getOrLoad('user-1:config', async () => 'short');
    await cache.getOrLoad('user-10:config', longLoad);

    cache.invalidatePrefix('user-1:');

    expect(await cache.getOrLoad('user-10:config', longLoad)).toBe('long');
    expect(longLoad).toHaveBeenCalledTimes(1);
  });
});

describe('HotCache bounds', () => {
  it('evicts oldest-first once the cap is exceeded', async () => {
    const cache = new HotCache({ ttlMs: 30_000, maxEntries: 3 });
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      await cache.getOrLoad(`${id}:config`, async () => id);
    }
    expect(cache.stats().size).toBe(3);
    expect(cache.stats().evictions).toBe(2);
    expect(cache.get('a:config')).toBeUndefined();
    expect(cache.get('e:config')).toBe('e');
  });

  it('re-setting a key refreshes its place in the eviction order', () => {
    const cache = new HotCache({ ttlMs: 30_000, maxEntries: 2 });
    cache.set('a:config', 1);
    cache.set('b:config', 2);
    cache.set('a:config', 3); // touch a
    cache.set('c:config', 4); // must evict b, not a
    expect(cache.get('a:config')).toBe(3);
    expect(cache.get('b:config')).toBeUndefined();
  });
});

describe('roomsForTelegramMessage', () => {
  const room = (id: string, ...channelIds: string[]) => ({
    id,
    channels: channelIds.map((channelId) => ({ channelId })),
  });

  const rooms = [
    room('group', '-100123'),
    room('topic', '-100123:7'),
    room('both', '-100123', '-100123:7'),
    room('other', '-100999'),
  ];

  it('resolves a non-topic message by chat id alone', () => {
    expect(roomsForTelegramMessage(rooms, '-100123', null).map((r) => r.id)).toEqual([
      'group',
      'both',
    ]);
  });

  it('gives a topic message both its topic rooms and the parent-group rooms', () => {
    expect(roomsForTelegramMessage(rooms, '-100123', 7).map((r) => r.id)).toEqual([
      'group',
      'topic',
      'both',
    ]);
  });

  it('returns a room subscribed to both channels exactly once', () => {
    const ids = roomsForTelegramMessage(rooms, '-100123', 7).map((r) => r.id);
    expect(ids.filter((id) => id === 'both')).toHaveLength(1);
  });

  it('excludes a different topic in the same group', () => {
    expect(roomsForTelegramMessage([room('topic', '-100123:7')], '-100123', 8)).toEqual([]);
  });
});
