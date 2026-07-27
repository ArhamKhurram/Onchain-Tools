// The execution step: the only code path in this workspace that can cause a
// transaction (plan §7, §10 step 5).
//
// ---------------------------------------------------------------------------
// THE ORDER IS THE SAFETY PROPERTY
// ---------------------------------------------------------------------------
//
//   guards -> dry run -> AUDIT INTENT -> signer.submit -> AUDIT OUTCOME
//
// Every arrow is load-bearing:
//
//  * Guards run at EXECUTION time, not at the time the candidate was surfaced.
//    A policy edit, or a pool removed from the allowlist, between the decision
//    and the broadcast must stop the broadcast. Checking only when the decision
//    was made would act on a permission that no longer exists (plan §9.2).
//
//  * The dry run runs BEFORE the intent write, so a transaction that would
//    revert never produces an intent record — and therefore never leaves a
//    phantom "possibly in flight" entry for the next startup to quarantine.
//
//  * The intent write is AWAITED and a failure is FATAL to the action. This is
//    the one place where failing closed is unambiguously correct: an unlogged
//    transaction over real funds is worse than a missed opportunity
//    (`audit/log.ts` header). There is no "log it later", no fire-and-forget,
//    no best-effort.
//
//  * The outcome write happens after, and if IT fails we deliberately leave the
//    intent unresolved rather than papering over it. `unresolved.ts` turns that
//    into a startup quarantine, which is exactly the signal a human needs.
//
// This module holds no key and constructs no client. It calls `simulate()` and
// `submit()` on an injected `TransactionSigner` and nothing else.

import type { OutcomeSnapshotExtra, PendingAction } from '../audit/log.js';
import type { PreparedTransaction } from '../calldata/types.js';
import { isPoolAllowed } from '../policy/pools.js';
import type { TransactionSigner } from '../signer/types.js';
import type { AutomationPolicy, Decision, LpPosition } from '../types.js';
import type { Quarantine } from './unresolved.js';
import type {
  ActionResult,
  AuditPort,
  Clock,
  ExecutableAction,
  IdFactory,
  Logger,
  Refusal,
} from './types.js';

export type TransactionReceiptInfo =
  | { status: 'success'; gasUsed: bigint; effectiveGasPrice: bigint }
  | { status: 'reverted' };

/** Optional post-receipt enrichment (enter/increase PnL fields from Krystal refresh). */
export interface OutcomeEnrichmentRequest {
  action: ExecutableAction;
  position: LpPosition;
  decision: Decision;
  txHash: string;
  receipt: TransactionReceiptInfo;
  preValueUsd: number;
}

export interface ExecutorDeps {
  audit: AuditPort;
  signer: TransactionSigner;
  logger: Logger;
  now: Clock;
  newId: IdFactory;
  /** Consulted on every action, for the process's whole lifetime. */
  quarantine: () => Quarantine;
  /**
   * Calldata older than this is refused. Krystal's quotes are perishable: the
   * amounts and the swap route inside `data` were computed against a price that
   * moves. Stale calldata mostly reverts (wasting gas), but a stale swap leg can
   * also execute at a materially worse price than the one we decided on.
   */
  calldataMaxAgeMs: number;
  /**
   * Wait for a mined receipt after broadcast. When provided, a `broadcast`
   * outcome is not treated as success until the receipt confirms `success`.
   */
  waitForReceipt?: (txHash: string) => Promise<TransactionReceiptInfo | null>;
  /** Native token USD price for converting receipt gas to dollars. */
  nativeTokenUsd?: number | null;
  /** Fallback per-tx gas estimate when receipt read is unavailable. */
  estimatedGasCostUsd?: number | null;
  enrichOutcomeSnapshot?: (request: OutcomeEnrichmentRequest) => Promise<OutcomeSnapshotExtra>;
}

export class ActionExecutor {
  constructor(private readonly deps: ExecutorDeps) {}

  /**
   * Checks that must hold before we spend anything — including the effort of
   * building calldata. Exposed so the loop can refuse early and cheaply; it is
   * re-run inside `execute` regardless, because "the caller already checked" is
   * not a guarantee this module is willing to rely on.
   */
  checkGuards(position: LpPosition, policy: AutomationPolicy): Refusal | null {
    const quarantine = this.deps.quarantine();
    if (quarantine.blocks(position.tokenId)) {
      return {
        rule: 'lifecycle.unresolved_intent',
        reason: quarantine.describe(position.tokenId),
      };
    }

    // THE GATE (see `policy/pools.ts`). Explicit allowlist membership, checked
    // here at the moment of execution against the policy resolved for THIS
    // position — not against whatever list surfaced the candidate earlier.
    if (!isPoolAllowed(policy, position.pool.address)) {
      return {
        rule: 'lifecycle.pool_not_allowed',
        reason:
          `pool ${position.pool.address} is not on policy v${policy.version}'s allowlist ` +
          `(${policy.allowedPools.length} pool(s)); refusing to execute`,
      };
    }

    return null;
  }

  /**
   * Run one action end to end.
   *
   * The caller is responsible for holding the position's lock (see `locks.ts`)
   * and for recording the refusal this returns; nothing here writes an
   * evaluation entry, so the loop keeps a single, auditable place where
   * "decision -> audit entry" happens.
   */
  async execute(request: {
    position: LpPosition;
    policy: AutomationPolicy;
    decision: Decision;
    action: ExecutableAction;
    transaction: PreparedTransaction;
    preValueUsd?: number;
  }): Promise<ActionResult> {
    const { position, policy, decision, action, transaction } = request;
    const { audit, signer, logger, now, newId } = this.deps;

    const guard = this.checkGuards(position, policy);
    if (guard !== null) return { status: 'refused', refusal: guard };

    const age = now() - transaction.meta.builtAt;
    if (age > this.deps.calldataMaxAgeMs) {
      return {
        status: 'refused',
        refusal: {
          rule: 'lifecycle.calldata_stale',
          reason: `calldata is ${age}ms old, past the ${this.deps.calldataMaxAgeMs}ms limit; re-quote before executing`,
        },
      };
    }

    // The id is minted BEFORE the dry run so the simulation, the intent record
    // and the outcome record all carry the same correlation id — a simulation
    // failure is then traceable to the attempt it belongs to.
    const auditId = newId();
    const submitRequest = { transaction, action, auditId } as const;

    // --- dry run ------------------------------------------------------------
    // `simulate()` is documented to never broadcast regardless of arm state,
    // and to run the same preflight `submit()` does. Using it (rather than a
    // bare eth_call) means the gate we pass here is the gate `submit` will
    // apply, instead of two divergent notions of "would this succeed".
    let simulation: Awaited<ReturnType<TransactionSigner['simulate']>>;
    try {
      simulation = await signer.simulate(submitRequest);
    } catch (error) {
      // A simulation that could not be RUN is not a simulation that passed.
      return {
        status: 'simulation_failed',
        refusal: {
          rule: 'lifecycle.simulation_error',
          reason: `simulation could not be run: ${describe(error)}`,
        },
      };
    }
    if (!simulation.ok) {
      return {
        status: 'simulation_failed',
        refusal: {
          rule: 'lifecycle.simulation_failed',
          reason: `dry run failed at ${simulation.stage ?? 'simulation'}: ${simulation.reason ?? 'no reason given'}`,
        },
      };
    }

    // --- intent (before the broadcast, always) -------------------------------
    const pending: PendingAction = { id: auditId, decision, startedAt: now() };
    try {
      await audit.recordIntent(pending);
    } catch (error) {
      logger.error('lp-lifecycle: intent write FAILED — refusing to submit', {
        auditId,
        tokenId: position.tokenId,
        action,
        error: describe(error),
      });
      return { status: 'intent_write_failed', error: describe(error) };
    }

    // --- broadcast -----------------------------------------------------------
    let outcome: Awaited<ReturnType<TransactionSigner['submit']>>;
    try {
      outcome = await signer.submit(submitRequest);
    } catch (error) {
      // A throw is indistinguishable from "it may have gone out". Record it as
      // a failure with a null hash so the intent is resolved, and say plainly
      // in the reason that the chain is the authority on what happened.
      outcome = {
        status: 'failed',
        reason: `signer threw: ${describe(error)} (chain state is authoritative — verify before retrying)`,
        txHash: null,
      };
    }

    const resolved = await this.resolveRecordedOutcome(outcome);
    const recorded = { txHash: resolved.txHash, error: resolved.error };
    let outcomeSnapshot = this.buildOutcomeSnapshot(recorded.txHash, recorded.error, resolved.receipt);
    if (recorded.error === null && recorded.txHash !== null && resolved.receipt?.status === 'success') {
      const enricher = this.deps.enrichOutcomeSnapshot;
      if (enricher !== undefined) {
        try {
          const extra = await enricher({
            action,
            position,
            decision,
            txHash: recorded.txHash,
            receipt: resolved.receipt,
            preValueUsd: request.preValueUsd ?? position.valueUsd,
          });
          if (Object.keys(extra).length > 0) outcomeSnapshot = { ...outcomeSnapshot, ...extra };
        } catch (error) {
          logger.warn('lp-lifecycle: outcome snapshot enrichment failed', {
            auditId,
            tokenId: position.tokenId,
            action,
            error: describe(error),
          });
        }
      }
    }
    try {
      await audit.recordOutcome(pending, recorded, now(), outcomeSnapshot);
    } catch (writeError) {
      logger.error(
        'lp-lifecycle: outcome write FAILED — intent left UNRESOLVED on purpose; ' +
          'the next startup will quarantine this position',
        { auditId, tokenId: position.tokenId, action, txHash: recorded.txHash, error: describe(writeError) },
      );
      return {
        status: 'outcome_write_failed',
        auditId,
        outcome,
        recorded,
        error: describe(writeError),
      };
    }

    const gasSpentUsd =
      typeof outcomeSnapshot.gasSpentUsd === 'number' && Number.isFinite(outcomeSnapshot.gasSpentUsd)
        ? outcomeSnapshot.gasSpentUsd
        : undefined;
    return { status: 'submitted', auditId, outcome, recorded, gasSpentUsd };
  }

  /**
   * Map signer output to the audit log's `{ txHash, error }` pair, then — when
   * configured — wait for the mined receipt so a reverted broadcast is not
   * recorded as success.
   */
  private async resolveRecordedOutcome(
    outcome: Awaited<ReturnType<TransactionSigner['submit']>>,
  ): Promise<{
    txHash: string | null;
    error: string | null;
    receipt: TransactionReceiptInfo | null;
  }> {
    const { txHash, error: submitError } = summarizeOutcome(outcome);
    if (submitError !== null || txHash === null) {
      return { txHash, error: submitError, receipt: null };
    }

    const waiter = this.deps.waitForReceipt;
    if (waiter === undefined) {
      return { txHash, error: null, receipt: null };
    }

    try {
      const receipt = await waiter(txHash);
      if (receipt === null) {
        return {
          txHash,
          error: `transaction receipt unavailable after timeout (tx ${txHash}); check chain before retrying`,
          receipt: null,
        };
      }
      if (receipt.status === 'reverted') {
        return {
          txHash,
          error: `transaction reverted on chain (tx ${txHash})`,
          receipt,
        };
      }
      return { txHash, error: null, receipt };
    } catch (readError) {
      return {
        txHash,
        error: `could not confirm transaction receipt (tx ${txHash}): ${describe(readError)}`,
        receipt: null,
      };
    }
  }

  /** Gas spent on a confirmed successful broadcast — merged into the outcome snapshot. */
  private buildOutcomeSnapshot(
    txHash: string | null,
    error: string | null,
    receipt: TransactionReceiptInfo | null,
  ): OutcomeSnapshotExtra {
    if (error !== null || txHash === null) return {};

    const extra: OutcomeSnapshotExtra = {};
    const nativeUsd = this.deps.nativeTokenUsd;
    if (nativeUsd !== null && nativeUsd !== undefined && Number.isFinite(nativeUsd) && nativeUsd > 0) {
      extra.nativeTokenUsd = nativeUsd;
    }

    if (receipt?.status === 'success' && receipt.gasUsed > 0n) {
      extra.gasUsed = receipt.gasUsed.toString();
      extra.effectiveGasPriceWei = receipt.effectiveGasPrice.toString();
      if (nativeUsd !== null && nativeUsd !== undefined && Number.isFinite(nativeUsd) && nativeUsd > 0) {
        const wei = receipt.gasUsed * receipt.effectiveGasPrice;
        const eth = Number(wei) / 1e18;
        if (Number.isFinite(eth)) {
          extra.gasSpentUsd = eth * nativeUsd;
        }
      }
    }

    if (extra.gasSpentUsd === undefined) {
      const estimate = this.deps.estimatedGasCostUsd;
      if (estimate !== null && estimate !== undefined && Number.isFinite(estimate) && estimate > 0) {
        extra.gasSpentUsd = estimate;
        extra.gasSpentEstimated = true;
      }
    }

    return extra;
  }
}

/**
 * Map a `SubmitOutcome` onto the audit log's `{ txHash, error }` pair.
 *
 * Only a genuine broadcast is a success. `skipped_disarmed` in particular is
 * recorded as a failure with a null hash — it is the honest record ("we did not
 * do this"), and it keeps a disarmed dry-run pass from being mistaken for a
 * completed action by `summarize()` or by `deriveLastCompounded`.
 */
function summarizeOutcome(
  outcome: Awaited<ReturnType<TransactionSigner['submit']>>,
): { txHash: string | null; error: string | null } {
  switch (outcome.status) {
    case 'broadcast':
      return { txHash: outcome.txHash, error: null };
    case 'skipped_disarmed':
      return { txHash: null, error: 'skipped: signer is disarmed (simulated only, nothing broadcast)' };
    case 'rejected':
      return { txHash: null, error: `rejected at ${outcome.stage}: ${outcome.reason}` };
    case 'failed':
      return { txHash: outcome.txHash, error: `failed: ${outcome.reason}` };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
