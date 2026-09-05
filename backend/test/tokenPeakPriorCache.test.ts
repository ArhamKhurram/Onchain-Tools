import { beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@oct/shared';
import {
  recordPeakHosted,
  resetHostedPeakCache,
  resetPeakListeners,
  onPeakRaised,
  type TokenPeak,
} from '../src/alerts/tokenPeakStore.js';

/**
 * Stub Supabase client that serves token_peaks rows and counts round-trips —
 * the measurement rig for the hosted prior-peak cache. Before the cache every
 * recordPeak cost 1 SELECT + 1 upsert; after it, steady-state observations
 * cost 1 upsert and only a first-sight token pays the read.
 */
function stubDb(existing: Record<string, { peak_mc: number; peak_at: string }>) {
  const stats = { selects: 0, upserts: 0, lastUpsert: null as Record<string, unknown> | null };
  let failSelect = false;
  let failUpsert = false;
  const db = {
    from(table: string) {
      if (table !== 'token_peaks') throw new Error(`unexpected table ${table}`);
      return {
        select() {
          const filters: Record<string, unknown> = {};
          const chain = {
            eq(col: string, val: unknown) {
              filters[col] = val;
              return chain;
            },
            maybeSingle() {
              stats.selects += 1;
              if (failSelect) return Promise.resolve({ data: null, error: { message: 'boom' } });
              const row = existing[`${filters.chain}:${filters.address}`] ?? null;
              return Promise.resolve({ data: row, error: null });
            },
          };
          return chain;
        },
        upsert(row: Record<string, unknown>) {
          stats.upserts += 1;
          stats.lastUpsert = row;
          if (failUpsert) return Promise.resolve({ error: { message: 'boom' } });
          existing[`${row.chain}:${row.address}`] = {
            peak_mc: row.peak_mc as number,
            peak_at: row.peak_at as string,
          };
          return Promise.resolve({ error: null });
        },
      };
    },
  } as unknown as SupabaseClient<Database>;
  return {
    db,
    stats,
    setFailSelect: (v: boolean) => (failSelect = v),
    setFailUpsert: (v: boolean) => (failUpsert = v),
  };
}

const obs = (mcNow: number, address = 'MintAAA') => ({
  address,
  chain: 'sol' as const,
  mcNow,
});

describe('recordPeakHosted prior-peak cache', () => {
  beforeEach(() => {
    resetHostedPeakCache();
    resetPeakListeners();
  });

  it('first sight of a token pays one SELECT + one upsert', async () => {
    const { db, stats } = stubDb({});
    await recordPeakHosted(db, obs(100), '2026-08-31T00:00:00.000Z');
    expect(stats.selects).toBe(1);
    expect(stats.upserts).toBe(1);
    expect(stats.lastUpsert?.peak_mc).toBe(100);
  });

  it('steady-state observations issue zero SELECTs', async () => {
    const { db, stats } = stubDb({});
    // 100 simulated observations of one token — before the cache this was
    // 100 SELECTs + 100 upserts; now 1 SELECT + 100 upserts.
    for (let i = 0; i < 100; i++) {
      await recordPeakHosted(db, obs(100 + i), `2026-08-31T00:00:${String(i).padStart(2, '0')}.000Z`);
    }
    expect(stats.selects).toBe(1);
    expect(stats.upserts).toBe(100);
    expect(stats.lastUpsert?.peak_mc).toBe(199);
  });

  it('max-upsert semantics survive the cache: a lower reading never lowers the peak', async () => {
    const { db, stats } = stubDb({});
    await recordPeakHosted(db, obs(500), '2026-08-31T00:00:00.000Z');
    await recordPeakHosted(db, obs(200), '2026-08-31T00:01:00.000Z');
    expect(stats.lastUpsert?.peak_mc).toBe(500);
    // peak_at stays pinned to the raise, last_mc tracks the reading.
    expect(stats.lastUpsert?.peak_at).toBe('2026-08-31T00:00:00.000Z');
    expect(stats.lastUpsert?.last_mc).toBe(200);
  });

  it('reads the DB prior on first sight and respects it', async () => {
    const { db, stats } = stubDb({
      'sol:mintaaa': { peak_mc: 900, peak_at: '2026-08-30T00:00:00.000Z' },
    });
    const raised: TokenPeak[] = [];
    onPeakRaised((p) => raised.push(p));

    await recordPeakHosted(db, obs(300), '2026-08-31T00:00:00.000Z');
    expect(stats.lastUpsert?.peak_mc).toBe(900);
    expect(stats.lastUpsert?.peak_at).toBe('2026-08-30T00:00:00.000Z');
    expect(raised).toHaveLength(0);

    await recordPeakHosted(db, obs(1000), '2026-08-31T00:01:00.000Z');
    expect(stats.lastUpsert?.peak_mc).toBe(1000);
    expect(raised).toHaveLength(1);
    expect(stats.selects).toBe(1);
  });

  it('caches per (chain, address) — an EVM and a SOL token never share a prior', async () => {
    const { db, stats } = stubDb({});
    await recordPeakHosted(db, { address: '0xAbC', chain: 'evm', evmChain: 'base', mcNow: 50 }, '2026-08-31T00:00:00.000Z');
    await recordPeakHosted(db, { address: '0xAbC', chain: 'sol', mcNow: 70 }, '2026-08-31T00:00:01.000Z');
    expect(stats.selects).toBe(2);
    expect(stats.lastUpsert?.peak_mc).toBe(70);
  });

  it('lowercases the address for both the read and the write', async () => {
    const { db, stats } = stubDb({
      'sol:mintaaa': { peak_mc: 900, peak_at: '2026-08-30T00:00:00.000Z' },
    });
    await recordPeakHosted(db, obs(100, 'MINTaaa'), '2026-08-31T00:00:00.000Z');
    expect(stats.selects).toBe(1);
    expect(stats.lastUpsert?.address).toBe('mintaaa');
    expect(stats.lastUpsert?.peak_mc).toBe(900);
  });

  it('a failed SELECT keeps write parity with the old path and stays coherent with the DB', async () => {
    const existing = {
      'sol:mintaaa': { peak_mc: 900, peak_at: '2026-08-30T00:00:00.000Z' },
    };
    const { db, stats, setFailSelect } = stubDb(existing);
    setFailSelect(true);
    await recordPeakHosted(db, obs(100), '2026-08-31T00:00:00.000Z');
    // Write parity with the old path: a failed read behaves like "no prior
    // row", so the upsert writes mcNow (yes — the pre-existing path can lower
    // a stored peak on a read failure; this change neither fixes nor worsens
    // that). The successful upsert then defines the row, and the cache holds
    // exactly what the DB holds.
    expect(stats.lastUpsert?.peak_mc).toBe(100);
    expect(existing['sol:mintaaa'].peak_mc).toBe(100);

    setFailSelect(false);
    await recordPeakHosted(db, obs(50), '2026-08-31T00:01:00.000Z');
    expect(stats.selects).toBe(1); // cache (100) mirrors the DB row it wrote
    expect(stats.lastUpsert?.peak_mc).toBe(100);
  });

  it('a failed SELECT followed by a failed upsert caches nothing — the next observation re-reads', async () => {
    const { db, stats, setFailSelect, setFailUpsert } = stubDb({
      'sol:mintaaa': { peak_mc: 900, peak_at: '2026-08-30T00:00:00.000Z' },
    });
    setFailSelect(true);
    setFailUpsert(true);
    await recordPeakHosted(db, obs(100), '2026-08-31T00:00:00.000Z');

    setFailSelect(false);
    setFailUpsert(false);
    await recordPeakHosted(db, obs(100), '2026-08-31T00:01:00.000Z');
    expect(stats.selects).toBe(2); // the blank was never trusted
    expect(stats.lastUpsert?.peak_mc).toBe(900);
  });

  it('a failed upsert leaves the cached prior intact (from the successful read)', async () => {
    const { db, stats, setFailUpsert } = stubDb({
      'sol:mintaaa': { peak_mc: 900, peak_at: '2026-08-30T00:00:00.000Z' },
    });
    setFailUpsert(true);
    await recordPeakHosted(db, obs(100), '2026-08-31T00:00:00.000Z');
    setFailUpsert(false);
    await recordPeakHosted(db, obs(100), '2026-08-31T00:01:00.000Z');
    // The read result was cached even though the first write failed.
    expect(stats.selects).toBe(1);
    expect(stats.lastUpsert?.peak_mc).toBe(900);
  });
});
