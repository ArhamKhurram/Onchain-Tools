import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ActivityCursorCache, type ActivityCursorRow } from '../src/fomo/dispatch.js';

/**
 * Stub Supabase client that serves fomo_activity_cursors rows and counts
 * SELECTs — the "measurement rig" for the cursor cache: before the cache the
 * poller issued one SELECT per tick, after it steady-state ticks issue zero.
 */
function stubDb(rows: ActivityCursorRow[]) {
  const stats = { selects: 0, lastIds: [] as string[] };
  const db = {
    from(table: string) {
      if (table !== 'fomo_activity_cursors') throw new Error(`unexpected table ${table}`);
      return {
        select() {
          return {
            in(_col: string, ids: string[]) {
              stats.selects += 1;
              stats.lastIds = ids;
              return Promise.resolve({
                data: rows.filter((r) => ids.includes(r.fomo_user_id)),
                error: null,
              });
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { db, stats };
}

const row = (id: string, cursor: string | null): ActivityCursorRow => ({
  fomo_user_id: id,
  last_activity_id: cursor,
  cursor_seeded: true,
});

describe('ActivityCursorCache', () => {
  it('first load queries the DB once for all requested ids', async () => {
    const { db, stats } = stubDb([row('a', 'x1'), row('b', 'x2')]);
    const cache = new ActivityCursorCache();

    const cursors = await cache.load(db, ['a', 'b']);
    expect(stats.selects).toBe(1);
    expect(stats.lastIds).toEqual(['a', 'b']);
    expect(cursors.get('a')?.last_activity_id).toBe('x1');
    expect(cursors.get('b')?.last_activity_id).toBe('x2');
  });

  it('steady-state loads issue zero DB queries', async () => {
    const { db, stats } = stubDb([row('a', 'x1'), row('b', 'x2')]);
    const cache = new ActivityCursorCache();

    await cache.load(db, ['a', 'b']);
    // 100 simulated ticks — before the cache this was 100 SELECTs.
    for (let i = 0; i < 100; i++) {
      const cursors = await cache.load(db, ['a', 'b']);
      expect(cursors.get('a')?.last_activity_id).toBe('x1');
    }
    expect(stats.selects).toBe(1);
  });

  it('a newly tracked trader triggers one query for just that id', async () => {
    const { db, stats } = stubDb([row('a', 'x1'), row('c', 'x3')]);
    const cache = new ActivityCursorCache();

    await cache.load(db, ['a']);
    const cursors = await cache.load(db, ['a', 'c']);
    expect(stats.selects).toBe(2);
    expect(stats.lastIds).toEqual(['c']);
    expect(cursors.get('c')?.last_activity_id).toBe('x3');
  });

  it('does not re-query ids known to have no row (unseeded traders)', async () => {
    const { db, stats } = stubDb([]);
    const cache = new ActivityCursorCache();

    const first = await cache.load(db, ['fresh']);
    expect(first.has('fresh')).toBe(false);
    await cache.load(db, ['fresh']);
    await cache.load(db, ['fresh']);
    expect(stats.selects).toBe(1);
  });

  it('noteUpserted mirrors the poller write without a DB read', async () => {
    const { db, stats } = stubDb([]);
    const cache = new ActivityCursorCache();

    await cache.load(db, ['a']);
    cache.noteUpserted('a', 'newest-1', true);

    const cursors = await cache.load(db, ['a']);
    expect(stats.selects).toBe(1);
    expect(cursors.get('a')).toEqual({
      fomo_user_id: 'a',
      last_activity_id: 'newest-1',
      cursor_seeded: true,
    });
  });

  it('noteUpserted on a never-loaded id marks it known', async () => {
    const { db, stats } = stubDb([]);
    const cache = new ActivityCursorCache();

    cache.noteUpserted('a', 'n1', true);
    const cursors = await cache.load(db, ['a']);
    expect(stats.selects).toBe(0);
    expect(cursors.get('a')?.last_activity_id).toBe('n1');
  });
});
