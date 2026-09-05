import { describe, expect, it } from 'vitest';
import { ContractsRepo } from '../src/storage/supabase/contractsRepo.js';
import type { SupabaseContext } from '../src/storage/supabase/client.js';
import type { ContractEntry } from '../src/utils/contractLog.js';

/**
 * Column budget for logContract's repeat-mention carry-forward lookup.
 *
 * Every repeat mention of a known address (the common case on a busy feed)
 * used to re-read the full prior row — select('*') dragging author/channel/
 * guild strings, room_ids, message_id and ids across the wire (representative
 * row: 1132B) when the carry-forward block reads only the 16 enrichment
 * columns (518B). This pins:
 *
 *  - the prior lookup never selects '*',
 *  - carry-forward semantics are unchanged (prior enrichment fills the gaps,
 *    fdv_at_call is NOT carried — it is per-call),
 *  - the pre-migration global-first tolerance now also covers the SELECT: a
 *    database without 20260812160000_network_scans.sql rejects a select
 *    naming first_call columns, and the lookup retries without them.
 */

const MISSING_COLUMN_ERROR = {
  message: 'column contracts.first_caller_name does not exist',
};

const PRIOR_ROW = {
  token_name: 'Example Meme Token',
  token_symbol: 'EXMPL',
  token_pair: 'EXMPL/SOL',
  description: 'prior description',
  liquidity_usd: 98765.43,
  liquidity_display: '98.8K',
  volume_usd: 456789.01,
  volume_display: '456.8K',
  price_usd: 0.00123456,
  token_age: '2h',
  enrichment_source: 'gmgn',
  enriched_at: '2026-08-31T04:05:10.000Z',
  evm_chain: null,
  fdv_at_call: 999_999, // present in DB; must NOT be carried forward
  first_caller_name: 'espadabtw',
  first_call_mcap_usd: 49300,
  first_call_at: '2026-08-30T11:22:33.000Z',
};

function makeClient(opts: { firstCallColumnsMissing: boolean }) {
  const selects: string[] = [];
  const guardSelects: string[] = [];
  const inserts: Record<string, unknown>[] = [];

  class Query {
    private op: 'select' | 'insert' = 'select';
    private columns = '';
    private payload?: Record<string, unknown>;
    private head = false;
    private filters: string[] = [];

    select(cols?: string, options?: { head?: boolean }) {
      if (options?.head) this.head = true;
      this.columns = cols ?? '';
      return this;
    }
    insert(row: Record<string, unknown>) {
      this.op = 'insert';
      this.payload = row;
      return this;
    }
    eq(col?: string) { if (col) this.filters.push(col); return this; }
    ilike() { return this; }
    or() { return this; }
    order() { return this; }
    limit() { return this; }

    then<T>(resolve: (v: { data: unknown; error: unknown; count?: number }) => T, reject?: (e: unknown) => T) {
      let result: { data: unknown; error: unknown; count?: number };
      if (this.op === 'insert') {
        inserts.push({ ...this.payload });
        result = { data: null, error: null };
      } else if (this.head) {
        // hasAddress: the address is known -> repeat-mention path.
        result = { data: null, error: null, count: 1 };
      } else if (this.filters.includes('message_id')) {
        // The duplicate-call guard. This entry's own message has not been
        // logged before, so it finds nothing and logging proceeds.
        guardSelects.push(this.columns);
        result = { data: [], error: null };
      } else {
        selects.push(this.columns);
        if (opts.firstCallColumnsMissing && /first_call/.test(this.columns)) {
          result = { data: null, error: MISSING_COLUMN_ERROR };
        } else {
          // Project like PostgREST: only the requested columns come back.
          const requested = this.columns.split(',').map((c) => c.trim());
          const projected = Object.fromEntries(
            Object.entries(PRIOR_ROW).filter(([key]) => requested.includes(key)),
          );
          result = { data: [projected], error: null };
        }
      }
      return Promise.resolve(result).then(resolve, reject);
    }
  }

  const client = { from: (_table: string) => new Query() };
  return { client, selects, guardSelects, inserts };
}

function makeRepo(opts: { firstCallColumnsMissing: boolean }) {
  const { client, selects, guardSelects, inserts } = makeClient(opts);
  const repo = new ContractsRepo({ supabase: client } as unknown as SupabaseContext);
  return { repo, selects, guardSelects, inserts };
}

const REPEAT_ENTRY: ContractEntry = {
  address: 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  chain: 'sol',
  authorId: 'a2',
  authorName: 'second-caller',
  channelId: 'c2',
  channelName: 'beta',
  guildId: null,
  guildName: null,
  roomIds: ['r2'],
  messageId: 'm9',
  timestamp: '2026-08-31T05:00:00.000Z',
};

describe('logContract prior-row lookup column budget', () => {
  it('never selects "*" for the prior row (nor for the duplicate-call guard)', async () => {
    const { repo, selects, guardSelects } = makeRepo({ firstCallColumnsMissing: false });
    await repo.logContract('u1', REPEAT_ENTRY);
    expect(selects.length).toBeGreaterThan(0);
    expect(guardSelects.length).toBeGreaterThan(0);
    for (const cols of [...selects, ...guardSelects]) {
      expect(cols).not.toBe('*');
      expect(cols).not.toContain('author_name');
      expect(cols).not.toContain('room_ids');
    }
  });

  it('still carries prior enrichment onto the repeat mention (fdv_at_call excluded)', async () => {
    const { repo, inserts } = makeRepo({ firstCallColumnsMissing: false });
    const logged = await repo.logContract('u1', REPEAT_ENTRY);

    expect(logged.tokenSymbol).toBe('EXMPL');
    expect(logged.tokenName).toBe('Example Meme Token');
    expect(logged.description).toBe('prior description');
    expect(logged.liquidityUsd).toBeCloseTo(98765.43);
    expect(logged.enrichmentSource).toBe('gmgn');
    expect(logged.firstCallerName).toBe('espadabtw');
    expect(logged.firstCallMcapUsd).toBe(49300);
    // fdv is per-call: the DB row had one, the new mention must not inherit it.
    expect(logged.fdvAtCall).toBeUndefined();
    expect(logged.firstSeen).toBe(false);

    expect(inserts).toHaveLength(1);
    expect(inserts[0].token_symbol).toBe('EXMPL');
    expect(inserts[0].fdv_at_call).toBeNull();
    // The new mention's own identity fields are untouched by the carry.
    expect(inserts[0].author_name).toBe('second-caller');
    expect(inserts[0].message_id).toBe('m9');
  });

  it('retries the lookup without the global-first columns pre-migration', async () => {
    const { repo, selects } = makeRepo({ firstCallColumnsMissing: true });
    const logged = await repo.logContract('u1', REPEAT_ENTRY);

    // First attempt names the first_call columns, the retry does not.
    expect(selects).toHaveLength(2);
    expect(selects[0]).toContain('first_caller_name');
    expect(selects[1]).not.toContain('first_call');

    // Carry-forward of everything else still works.
    expect(logged.tokenSymbol).toBe('EXMPL');
    expect(logged.firstCallerName).toBeUndefined();
  });
});
