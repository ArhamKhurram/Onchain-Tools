// Manual lifecycle actions — compound, rebalance, exit.
//
// THE ONE THING THIS MODULE EXISTS TO PREVENT: a button that looks like it acted.
//
// `POST /api/lp/positions/:tokenId/actions` does not compound anything. It
// writes a row that a separate worker process claims a few seconds later. Every
// piece of copy below therefore names a QUEUE STATE, never a past-tense outcome,
// until the worker has actually reported one. "Compounded" is a lie for the
// several seconds that matter most, and the cost of that lie is specific: the
// operator clicks again, and now there are two withdrawals in flight against one
// position.
//
// The second rule: an action that the API would reject is DISABLED with the
// reason visible, never enabled-then-409. The 409 conditions are knowable from
// data the page already holds (`PositionCoverage`), so letting the click through
// only to fail is a round trip that teaches nothing.

import type { PositionCoverage } from './positions';

// --- API contract mirror ----------------------------------------------------
//
// Restated here for the same reason as `positions.ts`: `lp-automation/` is a
// separate workspace the console does not depend on. Keep in sync with
// `POST /api/lp/positions/:tokenId/actions` and `GET /api/lp/commands`.

export type LpCommandAction = 'compound' | 'rebalance' | 'exit' | 'compound_rebalance' | 'increase' | 'decrease';

/**
 * `pending | claimed | done | failed` are the states the API actually stores.
 *
 * `skipped` is accepted in addition, for forward compatibility. Today a queued
 * action that reaches a DISARMED signer is stored as `failed` carrying an error
 * that begins "skipped: …" — see `lp-automation/src/lifecycle/commandSource.ts`,
 * where `error === null` is the only thing that records `done`. The wire format
 * is honest; it is the word "failed" that is misleading to an operator, since
 * nothing was broadcast and nothing is broken. `presentCommand` reads that case
 * back out — see `isSkipReport`.
 *
 * `unknown` is the parse fallback. An unrecognised state is treated as
 * *unresolved*, never as success — see `isCommandInFlight`.
 */
export type LpCommandStatus = 'pending' | 'claimed' | 'done' | 'failed' | 'skipped' | 'unknown';

export interface LpCommand {
  id: string;
  tokenId: string;
  action: LpCommandAction;
  status: LpCommandStatus;
  requestedAt: string | null;
  completedAt: string | null;
  /** Present only once the worker broadcast something. */
  txHash: string | null;
  error: string | null;
}

export const COMMAND_ACTIONS: readonly LpCommandAction[] = [
  'compound',
  'rebalance',
  'compound_rebalance',
  'increase',
  'decrease',
  'exit',
];

const ACTION_SET = new Set<string>(COMMAND_ACTIONS);

export function isCommandAction(value: unknown): value is LpCommandAction {
  return typeof value === 'string' && ACTION_SET.has(value);
}

const STATUS_SET = new Set<string>(['pending', 'claimed', 'done', 'failed', 'skipped']);

function parseStatus(value: unknown): LpCommandStatus {
  if (typeof value === 'string' && STATUS_SET.has(value)) return value as LpCommandStatus;
  return 'unknown';
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Total over anything an HTTP boundary can produce. A row missing its `action`
 * is dropped rather than coerced — a command whose action we cannot name is one
 * we cannot honestly describe, and a mislabelled `exit` is unforgivable.
 */
export function parseCommand(raw: unknown): LpCommand | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (!isCommandAction(record.action)) return null;

  const id = optionalString(record.id);
  const tokenId =
    typeof record.tokenId === 'string'
      ? record.tokenId
      : typeof record.tokenId === 'number'
        ? String(record.tokenId)
        : null;
  if (!id || tokenId === null) return null;

  return {
    id,
    tokenId,
    action: record.action,
    status: parseStatus(record.status),
    requestedAt: optionalString(record.requestedAt),
    completedAt: optionalString(record.completedAt),
    txHash: optionalString(record.txHash),
    error: optionalString(record.error),
  };
}

function requestedAtMs(command: LpCommand): number {
  if (!command.requestedAt) return 0;
  const time = new Date(command.requestedAt).getTime();
  return Number.isFinite(time) ? time : 0;
}

/**
 * Newest first. The API already promises that order; re-sorting here means a
 * merged optimistic row (from the POST response) lands in the right place
 * without waiting for the next poll to correct it.
 */
export function parseCommands(raw: unknown): LpCommand[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).commands)
      ? ((raw as Record<string, unknown>).commands as unknown[])
      : [];

  return list
    .map(parseCommand)
    .filter((entry): entry is LpCommand => entry !== null)
    .sort((a, b) => {
      const delta = requestedAtMs(b) - requestedAtMs(a);
      if (delta !== 0) return delta;
      return b.id.localeCompare(a.id);
    });
}

/** De-duplicates by id, keeping the newer copy. Used to merge a POST result in. */
export function mergeCommands(existing: readonly LpCommand[], incoming: readonly LpCommand[]): LpCommand[] {
  const byId = new Map<string, LpCommand>();
  for (const command of existing) byId.set(command.id, command);
  // Incoming wins: a poll result is fresher than the optimistic row it replaces.
  for (const command of incoming) byId.set(command.id, command);
  return parseCommands(Array.from(byId.values()));
}

// --- Lifecycle --------------------------------------------------------------

/**
 * The worker has not finished with this yet.
 *
 * Deliberately a whitelist rather than `!settled`: an unrecognised status must
 * not keep the page polling forever, and must not be silently promoted to done
 * either. It reads as unresolved and stops.
 */
export function isCommandInFlight(status: LpCommandStatus): boolean {
  return status === 'pending' || status === 'claimed';
}

export function isCommandSettled(status: LpCommandStatus): boolean {
  return !isCommandInFlight(status);
}

/** True only where the worker actually executed something on chain. */
export function didCommandExecute(command: LpCommand): boolean {
  return command.status === 'done';
}

export function latestCommandFor(commands: readonly LpCommand[], tokenId: string): LpCommand | null {
  for (const command of commands) {
    if (command.tokenId === tokenId) return command;
  }
  return null;
}

/** The action currently occupying this position, if any. Drives the 409 guard. */
export function inFlightActionFor(
  commands: readonly LpCommand[],
  tokenId: string,
): LpCommandAction | null {
  for (const command of commands) {
    if (command.tokenId === tokenId && isCommandInFlight(command.status)) return command.action;
  }
  return null;
}

/** True while anything at all is unsettled — the poll's own on/off switch. */
export function hasCommandInFlight(commands: readonly LpCommand[]): boolean {
  return commands.some((command) => isCommandInFlight(command.status));
}

// --- Presentation -----------------------------------------------------------

export interface ActionMeta {
  label: string;
  /** Used mid-sentence: "a compound is already queued". */
  noun: string;
  /** What it will do, stated as the consequence rather than the API call. */
  description: string;
  /** Exit is one-way. Rendered apart from the other two. */
  destructive: boolean;
}

export const ACTION_META: Record<LpCommandAction, ActionMeta> = {
  compound: {
    label: 'Compound',
    noun: 'compound',
    description:
      'Claims the unclaimed fees and puts them back into this position. The range is not moved.',
    destructive: false,
  },
  rebalance: {
    label: 'Rebalance',
    noun: 'rebalance',
    description:
      'Moves the range around the current price. The position is withdrawn and re-minted, so whatever is in it today is realised in the process.',
    destructive: false,
  },
  compound_rebalance: {
    label: 'Compound + rebalance',
    noun: 'compound and rebalance',
    description:
      'Claims unclaimed fees back into the position, then recenters the range around the current price. Two on-chain steps, one queue entry.',
    destructive: false,
  },
  increase: {
    label: 'Add liquidity',
    noun: 'add liquidity',
    description:
      'Zaps more of one token into this position without changing the range. The worker auto-approves WETH to Krystal when needed.',
    destructive: false,
  },
  decrease: {
    label: 'Remove liquidity',
    noun: 'remove liquidity',
    description: 'Withdraws part of the position and swaps to one token via Krystal withdraw_and_swap.',
    destructive: false,
  },
  exit: {
    label: 'Exit',
    noun: 'exit',
    description:
      'Withdraws the whole position and its fees back to the Safe. There is no undo — reopening is a new entry, and it spends against the daily cap.',
    destructive: true,
  },
};

export type CommandTone = 'queued' | 'running' | 'done' | 'failed' | 'skipped' | 'unknown';

export interface CommandPresentation {
  tone: CommandTone;
  /** One word for a chip. */
  label: string;
  /** Names the action AND the state. Never the action alone. */
  headline: string;
  /** What is literally true on chain right now. */
  detail: string;
  txHash: string | null;
  error: string | null;
  inFlight: boolean;
}

/**
 * The exact prefix the worker writes when it declined to act rather than
 * failed. Must stay in sync with `lp-automation/src/lifecycle/loop.ts`.
 *
 * This is an unenforced cross-process string contract — the two live in
 * separate workspaces with no shared type — so it is pinned here as a constant
 * and asserted against the real worker string in the tests. The first version
 * of this used /^\s*skipped\b/i, which silently did NOT match the actual
 * `skipped_disarmed:` the worker emits: `_` is a word character, so `\b` never
 * fires between "skipped" and "_disarmed". A disarmed skip therefore rendered
 * as a red FAILED — the precise misreading this function exists to prevent.
 */
export const SKIP_REPORT_PREFIX = 'skipped';

/**
 * True when a `failed` row is really "the worker declined to act".
 *
 * Presentation only. If the worker's wording ever changes this returns false
 * and the row renders as an ordinary failure with its reason shown verbatim —
 * the same text either way. Nothing downstream branches on it, so a miss
 * degrades to a harsher label rather than to a claim that isn't true.
 */
export function isSkipReport(error: string | null): boolean {
  return error !== null && error.trimStart().toLowerCase().startsWith(SKIP_REPORT_PREFIX);
}

export function presentCommand(command: LpCommand): CommandPresentation {
  const meta = ACTION_META[command.action];
  const base = { txHash: command.txHash, error: command.error };

  switch (command.status) {
    case 'pending':
      return {
        ...base,
        tone: 'queued',
        label: 'Queued',
        headline: `${meta.label} queued`,
        detail:
          'Written to the command queue. The worker has not picked it up, and nothing has been sent on-chain.',
        inFlight: true,
      };
    case 'claimed':
      return {
        ...base,
        tone: 'running',
        label: 'Running',
        headline: `${meta.label} running`,
        detail:
          'The worker has claimed this and is building and broadcasting the transaction. It is not confirmed yet.',
        inFlight: true,
      };
    case 'done':
      return {
        ...base,
        tone: 'done',
        label: 'Done',
        headline: `${meta.label} done`,
        detail: command.txHash
          ? 'Executed on-chain. The transaction hash below is the receipt.'
          : 'The worker reported this complete but returned no transaction hash, so there is nothing to check against an explorer.',
        inFlight: false,
      };
    case 'failed':
      // A no-op is not a failure. A disarmed signer never touched the chain,
      // and rendering that in flame next to "failed" would send the operator
      // looking for a broken transaction that does not exist.
      if (isSkipReport(command.error)) {
        return {
          ...base,
          tone: 'skipped',
          label: 'Skipped',
          headline: `${meta.label} skipped`,
          detail: `${command.error} Nothing was broadcast, and nothing changed on-chain.`,
          inFlight: false,
        };
      }
      return {
        ...base,
        tone: 'failed',
        label: 'Failed',
        headline: `${meta.label} failed`,
        detail:
          command.error ??
          'The worker reported a failure and gave no reason. Nothing here says whether a transaction was broadcast — check the Safe before retrying.',
        inFlight: false,
      };
    case 'skipped':
      return {
        ...base,
        tone: 'skipped',
        label: 'Skipped',
        headline: `${meta.label} skipped`,
        detail:
          command.error ??
          'The automation was disarmed when the worker reached this, so it was not executed. Nothing changed on-chain.',
        inFlight: false,
      };
    default:
      return {
        ...base,
        tone: 'unknown',
        label: 'Unknown',
        headline: `${meta.label} — state not recognised`,
        detail:
          'The worker reported a state this console does not know. Treat it as unresolved rather than as done, and check the Safe before queueing anything else.',
        inFlight: false,
      };
  }
}

/**
 * Guarantees a refusal ends by saying nothing was enqueued — without saying it
 * twice. Several of the server's own refusals already end that way, and
 * "…so it was not queued. Nothing was queued." reads like a bug in the page,
 * which is exactly the wrong impression to give while refusing a money action.
 */
export function withNothingQueued(message: string): string {
  return /not queued|nothing was queued/i.test(message) ? message : `${message} Nothing was queued.`;
}

/** `0x1234…cdef` for a 32-byte hash — `shortAddress` is sized for 20 bytes. */
export function shortTxHash(hash: string | null): string | null {
  if (!hash) return null;
  if (hash.length <= 18) return hash;
  return `${hash.slice(0, 10)}…${hash.slice(-8)}`;
}

// --- Availability -----------------------------------------------------------

export interface ActionAvailability {
  enabled: boolean;
  /** Present exactly when `enabled` is false. Shown, not hidden behind a tooltip. */
  reason: string | null;
}

const ALLOWED: ActionAvailability = { enabled: true, reason: null };

export interface ActionAvailabilityInput {
  action: LpCommandAction;
  /** Derived by `positionCoverage` — the same policy fact the API checks. */
  coverage: PositionCoverage;
  /** An unsettled command already occupies this position. */
  inFlight: LpCommandAction | null;
  /** The backend has no manual-actions route yet. */
  apiUnavailable?: boolean;
}

/**
 * Mirrors the two documented 409 conditions client-side, plus the cases where a
 * request would be pointless.
 *
 * `pending_allowlist` is disabled on purpose: a pool ticked in the draft is not
 * in the saved policy, and the saved policy is what the worker reads. Enabling
 * it would produce a 409 whose message ("pool is not allowlisted") flatly
 * contradicts the tick the operator can see on screen.
 *
 * `pending_removal` is enabled on purpose: the pool is still on the saved
 * allowlist, so the action is still legal today. The unsaved removal is a
 * future fact, and disabling on it would block a legal action for a reason that
 * is not yet true.
 */
export function actionAvailability({
  action,
  coverage,
  inFlight,
  apiUnavailable = false,
}: ActionAvailabilityInput): ActionAvailability {
  if (coverage === 'closed') {
    return {
      enabled: false,
      reason: 'This position is closed. There is nothing left to compound, rebalance, exit, or compound-and-rebalance.',
    };
  }

  if (apiUnavailable) {
    return {
      enabled: false,
      reason: 'This backend has no manual-actions API yet, so there is no queue to write to.',
    };
  }

  if (coverage === 'unknown') {
    return {
      enabled: false,
      reason:
        'The policy could not be read, so whether this pool is allowlisted is unknown. Refresh before queueing an action the worker may reject.',
    };
  }

  if (coverage === 'unmanaged') {
    return {
      enabled: false,
      reason:
        'The worker only acts on allowlisted pools. Add this pool to the allowlist and save the policy first.',
    };
  }

  if (coverage === 'pending_allowlist') {
    return {
      enabled: false,
      reason:
        'This pool is ticked but not saved. The worker reads the saved policy, so save before queueing anything.',
    };
  }

  if (inFlight !== null) {
    return {
      enabled: false,
      reason:
        inFlight === action
          ? `A ${ACTION_META[action].noun} is already queued for this position. Wait for it to settle.`
          : `A ${ACTION_META[inFlight].noun} is already queued for this position. Only one action runs at a time.`,
    };
  }

  return ALLOWED;
}

// --- Fee accrual ------------------------------------------------------------

export interface FeeAccrual {
  feesUsd: number | null;
  valueUsd: number | null;
  /** Unclaimed fees as a percentage of position value. Null when unknowable. */
  percentOfValue: number | null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * A ratio, deliberately not a rate.
 *
 * A fees-per-day figure would need a history this feed does not have (see
 * `LpPositionHistorySlot`), and inventing one by dividing unclaimed fees by an
 * assumed age would be a fabricated number on a page about real money.
 */
export function feeAccrual(position: {
  valueUsd: unknown;
  unclaimedFeesUsd: unknown;
}): FeeAccrual {
  const feesUsd = finite(position.unclaimedFeesUsd);
  const valueUsd = finite(position.valueUsd);
  const percentOfValue =
    feesUsd !== null && valueUsd !== null && valueUsd > 0 ? (feesUsd / valueUsd) * 100 : null;
  return { feesUsd, valueUsd, percentOfValue };
}

export function describeFeeAccrual(accrual: FeeAccrual, coverage: PositionCoverage): string {
  if (accrual.feesUsd === null) {
    return 'The quote carried no fee figure for this position.';
  }
  const share =
    accrual.percentOfValue === null
      ? ''
      : ` — ${accrual.percentOfValue.toFixed(accrual.percentOfValue >= 1 ? 1 : 2)}% of the position's value`;

  if (accrual.feesUsd <= 0) {
    return 'Nothing has accrued since the last claim.';
  }
  if (coverage === 'managed' || coverage === 'pending_removal') {
    return `Sitting in the position${share}. The automation compounds it when the fee-versus-gas trigger clears.`;
  }
  return `Sitting unclaimed${share}. Nothing is compounding it, and it keeps accruing either way.`;
}
