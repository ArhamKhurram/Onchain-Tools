import { describe, expect, it } from 'vitest';
import { SupabaseContext } from '../src/storage/supabase/client.js';
import { ConfigRepo } from '../src/storage/supabase/configRepo.js';
import { RoomsRepo } from '../src/storage/supabase/roomsRepo.js';
import { TokensRepo } from '../src/storage/supabase/tokensRepo.js';
import { TelegramRepo } from '../src/storage/supabase/telegramRepo.js';

/**
 * Round-trip budget for the hosted getConfig() cache-miss path.
 *
 * getConfig sits on every alert/notify path (pushover checks in the revival,
 * missed-runner, volume-death, fomo and callout pollers), the message-context
 * API and the config routes, behind a 10s TTL cache — so its cache-miss cost
 * recurs all day for every active user. Each fake-client query below is one
 * real PostgREST round-trip in production.
 *
 * The budget this pins:
 *  - `highlighted_users` and `keywords` are each fetched EXACTLY ONCE.
 *    getRooms' or-filter (`room_id.is.null,room_id.in.(...)`) already returns
 *    the global rows, so a second unfiltered fetch of both tables is pure
 *    duplicate egress (it was exactly that until this budget landed).
 *  - 8 queries total on a cache miss (was 10).
 *  - Independent loads run concurrently: with per-query latency the whole
 *    getConfig takes ~2 round-trips of wall time (rooms -> children is the
 *    only forced sequence), not ~7.
 */

const QUERY_LATENCY_MS = 20;

interface QueryLogEntry {
  table: string;
  startedAt: number;
}

const ROOM_ROWS = [
  {
    id: 'r1',
    name: 'alpha',
    color: null,
    filtered_users: [],
    filter_enabled: false,
    highlight_mode: 'background',
  },
  {
    id: 'r2',
    name: 'beta',
    color: '#ff0000',
    filtered_users: [],
    filter_enabled: false,
    highlight_mode: 'background',
  },
];

const TABLE_DATA: Record<string, unknown> = {
  user_configs: [{ settings: { contractDetection: false } }],
  discord_tokens: [],
  rooms: ROOM_ROWS,
  room_channels: [
    {
      room_id: 'r1',
      source: 'discord',
      guild_id: 'g1',
      channel_id: 'c1',
      guild_name: 'Guild',
      channel_name: 'general',
      disable_embeds: false,
    },
  ],
  highlighted_users: [
    { room_id: null, match_type: 'user_id', value: 'global-user', color: null },
    { room_id: 'r1', match_type: 'user_id', value: 'room-user', color: '#00ff00' },
  ],
  keywords: [
    { room_id: null, pattern: 'globalword', match_mode: 'includes', label: null, enabled: true },
    { room_id: 'r1', pattern: 'roomword', match_mode: 'includes', label: null, enabled: true },
  ],
  telegram_credentials: [],
  telegram_sessions: [],
};

function makeFakeClient(log: QueryLogEntry[]) {
  class Query {
    constructor(private table: string) {}
    select() { return this; }
    eq() { return this; }
    is() { return this; }
    in() { return this; }
    or() { return this; }
    order() { return this; }
    limit() { return this; }

    private exec(): Promise<{ data: unknown; error: null }> {
      log.push({ table: this.table, startedAt: Date.now() });
      const data = TABLE_DATA[this.table] ?? [];
      return new Promise((resolve) =>
        setTimeout(() => resolve({ data, error: null }), QUERY_LATENCY_MS),
      );
    }

    single(): Promise<{ data: unknown; error: unknown }> {
      return this.exec().then((r) => {
        const rows = r.data as unknown[];
        return rows.length === 1
          ? { data: rows[0], error: null }
          : { data: null, error: { message: 'expected single row' } };
      });
    }

    then<T>(
      resolve: (v: { data: unknown; error: null }) => T,
      reject?: (e: unknown) => T,
    ): Promise<T> {
      return this.exec().then(resolve, reject);
    }
  }

  return { from: (table: string) => new Query(table) };
}

function makeRepos() {
  const log: QueryLogEntry[] = [];
  const ctx = new SupabaseContext(makeFakeClient(log) as never);
  const config = new ConfigRepo(ctx);
  const rooms = new RoomsRepo(ctx);
  const tokens = new TokensRepo(ctx);
  const telegram = new TelegramRepo(ctx);
  config.rooms = rooms;
  config.tokens = tokens;
  config.telegram = telegram;
  rooms.config = config;
  return { config, rooms, log };
}

function countByTable(log: QueryLogEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of log) counts[entry.table] = (counts[entry.table] ?? 0) + 1;
  return counts;
}

describe('ConfigRepo.getConfig round-trip budget', () => {
  it('fetches highlighted_users and keywords exactly once on a cache miss', async () => {
    const { config, log } = makeRepos();
    await config.getConfig('u1');

    const counts = countByTable(log);
    expect(counts.highlighted_users).toBe(1);
    expect(counts.keywords).toBe(1);
    expect(counts.rooms).toBe(1);
    expect(counts.room_channels).toBe(1);
    expect(counts.user_configs).toBe(1);
    expect(counts.discord_tokens).toBe(1);
    expect(counts.telegram_credentials).toBe(1);
    expect(counts.telegram_sessions).toBe(1);
    expect(log.length).toBe(8);
  });

  it('still assembles global AND per-room highlight/keyword state from the single fetch', async () => {
    const { config } = makeRepos();
    const result = await config.getConfig('u1');

    // Globals come from the room_id-null rows.
    expect(result.globalHighlightedUsers).toEqual(['global-user']);
    expect(result.globalKeywordPatterns.map((p) => p.pattern)).toEqual(['globalword']);

    // Per-room state still lands on the right room.
    const r1 = result.rooms.find((r) => r.id === 'r1');
    const r2 = result.rooms.find((r) => r.id === 'r2');
    expect(r1?.highlightedUsers).toEqual(['room-user']);
    expect(r1?.keywordPatterns.map((p) => p.pattern)).toEqual(['roomword']);
    expect(r1?.channels).toHaveLength(1);
    expect(r2?.highlightedUsers).toEqual([]);
    expect(r2?.keywordPatterns).toEqual([]);

    // The settings blob merged over defaults.
    expect(result.contractDetection).toBe(false);
  });

  it('runs independent loads concurrently (~2 round-trips of wall time, not ~7)', async () => {
    const { config } = makeRepos();
    const start = Date.now();
    await config.getConfig('u1');
    const elapsed = Date.now() - start;

    // Two sequential stages (rooms -> room children) at QUERY_LATENCY_MS each,
    // plus scheduling slack. The old fully-sequential chain took 7 stages
    // (>= 140ms here); allow generous slack while still catching a regression
    // to sequential loading.
    expect(elapsed).toBeLessThan(QUERY_LATENCY_MS * 5);
  });

  it('serves the second call within the TTL from cache with zero queries', async () => {
    const { config, log } = makeRepos();
    await config.getConfig('u1');
    const afterMiss = log.length;
    await config.getConfig('u1');
    expect(log.length).toBe(afterMiss);
  });

  it('getRooms callers still get rooms (bundle seam stays compatible)', async () => {
    const { rooms } = makeRepos();
    const list = await rooms.getRooms('u1');
    expect(list.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(list[0]?.channels).toHaveLength(1);
  });

  it('zero-room users still get global rows without a crash', async () => {
    const roomsBackup = TABLE_DATA.rooms;
    const channelsBackup = TABLE_DATA.room_channels;
    TABLE_DATA.rooms = [];
    TABLE_DATA.room_channels = [];
    try {
      const { config } = makeRepos();
      const result = await config.getConfig('u1');
      expect(result.rooms).toEqual([]);
      expect(result.globalHighlightedUsers).toEqual(['global-user']);
      expect(result.globalKeywordPatterns.map((p) => p.pattern)).toEqual(['globalword']);
    } finally {
      TABLE_DATA.rooms = roomsBackup;
      TABLE_DATA.room_channels = channelsBackup;
    }
  });
});
