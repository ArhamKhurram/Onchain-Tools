// EVM executor — Robinhood Chain (chainId 4663), Uniswap V3 and V4.
//
// This is the first NON-CUSTODIAL venue in the sniper. Slotshark holds its own
// wallet and OCT holds a bearer token; here OCT holds the signing key itself,
// which changes the threat model in one specific way: a leak is not a drain of a
// deliberately-small venue balance, it is a drain of the wallet. Every rule
// below follows from that.
//
// THE KEY DISCIPLINE (mirrors venueCredentials.ts:9-11, and goes one step
// further than SlotsharkExecutor):
//
//   * The key is NOT a constructor argument. `SlotsharkExecutor` takes its token
//     in the constructor and relies on the executor being per-fire; this class
//     takes a `readKey` FUNCTION instead, calls it inside `send()`, and lets the
//     value die with that call frame. There is no field, no closure over the
//     value, and no module-level cache to forget to clear.
//   * It is never logged, never returned in any SendOutcome, never put in an
//     error message. The only thing that ever touches it is
//     `privateKeyToAccount`, one line, inside `send()`.
//   * Reading it at module load — even to check whether it exists — would put it
//     in the module's memory for the life of the process for no benefit, so
//     nothing in this file runs at import. The server boots identically with the
//     variable set, unset, or malformed.
//
// WITH NO KEY PRESENT the executor refuses, loudly, and returns a `dead` outcome
// rather than throwing: an import-time throw would take the whole server down
// over a variable that is legitimately absent until the operator sets it. The
// route resolution and both pre-trade gates need no key at all, so everything up
// to the signature is exercisable — and IS exercised — before one exists.

import { createWalletClient, http, parseUnits, publicActions } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { robinhoodChain } from '../evm/chain.js';
import type { EvmSniperConfig } from '../evm/config.js';
import { runPreTradeGates } from '../evm/gates.js';
import { makeHttpEvmRpc, type EvmRpc } from '../evm/rpc.js';
import { describeCandidates, resolveRoute, type PoolFetcher } from '../evm/routing.js';
import { applySlippage, buildBuyTx } from '../evm/swap.js';
import type { Chain, Executor, FireIntent, FireLeg, SendOutcome, Venue } from '../types.js';

/**
 * How long to wait for the receipt before giving up and reporting `unknown`.
 *
 * Robinhood Chain is an Arbitrum Orbit L3 with sub-second blocks, so a receipt
 * normally arrives in well under a second; this is generous on purpose. Giving
 * up early is not "safe" here — an abandoned send that later lands is exactly
 * the ambiguity `unknown` exists to record, and every second of extra patience
 * is one fewer row a human has to reconcile by hand.
 */
const RECEIPT_TIMEOUT_MS = 20_000;

export interface EvmUniswapConfig {
  /** Read-only chain access for routing and the gates. Injected so tests need no network. */
  rpc?: EvmRpc;
  /** Parsed env. Carries the slippage, deadline and both gate settings. */
  config: EvmSniperConfig;
  /**
   * Returns the signing key, or undefined when none is configured.
   *
   * A FUNCTION, not a value: this is what keeps the key out of this object's
   * fields. Defaults to a late `process.env` read — see the header.
   */
  readKey?: () => string | undefined;
  /** Pool discovery. Injected in tests; defaults to DexScreener. */
  fetchPools?: PoolFetcher;
  /** Injected clock (ms) for the swap deadline. */
  now?: () => number;
}

/** The default key source. Read at CALL time, never at import time. */
function readKeyFromEnv(): string | undefined {
  const raw = process.env.SNIPER_EVM_PRIVATE_KEY?.trim();
  return raw ? raw : undefined;
}

/**
 * Native-unit float -> wei.
 *
 * `leg.amount` is a JS number because the whole sniper sizes in native units
 * (see SnipeRule.sizeTotal), and a ladder split produces values like
 * 0.1/3 = 0.03333333333333333. `parseUnits` rejects more than 18 decimals, so
 * the value is truncated — DOWN, never rounded — to 18 places first. Truncating
 * down means the wei amount is at most one wei under the leg's nominal size and
 * never over it, so the reservation executeFire already took always covers what
 * is actually sent.
 */
export function ethToWei(amount: number): bigint {
  // `>= 1e21` is where `toFixed` switches to exponential notation, which
  // `parseUnits` cannot read. It is also six orders of magnitude past
  // MAX_BUY_ETH, so a value up there is a corrupted leg rather than a large one
  // — and 0n makes the executor refuse it, which is the right answer either way.
  if (!Number.isFinite(amount) || amount <= 0 || amount >= 1e21) return 0n;

  // `toFixed(18)` would ROUND the 19th decimal, which can push the result one
  // wei ABOVE the leg's nominal size — above the reservation executeFire already
  // took. So take more digits than needed and cut, rather than round: 20 places
  // is past the ~17 significant digits a double carries, so nothing real is lost
  // and the result is always at or below the true value.
  const [whole, frac = ''] = amount.toFixed(20).split('.');
  return parseUnits(`${whole}.${frac.slice(0, 18)}`, 18);
}

export class EvmUniswapExecutor implements Executor {
  readonly venue: Venue = 'evm_uniswap';
  readonly chains: readonly Chain[] = ['rhc'];

  private readonly rpc: EvmRpc;
  private readonly readKey: () => string | undefined;

  constructor(private cfg: EvmUniswapConfig) {
    this.rpc = cfg.rpc ?? makeHttpEvmRpc(cfg.config.rpcUrl);
    this.readKey = cfg.readKey ?? readKeyFromEnv;
  }

  async send(intent: FireIntent, leg: FireLeg, correlationId: string): Promise<SendOutcome> {
    const token = intent.mint;
    const amountInWei = ethToWei(leg.amount);
    if (amountInWei <= 0n) {
      return this.refuse('validation', `leg amount ${leg.amount} does not convert to a positive wei value`, correlationId);
    }

    // ---- Step 1: the key ---------------------------------------------------
    //
    // Checked FIRST so a missing key costs no network calls and produces one
    // unambiguous line in the log. `fireOrchestrator` performs the same check as
    // a preflight and aborts with `no_credential` before this class is even
    // constructed; this is the independent second refusal, so the guarantee
    // holds no matter who calls the executor.
    //
    // `dead` (not `unknown`): nothing was built, nothing was signed, nothing
    // left the process. It is provably unsubmitted, which is the precondition
    // executeFire requires before it will retry or release the reservation.
    const key = this.readKey();
    if (!key) {
      return this.refuse(
        'auth',
        'SNIPER_EVM_PRIVATE_KEY is not set — the EVM sniper cannot sign. No transaction was built.',
        correlationId,
      );
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
      // Shape-checked before `privateKeyToAccount`, whose thrown error has been
      // known to embed the offending value. Nothing derived from the key —
      // length, prefix, a fragment — appears in this message.
      return this.refuse('auth', 'SNIPER_EVM_PRIVATE_KEY is not a 32-byte hex key. No transaction was built.', correlationId);
    }

    // ---- Step 2: route -----------------------------------------------------
    let decision;
    try {
      decision = await resolveRoute(token, { rpc: this.rpc, fetchPools: this.cfg.fetchPools });
    } catch (err) {
      // Discovery failed (DexScreener down, RPC down). Nothing was signed, so
      // this is provably unsubmitted and executeFire may retry it — which is
      // the right behaviour, because a transient upstream is exactly the case a
      // retry helps.
      return this.refuse('network', `route discovery failed: ${(err as Error)?.message ?? err}`, correlationId);
    }
    if (!decision.route) {
      return this.refuse(
        'validation',
        `no routable pool for ${token} (${describeCandidates(decision.candidates)})`,
        correlationId,
      );
    }

    // Best execution is a claim worth being able to audit after the fact, so the
    // pool we chose AND the ones we passed over are logged together.
    console.log(
      `[sniper/evm] ${correlationId} routing via ${decision.route.family} ` +
        `$${Math.round(decision.route.liquidityUsd)} — candidates: ${describeCandidates(decision.candidates)}`,
    );

    const deadline = BigInt(Math.floor((this.cfg.now?.() ?? Date.now()) / 1000) + this.cfg.config.deadlineSeconds);

    // ---- Step 3: pre-trade gates ------------------------------------------
    //
    // Before signing, never after. Both gates run on simulation only and would
    // run identically with no key present — the key check above is first purely
    // so a misconfigured deployment fails fast, not because the gates need it.
    const gates = await runPreTradeGates({
      rpc: this.rpc,
      route: decision.route,
      token,
      amountInWei,
      deadline,
      config: this.cfg.config,
    });
    if (!gates.ok) {
      return this.refuse('validation', `pre-trade gate "${gates.reason}": ${gates.detail}`, correlationId);
    }

    // ---- Step 4: sign and send --------------------------------------------
    //
    // `account` is the only thing derived from the key, and it lives exactly as
    // long as this block. `walletClient` holds it, and `walletClient` is a local.
    const account = privateKeyToAccount(key as `0x${string}`);

    // If the operator declared which wallet they funded and capped, the key must
    // BE that wallet. Rotating a key without updating the config would otherwise
    // fire from an address whose balance nobody sized and whose caps nobody set
    // — the budget row in the store is keyed on a walletId, not on an address,
    // so nothing downstream would notice.
    const declared = this.cfg.config.declaredWalletAddress;
    if (declared && declared.toLowerCase() !== account.address.toLowerCase()) {
      return this.refuse(
        'validation',
        `SNIPER_EVM_PRIVATE_KEY derives ${account.address}, but SNIPER_EVM_WALLET_ADDRESS declares ${declared}`,
        correlationId,
      );
    }

    const tx = buildBuyTx({
      route: decision.route,
      token,
      amountIn: amountInWei,
      // The floor is anchored to the quote the gate MEASURED, not to zero and
      // not to an oracle. A zero floor would make `slippageBps` decorative and
      // hand the whole position to a sandwich.
      amountOutMinimum: applySlippage(gates.expectedOut, intent.slippageBps),
      deadline,
      recipient: account.address,
    });

    const client = createWalletClient({
      account,
      chain: robinhoodChain,
      transport: http(this.cfg.config.rpcUrl),
    }).extend(publicActions);

    // Honour the rule's EVM gas knobs when it carries them; otherwise let viem
    // price the transaction. A `sol` exec bag on an EVM rule is rejected at arm
    // time (validateRule's `exec_kind_mismatch`), so reaching here with one
    // would be a store-level corruption — the fields are read defensively
    // regardless, since this is the money path.
    const evmExec = intent.exec.kind === 'evm' ? intent.exec : null;
    const gasOverrides = {
      maxFeePerGas: parseOptionalWei(evmExec?.maxFeePerGas),
      maxPriorityFeePerGas: parseOptionalWei(evmExec?.maxPriorityFeePerGas),
      gas: parseOptionalWei(evmExec?.gasLimit),
    };

    let hash: `0x${string}`;
    try {
      hash = await client.sendTransaction({
        to: tx.to as `0x${string}`,
        data: tx.data as `0x${string}`,
        value: tx.value,
        ...(gasOverrides.maxFeePerGas !== undefined ? { maxFeePerGas: gasOverrides.maxFeePerGas } : {}),
        ...(gasOverrides.maxPriorityFeePerGas !== undefined
          ? { maxPriorityFeePerGas: gasOverrides.maxPriorityFeePerGas }
          : {}),
        ...(gasOverrides.gas !== undefined ? { gas: gasOverrides.gas } : {}),
      });
    } catch (err) {
      return classifySendFailure(err, correlationId);
    }

    // ---- Step 5: resolve the outcome --------------------------------------
    try {
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
      if (receipt.status === 'success') {
        return { kind: 'filled', signature: hash, amountIn: leg.amount, amountOut: 0, feePaid: 0 };
      }
      // The transaction was mined and REVERTED. No tokens were received and no
      // ETH left the wallet beyond gas, so this is `dead` — and note it is a
      // STRONGER proof of non-execution than a failed submission, which is the
      // usual justification for `dead`. Retrying is therefore safe, and for a
      // slippage revert on a moving pool it is also the useful thing to do.
      console.warn(`[sniper/evm] ${correlationId} tx ${hash} reverted on chain`);
      return { kind: 'dead', reason: 'validation', status: 0 };
    } catch {
      // No receipt in time. The transaction IS in the mempool and may well land.
      // `unknown` holds the reservation and stops the retry loop — the one thing
      // that must never happen here is a re-send, which is how a slow receipt
      // becomes two buys.
      console.warn(`[sniper/evm] ${correlationId} no receipt for ${hash} within ${RECEIPT_TIMEOUT_MS}ms; reporting unknown`);
      return { kind: 'unknown' };
    }
  }

  /** One place that logs a refusal and shapes it as a `dead` outcome. Never logs the key. */
  private refuse(reason: 'validation' | 'auth' | 'network', detail: string, correlationId: string): SendOutcome {
    console.warn(`[sniper/evm] ${correlationId} refused (${reason}): ${detail}`);
    return { kind: 'dead', reason, status: 0 };
  }
}

/** `EvmExecParams` carries wei as decimal strings. A malformed one is ignored, not guessed at. */
function parseOptionalWei(raw: string | undefined): bigint | undefined {
  if (raw === undefined) return undefined;
  try {
    const v = BigInt(raw);
    return v > 0n ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Map a `sendTransaction` failure onto the outcome union.
 *
 * DEFAULTS TO `unknown`, for the same reason SlotsharkExecutor does: `dead` is
 * what executeFire retries, and retrying a transaction that actually reached the
 * mempool is a double buy. Only errors that PROVE the node never accepted the
 * transaction may be `dead` — a node rejecting it outright, or a connection that
 * was never established. "Socket hang up" and its relatives all fire AFTER the
 * bytes went out and are therefore `unknown`.
 */
export function classifySendFailure(err: unknown, correlationId: string): SendOutcome {
  const e = err as NodeJS.ErrnoException & { name?: string; message?: string; cause?: NodeJS.ErrnoException };
  const code = e?.code ?? e?.cause?.code;
  const message = (e?.message ?? '').toLowerCase();

  console.warn(`[sniper/evm] ${correlationId} send failed: ${e?.name ?? 'Error'}`);

  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { kind: 'dead', reason: 'network', status: 0 };
  }
  // Node-side rejections: the transaction was evaluated and refused, so it is
  // not in any mempool. These strings are the standard geth/nitro wordings.
  if (
    message.includes('insufficient funds') ||
    message.includes('nonce too low') ||
    message.includes('intrinsic gas too low') ||
    message.includes('gas required exceeds') ||
    message.includes('exceeds block gas limit') ||
    message.includes('execution reverted')
  ) {
    return { kind: 'dead', reason: 'validation', status: 0 };
  }
  return { kind: 'unknown' };
}
