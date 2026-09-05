import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ContractsRepo } from '../src/storage/supabase/contractsRepo.js';
import type { SupabaseContext } from '../src/storage/supabase/client.js';
import type { ContractEntry } from '../src/utils/contractLog.js';

/**
 * One call = one row.
 *
 * `logContract` was an unconditional INSERT, and the Telegram update stream
 * re-delivers a message after a reconnect or an update-gap recovery — so one
 * call landed as 2-16 rows sharing (user_id, message_id, address). Measured
 * over a 24h production window: 43% of ALL contract rows sat in such a group,
 * and 6,671 of 6,905 Telegram rows (97%) did. Those inflated rows are what the
 * caller/radar call counts are computed over.
 *
 * `TelegramClientManager` does dedupe re-deliveries, but on a 10-second window,
 * and the measured gap between two duplicate INSERTs of the same call is a
 * median of ~116s (p90 ~31min, p99 ~2.1h, max ~2.9h). That window catches
 * 18.7% of them; a 2h window would still miss ~2%. The tail is unbounded, so
 * the guard has to be keyed on the identity of the call rather than on time —
 * which is what these tests pin, at 5s, at the measured median, and at an hour.
 *
 * Both storage backends are covered: the hosted Supabase repo and the local
 * JSON log. A Postgres-only fix would silently no-op on the desktop app.
 */

const ADDRESS = 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const MESSAGE_ID = 'tg_-1002345678_9911';

function call(overrides: Partial<ContractEntry> = {}): ContractEntry {
  return {
    address: ADDRESS,
    chain: 'sol',
    authorId: 'a1',
    authorName: 'caller',
    channelId: 'c1',
    channelName: 'calls',
    guildId: null,
    guildName: null,
    roomIds: ['r1'],
    messageId: MESSAGE_ID,
    timestamp: '2026-09-05T10:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Hosted (Supabase)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

/**
 * A fake PostgREST that keeps a real row array, so a second `logContract` of
 * the same call sees what the first one wrote. Matching mirrors the repo:
 * `eq` on the listed columns, `ilike` folded to case-insensitive equality.
 */
function makeRepo(seed: Row[] = []) {
  const rows: Row[] = [...seed];
  const inserts: Row[] = [];
  let nextId = seed.length + 1;
  let uniqueIndexApplied = false;

  class Query {
    private op: 'select' | 'insert' | 'update' = 'select';
    private columns = '';
    private payload?: Row;
    private head = false;
    private eqs: [string, unknown][] = [];
    private ilikes: [string, string][] = [];

    select(cols?: string, options?: { head?: boolean }) {
      if (options?.head) this.head = true;
      this.columns = cols ?? '';
      return this;
    }
    insert(row: Row) {
      this.op = 'insert';
      this.payload = row;
      return this;
    }
    update(row: Row) {
      this.op = 'update';
      this.payload = row;
      return this;
    }
    eq(col: string, val: unknown) { this.eqs.push([col, val]); return this; }
    ilike(col: string, val: string) { this.ilikes.push([col, val]); return this; }
    or() { return this; }
    order() { return this; }
    limit() { return this; }

    private matches(): Row[] {
      return rows.filter((row) => {
        for (const [col, val] of this.eqs) if (row[col] !== val) return false;
        for (const [col, val] of this.ilikes) {
          if (String(row[col] ?? '').toLowerCase() !== val.toLowerCase()) return false;
        }
        return true;
      });
    }

    private exec(): { data: unknown; error: unknown; count?: number } {
      if (this.op === 'insert') {
        const row = this.payload as Row;
        const clash = rows.some(
          (r) =>
            r.user_id === row.user_id &&
            r.message_id === row.message_id &&
            r.chain === row.chain &&
            String(r.address).toLowerCase() === String(row.address).toLowerCase(),
        );
        if (uniqueIndexApplied && clash) {
          return {
            data: null,
            error: { code: '23505', message: 'duplicate key value violates unique constraint "contracts_one_row_per_call"' },
          };
        }
        const stored = { id: `row-${nextId++}`, ...row };
        rows.push(stored);
        inserts.push(stored);
        return { data: null, error: null };
      }
      if (this.op === 'update') {
        const matched = this.matches();
        for (const row of matched) Object.assign(row, this.payload);
        return { data: matched, error: null };
      }
      const matched = this.matches();
      if (this.head) return { data: null, error: null, count: matched.length };
      return { data: matched, error: null };
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
  const repo = new ContractsRepo({ supabase: client } as unknown as SupabaseContext);
  return {
    repo,
    rows,
    inserts,
    applyUniqueIndex() { uniqueIndexApplied = true; },
  };
}

const MINUTE = 60_000;

function laterBy(ms: number): string {
  return new Date(Date.parse('2026-09-05T10:00:00.000Z') + ms).toISOString();
}

describe('logContract is idempotent per call — hosted (Supabase)', () => {
  it('logs the first delivery of a call', async () => {
    const { repo, inserts } = makeRepo();
    const logged = await repo.logContract('u1', call());
    expect(inserts).toHaveLength(1);
    expect(logged.firstSeen).toBe(true);
  });

  it('drops a re-delivery inside the old 10s dedupe window', async () => {
    const { repo, inserts } = makeRepo();
    await repo.logContract('u1', call());
    const again = await repo.logContract('u1', call({ timestamp: laterBy(5_000) }));
    expect(inserts).toHaveLength(1);
    expect(again.messageId).toBe(MESSAGE_ID);
  });

  it('drops a re-delivery at the measured median gap (~2 min)', async () => {
    const { repo, inserts } = makeRepo();
    await repo.logContract('u1', call());
    await repo.logContract('u1', call({ timestamp: laterBy(2 * MINUTE) }));
    expect(inserts).toHaveLength(1);
  });

  it('drops a re-delivery an hour later (past any affordable time window)', async () => {
    const { repo, inserts } = makeRepo();
    await repo.logContract('u1', call());
    await repo.logContract('u1', call({ timestamp: laterBy(60 * MINUTE) }));
    expect(inserts).toHaveLength(1);
  });

  it('survives a 16-fold re-delivery burst spread over three hours', async () => {
    const { repo, inserts } = makeRepo();
    for (let i = 0; i < 16; i++) {
      await repo.logContract('u1', call({ timestamp: laterBy(i * 11 * MINUTE) }));
    }
    expect(inserts).toHaveLength(1);
  });

  it('hands the stored enrichment back to the suppressed duplicate', async () => {
    const { repo } = makeRepo();
    await repo.logContract('u1', call());
    // The first row gets priced by the Dex fallback seconds later.
    await repo.enrichContract('u1', ADDRESS, { tokenSymbol: 'EXMPL', fdvAtCall: 816_000 }, { messageId: MESSAGE_ID });

    const duplicate = await repo.logContract('u1', call({ timestamp: laterBy(2 * MINUTE) }));
    expect(duplicate.tokenSymbol).toBe('EXMPL');
    // fdv_at_call is per-CALL and never carried onto a repeat mention — but a
    // duplicate IS the same call, so it must carry the same price.
    expect(duplicate.fdvAtCall).toBe(816_000);
    expect(duplicate.firstSeen).toBe(true);
  });

  it('still logs a genuinely different call of the same address', async () => {
    const { repo, inserts } = makeRepo();
    await repo.logContract('u1', call());
    const second = await repo.logContract('u1', call({ messageId: 'tg_-1002345678_9912', authorName: 'other-caller' }));
    expect(inserts).toHaveLength(2);
    expect(second.firstSeen).toBe(false);
  });

  it('does not suppress across users', async () => {
    const { repo, inserts } = makeRepo();
    await repo.logContract('u1', call());
    await repo.logContract('u2', call());
    expect(inserts).toHaveLength(2);
  });

  it('folds EVM address casing, and keeps Solana base58 case-sensitive', async () => {
    const evm = makeRepo();
    const base = call({ address: '0xAbC0000000000000000000000000000000000001', chain: 'evm' });
    await evm.repo.logContract('u1', base);
    await evm.repo.logContract('u1', { ...base, address: base.address.toLowerCase() });
    expect(evm.inserts).toHaveLength(1);

    const sol = makeRepo();
    await sol.repo.logContract('u1', call());
    await sol.repo.logContract('u1', call({ address: ADDRESS.toLowerCase() }));
    expect(sol.inserts).toHaveLength(2);
  });

  it('treats a 23505 from the unique index as a benign duplicate, not an ingest failure', async () => {
    // The race the in-process guard cannot close: two re-deliveries in flight
    // at once, both reading "not present" before either insert lands. Simulated
    // by seeding a row the guard cannot see, on a database where
    // 20260905140000_contracts_unique_call.sql has been applied.
    const { repo, applyUniqueIndex, rows } = makeRepo();
    applyUniqueIndex();
    rows.push({
      id: 'row-racer',
      user_id: 'u1',
      // Deliberately mismatched casing on the SELECT key so the guard misses it
      // but the index (which folds EVM case) still fires.
      message_id: MESSAGE_ID,
      address: '0xAbC0000000000000000000000000000000000001'.toUpperCase(),
      chain: 'evm',
      first_seen: true,
      token_symbol: 'RACED',
    });

    const logged = await repo.logContract(
      'u1',
      call({ address: '0xabc0000000000000000000000000000000000001', chain: 'evm' }),
    );
    // No throw, and the caller still gets a usable entry for the broadcast.
    expect(logged.address).toBe('0xabc0000000000000000000000000000000000001');
  });
});

// ---------------------------------------------------------------------------
// Local (JSON contract log)
// ---------------------------------------------------------------------------

// The local log is a module singleton that resolves OCT_DATA_DIR at import
// time, so the temp dir has to be set before the dynamic import.
let dataDir: string;
let contractLog: typeof import('../src/utils/contractLog').contractLog;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'oct-contract-log-'));
  process.env.OCT_DATA_DIR = dataDir;
  ({ contractLog } = await import('../src/utils/contractLog'));
});

afterAll(() => {
  delete process.env.OCT_DATA_DIR;
  if (dataDir && existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
});

describe('logContract is idempotent per call — local (JSON)', () => {
  it('drops re-deliveries at 5s, 2min and 1h alike', () => {
    contractLog.deleteAllContracts();
    contractLog.logContract(call());
    contractLog.logContract(call({ timestamp: laterBy(5_000) }));
    contractLog.logContract(call({ timestamp: laterBy(2 * MINUTE) }));
    contractLog.logContract(call({ timestamp: laterBy(60 * MINUTE) }));
    expect(contractLog.getContracts(100)).toHaveLength(1);
  });

  it('returns the already-stored entry, enrichment included', () => {
    contractLog.deleteAllContracts();
    contractLog.logContract(call());
    contractLog.enrichContract(ADDRESS, { tokenSymbol: 'EXMPL', fdvAtCall: 816_000 }, { messageId: MESSAGE_ID });

    const duplicate = contractLog.logContract(call({ timestamp: laterBy(2 * MINUTE) }));
    expect(duplicate.tokenSymbol).toBe('EXMPL');
    expect(duplicate.fdvAtCall).toBe(816_000);
    expect(duplicate.firstSeen).toBe(true);
    expect(contractLog.getContracts(100)).toHaveLength(1);
  });

  it('still logs a different message mentioning the same address', () => {
    contractLog.deleteAllContracts();
    contractLog.logContract(call());
    const second = contractLog.logContract(call({ messageId: 'tg_-1002345678_9912' }));
    expect(contractLog.getContracts(100)).toHaveLength(2);
    expect(second.firstSeen).toBe(false);
  });
});
