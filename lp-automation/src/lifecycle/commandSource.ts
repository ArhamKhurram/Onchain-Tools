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
import type { Address, RangeStrategy } from '../types.js';

const TABLE = 'lp_automation_commands';

/**
 * Actions a human can request.
 *
 * All but `enter` act on an EXISTING position and carry its `tokenId`. `enter`
 * opens a BRAND-NEW position, so it has no tokenId — it carries the pool, the
 * input token + amount and the range strategy instead. The two shapes are kept
 * from being confused by a database CHECK (see the enter migration) and by
 * `rowToCommand` below.
 */
export type CommandAction =
  | 'compound'
  | 'rebalance'
  | 'exit'
  | 'compound_rebalance'
  | 'enter'
  | 'increase';

const COMMAND_ACTIONS: readonly CommandAction[] = [
  'compound',
  'rebalance',
  'exit',
  'compound_rebalance',
  'enter',
  'increase',
];

/**
 * A claimed command: ours to execute, exactly once.
 *
 * `tokenId` is null for `enter` and a string for every other action. The enter
 * fields (`tokenInAddress`, `amountIn`, `rangeStrategy`, `swapSlippage`) are
 * present only for `enter`; `rowToCommand` enforces both halves of that.
 */
export interface LpCommand {
  id: string;
  /** Null for `enter` (the position does not exist yet); set otherwise. */
  tokenId: string | null;
  /** Pool the requester believed the position was in, or the enter target. Lowercased. */
  poolAddress: Address;
  action: CommandAction;
  /** Epoch ms. Used only for logging — staleness is judged on the calldata. */
  requestedAt: number;
  // --- enter-only (present iff action === 'enter') --------------------------
  /** The token the operator is zapping in. Lowercased. */
  tokenInAddress?: Address;
  /** Raw base units, decimal string. Never a number — precision loss. */
  amountIn?: string;
  /** Where to place the new range. Null means "use the policy default". */
  rangeStrategy?: RangeStrategy | null;
  /** Per-enter slippage override (fraction). Null means "use the builder default". */
  swapSlippage?: number | null;
  // --- increase-only (present iff action === 'increase') ------------------
  // Reuses tokenInAddress, amountIn and swapSlippage above; rangeStrategy must be null.
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
  token_id: string | null;
  pool_address: string;
  action: string;
  requested_at: string;
  // enter-only columns, null for every other action.
  token_in_address?: string | null;
  amount_in?: string | null;
  range_strategy?: string | null;
  swap_slippage?: string | number | null;
}

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const TOKEN_ID_PATTERN = /^[1-9][0-9]{0,77}$/;
const AMOUNT_PATTERN = /^[1-9][0-9]*$/;

/**
 * Map a row, refusing anything it cannot read unambiguously.
 *
 * Pure — exported for tests. Throws rather than repairing: a command row whose
 * action or pool we cannot read is not a command we may guess at, because the
 * guess would be a transaction. The `enter` branch validates its own required
 * fields the same way — a malformed enter is refused, never zapped with a
 * defaulted amount or pool.
 */
export function rowToCommand(row: CommandRow): LpCommand {
  if (typeof row.id !== 'string' || row.id.length === 0) {
    throw new CommandSourceError('command row has no id.');
  }
  if (!COMMAND_ACTIONS.includes(row.action as CommandAction)) {
    throw new CommandSourceError(`command ${row.id} has an unknown action: ${String(row.action)}`);
  }
  const action = row.action as CommandAction;

  const pool = typeof row.pool_address === 'string' ? row.pool_address.toLowerCase() : '';
  if (!ADDRESS_PATTERN.test(pool)) {
    throw new CommandSourceError(
      `command ${row.id} has a malformed pool_address: ${String(row.pool_address)}`,
    );
  }

  // A timestamp we cannot parse is logged as 0 rather than NaN: it is used only
  // for a log line, and NaN would serialize to null and read as "missing".
  const parsedAt = Date.parse(row.requested_at);
  const requestedAt = Number.isFinite(parsedAt) ? parsedAt : 0;

  if (action === 'enter') {
    // No tokenId — the position does not exist yet. Every enter parameter is
    // required and validated; the DB shape CHECK guarantees the same, but this
    // process does not trust the row it read to build a transaction.
    const tokenIn = typeof row.token_in_address === 'string' ? row.token_in_address.toLowerCase() : '';
    if (!ADDRESS_PATTERN.test(tokenIn)) {
      throw new CommandSourceError(
        `enter command ${row.id} has a malformed token_in_address: ${String(row.token_in_address)}`,
      );
    }
    if (typeof row.amount_in !== 'string' || !AMOUNT_PATTERN.test(row.amount_in)) {
      throw new CommandSourceError(
        `enter command ${row.id} has a malformed amount_in: ${String(row.amount_in)}`,
      );
    }
    const rangeStrategy = rangeStrategyOrNull(row.range_strategy, row.id);
    const swapSlippage = swapSlippageOrNull(row.swap_slippage, row.id);
    return {
      id: row.id,
      tokenId: null,
      poolAddress: pool as Address,
      action,
      requestedAt,
      tokenInAddress: tokenIn as Address,
      amountIn: row.amount_in,
      rangeStrategy,
      swapSlippage,
    };
  }

  if (action === 'increase') {
    const tokenIn = typeof row.token_in_address === 'string' ? row.token_in_address.toLowerCase() : '';
    if (!ADDRESS_PATTERN.test(tokenIn)) {
      throw new CommandSourceError(
        `increase command ${row.id} has a malformed token_in_address: ${String(row.token_in_address)}`,
      );
    }
    if (typeof row.amount_in !== 'string' || !AMOUNT_PATTERN.test(row.amount_in)) {
      throw new CommandSourceError(
        `increase command ${row.id} has a malformed amount_in: ${String(row.amount_in)}`,
      );
    }
    if (row.range_strategy !== null && row.range_strategy !== undefined) {
      throw new CommandSourceError(
        `increase command ${row.id} must not carry range_strategy: ${String(row.range_strategy)}`,
      );
    }
    const swapSlippage = swapSlippageOrNull(row.swap_slippage, row.id);
    if (typeof row.token_id !== 'string' || !TOKEN_ID_PATTERN.test(row.token_id)) {
      throw new CommandSourceError(`increase command ${row.id} has a malformed token_id: ${String(row.token_id)}`);
    }
    return {
      id: row.id,
      tokenId: row.token_id,
      poolAddress: pool as Address,
      action,
      requestedAt,
      tokenInAddress: tokenIn as Address,
      amountIn: row.amount_in,
      swapSlippage,
    };
  }

  if (typeof row.token_id !== 'string' || !TOKEN_ID_PATTERN.test(row.token_id)) {
    throw new CommandSourceError(`command ${row.id} has a malformed token_id: ${String(row.token_id)}`);
  }

  return {
    id: row.id,
    tokenId: row.token_id,
    poolAddress: pool as Address,
    action,
    requestedAt,
  };
}

/** null (use the policy default) or a known strategy; anything else is corrupt. */
function rangeStrategyOrNull(value: unknown, id: string): RangeStrategy | null {
  if (value === null || value === undefined) return null;
  if (value === 'narrow' || value === 'wide' || value === 'full') return value;
  throw new CommandSourceError(`enter command ${id} has an unknown range_strategy: ${String(value)}`);
}

/** null (use the builder default) or a fraction in (0, 0.05]; anything else is corrupt. */
function swapSlippageOrNull(value: unknown, id: string): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > 0.05) {
    throw new CommandSourceError(`enter command ${id} has an out-of-range swap_slippage: ${String(value)}`);
  }
  return n;
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
        .select(
          'id, token_id, pool_address, action, requested_at, token_in_address, amount_in, range_strategy, swap_slippage',
        );

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
