/**
 * One-shot MC@CALL recovery for `contracts.fdv_at_call`.
 *
 *   npm run backfill:mc -w oct-backend -- --tier=exact --population=A --limit=200
 *   npm run backfill:mc -w oct-backend -- --tier=exact --population=A --commit
 *
 * DRY RUN IS THE DEFAULT. There is no `--dry-run` flag to forget; `--commit` is
 * the only thing that enables a write. A non-commit run's deliverable is the
 * plan file and the refusal histogram, not a side effect.
 *
 * Never imported by `index.ts` or any route — it compiles into `dist/` as inert
 * weight and no request path can reach it. All decisions live in
 * `fdvRecovery/rules.ts` and `fdvRecovery/planner.ts`; this file is I/O,
 * batching, accounting and the CLI.
 *
 * Two deliberate departures from the normal code path, both load-bearing:
 *
 * 1. It writes through a raw service client, NOT `StorageProvider.enrichContract`.
 *    That method routes every patch through `mergeEnrichmentPatch`, which has
 *    rules about who may overwrite an FDV. Recovery is not an enrichment and
 *    must not be merged like one; going through the normal path would also make
 *    the script's behaviour depend on a merge policy that is being fixed
 *    separately.
 * 2. The client is untyped. `packages/shared/src/database.types.ts` is generated
 *    and does not carry `fdv_at_call_provenance` or `contract_fdv_recovery_log`
 *    until the operator regenerates it after applying
 *    `20260808120000_contract_fdv_recovery.sql`. Typing this against a schema
 *    that does not describe the migration would be worse than not typing it.
 *
 * MEMORY: `birdeyeClient` caches every response in an unbounded Map with a 120s
 * TTL evicted only on read, so a multi-hour TIER 3 run accumulates entries that
 * are never read again. Split TIER 3 into `--limit`ed passes, or give node
 * `--max-old-space-size` headroom.
 */

import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { birdeyeGet, isBirdeyeConfigured, type BirdeyeChain } from '../utils/birdeyeClient.js';
import {
  addressKey,
  buildPopulationIndex,
  formatRecoveredDisplay,
  toBirdeyeChain,
  PRICE_POINT_MAX_SKEW_MS,
  RECOVERY_TIERS,
  type CandidateRow,
  type CatalogRow,
  type Population,
  type PricePoint,
  type RecoveryTier,
  type RefusalReason,
  type SupplySample,
} from './fdvRecovery/rules.js';
import {
  applyDerived,
  emptyTally,
  planOfflineTiers,
  resolveDerived,
  tallyPlan,
  type PlanContext,
  type RowPlan,
} from './fdvRecovery/planner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.OCT_DATA_DIR || process.env.TRENCHCORD_DATA_DIR || join(__dirname, '../../data');
const STATE_DIR = join(DATA_DIR, 'backfill');
const PAGE_SIZE = 1000;
const DEFAULT_BATCH = 200;

// Flag aliases, so the CLI reads in English and the stored provenance stays the
// column value.
const TIER_ALIASES: Record<string, RecoveryTier> = {
  exact: 'catalog_exact',
  catalog_exact: 'catalog_exact',
  sibling: 'sibling_measured',
  sibling_measured: 'sibling_measured',
  derived: 'birdeye_derived',
  birdeye_derived: 'birdeye_derived',
};

interface Options {
  commit: boolean;
  tiers: Set<RecoveryTier>;
  population: Population;
  userId?: string;
  since?: string;
  until?: string;
  limit?: number;
  batch: number;
  runId: string;
  probeOnly: boolean;
  allowCurrentSupply: boolean;
}

function makeRunId(): string {
  // Sortable-by-time and unique, without adding a ULID dependency for one script.
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    commit: false,
    tiers: new Set<RecoveryTier>(['catalog_exact', 'sibling_measured']),
    population: 'A',
    batch: DEFAULT_BATCH,
    runId: makeRunId(),
    probeOnly: false,
    allowCurrentSupply: false,
  };

  for (const arg of argv) {
    const [rawKey, rawValue] = arg.startsWith('--') ? arg.slice(2).split('=', 2) : ['', ''];
    const value = rawValue ?? '';
    switch (rawKey) {
      case 'commit':
        opts.commit = true;
        break;
      case 'probe':
        opts.probeOnly = true;
        break;
      case 'allow-current-supply':
        opts.allowCurrentSupply = true;
        break;
      case 'tier': {
        const tiers = new Set<RecoveryTier>();
        for (const part of value.split(',').map((p) => p.trim()).filter(Boolean)) {
          const tier = TIER_ALIASES[part];
          if (!tier) throw new Error(`Unknown tier "${part}". Known: ${Object.keys(TIER_ALIASES).join(', ')}`);
          tiers.add(tier);
        }
        if (tiers.size === 0) throw new Error('--tier needs at least one tier');
        opts.tiers = tiers;
        break;
      }
      case 'population': {
        if (value !== 'A' && value !== 'B' && value !== 'all') {
          throw new Error('--population must be A, B or all');
        }
        opts.population = value;
        break;
      }
      case 'user':
        opts.userId = value;
        break;
      case 'since':
        opts.since = value;
        break;
      case 'until':
        opts.until = value;
        break;
      case 'limit':
        opts.limit = Number.parseInt(value, 10);
        break;
      case 'batch':
        opts.batch = Number.parseInt(value, 10) || DEFAULT_BATCH;
        break;
      case 'run-id':
        opts.runId = value;
        break;
      default:
        if (rawKey) throw new Error(`Unknown flag --${rawKey}`);
    }
  }

  if (opts.limit != null && (!Number.isFinite(opts.limit) || opts.limit <= 0)) {
    throw new Error('--limit must be a positive integer');
  }
  return opts;
}

/**
 * The script's own view of the schema: exactly the columns it reads and writes,
 * and nothing else.
 *
 * It does not use the generated `Database` type because that file is generated
 * from the live project and does not describe `fdv_at_call_provenance`,
 * `fdv_at_call_recovered_at` or `contract_fdv_recovery_log` until the operator
 * applies 20260808120000_contract_fdv_recovery.sql and regenerates. Declaring
 * the contract here means the compiler still checks every column name, and the
 * declaration doubles as the list of what this script is permitted to touch.
 */
type RecoveryContractRow = {
  id: string;
  user_id: string;
  address: string;
  chain: string;
  evm_chain: string | null;
  message_id: string;
  timestamp: string;
  fdv_at_call: number | null;
  fdv_at_call_display: string | null;
  fdv_at_call_provenance: string | null;
  fdv_at_call_recovered_at: string | null;
  price_usd: number | null;
  token_symbol: string | null;
};

type RecoveryCatalogRow = {
  address: string;
  chain: string;
  evm_chain: string | null;
  symbol: string | null;
  fdv: number | null;
  enriched_at: string;
};

type RecoveryLogRow = {
  id: string;
  run_id: string;
  contract_id: string;
  address: string;
  tier: string;
  fdv_written: number;
  inputs: Record<string, unknown>;
  created_at: string;
};

type RecoverySchema = {
  __InternalSupabase: { PostgrestVersion: '14.5' };
  public: {
    Tables: {
      contracts: {
        Row: RecoveryContractRow;
        Insert: Partial<RecoveryContractRow>;
        Update: Partial<RecoveryContractRow>;
        Relationships: [];
      };
      token_catalog: {
        Row: RecoveryCatalogRow;
        Insert: Partial<RecoveryCatalogRow>;
        Update: Partial<RecoveryCatalogRow>;
        Relationships: [];
      };
      contract_fdv_recovery_log: {
        Row: RecoveryLogRow;
        Insert: Omit<RecoveryLogRow, 'id' | 'created_at'>;
        Update: Partial<RecoveryLogRow>;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};

type Client = ReturnType<typeof createClient<RecoverySchema>>;

function serviceClient(): Client {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required.');
  return createClient<RecoverySchema>(url, key, { auth: { persistSession: false } });
}

// ---------------------------------------------------------------------------
// Loads. Both indexes are read once, whole, and everything after is in memory:
// duplicate groups, sibling windows and implied supply are all cross-row facts
// that PostgREST cannot express, and 31k narrow rows is a few megabytes.
// ---------------------------------------------------------------------------

async function loadAllContracts(db: Client): Promise<CandidateRow[]> {
  const rows: CandidateRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await db
      .from('contracts')
      .select(
        'id,user_id,address,chain,evm_chain,message_id,timestamp,fdv_at_call,price_usd,token_symbol,fdv_at_call_provenance',
      )
      // Ordered by the primary key, not by timestamp: ties in `timestamp` are
      // common (one message, several addresses) and would let a row slip
      // between pages.
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) throw new Error(`Failed to read contracts: ${error.message}`);
    const page = data ?? [];
    for (const row of page) {
      rows.push({
        id: row.id,
        userId: row.user_id,
        address: row.address,
        chain: row.chain === 'sol' ? 'sol' : 'evm',
        evmChain: row.evm_chain || null,
        messageId: row.message_id ?? null,
        timestamp: row.timestamp,
        fdvAtCall: row.fdv_at_call != null ? Number(row.fdv_at_call) : null,
        priceUsd: row.price_usd != null ? Number(row.price_usd) : null,
        tokenSymbol: row.token_symbol || null,
        provenance: row.fdv_at_call_provenance || null,
      });
    }
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

async function loadCatalog(db: Client): Promise<CatalogRow[]> {
  const rows: CatalogRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await db
      .from('token_catalog')
      .select('address,chain,evm_chain,symbol,fdv,enriched_at')
      .order('address', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) throw new Error(`Failed to read token_catalog: ${error.message}`);
    const page = data ?? [];
    for (const row of page) {
      rows.push({
        address: row.address,
        chain: row.chain === 'sol' ? 'sol' : 'evm',
        evmChain: row.evm_chain ?? null,
        symbol: row.symbol || null,
        fdv: row.fdv != null ? Number(row.fdv) : null,
        enrichedAt: row.enriched_at,
      });
    }
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

interface Indexes {
  byAddress: Map<string, CandidateRow[]>;
  byUserAddress: Map<string, CandidateRow[]>;
  /** Keyed by address only; `resolveCatalogExact` picks the chain key itself so
   * that a row which cannot name its chain is refused rather than mis-keyed. */
  catalogByAddress: Map<string, CatalogRow[]>;
}

function pushInto<T>(map: Map<string, T[]>, key: string, value: T): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}

function buildIndexes(rows: CandidateRow[], catalog: CatalogRow[]): Indexes {
  const byAddress = new Map<string, CandidateRow[]>();
  const byUserAddress = new Map<string, CandidateRow[]>();
  for (const row of rows) {
    const key = addressKey(row.chain, row.evmChain, row.address);
    pushInto(byAddress, key, row);
    pushInto(byUserAddress, `${row.userId} ${key}`, row);
  }

  const catalogByAddress = new Map<string, CatalogRow[]>();
  for (const entry of catalog) {
    pushInto(catalogByAddress, addressKey(entry.chain, entry.evmChain, entry.address), entry);
  }

  return { byAddress, byUserAddress, catalogByAddress };
}

// ---------------------------------------------------------------------------
// Birdeye historical price.
//
// UNVERIFIED FROM THIS REPOSITORY. Every existing `birdeyeGet` call site is a
// wallet/trader path (`/wallet/v2/*`, `/trader/*`); no `/defi/*` path is used
// anywhere here, so the path below, its parameter names, its response shape, its
// price unit and its timestamp semantics are a CANDIDATE, not an established
// fact. `--probe` is what establishes them, by pricing three rows whose real
// price we already recorded. TIER 3 stays hard-disabled until it passes in the
// same process. Override the path with OCT_BIRDEYE_HISTORY_PATH if the probe
// shows it is wrong, then record what worked in ADR 013.
// ---------------------------------------------------------------------------

const HISTORY_PRICE_PATH = process.env.OCT_BIRDEYE_HISTORY_PATH || '/defi/history_price';

interface HistoryPriceEnvelope {
  items?: { unixTime?: number; value?: number }[];
}

async function fetchPricePoints(
  chain: BirdeyeChain,
  address: string,
  callTs: string,
): Promise<PricePoint[] | null> {
  const callMs = Date.parse(callTs);
  if (!Number.isFinite(callMs)) return null;

  // Ask only for the window a point could legitimately come from. Never widen it
  // to raise yield: a point outside it is refused by `pickPricePoint` anyway.
  const from = Math.floor((callMs - PRICE_POINT_MAX_SKEW_MS) / 1000);
  const to = Math.ceil((callMs + PRICE_POINT_MAX_SKEW_MS) / 1000);

  const res = await birdeyeGet<HistoryPriceEnvelope>(chain, HISTORY_PRICE_PATH, {
    address,
    address_type: 'token',
    type: '1m',
    time_from: from,
    time_to: to,
  });
  if (!res.ok) return null;

  // `unixTime` is read as SECONDS. If the provider means milliseconds the probe
  // fails by three orders of magnitude, which is the point of the probe — this
  // code does not guess and silently rescale.
  return (res.data?.items ?? [])
    .filter((i): i is { unixTime: number; value: number } =>
      typeof i.unixTime === 'number' && typeof i.value === 'number')
    .map((i) => ({ unixSeconds: i.unixTime, priceUsd: i.value }));
}

interface ProbeFixture {
  row: CandidateRow;
  chain: BirdeyeChain;
}

/** Fixtures come from our OWN data — that is what makes the probe meaningful. */
function pickProbeFixtures(rows: CandidateRow[]): ProbeFixture[] {
  const usable = rows
    .filter((r) => r.provenance == null && r.fdvAtCall != null && r.priceUsd != null && r.priceUsd > 0)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  const chosen: ProbeFixture[] = [];
  const usedChains = new Set<BirdeyeChain>();
  const usedWeeks = new Set<number>();

  for (const pass of [0, 1]) {
    for (const row of usable) {
      if (chosen.length >= 3) break;
      const chain = toBirdeyeChain(row.chain, row.evmChain);
      if (!chain) continue;
      const week = Math.floor(Date.parse(row.timestamp) / (7 * 86_400_000));
      // First pass insists on a distinct chain AND a distinct week, so a pass
      // cannot be a coincidence of one chain on one day. Second pass relaxes the
      // week only.
      if (usedChains.has(chain)) continue;
      if (pass === 0 && usedWeeks.has(week)) continue;
      chosen.push({ row, chain });
      usedChains.add(chain);
      usedWeeks.add(week);
    }
  }
  return chosen;
}

const PROBE_TOLERANCE = 0.05;

async function runProbe(rows: CandidateRow[]): Promise<boolean> {
  if (!isBirdeyeConfigured()) {
    console.error('[probe] BIRDEYE_API_KEY is not set. This is a config error, not a refusal.');
    return false;
  }

  const fixtures = pickProbeFixtures(rows);
  if (fixtures.length < 3) {
    console.error(
      `[probe] FAILED: only ${fixtures.length} usable fixtures (need 3 across distinct chains).`,
    );
    console.error('[probe] A fixture is a row with a measured fdv_at_call AND price_usd.');
    return false;
  }

  let allPass = true;
  for (const { row, chain } of fixtures) {
    const points = await fetchPricePoints(chain, row.address, row.timestamp);
    if (points === null) {
      console.error(`[probe] ${chain} ${row.address}: request failed or returned success:false.`);
      allPass = false;
      continue;
    }
    if (points.length === 0) {
      console.error(
        `[probe] ${chain} ${row.address}: no points returned. Raw path was ${HISTORY_PRICE_PATH}.`,
      );
      allPass = false;
      continue;
    }
    const callMs = Date.parse(row.timestamp);
    const nearest = points.reduce((a, b) =>
      Math.abs(a.unixSeconds * 1000 - callMs) <= Math.abs(b.unixSeconds * 1000 - callMs) ? a : b,
    );
    const recorded = row.priceUsd as number;
    const drift = Math.abs(nearest.priceUsd - recorded) / recorded;
    const skewSeconds = Math.abs(nearest.unixSeconds * 1000 - callMs) / 1000;
    const verdict = drift <= PROBE_TOLERANCE ? 'PASS' : 'FAIL';
    if (verdict === 'FAIL') allPass = false;
    console.log(
      `[probe] ${verdict} ${chain} ${row.address} @${row.timestamp}: `
      + `recorded ${recorded}, returned ${nearest.priceUsd} `
      + `(drift ${(drift * 100).toFixed(1)}%, skew ${skewSeconds.toFixed(0)}s)`,
    );
  }

  console.log(
    allPass
      ? '[probe] PASSED. Path, params, envelope, price unit and timestamp semantics all check out.'
      : '[probe] FAILED. TIER 3 stays disabled. Record what you change in ADR 013.',
  );
  return allPass;
}

// ---------------------------------------------------------------------------
// Run state. Two independent mechanisms, because a rate-limited run over
// thousands of rows WILL be interrupted.
// ---------------------------------------------------------------------------

interface StateLine {
  id: string;
  decision: 'written' | 'refused';
  tier?: RecoveryTier;
  reason?: RefusalReason;
}

function statePath(runId: string): string {
  return join(STATE_DIR, `fdv-at-call-${runId}.state.jsonl`);
}

function planPath(runId: string): string {
  return join(STATE_DIR, `fdv-at-call-${runId}.plan.jsonl`);
}

/**
 * Reload a previous run's decisions. Refusals are the expensive part to
 * recompute — a TIER 3 refusal costs a Birdeye call to learn — so this is a
 * negative cache as much as a checkpoint.
 */
function loadState(runId: string): Set<string> {
  const path = statePath(runId);
  if (!existsSync(path)) return new Set();
  const done = new Set<string>();
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      done.add((JSON.parse(line) as StateLine).id);
    } catch {
      // A torn last line from a hard kill. Recomputing one row is cheap.
    }
  }
  return done;
}

class JsonlWriter {
  private buffer: string[] = [];

  constructor(private readonly path: string) {
    mkdirSync(STATE_DIR, { recursive: true });
  }

  write(value: unknown): void {
    this.buffer.push(`${JSON.stringify(value)}\n`);
    if (this.buffer.length >= 50) this.flush();
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    appendFileSync(this.path, this.buffer.join(''), 'utf-8');
    this.buffer = [];
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function pct(n: number, total: number): string {
  return total > 0 ? `${((100 * n) / total).toFixed(1)}%` : '0.0%';
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const db = serviceClient();

  console.log(`[backfill] run ${opts.runId} — ${opts.commit ? 'COMMIT' : 'DRY RUN'}`);
  console.log('[backfill] loading contracts + token_catalog...');
  const allRows = await loadAllContracts(db);
  const catalog = await loadCatalog(db);
  console.log(`[backfill] ${allRows.length} contract rows, ${catalog.length} catalog rows.`);

  if (opts.probeOnly) {
    const passed = await runProbe(allRows);
    process.exit(passed ? 0 : 1);
  }

  const index = buildPopulationIndex(allRows, catalog);
  const idx = buildIndexes(allRows, catalog);

  // TIER 3 is hard-disabled unless a probe passed IN THIS PROCESS — not cached,
  // not remembered from a previous run, not overridable by a flag.
  let probePassed = false;
  if (opts.tiers.has('birdeye_derived')) {
    console.log('[backfill] TIER 3 requested — verifying the Birdeye historical price endpoint.');
    probePassed = await runProbe(allRows);
    if (!probePassed) {
      console.error('[backfill] Probe failed. TIER 3 will refuse every row; run without --tier=derived.');
    }
  }

  const nulls = allRows.filter((r) => r.fdvAtCall == null && r.provenance == null);
  let candidates = nulls;
  if (opts.userId) candidates = candidates.filter((r) => r.userId === opts.userId);
  if (opts.since) {
    const since = Date.parse(opts.since);
    candidates = candidates.filter((r) => Date.parse(r.timestamp) >= since);
  }
  if (opts.until) {
    const until = Date.parse(opts.until);
    candidates = candidates.filter((r) => Date.parse(r.timestamp) <= until);
  }
  candidates.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  if (opts.limit != null) candidates = candidates.slice(0, opts.limit);

  const alreadyDecided = loadState(opts.runId);
  if (alreadyDecided.size > 0) {
    console.log(`[backfill] resuming: ${alreadyDecided.size} rows already decided in this run.`);
    candidates = candidates.filter((r) => !alreadyDecided.has(r.id));
  }

  console.log(
    `[backfill] ${nulls.length} rows with no MC@call; ${candidates.length} considered `
    + `(population=${opts.population}, tiers=${[...opts.tiers].join(',')}).`,
  );

  const ctx: PlanContext = {
    index,
    population: opts.population,
    tiers: opts.tiers,
    catalogFor: (row) => idx.catalogByAddress.get(addressKey(row.chain, row.evmChain, row.address)) ?? [],
    addressRowsFor: (row) => idx.byAddress.get(addressKey(row.chain, row.evmChain, row.address)) ?? [],
    siblingsFor: (row) =>
      idx.byUserAddress.get(`${row.userId} ${addressKey(row.chain, row.evmChain, row.address)}`) ?? [],
  };

  const tally = emptyTally();
  const planOut = new JsonlWriter(planPath(opts.runId));
  const stateOut = new JsonlWriter(statePath(opts.runId));

  // No in-memory-only progress: a SIGINT flushes both files and exits non-zero.
  process.on('SIGINT', () => {
    planOut.flush();
    stateOut.flush();
    console.error(`\n[backfill] interrupted. Resume with --run-id=${opts.runId}`);
    process.exit(130);
  });

  for (let i = 0; i < candidates.length; i += opts.batch) {
    const batch = candidates.slice(i, i + opts.batch);
    const plans: RowPlan[] = [];

    for (const row of batch) {
      const plan = planOfflineTiers(row, ctx);
      if (plan.needsPrice) {
        const derived = await resolveDerivedForRow(row, {
          probePassed,
          allowCurrentSupply: opts.allowCurrentSupply,
          index: idx,
        });
        applyDerived(plan, derived);
      }
      tallyPlan(tally, plan);
      plans.push(plan);
      planOut.write(serialisePlan(plan));
    }

    if (opts.commit) {
      for (const plan of plans) {
        if (!plan.result) {
          stateOut.write({ id: plan.row.id, decision: 'refused' } satisfies StateLine);
          continue;
        }
        const written = await writeRecovery(db, opts.runId, plan);
        if (written) {
          stateOut.write({
            id: plan.row.id,
            decision: 'written',
            tier: plan.result.tier,
          } satisfies StateLine);
        } else {
          // A live enrichment filled the row between read and write. The
          // measurement wins; the recovery is dropped, not retried.
          const perTier = tally.byTier.get(plan.result.tier) ?? new Map<RefusalReason, number>();
          perTier.set('concurrent_live_write', (perTier.get('concurrent_live_write') ?? 0) + 1);
          tally.byTier.set(plan.result.tier, perTier);
          tally.writes.set(plan.result.tier, Math.max(0, (tally.writes.get(plan.result.tier) ?? 0) - 1));
          stateOut.write({
            id: plan.row.id,
            decision: 'refused',
            reason: 'concurrent_live_write',
          } satisfies StateLine);
        }
      }
    }

    planOut.flush();
    stateOut.flush();
    console.log(`[backfill] ${Math.min(i + opts.batch, candidates.length)}/${candidates.length} considered.`);
  }

  planOut.flush();
  stateOut.flush();
  report(tally, candidates.length, opts);
}

function serialisePlan(plan: RowPlan): Record<string, unknown> {
  return {
    contractId: plan.row.id,
    address: plan.row.address,
    chain: plan.row.chain,
    evmChain: plan.row.evmChain,
    timestamp: plan.row.timestamp,
    population: plan.population,
    // Always null on a candidate — recorded so a reviewer can see the script was
    // never overwriting a measured value.
    currentFdvAtCall: plan.row.fdvAtCall,
    screenRefusal: plan.screenRefusal,
    attempts: plan.attempts.map((a) =>
      a.outcome.ok
        ? { tier: a.tier, ok: true, fdv: a.outcome.fdv, inputs: a.outcome.inputs }
        : { tier: a.tier, ok: false, reason: a.outcome.reason },
    ),
    proposedFdv: plan.result?.fdv ?? null,
    proposedDisplay: plan.result ? formatRecoveredDisplay(plan.result.fdv) : null,
    proposedTier: plan.result?.tier ?? null,
  };
}

interface DerivedDeps {
  probePassed: boolean;
  allowCurrentSupply: boolean;
  index: Indexes;
}

/**
 * TIER 3 for one row. Price fetches are deduplicated by (chain, address, minute)
 * because the distinct-address count is far below the row count and
 * `withBirdeyeLimit` allows ~3.3 requests per second.
 */
const priceCache = new Map<string, PricePoint[] | null>();

async function resolveDerivedForRow(row: CandidateRow, deps: DerivedDeps) {
  const key = addressKey(row.chain, row.evmChain, row.address);
  const siblings = deps.index.byAddress.get(key) ?? [];
  const supplySamples: SupplySample[] = siblings
    .filter(
      (s) =>
        s.provenance == null
        && s.fdvAtCall != null && s.fdvAtCall > 0
        && s.priceUsd != null && s.priceUsd > 0,
    )
    .map((s) => ({
      timestamp: s.timestamp,
      fdvAtCall: s.fdvAtCall as number,
      priceUsd: s.priceUsd as number,
    }));
  const measuredFdvForAddress = siblings
    .filter((s) => s.provenance == null && s.fdvAtCall != null && s.fdvAtCall > 0)
    .map((s) => s.fdvAtCall as number);

  const chain = toBirdeyeChain(row.chain, row.evmChain);
  let pricePoints: PricePoint[] | null = null;
  if (deps.probePassed && chain) {
    const minuteBucket = Math.floor(Date.parse(row.timestamp) / 60_000);
    const cacheKey = `${chain} ${key} ${minuteBucket}`;
    if (priceCache.has(cacheKey)) {
      pricePoints = priceCache.get(cacheKey) ?? null;
    } else {
      pricePoints = await fetchPricePoints(chain, row.address, row.timestamp);
      priceCache.set(cacheKey, pricePoints);
    }
  }

  return resolveDerived(row, {
    probePassed: deps.probePassed,
    pricePoints,
    supplySamples,
    // No Birdeye supply endpoint is called at all in the default configuration:
    // the default TIER 3 needs exactly one endpoint, which halves the unverified
    // surface. `--allow-current-supply` without a supply source refuses.
    currentSupply: null,
    allowCurrentSupply: deps.allowCurrentSupply,
    measuredFdvForAddress,
  });
}

/**
 * Write one recovery. Per row, never a bulk UPDATE across the batch: a
 * partially-failed bulk write is unauditable.
 *
 * Returns false when the guard matched nothing, which means a live enrichment
 * filled the row between the read and this write.
 */
async function writeRecovery(db: Client, runId: string, plan: RowPlan): Promise<boolean> {
  const result = plan.result;
  if (!result) return false;
  const now = new Date().toISOString();

  const { data, error } = await db
    .from('contracts')
    .update({
      fdv_at_call: result.fdv,
      fdv_at_call_display: formatRecoveredDisplay(result.fdv),
      fdv_at_call_provenance: result.tier,
      fdv_at_call_recovered_at: now,
    })
    .eq('id', plan.row.id)
    .is('fdv_at_call', null)
    .select('id');

  if (error) throw new Error(`Failed to write ${plan.row.id}: ${error.message}`);
  if (!data || data.length === 0) return false;

  const { error: logError } = await db.from('contract_fdv_recovery_log').insert({
    run_id: runId,
    contract_id: plan.row.id,
    address: plan.row.address,
    tier: result.tier,
    fdv_written: result.fdv,
    inputs: result.inputs,
  });
  if (logError) {
    // The value is written but unaudited, so `revert by run_id` will not reach
    // it. Loud, not fatal: the run should not abandon the rows behind it.
    console.error(`[backfill] AUDIT WRITE FAILED for ${plan.row.id}: ${logError.message}`);
  }
  return true;
}

function report(
  tally: ReturnType<typeof emptyTally>,
  considered: number,
  opts: Options,
): void {
  const writes = [...tally.writes.entries()].reduce((n, [, c]) => n + c, 0);

  console.log('\n=== MC@CALL recovery ===');
  console.log(`run           ${opts.runId}`);
  console.log(`mode          ${opts.commit ? 'COMMIT' : 'DRY RUN (nothing written)'}`);
  console.log(`considered    ${considered}`);
  console.log(`candidates    ${tally.populations.A + tally.populations.B} `
    + `(A ${tally.populations.A} radar-blank, B ${tally.populations.B} row-only)`);
  console.log(`screened out  ${tally.screened}`);

  console.log('\n-- writes by tier --');
  for (const tier of RECOVERY_TIERS) {
    const n = tally.writes.get(tier) ?? 0;
    if (opts.tiers.has(tier)) console.log(`  ${tier.padEnd(18)} ${n}`);
  }
  console.log(`  ${'TOTAL'.padEnd(18)} ${writes} (${pct(writes, considered)} of considered)`);

  // Printed with the same prominence as the writes on purpose. A run that
  // recovers 2,000 and refuses 15,000 is a SUCCESS under "missing beats wrong"
  // and must not read as a failure.
  console.log('\n-- refusals: never became a candidate --');
  for (const [reason, n] of [...tally.screen.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason.padEnd(26)} ${n}`);
  }

  for (const tier of RECOVERY_TIERS) {
    const perTier = tally.byTier.get(tier);
    if (!perTier || perTier.size === 0) continue;
    console.log(`\n-- refusals: ${tier} --`);
    for (const [reason, n] of [...perTier.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${reason.padEnd(26)} ${n}`);
    }
  }

  console.log(`\nleft blank    ${tally.unrecovered} candidates declined by every enabled tier.`);
  console.log(`plan          ${planPath(opts.runId)}`);
  if (!opts.commit) console.log('\nDry run. Re-run with --commit to write.');
}

main().catch((err) => {
  console.error('[backfill] fatal:', (err as Error).message);
  process.exit(1);
});
