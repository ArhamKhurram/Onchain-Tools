// The signer seam.
//
// This file is the contract between `lifecycle/` (which decides what to do) and
// `signer/` (which is the only code allowed to hold a key). It is import-free on
// purpose: nothing that consumes this interface should be able to reach a wallet
// client by following a type import.
//
// See LP_AUTOMATION_PLAN.md §4. The on-chain module is the real trust boundary;
// everything here is defence in depth in front of it.

import type { PreparedTransaction } from '../calldata/types.js';
import type { ActionKind } from '../types.js';

/**
 * Whether the process is allowed to broadcast at all.
 *
 * `disarmed` is the DEFAULT and must stay the default. A process that has a
 * funded key, a deployed module, and a working RPC is one config mistake away
 * from spending real money; requiring an explicit, separate opt-in means
 * "someone deployed it" and "someone armed it" are two distinct decisions with
 * two distinct moments to think.
 *
 * In `disarmed` mode everything runs — watch, evaluate, build calldata,
 * simulate, write the audit log — and the broadcast is the single step that is
 * skipped. That makes disarmed mode genuinely useful rather than a stub: it
 * exercises the whole pipeline and tells you what it *would* have done.
 */
export type ArmState = 'disarmed' | 'armed';

export interface SignerStatus {
  armState: ArmState;
  operatorAddress: string;
  safeAddress: string;
  moduleAddress: string;
  /** False if the Safe has not enabled the module — nothing can execute. */
  moduleEnabled: boolean;
  /** Native value still spendable in the module's current UTC-day bucket. */
  remainingDailyAllowanceWei: bigint;
  chainId: number;
}

export type SubmitOutcome =
  | { status: 'broadcast'; txHash: string }
  | { status: 'skipped_disarmed'; simulated: true }
  | { status: 'rejected'; reason: string; stage: PreflightStage }
  | { status: 'failed'; reason: string; txHash: string | null };

/**
 * Where a transaction died. Recorded in the audit log so a rejection is
 * diagnosable without re-running it — "rejected" alone is not an explanation.
 */
export type PreflightStage =
  | 'arm_check'
  | 'module_enabled'
  | 'destination_allowlist'
  | 'selector_allowlist'
  | 'value_cap'
  | 'daily_allowance'
  | 'simulation'
  | 'broadcast';

export interface SubmitRequest {
  transaction: PreparedTransaction;
  /** What this transaction is for — carried into the audit log. */
  action: ActionKind;
  /** Correlates with the audit log's intent record. */
  auditId: string;
}

/**
 * The only interface `lifecycle/` may use to cause a transaction.
 *
 * Implementations MUST, in order: check arm state, confirm the module is
 * enabled, re-check the destination and selector against the module's ON-CHAIN
 * allowlist (not a local copy — a local copy can drift), check the value and
 * remaining daily allowance, simulate, and only then broadcast. Every one of
 * those checks is duplicated on-chain by the module; doing them here as well
 * turns a silent revert that costs gas into a clear local rejection that costs
 * nothing.
 */
export interface TransactionSigner {
  getStatus(): Promise<SignerStatus>;
  /** Simulate only. Never broadcasts, regardless of arm state. */
  simulate(request: SubmitRequest): Promise<{ ok: boolean; reason?: string; stage?: PreflightStage }>;
  /** Full preflight, then broadcast if and only if armed. */
  submit(request: SubmitRequest): Promise<SubmitOutcome>;
}
