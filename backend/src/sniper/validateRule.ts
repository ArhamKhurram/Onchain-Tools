// Arm-time rule validation — the composition nothing performed before.
//
// `validateMatcher` and `validateLadderSplit` already existed as building
// blocks; this is the thing that runs all of them plus the cross-field checks
// that only make sense once you can see a rule and its wallets together.
//
// Split into two halves on purpose:
//
//   * `validateRuleStructure` — shape, ranges, and the chain/venue/exec
//     agreement. Runs on CREATE and PATCH, because a rule that violates any of
//     these cannot be persisted at all (each one mirrors a CHECK constraint in
//     20260807120000_sniper_rules_fires_budget.sql, so local and hosted refuse
//     identically rather than local accepting a row hosted would reject).
//   * `validateRule` — the above plus everything that needs the wallet rows.
//     Runs on ARM only, which is why a half-finished draft can still be saved.
//
// The reason strings are a frozen vocabulary: the console renders them directly
// and the two halves must not invent overlapping spellings.

import { estimateFees } from './fees.js';
import { computeLegs, validateLadderSplit } from './legs.js';
import { validateMatcher } from './matcher.js';
import { isLinearSafeRegex } from './regexGuard.js';
import type { MatcherNode, SnipeRule, WalletConfig } from './types.js';

export type ValidationReason =
  | 'no_mint'
  | 'phase_unsupported'
  | 'no_wallets'
  | 'unknown_wallet'
  | 'unit_mismatch'
  | 'wallet_chain_mismatch'
  | 'venue_chain_mismatch'
  | 'exec_kind_mismatch'
  | 'matcher_too_deep'
  | 'matcher_too_many_nodes'
  | 'matcher_regex_invalid'
  | 'ladder_split_empty'
  | 'ladder_split_negative'
  | 'ladder_split_not_normalized'
  | 'ladder_split_too_many'
  | 'slippage_out_of_range'
  | 'max_attempts_out_of_range'
  | 'fire_window_out_of_range'
  | 'max_tweet_age_out_of_range'
  | 'mcap_ceiling_out_of_range'
  | 'caps_inconsistent'
  | 'size_over_trigger_cap';

export type ValidationResult = { ok: true } | { ok: false; reason: ValidationReason; detail?: string };

const fail = (reason: ValidationReason, detail?: string): ValidationResult => ({ ok: false, reason, detail });

/**
 * The largest value a Postgres `integer` column holds. The ms fields and
 * max_attempts are int4 in the migration, so a value past this is rejected by
 * hosted and accepted by local unless it is checked here too — the same
 * local/hosted divergence the CHECK constraints exist to prevent.
 */
const PG_INT_MAX = 2_147_483_647;

/** int4, and inside `lo..hi` — the shape every `integer ... check` column has. */
function intInRange(v: number, lo: number, hi: number): boolean {
  return Number.isInteger(v) && v >= lo && v <= hi;
}

/** Walk the matcher tree and check every regex leaf against the ReDoS heuristic. */
function firstUnsafeRegex(node: MatcherNode): string | null {
  switch (node.op) {
    case 'leaf': {
      const isRegex = node.pattern.matchMode === 'regex' || node.pattern.isRegex === true;
      if (!isRegex) return null;
      return isLinearSafeRegex(node.pattern.pattern) ? null : node.pattern.pattern;
    }
    case 'and':
    case 'or': {
      for (const child of node.children) {
        const bad = firstUnsafeRegex(child);
        if (bad) return bad;
      }
      return null;
    }
    case 'not':
      return firstUnsafeRegex(node.child);
  }
}

/**
 * The half that can run without wallet rows. Every check here has a mirror in a
 * database CHECK constraint.
 */
export function validateRuleStructure(rule: SnipeRule): ValidationResult {
  // Phase 2 resolves the mint at trigger time from a candidate set that does not
  // exist yet — no `resolution` column, no CANDIDATE_TOKENS, no resolver. The
  // column is constrained 1|2 so this lifts without a migration.
  if (rule.phase !== 1) return fail('phase_unsupported', 'Only phase 1 rules are supported.');

  // Phase 1 binds the mint up front; executeFire aborts with `no_mint` otherwise.
  // Checked here rather than at arm time because the hosted CHECK constraint
  // `sniper_rules_phase1_needs_mint` would reject the INSERT anyway — refusing in
  // the app keeps local and hosted answering the same way.
  if (!rule.mint || !rule.mint.trim()) return fail('no_mint');

  // Slotshark is Solana-only (executors/slotshark.ts:36). Caught here rather
  // than at ExecutorRegistry.resolve, i.e. at configuration time rather than
  // inside the fire path.
  if (rule.venue === 'slotshark' && rule.chain !== 'sol') return fail('venue_chain_mismatch');

  // A sol rule carrying EvmExecParams loses its tip/priorityFee from
  // estimateFees, which makes the daily cap soft by exactly those amounts.
  const execMatches =
    (rule.chain === 'sol' && rule.exec.kind === 'sol') || (rule.chain === 'bsc' && rule.exec.kind === 'evm');
  if (!execMatches) return fail('exec_kind_mismatch');

  if (!Number.isFinite(rule.slippageBps) || rule.slippageBps < 1 || rule.slippageBps > 10_000) {
    return fail('slippage_out_of_range');
  }

  // `max_attempts integer not null check (max_attempts between 1 and 10)`.
  // The ceiling is the load-bearing half: runLeg's retry loop is bounded by this
  // number and by fireWindowMs alone, so maxAttempts:5000 with a one-hour window
  // retries a dead send five thousand times inside that hour, holding the
  // request open and hammering the venue. Local mode used to accept exactly that
  // while hosted rejected it as a raw Postgres error rendered to the operator.
  if (!intInRange(rule.maxAttempts, 1, 10)) return fail('max_attempts_out_of_range');

  // `fire_window_ms integer not null check (fire_window_ms > 0)`. A window of 0
  // or below expires every leg on attempt 1, which reads as a broken venue.
  if (!intInRange(rule.fireWindowMs, 1, PG_INT_MAX)) return fail('fire_window_out_of_range');

  // `max_tweet_age_ms integer not null check (max_tweet_age_ms > 0)`. Inert in
  // the alpha (the staleness gate has no feed to run against), which is exactly
  // why it needs checking here — nothing else would notice a bad value until M2.
  if (!intInRange(rule.maxTweetAgeMs, 1, PG_INT_MAX)) return fail('max_tweet_age_out_of_range');

  // `mcap_ceiling numeric check (mcap_ceiling is null or mcap_ceiling > 0)`.
  // Null means "no ceiling"; a zero or negative ceiling would abort every leg
  // the moment any market cap is pushed, silently.
  if (rule.mcapCeiling !== null && !(Number.isFinite(rule.mcapCeiling) && rule.mcapCeiling > 0)) {
    return fail('mcap_ceiling_out_of_range');
  }

  if (
    !(rule.sizeTotal > 0) ||
    !(rule.perFireCap > 0) ||
    !(rule.perTriggerCap > 0) ||
    rule.perTriggerCap < rule.perFireCap
  ) {
    // A trigger cap below the fire cap makes the fire cap unreachable and is
    // always a typo, never an intent.
    return fail('caps_inconsistent');
  }

  if (rule.entryStyle === 'ladder') {
    const split = validateLadderSplit(rule.ladderSplit);
    if (!split.ok) {
      const map = {
        empty: 'ladder_split_empty',
        negative: 'ladder_split_negative',
        not_normalized: 'ladder_split_not_normalized',
        too_many: 'ladder_split_too_many',
      } as const;
      return fail(map[split.reason]);
    }
  }

  const matcher = validateMatcher(rule.matcher);
  if (!matcher.ok) {
    return fail(matcher.reason === 'too_deep' ? 'matcher_too_deep' : 'matcher_too_many_nodes');
  }

  const unsafe = firstUnsafeRegex(rule.matcher);
  if (unsafe) return fail('matcher_regex_invalid', unsafe);

  return { ok: true };
}

/**
 * The full arm-time check: structure, plus everything that needs the caller's
 * wallet rows. `wallets` is passed in rather than fetched so this stays a pure
 * function — it is the unit-test target for the whole rejection vocabulary.
 */
export function validateRule(rule: SnipeRule, wallets: WalletConfig[]): ValidationResult {
  const structural = validateRuleStructure(rule);
  if (!structural.ok) return structural;

  if (rule.walletIds.length === 0) return fail('no_wallets');

  const byId = new Map(wallets.map((w) => [w.walletId, w]));
  for (const id of rule.walletIds) {
    const wallet = byId.get(id);
    if (!wallet) return fail('unknown_wallet', id);
    // Caps are denominated in native units precisely to keep a price oracle out
    // of the hot path; that only works if every wallet a rule spends from
    // denominates the same unit the rule sizes in. Otherwise the reservation
    // compares 5 SOL against a 1000-USDC cap.
    if (wallet.unit !== rule.sizeUnit) return fail('unit_mismatch', id);
    if (wallet.chain !== rule.chain) return fail('wallet_chain_mismatch', id);
  }

  // A rule whose own legs cannot clear its own per-trigger cap aborts at
  // executeFire step 2 on EVERY trigger. Without this it sits armed and inert,
  // looking healthy and firing nothing.
  const triggerTotal = computeLegs(rule).reduce((sum, leg) => sum + leg.amount + estimateFees(rule, leg.amount), 0);
  if (triggerTotal > rule.perTriggerCap) {
    return fail('size_over_trigger_cap', `${triggerTotal} > ${rule.perTriggerCap}`);
  }

  return { ok: true };
}
