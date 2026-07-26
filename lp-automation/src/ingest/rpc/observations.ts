// Pure helpers for turning a batch of raw chain observations into "the current
// state", and for deciding when an observation is safe to act on.
//
// Two problems live here:
//
//  1. Ordering. A single `eth_subscribe` delivery (or one poll interval) can
//     carry several Swap logs for the same pool. Only the last one by
//     (blockNumber, logIndex) describes the pool's current tick — acting on an
//     earlier one would mean reacting to a price that has already moved.
//
//  2. Confirmation depth. Reorg tolerance is expressed as "how many blocks
//     behind the head was this observation", which is arithmetic, not I/O.

export interface OrderedLog {
  blockNumber: bigint | null;
  logIndex: number | null;
  /** True when the node is telling us this log was reorged out. */
  removed?: boolean | null;
}

/**
 * Chain-order comparator: negative when `a` precedes `b`.
 * Logs without a block number (pending) sort first — we never act on them.
 */
export function compareLogOrder(a: OrderedLog, b: OrderedLog): number {
  const aBlock = a.blockNumber;
  const bBlock = b.blockNumber;
  if (aBlock === null && bBlock === null) return (a.logIndex ?? -1) - (b.logIndex ?? -1);
  if (aBlock === null) return -1;
  if (bBlock === null) return 1;
  if (aBlock < bBlock) return -1;
  if (aBlock > bBlock) return 1;
  return (a.logIndex ?? -1) - (b.logIndex ?? -1);
}

/**
 * The latest usable log in a batch, or null if there is none.
 *
 * Skips logs flagged `removed` (reorged out) and logs with no block number
 * (pending). Does not mutate the input.
 */
export function pickLatestLog<T extends OrderedLog>(logs: readonly T[]): T | null {
  let latest: T | null = null;
  for (const log of logs) {
    if (log.removed === true) continue;
    if (log.blockNumber === null) continue;
    if (latest === null || compareLogOrder(latest, log) < 0) latest = log;
  }
  return latest;
}

/**
 * How many blocks behind the head an observation sits. A log mined in the head
 * block has depth 0.
 *
 * Clamped at 0 when the observation is ahead of our last known head — that
 * happens routinely, because a log can arrive over the subscription before the
 * newHeads notification for the same block does.
 */
export function confirmationDepth(observedBlock: bigint, headBlock: bigint): number {
  if (headBlock <= observedBlock) return 0;
  const diff = headBlock - observedBlock;
  const limit = BigInt(Number.MAX_SAFE_INTEGER);
  return diff > limit ? Number.MAX_SAFE_INTEGER : Number(diff);
}

/**
 * Has `observedBlock` accumulated `required` confirmations under `headBlock`?
 *
 * `required === 0` means "act on the unconfirmed head" and always returns true.
 * That disables reorg protection; see the confirmation policy note in
 * `poolWatcher.ts` before choosing it.
 */
export function isConfirmed(observedBlock: bigint, headBlock: bigint, required: number): boolean {
  if (!Number.isFinite(required) || required < 0) {
    throw new RangeError(`required confirmations must be a non-negative number, got ${required}`);
  }
  return confirmationDepth(observedBlock, headBlock) >= required;
}
