// executeFire — the ONLY function that spends. Every risk control lives here,
// because a control anywhere else can be routed around by a retry, a ladder leg, a
// second wallet, or a future caller. See docs/architecture/sniper-execution.md.
//
// Order (steps 0-6): kill switch -> idempotency claim -> per-trigger cap ->
// per-leg [ re-check kill/mcap -> reserve -> send -> record ] -> auto-disable.
//
// TODO(M2): two controls from sniper-execution.md:265,270-272 are deliberately
// absent — the global fires-per-minute breaker and anomaly auto-kill. Both exist
// for fan-out amplification (50 rules on one handle, one viral tweet), and the
// alpha has no automatic OCT trigger at all: every fire is a human pressing a
// button behind a typed confirmation, so there is nothing to amplify. They become
// MANDATORY the same day a tweet feed lands. This note is here, at the top of the
// only function that spends, so that day cannot arrive quietly.

import type { ExecutorRegistry } from './executors/registry.js';
import type { IdempotencyLedger } from './idempotency.js';
import { triggerKey } from './idempotency.js';
import { estimateFees } from './fees.js';
import { computeLegs } from './legs.js';
import { utcDay } from './store.js';
import type { SniperStore } from './storeInterface.js';
import type { FireIntent, FireLeg, NormalizedTweet, SendOutcome, SnipeRule, Venue } from './types.js';

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
  store: SniperStore;
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
 *
 * The tenant is `rule.userId` throughout — deliberately not a separate
 * `deps.userId`, so there is exactly one source of truth and no way to fire one
 * user's rule against another user's budget by mismatching the two.
 */
export async function executeFire(
  rule: SnipeRule,
  tweet: NormalizedTweet,
  deps: FireDeps,
): Promise<FireResult> {
  const { store, ledger, registry, clock } = deps;
  const userId = rule.userId;
  const now = clock();

  // Step 0 — kill switch.
  if (await store.isKilled(userId)) {
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
    userId,
    chain: rule.chain,
    venue: rule.venue,
    mint,
    triggerKey: triggerKey(tweet),
    legs,
    slippageBps: rule.slippageBps,
    exec: rule.exec,
  };

  // Resolved once, before the loop, and threaded into every fire record. It is
  // NOT `rule.dryRun`: the process-level OCT_SNIPER_DRY_RUN overrides the rule
  // flag, so labelling rows from the rule flag alone would mark real-looking
  // rows on a process that spent nothing, and vice versa.
  const isDry = registry.isDryRun(rule);
  const executor = registry.resolve(rule);
  const results: LegResult[] = [];

  for (const leg of legs) {
    results.push(await runLeg(rule, intent, leg, executor, deps, day, mint, isDry));
  }

  const anyMovement = results.some((r) => r.state === 'filled' || r.state === 'unknown');
  let ruleDisabled = false;
  if (rule.autoDisableAfterFire && anyMovement) {
    await store.setRuleState(userId, rule.id, 'disabled');
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
  isDry: boolean,
): Promise<LegResult> {
  const { store, clock } = deps;
  const userId = rule.userId;
  const startedAt = clock();
  const fees = estimateFees(rule, leg.amount);
  const amountWithFees = leg.amount + fees;
  const correlationId = `${rule.id}:${intent.triggerKey}:${leg.walletId}:${leg.legNo}`;
  const venue: Venue = isDry ? 'dryrun' : rule.venue;

  const wallet = await store.getWallet(userId, leg.walletId);
  const record = async (
    state: LegState,
    extra: { reason?: string; signature?: string },
    attempts: number,
    /**
     * What the fire ROW references, which is not always what the leg names. The
     * empty string is the domain spelling of "no wallet" (toFire maps a NULL
     * wallet_id to it), and it is what the `no_wallet` abort below must persist:
     * `sniper_fires.wallet_id` is a foreign key into `sniper_wallets`, so
     * writing an id that resolved to nothing would fail the FK, throw out of
     * recordFire and executeFire, and reach the operator as fireRuleNow's
     * catch-all `venue_unsupported` — losing the one clean, accurate per-leg
     * refusal. The LegResult still reports `leg.walletId`, so the operator can
     * see WHICH wallet the rule asked for.
     */
    walletRef: string = leg.walletId,
  ): Promise<LegResult> => {
    await store.recordFire(userId, {
      ruleId: rule.id,
      userId,
      triggerKey: intent.triggerKey,
      walletId: walletRef,
      legNo: leg.legNo,
      attempts,
      mint,
      amount: leg.amount,
      state,
      dryRun: isDry,
      venue,
      signature: extra.signature,
      abortReason: extra.reason,
      at: clock(),
    });
    return { walletId: leg.walletId, legNo: leg.legNo, amount: leg.amount, state, attempts, ...extra };
  };

  // Deleted mid-fire, or never this tenant's. Either way there is no row for the
  // FK to point at, so the fire row is written with no wallet reference.
  if (!wallet) return await record('aborted', { reason: 'no_wallet' }, 0, '');

  // The authoritative per-leg cap is min(rule.perFireCap, wallet budget cap).
  // The store enforces only the budget side; without this check the rule-level
  // cap — which is what the operator actually sets, and what Phase 2's lower
  // ceiling rides on — would bound nothing at all.
  if (amountWithFees > rule.perFireCap) {
    return await record('aborted', { reason: 'per_fire_cap' }, 0);
  }

  for (let attempt = 1; attempt <= rule.maxAttempts; attempt++) {
    // Retry budget: fire clock, measured from the first attempt.
    if (clock() - startedAt >= rule.fireWindowMs) {
      return await record('expired', {}, attempt - 1);
    }
    // Re-check the abort conditions every attempt — neither is a network call.
    if (await store.isKilled(userId)) return await record('aborted', { reason: 'kill_switch' }, attempt - 1);
    if (rule.mcapCeiling !== null) {
      const mcap = deps.pushedMcap?.(mint);
      if (mcap !== undefined && mcap > rule.mcapCeiling) {
        return await record('aborted', { reason: 'mcap_ceiling' }, attempt - 1);
      }
    }

    const reservation = await store.reserveLeg(userId, {
      walletId: leg.walletId,
      chain: rule.chain,
      unit: rule.sizeUnit,
      day,
      amountWithFees,
    });
    if (!reservation.ok) {
      // A cap refusal is terminal for the leg — retrying cannot make room.
      return await record('aborted', { reason: reservation.reason }, attempt - 1);
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
      return await record('unknown', {}, attempt);
    }

    if (outcome.kind === 'filled') {
      // A dry run takes the reservation FOR REAL so the risk gate is genuinely
      // exercised — that is the whole point of dry-running before going live.
      // But no balance poll will ever show a synthetic position closing, so the
      // synthetic fill has to reverse it here. Without this, N test buys
      // permanently exhaust the daily cap and maxOpen and the (N+1)th test
      // silently returns `daily_cap`, which looks exactly like a broken UI.
      // (docs/architecture/sniper-execution.md:307-311)
      if (isDry) {
        await store.releaseLeg(userId, {
          walletId: leg.walletId,
          chain: rule.chain,
          day,
          amountWithFees,
          closePosition: true,
        });
      }
      return await record('filled', { signature: outcome.signature }, attempt);
    }
    if (outcome.kind === 'unknown') {
      // Hold the reservation. The send may have landed; a reconciler resolves it.
      // NEVER retried inline — that is how a timeout that landed becomes a double buy.
      return await record('unknown', {}, attempt);
    }
    // provably dead — release and retry.
    await store.releaseLeg(userId, { walletId: leg.walletId, chain: rule.chain, day, amountWithFees, closePosition: true });
  }

  return await record('expired', {}, rule.maxAttempts);
}
