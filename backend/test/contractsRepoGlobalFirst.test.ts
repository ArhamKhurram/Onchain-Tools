import { describe, expect, it } from 'vitest';
import { ContractsRepo } from '../src/storage/supabase/contractsRepo.js';
import type { SupabaseContext } from '../src/storage/supabase/client.js';
import type { ContractEntry } from '../src/utils/contractLog.js';

/**
 * Missing-column fallback for the global-first columns (the revival #123
 * pattern): 20260812160000_network_scans.sql is applied by hand, so backend
 * code that writes first_caller_name / first_call_mcap_usd / first_call_at
 * can reach prod before the columns exist. Writes must retry once without
 * them instead of failing the user's own contract logging/enrichment.
 */

const MISSING_COLUMN_ERROR = {
  message: "Could not find the 'first_caller_name' column of 'contracts' in the schema cache",
};

const EXISTING_ROW = {
  id: 'row-1',
  user_id: 'u1',
  address: 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  chain: 'sol',
  author_id: 'a1',
  author_name: 'caller',
  channel_id: 'c1',
  channel_name: 'alpha',
  guild_id: null,
  guild_name: null,
  room_ids: ['r1'],
  message_id: 'm1',
  timestamp: '2026-08-12T12:00:00.000Z',
};

function makeClient(opts: { columnsMissing: boolean }) {
  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];

  const hasFirstCallKey = (row: Record<string, unknown>) =>
    'first_caller_name' in row || 'first_call_mcap_usd' in row || 'first_call_at' in row;

  class Query {
    private op: 'select' | 'insert' | 'update' = 'select';
    private payload?: Record<string, unknown>;
    private head = false;
    private columns = '';
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
    update(row: Record<string, unknown>) {
      this.op = 'update';
      this.payload = row;
      return this;
    }
    eq(col?: string) { if (col) this.filters.push(col); return this; }
    ilike() { return this; }
    is() { return this; }
    gte() { return this; }
    or() { return this; }
    order() { return this; }
    limit() { return this; }

    private exec(): { data: unknown; error: unknown; count?: number } {
      if (this.op === 'insert') {
        inserts.push({ ...this.payload });
        if (opts.columnsMissing && hasFirstCallKey(this.payload ?? {})) {
          return { data: null, error: MISSING_COLUMN_ERROR };
        }
        return { data: null, error: null };
      }
      if (this.op === 'update') {
        updates.push({ ...this.payload });
        if (opts.columnsMissing && hasFirstCallKey(this.payload ?? {})) {
          return { data: null, error: MISSING_COLUMN_ERROR };
        }
        return { data: { ...EXISTING_ROW, ...this.payload }, error: null };
      }
      if (this.head) return { data: null, error: null, count: 0 };
      // The duplicate-call guard in logContract: a column-scoped select keyed
      // on message_id. These entries are new calls, so it finds nothing.
      // (enrichContract also filters on message_id, but selects '*'.)
      if (this.columns !== '*' && this.filters.includes('message_id')) {
        return { data: [], error: null };
      }
      return { data: [EXISTING_ROW], error: null };
    }

    maybeSingle() {
      const r = this.exec();
      const data = Array.isArray(r.data) ? r.data[0] ?? null : r.data;
      return Promise.resolve({ data, error: r.error });
    }

    then<T>(resolve: (v: { data: unknown; error: unknown; count?: number }) => T, reject?: (e: unknown) => T) {
      return Promise.resolve(this.exec()).then(resolve, reject);
    }
  }

  const client = { from: (_table: string) => new Query() };
  return { client, inserts, updates };
}

function makeRepo(opts: { columnsMissing: boolean }) {
  const { client, inserts, updates } = makeClient(opts);
  const repo = new ContractsRepo({ supabase: client } as unknown as SupabaseContext);
  return { repo, inserts, updates };
}

const ENTRY: ContractEntry = {
  address: EXISTING_ROW.address,
  chain: 'sol',
  authorId: 'a1',
  authorName: 'caller',
  channelId: 'c1',
  channelName: 'alpha',
  guildId: null,
  guildName: null,
  roomIds: ['r1'],
  messageId: 'm2',
  timestamp: '2026-08-12T12:05:00.000Z',
  firstCallerName: 'espadabtw',
  firstCallMcapUsd: 49_300,
  firstCallAt: '2026-08-12T02:00:00.000Z',
};

describe('ContractsRepo — global-first missing-column fallback', () => {
  it('logContract writes the columns on the happy path', async () => {
    const { repo, inserts } = makeRepo({ columnsMissing: false });
    await repo.logContract('u1', ENTRY);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].first_caller_name).toBe('espadabtw');
    expect(inserts[0].first_call_mcap_usd).toBe(49_300);
    expect(inserts[0].first_call_at).toBe('2026-08-12T02:00:00.000Z');
  });

  it('logContract omits the columns entirely when the entry has no global-first data', async () => {
    const { repo, inserts } = makeRepo({ columnsMissing: true });
    const { firstCallerName: _n, firstCallMcapUsd: _m, firstCallAt: _t, ...bare } = ENTRY;
    await repo.logContract('u1', bare as ContractEntry);
    // No first_call key was ever named, so the pre-migration DB never errors.
    expect(inserts).toHaveLength(1);
    expect('first_caller_name' in inserts[0]).toBe(false);
  });

  it('logContract retries once without the columns in the deploy→migrate window', async () => {
    const { repo, inserts } = makeRepo({ columnsMissing: true });
    const logged = await repo.logContract('u1', ENTRY);
    expect(inserts).toHaveLength(2);
    expect('first_caller_name' in inserts[0]).toBe(true);
    expect('first_caller_name' in inserts[1]).toBe(false);
    expect('first_call_mcap_usd' in inserts[1]).toBe(false);
    expect('first_call_at' in inserts[1]).toBe(false);
    // Nothing else was dropped from the row.
    expect(inserts[1].address).toBe(ENTRY.address);
    expect(inserts[1].message_id).toBe('m2');
    expect(logged.firstSeen).toBe(true);
  });

  it('enrichContract retries once without the columns and still applies the rest', async () => {
    const { repo, updates } = makeRepo({ columnsMissing: true });
    const updated = await repo.enrichContract(
      'u1',
      ENTRY.address,
      {
        tokenSymbol: 'MELON',
        fdvAtCall: 816_000,
        enrichmentSource: 'rick',
        firstCallerName: 'espadabtw',
        firstCallMcapUsd: 49_300,
        firstCallAt: '2026-08-12T02:00:00.000Z',
      },
      { messageId: 'm1' },
    );
    expect(updates).toHaveLength(2);
    expect('first_caller_name' in updates[0]).toBe(true);
    expect('first_caller_name' in updates[1]).toBe(false);
    expect(updates[1].token_symbol).toBe('MELON');
    expect(updates[1].fdv_at_call).toBe(816_000);
    expect(updated?.tokenSymbol).toBe('MELON');
  });

  it('enrichContract keeps the columns once the migration is applied', async () => {
    const { repo, updates } = makeRepo({ columnsMissing: false });
    const updated = await repo.enrichContract(
      'u1',
      ENTRY.address,
      {
        enrichmentSource: 'rick',
        firstCallerName: 'espadabtw',
        firstCallMcapUsd: 49_300,
        firstCallAt: '2026-08-12T02:00:00.000Z',
      },
      { messageId: 'm1' },
    );
    expect(updates).toHaveLength(1);
    expect(updates[0].first_caller_name).toBe('espadabtw');
    expect(updated?.firstCallerName).toBe('espadabtw');
    expect(updated?.firstCallMcapUsd).toBe(49_300);
  });
});
