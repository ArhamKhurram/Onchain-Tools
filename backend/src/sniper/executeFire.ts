// executeFire — the ONLY function that spends. Every risk control lives here,
// because a control anywhere else can be routed around by a retry, a ladder leg, a
// second wallet, or a future caller. See docs/architecture/sniper-execution.md.
//
// Order (steps 0-6): kill switch -> idempotency claim -> per-trigger cap ->
// per-leg [ re-check kill/mcap -> reserve -> send -> record ] -> auto-disable.

import type { ExecutorRegistry } from './executors/registry.js';
import type { IdempotencyLedger } from './idempotency.js';
import { triggerKey } from './idempotency.js';
import { estimateFees } from './fees.js';
import { computeLegs } from './legs.js';
import { InMemorySniperStore, utcDay } from './store.js';
import type { FireIntent, FireLeg, NormalizedTweet, SendOutcome, SnipeRule } from './types.js';

export type LegState = 'filled' | 'expired' | 'aborted' | 'unknown';

export interface LegResult {
  walletId: string;
  legNo: number;
  amount: number;
  state: LegState;
  reason?: string;
  signature?: string;
  attempts: number;
}

export interface FireResult {
  outcome: 'suppressed' | 'aborted' | 'fired';
  reason?: string;
  legs: LegResult[];
  ruleDisabled: boolean;
}

export interface FireDeps {
  store: InMemorySniperStore;
  ledger: IdempotencyLedger;
  registry: ExecutorRegistry;
  /** Injected clock (ms). Deterministic in tests; a monotonic clock in production. */
  clock: () => number;
  /** Latest market cap pushed by the feed/enrichment cache. Never fetched inline. */
  pushedMcap?: (mint: string) => number | undefined;
}

/**
 * Fire `rule` for `tweet`. Assumes the caller already ran the matcher and the
 * staleness gate; this function owns idempotency and everything downstream.
 */
export async function executeFire(
  rule: SnipeRule,
  tweet: NormalizedTweet,
  deps: FireDeps,
): Promise<FireResult> {
  const { store, ledger, registry, clock } = deps;
  const now = clock();

  // Step 0 — kill switch.
  if (store.isKilled()) {
    return { outcome: 'aborted', reason: 'kill_switch', legs: [], ruleDisabled: false };
  }

  // Step 1 — idempotency claim, BEFORE any external call. A lost claim means a
  // duplicate delivery; suppress silently.
  if (!ledger.claim(rule.id, tweet, now)) {
    return { outcome: 'suppressed', legs: [], ruleDisabled: false };
  }

  const mint = rule.mint;
  if (!mint) {
    // Phase 1 requires a bound mint. Phase 2 resolution lands in a later milestone.
    return { outcome: 'aborted', reason: 'no_mint', legs: [], ruleDisabled: false };
  }

  const day = utcDay(now);
  const legs = computeLegs(rule);

  // Step 2 — per-trigger cap: the whole tweet's spend, fees included, before any leg
  // sends. Without this, N ladder legs each within perFireCap spend N x perFireCap.
  const triggerTotal = legs.reduce(
    (sum, leg) => sum + leg.amount + estimateFees(rule, leg.amount),
    0,
  );
  if (triggerTotal > rule.perTriggerCap) {
    return { outcome: 'aborted', reason: 'per_trigger_cap', legs: [], ruleDisabled: false };
  }

  const intent: FireIntent = {
    ruleId: rule.id,
    userId: rule.userId,
    chain: rule.chain,
    venue: rule.venue,
    mint,
    triggerKey: triggerKey(tweet),
    legs,
    slippageBps: rule.slippageBps,
    exec: rule.exec,
  };

  const executor = registry.resolve(rule);
  const results: LegResult[] = [];

  for (const leg of legs) {
    results.push(await runLeg(rule, intent, leg, executor, deps, day, mint));
  }

  const anyMovement = results.some((r) => r.state === 'filled' || r.state === 'unknown');
  let ruleDisabled = false;
  if (rule.autoDisableAfterFire && anyMovement) {
    store.setRuleState(rule.id, 'disabled');
    ruleDisabled = true;
  }

  return { outcome: 'fired', legs: results, ruleDisabled };
}

async function runLeg(
  rule: SnipeRule,
  intent: FireIntent,
  leg: FireLeg,
  executor: ReturnType<ExecutorRegistry['resolve']>,
  deps: FireDeps,
  day: string,
  mint: string,
): Promise<LegResult> {
  const { store, clock } = deps;
  const startedAt = clock();
  const fees = estimateFees(rule, leg.amount);
  const amountWithFees = leg.amount + fees;
  const correlationId = `${rule.id}:${intent.triggerKey}:${leg.walletId}:${leg.legNo}`;

  const wallet = store.getWallet(leg.walletId);
  const record = (state: LegState, extra: { reason?: string; signature?: string }, attempts: number): LegResult => {
    store.recordFire({
      ruleId: rule.id,
      userId: rule.userId,
      triggerKey: intent.triggerKey,
      walletId: leg.walletId,
      legNo: leg.legNo,
      mint,
      amount: leg.amount,
      state,
      signature: extra.signature,
      abortReason: extra.reason,
      at: clock(),
    });
    return { walletId: leg.walletId, legNo: leg.legNo, amount: leg.amount, state, attempts, ...extra };
  };

  if (!wallet) return record('aborted', { reason: 'no_wallet' }, 0);

  // The authoritative per-leg cap is min(rule.perFireCap, wallet budget cap).
  // The store enforces only the budget side; without this check the rule-level
  // cap — which is what the operator actually sets, and what Phase 2's lower
  // ceiling rides on — would bound nothing at all.
  if (amountWithFees > rule.perFireCap) {
    return record('aborted', { reason: 'per_fire_cap' }, 0);
  }

  for (let attempt = 1; attempt <= rule.maxAttempts; attempt++) {
    // Retry budget: fire clock, measured from the first attempt.
    if (clock() - startedAt >= rule.fireWindowMs) {
      return record('expired', {}, attempt - 1);
    }
    // Re-check the abort conditions every attempt — neither is a network call.
    if (store.isKilled()) return record('aborted', { reason: 'kill_switch' }, attempt - 1);
    if (rule.mcapCeiling !== null) {
      const mcap = deps.pushedMcap?.(mint);
      if (mcap !== undefined && mcap > rule.mcapCeiling) {
        return record('aborted', { reason: 'mcap_ceiling' }, attempt - 1);
      }
    }

    const reservation = store.reserveLeg({
      walletId: leg.walletId,
      chain: rule.chain,
      unit: rule.sizeUnit,
      day,
      amountWithFees,
    });
    if (!reservation.ok) {
      // A cap refusal is terminal for the leg — retrying cannot make room.
      return record('aborted', { reason: reservation.reason }, attempt - 1);
    }

    // A throw is NOT a proof of non-submission, so it is treated as `unknown`:
    // the reservation is held and the leg is not retried. Without this, an
    // executor bug or an unexpected runtime error would escape executeFire with
    // the reservation still taken and no fire record written — leaking budget
    // and losing the reconciliation substrate for a send that may have landed.
    let outcome: SendOutcome;
    try {
      outcome = await executor.send(intent, leg, correlationId);
    } catch (err) {
      console.error(
        `[sniper] executor threw for rule=${rule.id} leg=${leg.legNo}:`,
        (err as Error)?.message ?? err,
      );
      return record('unknown', {}, attempt);
    }

    if (outcome.kind === 'filled') {
      return record('filled', { signature: outcome.signature }, attempt);
    }
    if (outcome.kind === 'unknown') {
      // Hold the reservation. The send may have landed; a reconciler resolves it.
      // NEVER retried inline — that is how a timeout that landed becomes a double buy.
      return record('unknown', {}, attempt);
    }
    // provably dead — release and retry.
    store.releaseLeg({ walletId: leg.walletId, chain: rule.chain, day, amountWithFees, closePosition: true });
  }

  return record('expired', {}, rule.maxAttempts);
}
