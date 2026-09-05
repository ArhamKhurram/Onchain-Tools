import { describe, expect, it } from 'vitest';
import { ContractsRepo } from '../src/storage/supabase/contractsRepo.js';
import type { SupabaseContext } from '../src/storage/supabase/client.js';

/**
 * MC@call was blank on ~22% of production rows long after the repeat-mention
 * fix (#88), and the blanks were not spread evenly: in a 24h production window
 * 1,874 of 1,878 of them sat in a group of rows sharing one
 * (user_id, message_id, address), and 2,258 of the 2,295 such groups already
 * held a sibling carrying the very FDV the blank rows were missing. Singleton
 * groups were 99.96% filled.
 *
 * The cause was not the fetch. `logContract` is an unconditional INSERT and the
 * Telegram update stream re-delivers a message after a reconnect or an
 * update-gap recovery, so one call becomes several rows; `enrichContract`
 * resolved exactly one of them and wrote by primary key, and nothing ever
 * revisits a row once its 8s/15s timer has fired.
 *
 * These tests pin the fan-out, and the lookup change that keeps it reachable
 * for duplicates that arrive after a sibling has already been enriched.
 */

type Row = Record<string, unknown>;

function blankRow(id: string, overrides: Row = {}): Row {
  return {
    id,
    user_id: 'u1',
    address: '0xAbC0000000000000000000000000000000000001',
    chain: 'evm',
    evm_chain: 'robinhood',
    author_id: 'a1',
    author_name: 'caller',
    channel_id: 'c1',
    channel_name: 'calls',
    guild_id: null,
    guild_name: null,
    room_ids: ['r1'],
    message_id: 'tg_-100_42555',
    timestamp: '2026-09-04T13:12:50.000Z',
    first_seen: false,
    token_name: 'Ponsi',
    token_symbol: 'PONSI',
    token_pair: null,
    description: null,
    fdv_at_call: null,
    fdv_at_call_display: null,
    liquidity_usd: null,
    liquidity_display: null,
    volume_usd: null,
    volume_display: null,
    price_usd: null,
    token_age: null,
    enrichment_source: 'gmgn',
    enriched_at: null,
    ...overrides,
  };
}

function makeRepo(rows: Row[]) {
  const updates: { ids: string[]; payload: Row }[] = [];

  class Query {
    private op: 'select' | 'update' = 'select';
    private payload: Row = {};
    private eqs: [string, unknown][] = [];
    private ilikes: [string, string][] = [];
    private limitN: number | null = null;
    private single = false;
    private sort: { col: string; asc: boolean } | null = null;

    select() { return this; }
    update(payload: Row) { this.op = 'update'; this.payload = payload; return this; }
    eq(col: string, val: unknown) { this.eqs.push([col, val]); return this; }
    ilike(col: string, val: string) { this.ilikes.push([col, val]); return this; }
    order(col: string, opts?: { ascending?: boolean }) {
      this.sort = { col, asc: opts?.ascending !== false };
      return this;
    }
    limit(n: number) { this.limitN = n; return this; }
    maybeSingle() { this.single = true; return this; }

    private matched(): Row[] {
      const hit = rows.filter((r) =>
        this.eqs.every(([c, v]) => r[c] === v)
        && this.ilikes.every(([c, v]) => String(r[c]).toLowerCase() === String(v).toLowerCase()));
      if (this.sort) {
        const { col, asc } = this.sort;
        hit.sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
      }
      return this.limitN == null ? hit : hit.slice(0, this.limitN);
    }

    then<T>(resolve: (v: { data: unknown; error: unknown }) => T, reject?: (e: unknown) => T) {
      const hit = this.matched();
      if (this.op === 'update') {
        for (const r of hit) Object.assign(r, this.payload);
        updates.push({ ids: hit.map((r) => String(r.id)), payload: this.payload });
      }
      const data = this.single ? (hit[0] ?? null) : hit;
      return Promise.resolve({ data, error: null }).then(resolve, reject);
    }
  }

  const client = { from: (_table: string) => new Query() };
  const repo = new ContractsRepo({ supabase: client } as unknown as SupabaseContext);
  return { repo, updates };
}

const ADDRESS = '0xabc0000000000000000000000000000000000001';
const MESSAGE_ID = 'tg_-100_42555';
const PATCH = {
  tokenSymbol: 'PONSI',
  fdvAtCall: 36_123,
  fdvAtCallDisplay: '36.1K',
  enrichmentSource: 'dexscreener' as const,
};

describe('enrichContract fan-out across duplicate rows of one call', () => {
  it('writes the MC@call to every row sharing (user_id, message_id, address)', async () => {
    const rows = [blankRow('r-1'), blankRow('r-2'), blankRow('r-3')];
    const { repo } = makeRepo(rows);

    await repo.enrichContract('u1', ADDRESS, PATCH, { channelId: 'c1', messageId: MESSAGE_ID });

    expect(rows.map((r) => r.fdv_at_call)).toEqual([36_123, 36_123, 36_123]);
    expect(rows.map((r) => r.fdv_at_call_display)).toEqual(['36.1K', '36.1K', '36.1K']);
  });

  it('still returns the representative row so the WS broadcast is unchanged', async () => {
    const { repo } = makeRepo([blankRow('r-1'), blankRow('r-2')]);

    const updated = await repo.enrichContract('u1', ADDRESS, PATCH, { messageId: MESSAGE_ID });

    expect(updated?.fdvAtCall).toBe(36_123);
    expect(updated?.messageId).toBe(MESSAGE_ID);
  });

  // The by-primary-key write is what fixed the PGRST116 crash (a
  // (user_id, message_id, address) update matches several rows and `.single()`
  // rejects that). Fanning out must add writes, never widen one.
  it('writes each row by its own primary key, one update per row', async () => {
    const { repo, updates } = makeRepo([blankRow('r-1'), blankRow('r-2'), blankRow('r-3')]);

    await repo.enrichContract('u1', ADDRESS, PATCH, { messageId: MESSAGE_ID });

    expect(updates).toHaveLength(3);
    expect(updates.flatMap((u) => u.ids).sort()).toEqual(['r-1', 'r-2', 'r-3']);
    for (const u of updates) expect(u.ids).toHaveLength(1);
  });

  it('leaves rows belonging to another call alone', async () => {
    const other = blankRow('r-other', { message_id: 'tg_-100_99999' });
    const rows = [blankRow('r-1'), other];
    const { repo } = makeRepo(rows);

    await repo.enrichContract('u1', ADDRESS, PATCH, { messageId: MESSAGE_ID });

    expect(rows[0].fdv_at_call).toBe(36_123);
    expect(other.fdv_at_call).toBeNull();
  });

  // mergeEnrichmentPatch is authority-ordered per row, so the fan-out must run
  // the merge for each sibling rather than stamping one merged result onto all
  // of them: a sibling Rick already priced keeps its own number.
  it('merges per row, so a sibling Rick already priced keeps its FDV', async () => {
    const rick = blankRow('r-rick', { enrichment_source: 'rick', fdv_at_call: 51_000 });
    const rows = [blankRow('r-1'), rick];
    const { repo } = makeRepo(rows);

    await repo.enrichContract('u1', ADDRESS, PATCH, { messageId: MESSAGE_ID });

    expect(rows[0].fdv_at_call).toBe(36_123);
    expect(rick.fdv_at_call).toBe(51_000);
  });
});

describe('getContractByMessage picks the row the fallback can still help', () => {
  it('prefers a still-blank duplicate over an already-enriched sibling', async () => {
    const filled = blankRow('r-filled', {
      fdv_at_call: 36_123,
      timestamp: '2026-09-04T13:12:59.000Z',
    });
    const { repo } = makeRepo([filled, blankRow('r-blank')]);

    const hit = await repo.getContractByMessage('u1', MESSAGE_ID, ADDRESS);

    // Newest-first ordering would have returned r-filled, whose full symbol +
    // FDV makes resolveFallbackTarget skip — leaving r-blank never priced.
    expect(hit?.fdvAtCall).toBeUndefined();
  });

  it('falls back to the newest row when every duplicate is already complete', async () => {
    const { repo } = makeRepo([
      blankRow('r-old', { fdv_at_call: 100, timestamp: '2026-09-04T13:12:50.000Z' }),
      blankRow('r-new', { fdv_at_call: 200, timestamp: '2026-09-04T13:12:59.000Z' }),
    ]);

    const hit = await repo.getContractByMessage('u1', MESSAGE_ID, ADDRESS);

    expect(hit?.fdvAtCall).toBe(200);
  });

  it('returns null when the message logged no such address', async () => {
    const { repo } = makeRepo([blankRow('r-1')]);
    expect(await repo.getContractByMessage('u1', 'tg_-100_00000', ADDRESS)).toBeNull();
  });
});
