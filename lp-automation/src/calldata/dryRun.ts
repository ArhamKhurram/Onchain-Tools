// Off-chain dry run (plan §4, §7: "dry-run via staticCall before every broadcast").
//
// NOT A SIGNER. This module performs `eth_call` only, through a viem PUBLIC
// client. A public client has no account and cannot sign or send — that is the
// whole reason the seam is typed against `PublicClient` rather than something
// broader. Do not widen this to accept a wallet client, and do not add a
// `sendTransaction` path here; broadcasting belongs in `src/signer/` behind the
// Safe + Guard.
//
// The dry run is the layer that catches a transaction which WOULD REVERT. The
// Guard catches a transaction going to the wrong place or spending too much.
// They are complementary; see the header of `validate.ts`.

import type { PreparedTransaction } from './types.js';

/**
 * The narrow slice of viem's `PublicClient` we need. Structural typing keeps
 * this module decoupled from viem's version churn and, more importantly, makes
 * it impossible to pass something with signing capability by accident.
 */
export interface EthCallCapableClient {
  call(args: {
    account?: `0x${string}`;
    to: `0x${string}`;
    data?: `0x${string}`;
    value?: bigint;
  }): Promise<{ data?: `0x${string}` | undefined }>;
}

export type DryRunResult =
  | { ok: true; returnData: `0x${string}` | null; simulatedAt: number }
  | { ok: false; reason: string; simulatedAt: number };

export interface DryRunOptions {
  /**
   * Account to simulate `from`. Defaults to `tx.meta.from` (the Safe), which is
   * what the transaction was built for — simulating from anything else can pass
   * where the real execution would revert.
   */
  account?: `0x${string}`;
  now?: () => number;
}

/**
 * Simulate a `PreparedTransaction` with `eth_call`.
 *
 * Returns a result object rather than throwing on revert: a revert is an
 * expected, routine outcome (stale quote, moved price) that the lifecycle layer
 * should handle by re-quoting, not an exceptional one. Transport failures still
 * throw, because "the RPC is down" is not evidence that the transaction is safe.
 *
 * A `false` result MUST block the broadcast. Nothing here enforces that — the
 * caller does — so treat any code path that ignores the return value as a bug.
 */
export async function dryRun(
  tx: PreparedTransaction,
  client: EthCallCapableClient,
  options: DryRunOptions = {},
): Promise<DryRunResult> {
  const now = options.now ?? Date.now;
  const account = options.account ?? (tx.meta.from as `0x${string}`);

  try {
    const result = await client.call({ account, to: tx.to, data: tx.data, value: tx.value });
    return { ok: true, returnData: result.data ?? null, simulatedAt: now() };
  } catch (error) {
    if (isTransportFailure(error)) throw error;
    return { ok: false, reason: describeRevert(error), simulatedAt: now() };
  }
}

function isTransportFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const name = error.name;
  return (
    name === 'HttpRequestError' ||
    name === 'TimeoutError' ||
    name === 'SocketClosedError' ||
    name === 'WebSocketRequestError'
  );
}

function describeRevert(error: unknown): string {
  if (error instanceof Error) {
    const shortMessage = (error as { shortMessage?: unknown }).shortMessage;
    if (typeof shortMessage === 'string' && shortMessage.length > 0) return shortMessage;
    return error.message;
  }
  return String(error);
}
