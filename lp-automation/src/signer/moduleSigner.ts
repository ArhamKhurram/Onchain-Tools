// ============================================================================
// THE ONLY CODE IN THIS SYSTEM THAT MAY HOLD A KEY.
// ============================================================================
//
// Read LP_AUTOMATION_PLAN.md §4 before changing anything here.
//
// This class turns an inert `PreparedTransaction` into a broadcast. Everything
// upstream of it — ingest, rules, calldata validation — is arithmetic and
// parsing; a bug there costs a wrong decision. A bug HERE costs funds.
//
// Three properties are load-bearing. Each is stated as a rule because each has
// an obvious-looking "improvement" that quietly removes it:
//
//  1. THE ALLOWLIST IS RE-READ FROM THE CHAIN, EVERY TIME.
//     `calldata/validate.ts` already checks the destination against a local
//     list. That list is a MIRROR of the module's on-chain allowlist and mirrors
//     drift: an owner narrows the on-chain list, nobody redeploys this process,
//     and the local copy now authorizes something the chain does not. The chain
//     is authoritative. Do not "optimize" these reads into a cached config.
//
//  2. FAIL CLOSED, ALWAYS.
//     A check that cannot be EVALUATED is a rejection. An RPC timeout, a
//     malformed response, a node returning a string where a bool belongs — none
//     of these are evidence that a transaction is safe, and none may be treated
//     as a pass. There is no `catch { /* assume fine */ }` in this file and
//     there must never be one.
//
//  3. THE KEY IS NEVER OBSERVABLE.
//     The key is read once from env, converted to a viem account, and dropped
//     (see `clients.ts`). This class holds only `#`-private fields, so
//     `JSON.stringify(signer)` is `{}`. No status object, error message, or
//     audit record built here contains key material, and no field may be added
//     that would.
//
// The on-chain module duplicates every check below. That is not redundancy for
// its own sake: the module is what stops a COMPROMISED version of this process,
// and these checks are what turn a silent, gas-burning revert into a labelled
// local rejection. Neither replaces the other.

import { OCT_AUTOMATION_MODULE_ABI } from './abi.js';
import type { SignerConfig } from './config.js';
import type { SignerPublicClient, SignerWalletClient } from './clients.js';
import type { Address } from '../types.js';
import type {
  ArmState,
  PreflightStage,
  SignerStatus,
  SubmitOutcome,
  SubmitRequest,
  TransactionSigner,
} from './types.js';

/** Thrown when a chain read fails or comes back the wrong shape. Never a pass. */
export class SignerReadError extends Error {
  readonly functionName: string;

  constructor(functionName: string, detail: string) {
    super(`module.${functionName}() could not be evaluated: ${detail}`);
    this.name = 'SignerReadError';
    this.functionName = functionName;
  }
}

/**
 * `SignerStatus` plus the things the interface has no field for but an operator
 * genuinely needs to see. Returned from `getStatus()`; assignable to
 * `SignerStatus`, so the fixed interface is satisfied without widening it.
 */
export interface ModuleSignerStatus extends SignerStatus {
  /** Owner-controlled kill switch. True means nothing executes, module enabled or not. */
  readonly paused: boolean;
  /** Whether our operator address is actually authorized on the module. */
  readonly operatorAuthorized: boolean;
  /** Whether `module.safe()` matches `LP_SAFE_ADDRESS`. False = pointed at a foreign Safe. */
  readonly safeMatchesConfig: boolean;
  /** Per-transaction native value cap, read from the module. */
  readonly maxValuePerTxWei: bigint;
  /** The Safe address the MODULE reports, which may differ from the configured one. */
  readonly onChainSafeAddress: Address;
}

/**
 * `SubmitOutcome` carrying the caller's audit id back.
 *
 * The id is echoed, not used: dedup state belongs to the caller (it owns the
 * audit log and therefore owns the question "did I already do this?"). Holding
 * a second copy of that state here would create two sources of truth for
 * whether an action has run, which is exactly the ambiguity that causes a
 * double-spend after a crash.
 */
export type ModuleSubmitOutcome = SubmitOutcome & {
  readonly auditId: string;
  readonly armState: ArmState;
};

export type PreflightRejection = { readonly ok: false; readonly reason: string; readonly stage: PreflightStage };
type PreflightPass = { readonly ok: true; readonly simulatedRequest: unknown };
type PreflightResult = PreflightPass | PreflightRejection;

export interface ModuleTransactionSignerDeps {
  readonly config: SignerConfig;
  readonly publicClient: SignerPublicClient;
  readonly walletClient: SignerWalletClient;
  /** Derived from the key by `createModuleClients`. Public information. */
  readonly operatorAddress: Address;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Order is the contract, not an implementation detail. See `types.ts`. */
export const PREFLIGHT_ORDER: readonly PreflightStage[] = [
  'arm_check',
  'module_enabled',
  'destination_allowlist',
  'selector_allowlist',
  'value_cap',
  'daily_allowance',
  'simulation',
  'broadcast',
];

export class ModuleTransactionSigner implements TransactionSigner {
  // `#`-private: not enumerable, not reachable, not serializable. The absence of
  // any key-bearing field here is a deliberate invariant, tested in
  // `test/signer.test.ts`.
  readonly #config: SignerConfig;
  readonly #publicClient: SignerPublicClient;
  readonly #walletClient: SignerWalletClient;
  readonly #operatorAddress: Address;

  constructor(deps: ModuleTransactionSignerDeps) {
    this.#config = deps.config;
    this.#publicClient = deps.publicClient;
    this.#walletClient = deps.walletClient;
    this.#operatorAddress = deps.operatorAddress.toLowerCase() as Address;
  }

  /** Public information only. Safe to log. */
  get operatorAddress(): Address {
    return this.#operatorAddress;
  }

  get armState(): ArmState {
    return this.#config.armState;
  }

  /**
   * Report what the chain actually says.
   *
   * THROWS rather than reporting a default when a read fails. "moduleEnabled:
   * false" because the RPC timed out is a lie in the shape of a safety
   * assertion, and an operator staring at a dashboard cannot tell the two apart.
   * A thrown `SignerReadError` says "I don't know", which is the truth.
   */
  async getStatus(): Promise<ModuleSignerStatus> {
    const onChainSafeAddress = await this.#readAddress('safe', []);
    const moduleEnabled = await this.#readBoolean('isModuleEnabledOnSafe', []);
    const paused = await this.#readBoolean('paused', []);
    const operatorAuthorized = await this.#readBoolean('isOperator', [this.#operatorAddress]);
    const remainingDailyAllowanceWei = await this.#readBigInt('remainingDailyAllowance', []);
    const maxValuePerTxWei = await this.#readBigInt('maxValuePerTx', []);

    return {
      armState: this.#config.armState,
      operatorAddress: this.#operatorAddress,
      safeAddress: this.#config.safeAddress,
      moduleAddress: this.#config.moduleAddress,
      moduleEnabled,
      remainingDailyAllowanceWei,
      chainId: this.#config.chainId,
      paused,
      operatorAuthorized,
      safeMatchesConfig: onChainSafeAddress === this.#config.safeAddress,
      maxValuePerTxWei,
      onChainSafeAddress,
    };
  }

  /**
   * Run the full ladder up to and including simulation, and stop.
   *
   * Never broadcasts, in any arm state — there is no code path from here to
   * `writeContract`. Useful on its own (a lifecycle dry run) and reused
   * verbatim by `submit`, so the two can never diverge.
   */
  async simulate(request: SubmitRequest): Promise<{ ok: boolean; reason?: string; stage?: PreflightStage }> {
    const result = await this.#preflight(request);
    if (result.ok) return { ok: true };
    return { ok: false, reason: result.reason, stage: result.stage };
  }

  /**
   * Full preflight, then broadcast if and only if armed.
   *
   * Ladder order (identical in disarmed mode — the ONLY thing disarming removes
   * is the send):
   *
   *   1. arm_check             — resolve arm state; verify this transaction was
   *                              built for THIS chain and THIS Safe.
   *   2. module_enabled        — module.safe() matches config, module is enabled
   *                              on the Safe, not paused, and our operator key is
   *                              authorized.
   *   3. destination_allowlist — `to` is not the Safe/module/zero, and
   *                              module.isAllowedTarget(to) is true ON-CHAIN.
   *   4. selector_allowlist    — calldata carries a selector, it matches the
   *                              transaction's own metadata, and
   *                              module.isAllowedSelector(to, selector) is true
   *                              ON-CHAIN.
   *   5. value_cap             — value <= module.maxValuePerTx().
   *   6. daily_allowance       — value <= module.remainingDailyAllowance().
   *   7. simulation            — eth_call of module.execute(...) FROM the
   *                              operator. A revert here is a rejection.
   *   8. broadcast             — armed only.
   */
  async submit(request: SubmitRequest): Promise<ModuleSubmitOutcome> {
    const { auditId } = request;
    const armState = this.#config.armState;

    const preflight = await this.#preflight(request);
    if (!preflight.ok) {
      return { status: 'rejected', reason: preflight.reason, stage: preflight.stage, auditId, armState };
    }

    // THE ARM GATE. This comparison is the only thing standing between a
    // simulated transaction and a real one, and this is the only call site of
    // `writeContract` in the codebase. Disarmed means the entire ladder above
    // has already run, including the simulation — so a disarmed run tells you
    // exactly what an armed run would have done.
    if (armState !== 'armed') {
      return { status: 'skipped_disarmed', simulated: true, auditId, armState };
    }

    try {
      // Broadcasts the SIMULATED request verbatim. Rebuilding it here would mean
      // sending something that was never simulated.
      const txHash = await this.#walletClient.writeContract(preflight.simulatedRequest);

      if (typeof txHash !== 'string' || !TX_HASH.test(txHash)) {
        // The send may well have landed; we simply cannot name it. Reported as
        // `failed` with a null hash so the caller reconciles against the chain
        // rather than assuming nothing happened.
        return {
          status: 'failed',
          reason: 'wallet client returned a value that is not a transaction hash; the send may still have landed',
          txHash: null,
          auditId,
          armState,
        };
      }

      return { status: 'broadcast', txHash, auditId, armState };
    } catch (error) {
      // ======================================================================
      // NO RETRY. NOT HERE, NOT ANYWHERE ABOVE THIS.
      // ======================================================================
      // A failed send is NOT a proof of non-execution. A timeout, a dropped
      // socket, or a provider 500 can all occur AFTER the transaction was
      // accepted into the mempool, and it can be mined seconds later. Resending
      // the same intent produces a second, independently valid transaction: two
      // compounds, two rebalances, two withdrawals — each one within the daily
      // cap, so the on-chain module will happily allow both.
      //
      // The only safe recovery is reconciliation: return a null hash, let the
      // caller match `auditId` against the audit log and the chain, and decide
      // with evidence. Retrying here would be guessing with the user's funds.
      // If you are adding a retry loop, you are adding a double-spend.
      return { status: 'failed', reason: describeError(error), txHash: null, auditId, armState };
    }
  }

  // -------------------------------------------------------------------------
  // Preflight
  // -------------------------------------------------------------------------

  async #preflight(request: SubmitRequest): Promise<PreflightResult> {
    const tx = request.transaction;
    const to = tx.to.toLowerCase() as Address;
    const { safeAddress, moduleAddress, chainId } = this.#config;

    // --- 1. arm_check ------------------------------------------------------
    // Arm state itself never rejects — disarmed is a valid, fully-exercised
    // mode, not an error. What this stage rejects is a transaction that does
    // not belong to this deployment at all: built for another chain, or built
    // for an account that is not our Safe. Those are checked first because
    // every later check is meaningless if the transaction is not ours.
    if (tx.meta.chainId !== chainId) {
      return reject('arm_check', `transaction was built for chain ${tx.meta.chainId}, signer is on chain ${chainId}`);
    }
    if (tx.meta.from.toLowerCase() !== safeAddress) {
      return reject(
        'arm_check',
        `transaction was built for ${tx.meta.from.toLowerCase()}, which is not the configured Safe ${safeAddress}`,
      );
    }

    // --- 2. module_enabled -------------------------------------------------
    // Four distinct ways the module can be unable to execute for us. All four
    // live in this stage because the answer to each is the same: nothing this
    // process does can proceed until a Safe owner acts.
    try {
      const onChainSafe = await this.#readAddress('safe', []);
      if (onChainSafe !== safeAddress) {
        return reject(
          'module_enabled',
          `module ${moduleAddress} executes out of ${onChainSafe}, not the configured Safe ${safeAddress}`,
        );
      }

      const enabled = await this.#readBoolean('isModuleEnabledOnSafe', []);
      if (!enabled) {
        return reject('module_enabled', `Safe ${safeAddress} has not enabled module ${moduleAddress}`);
      }

      const paused = await this.#readBoolean('paused', []);
      if (paused) return reject('module_enabled', 'module is paused by the Safe owners');

      const authorized = await this.#readBoolean('isOperator', [this.#operatorAddress]);
      if (!authorized) {
        return reject('module_enabled', `operator ${this.#operatorAddress} is not authorized on the module`);
      }
    } catch (error) {
      return reject('module_enabled', describeError(error));
    }

    // --- 3. destination_allowlist ------------------------------------------
    try {
      // Mirrors the module's `ForbiddenTarget` check. Cheap, local, and catches
      // the single worst calldata failure (a transaction aimed at the Safe or at
      // the module itself) before spending an RPC round trip on it.
      if (to === safeAddress || to === moduleAddress || to === ZERO_ADDRESS) {
        return reject('destination_allowlist', `destination ${to} is a forbidden target`);
      }

      // ON-CHAIN. Not the local mirror in `calldata/validate.ts` — see the
      // header of this file.
      const allowedTarget = await this.#readBoolean('isAllowedTarget', [to]);
      if (!allowedTarget) {
        return reject('destination_allowlist', `destination ${to} is not on the module's on-chain allowlist`);
      }
    } catch (error) {
      return reject('destination_allowlist', describeError(error));
    }

    // --- 4. selector_allowlist ---------------------------------------------
    let selector: `0x${string}`;
    try {
      // '0x' + 8 hex chars. The module rejects anything under 4 bytes outright
      // (a bare native transfer has no selector to constrain).
      if (tx.data.length < 10) {
        return reject('selector_allowlist', `calldata is shorter than a 4-byte selector (${tx.data.length} chars)`);
      }
      selector = tx.data.slice(0, 10).toLowerCase() as `0x${string}`;

      // The metadata is what the audit log records and what a human reads. If it
      // disagrees with the bytes we are about to sign, the log is describing a
      // different transaction than the one that executes.
      if (selector !== tx.meta.selector.toLowerCase()) {
        return reject(
          'selector_allowlist',
          `calldata selector ${selector} does not match the transaction's declared selector ${tx.meta.selector.toLowerCase()}`,
        );
      }

      const allowedSelector = await this.#readBoolean('isAllowedSelector', [to, selector]);
      if (!allowedSelector) {
        return reject('selector_allowlist', `selector ${selector} is not allowlisted on-chain for ${to}`);
      }
    } catch (error) {
      return reject('selector_allowlist', describeError(error));
    }

    // --- 5. value_cap ------------------------------------------------------
    try {
      if (tx.value < 0n) return reject('value_cap', `native value ${tx.value} is negative`);

      const maxValuePerTx = await this.#readBigInt('maxValuePerTx', []);
      if (tx.value > maxValuePerTx) {
        return reject('value_cap', `native value ${tx.value} exceeds the module's per-tx cap of ${maxValuePerTx}`);
      }
    } catch (error) {
      return reject('value_cap', describeError(error));
    }

    // --- 6. daily_allowance ------------------------------------------------
    // Only meaningful for value-bearing transactions: the module's
    // `_recordSpend` short-circuits at zero, so a zero-value execution consumes
    // no allowance and succeeds even with the bucket exhausted. Mirroring that
    // exactly avoids rejecting locally what the chain would accept.
    if (tx.value > 0n) {
      try {
        const remaining = await this.#readBigInt('remainingDailyAllowance', []);
        if (tx.value > remaining) {
          return reject(
            'daily_allowance',
            `native value ${tx.value} exceeds the remaining daily allowance of ${remaining} wei`,
          );
        }
      } catch (error) {
        return reject('daily_allowance', describeError(error));
      }
    }

    // --- 7. simulation -----------------------------------------------------
    // The one check the on-chain module cannot perform for us: whether the
    // transaction would actually succeed. Simulated FROM the operator, so the
    // `isOperator` gate and the module's own reverts are exercised too.
    //
    // `value: 0` on the outer call is deliberate and is not the same as
    // `tx.value`: `execute` is non-payable and the native value is drawn from
    // the Safe's balance, not the operator's. `tx.value` travels as an ABI
    // argument only.
    try {
      const { request: simulatedRequest } = await this.#publicClient.simulateContract({
        address: moduleAddress,
        abi: OCT_AUTOMATION_MODULE_ABI,
        functionName: 'execute',
        args: [to, tx.value, tx.data],
        account: this.#operatorAddress,
      });
      return { ok: true, simulatedRequest };
    } catch (error) {
      // Covers both a revert (stale quote, moved price, module refusal) and a
      // transport failure. Deliberately NOT distinguished: an unreachable node
      // is not evidence that the transaction is safe, so both fail closed.
      return reject('simulation', describeError(error));
    }
  }

  // -------------------------------------------------------------------------
  // Typed reads. Every one of these throws on a shape it does not recognise.
  // -------------------------------------------------------------------------

  async #read(functionName: string, args: readonly unknown[]): Promise<unknown> {
    try {
      return await this.#publicClient.readContract({
        address: this.#config.moduleAddress,
        abi: OCT_AUTOMATION_MODULE_ABI,
        functionName,
        args,
      });
    } catch (error) {
      throw new SignerReadError(functionName, describeError(error));
    }
  }

  async #readBoolean(functionName: string, args: readonly unknown[]): Promise<boolean> {
    const value = await this.#read(functionName, args);
    // NOT coerced. `Boolean('false')` is `true`, and a node returning a string
    // where a bool belongs would otherwise become a silent authorization.
    if (typeof value !== 'boolean') {
      throw new SignerReadError(functionName, `expected a boolean, received ${describeShape(value)}`);
    }
    return value;
  }

  async #readBigInt(functionName: string, args: readonly unknown[]): Promise<bigint> {
    const value = await this.#read(functionName, args);
    if (typeof value !== 'bigint') {
      throw new SignerReadError(functionName, `expected a bigint, received ${describeShape(value)}`);
    }
    if (value < 0n) throw new SignerReadError(functionName, 'returned a negative amount');
    return value;
  }

  async #readAddress(functionName: string, args: readonly unknown[]): Promise<Address> {
    const value = await this.#read(functionName, args);
    if (typeof value !== 'string' || !ADDRESS.test(value)) {
      throw new SignerReadError(functionName, `expected an address, received ${describeShape(value)}`);
    }
    return value.toLowerCase() as Address;
  }
}

function reject(stage: PreflightStage, reason: string): PreflightRejection {
  return { ok: false, reason, stage };
}

/** Max length of a reason string. Keeps a 10KB revert blob out of the audit log. */
const MAX_REASON_CHARS = 500;

/**
 * Render an error for the audit log.
 *
 * Cannot leak the key: the key is never placed in a request object, so nothing
 * viem throws can contain it. This function still refuses to serialize unknown
 * objects wholesale — it takes messages, never structures — so that stays true
 * even if that assumption changes.
 */
export function describeError(error: unknown): string {
  let message: string;
  if (error instanceof Error) {
    const shortMessage = (error as { shortMessage?: unknown }).shortMessage;
    message = typeof shortMessage === 'string' && shortMessage.length > 0 ? shortMessage : error.message;
  } else if (typeof error === 'string') {
    message = error;
  } else {
    message = describeShape(error);
  }
  return message.length > MAX_REASON_CHARS ? `${message.slice(0, MAX_REASON_CHARS)}…` : message;
}

/** Names a value's shape WITHOUT serializing its contents. */
function describeShape(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  return `a value of type ${typeof value}`;
}
