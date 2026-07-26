// The manual command queue, as the signer process consumes it
// (LP_AUTOMATION_PLAN.md §9 point 1, §7).
//
// ---------------------------------------------------------------------------
// WHY POLLING, AND WHY THIS PROCESS MUST NEVER BE PUSHED TO
// ---------------------------------------------------------------------------
// The dashboard needs to ask for a compound / rebalance / exit. It cannot sign,
// and this process must not be reachable: §9 point 1 makes the signer an
// outbound-only process with no inbound network surface at all. An HTTP
// endpoint here — even one behind a shared secret — would be a remote trigger
// on the one component that holds a key over real funds.
//
// So the dashboard writes a row and we come and get it. Polling is the point,
// not a limitation: the direction of the connection IS the security property.
//
// ---------------------------------------------------------------------------
// A COMMAND IS A TRIGGER, NOT AN AUTHORITY
// ---------------------------------------------------------------------------
// Claiming a command decides only WHICH position and WHICH action. Everything
// that decides whether it may happen is unchanged and runs afterwards, in
// `ActionExecutor`: the unresolved-intent quarantine, the pool allowlist read
// from the policy at the moment of execution, the dry run, the audit intent
// written before the broadcast, the per-position lock, and — on chain — the
// module's destination/selector allowlist and spend caps, plus the `LP_ARMED`
// gate. A manual compound is exactly as constrained as an automatic one, and
// this file adds no way to widen any of it.
//
// ---------------------------------------------------------------------------
// WRITE SCOPE
// ---------------------------------------------------------------------------
// This is the ONLY table this process writes to, and it writes only the status
// and result columns (`status`, `claimed_at`, `completed_at`, `tx_hash`,
// `error`). It never writes policy or settings — §9 point 1 keeps the process
// holding the key a consumer of its own constraints, never a producer of them,
// which is the off-chain counterpart of the module's `msg.sender == safe` admin
// gate. `supabasePolicySource.ts` is read-only for the same reason; if a write
// to any other table ever appears in this workspace, that invariant is gone.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Address } from '../types.js';

const TABLE = 'lp_automation_commands';

/**
 * Actions a human can request on an EXISTING position.
 *
 * `enter` is absent on purpose: opening a position needs a pool, a size and a
 * range, and those are policy decisions, not queue-entry decisions.
 */
export type CommandAction = 'compound' | 'rebalance' | 'exit';

const COMMAND_ACTIONS: readonly CommandAction[] = ['compound', 'rebalance', 'exit'];

/** A claimed command: ours to execute, exactly once. */
export interface LpCommand {
  id: string;
  tokenId: string;
  /** Pool the requester believed the position was in. Lowercased. */
  poolAddress: Address;
  action: CommandAction;
  /** Epoch ms. Used only for logging — staleness is judged on the calldata. */
  requestedAt: number;
}

/**
 * The outcome of executing a claimed command.
 *
 * `error === null` is the ONLY thing that records `done`. In particular a
 * disarmed run carries an error string ("skipped: the signer is disarmed…") and
 * is therefore recorded as `failed` — a dry run that never touched the chain
 * must not read as a completed action in the dashboard any more than it does in
 * the audit log (`deriveLastCompounded` makes the same distinction).
 */
export interface CommandResult {
  txHash: string | null;
  error: string | null;
}

/**
 * The port the lifecycle loop runs against. Declared here (not just satisfied
 * by the Supabase class) so the loop can be tested without a database — the
 * behaviours worth testing are a lost claim race and a failing execution, and
 * neither can be provoked against a live table on demand.
 */
export interface CommandSource {
  /**
   * Atomically take the oldest pending command, or null if there is none.
   *
   * MUST be atomic: an implementation that reads then writes lets a second
   * instance — or the same instance after a restart — execute the same command
   * twice. Twice is not "a retry"; on an exit it is a withdrawal followed by a
   * second withdrawal against a position that no longer holds what the first
   * one measured.
   */
  claimNext(): Promise<LpCommand | null>;
  /** Record what happened. Called exactly once per successful claim. */
  complete(command: LpCommand, result: CommandResult): Promise<void>;
}

export class CommandSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandSourceError';
  }
}

/** Row shape written by `*_lp_automation_commands.sql`. */
interface CommandRow {
  id: string;
  token_id: string;
  pool_address: string;
  action: string;
  requested_at: string;
}

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;

/**
 * Map a row, refusing anything it cannot read unambiguously.
 *
 * Pure — exported for tests. Throws rather than repairing: a command row whose
 * action or pool we cannot read is not a command we may guess at, because the
 * guess would be a transaction.
 */
export function rowToCommand(row: CommandRow): LpCommand {
  if (typeof row.id !== 'string' || row.id.length === 0) {
    throw new CommandSourceError('command row has no id.');
  }
  if (typeof row.token_id !== 'string' || !/^[1-9][0-9]{0,77}$/.test(row.token_id)) {
    throw new CommandSourceError(`command ${row.id} has a malformed token_id: ${String(row.token_id)}`);
  }
  const pool = typeof row.pool_address === 'string' ? row.pool_address.toLowerCase() : '';
  if (!ADDRESS_PATTERN.test(pool)) {
    throw new CommandSourceError(
      `command ${row.id} has a malformed pool_address: ${String(row.pool_address)}`,
    );
  }
  if (!COMMAND_ACTIONS.includes(row.action as CommandAction)) {
    throw new CommandSourceError(`command ${row.id} has an unknown action: ${String(row.action)}`);
  }

  // A timestamp we cannot parse is logged as 0 rather than NaN: it is used only
  // for a log line, and NaN would serialize to null and read as "missing".
  const requestedAt = Date.parse(row.requested_at);

  return {
    id: row.id,
    tokenId: row.token_id,
    poolAddress: pool as Address,
    action: row.action as CommandAction,
    requestedAt: Number.isFinite(requestedAt) ? requestedAt : 0,
  };
}

export interface SupabaseCommandSourceOptions {
  url: string;
  serviceRoleKey: string;
  userId: string;
  /** How many pending rows to consider per poll before giving up. */
  claimBatchSize?: number;
}

const DEFAULT_CLAIM_BATCH = 5;

export class SupabaseCommandSource implements CommandSource {
  private readonly client: SupabaseClient;
  private readonly batchSize: number;

  constructor(private readonly options: SupabaseCommandSourceOptions) {
    this.client = createClient(options.url, options.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    this.batchSize = options.claimBatchSize ?? DEFAULT_CLAIM_BATCH;
  }

  /**
   * Claim by CONDITIONAL UPDATE, not by read-then-write.
   *
   * The update is filtered on `status = 'pending'` as well as on the id, so the
   * transition is decided by Postgres under a row lock: exactly one caller's
   * UPDATE matches, and every other caller's matches zero rows. Postgres
   * returns the rows it actually changed, so "did I win?" is answered by the
   * database rather than inferred from a prior read.
   *
   * A zero-row result therefore means someone else got there first — another
   * instance, or this one before a restart. We skip it and move on; we do NOT
   * retry it, because the winner may already have broadcast.
   *
   * The select-then-claim shape is a scan hint, not a check: nothing is decided
   * by what the select returned. It only tells us which ids are worth trying.
   */
  async claimNext(): Promise<LpCommand | null> {
    const { data: pending, error: readError } = await this.client
      .from(TABLE)
      .select('id')
      .eq('user_id', this.options.userId)
      .eq('status', 'pending')
      .order('requested_at', { ascending: true })
      .limit(this.batchSize);

    if (readError) {
      throw new CommandSourceError(`Failed to poll LP commands: ${readError.message}`);
    }
    const candidates = (pending as { id: string }[] | null) ?? [];

    for (const candidate of candidates) {
      const { data, error } = await this.client
        .from(TABLE)
        .update({ status: 'claimed', claimed_at: new Date().toISOString() })
        .eq('id', candidate.id)
        // THE ATOMIC BIT. Without this predicate the update would happily
        // re-claim a command another instance is already executing.
        .eq('status', 'pending')
        .select('id, token_id, pool_address, action, requested_at');

      if (error) {
        throw new CommandSourceError(`Failed to claim LP command ${candidate.id}: ${error.message}`);
      }

      const rows = (data as CommandRow[] | null) ?? [];
      if (rows.length === 0) continue; // lost the race — someone else owns it now
      return rowToCommand(rows[0] as CommandRow);
    }

    return null;
  }

  /**
   * Record the outcome.
   *
   * Filtered on `status = 'claimed'` so this can only ever resolve a command
   * this process actually holds — it cannot overwrite an already-completed row,
   * and it cannot invent an outcome for a command it never claimed.
   *
   * A failure to write is thrown, not swallowed: the audit log is the record of
   * what happened to the funds, but this row is the record the human who
   * pressed the button reads, and leaving it stuck on `claimed` silently is how
   * a completed action looks like a hung one.
   */
  async complete(command: LpCommand, result: CommandResult): Promise<void> {
    const { error } = await this.client
      .from(TABLE)
      .update({
        status: result.error === null ? 'done' : 'failed',
        completed_at: new Date().toISOString(),
        tx_hash: result.txHash,
        error: result.error,
      })
      .eq('id', command.id)
      .eq('status', 'claimed');

    if (error) {
      throw new CommandSourceError(
        `Failed to record the outcome of LP command ${command.id}: ${error.message}`,
      );
    }
  }
}

/**
 * Build a Supabase-backed command source if configured, else null.
 *
 * Same contract as `createSupabasePolicySource`: null only when BOTH values are
 * absent, and a throw when the configuration is half-present, because that is
 * far more likely to be a deployment mistake than an intentional opt-out. With
 * no source configured the loop simply never polls, and the automation runs as
 * it did before this feature existed.
 */
export function createSupabaseCommandSource(
  env: NodeJS.ProcessEnv,
  userId: string,
): SupabaseCommandSource | null {
  const url = env.SUPABASE_URL?.trim();
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url && !key) return null;
  if (!url || !key) {
    throw new CommandSourceError(
      'Supabase command source is half-configured: set BOTH SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or neither.',
    );
  }
  if (!userId) {
    throw new CommandSourceError(
      'LP_POLICY_USER_ID is required when reading manual commands from Supabase.',
    );
  }
  return new SupabaseCommandSource({ url, serviceRoleKey: key, userId });
}
