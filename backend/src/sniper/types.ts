// Core types for the tweet-triggered sniper. See the architecture docs:
// https://arhamkhurram.github.io/Onchain-Tools/architecture/sniper/
//
// M1 scope: the fire path (rule match -> risk gate -> executor) exercised
// entirely in dry-run, with no money and no live tweet feed. The live J7 socket
// (social-stream) and Supabase-backed store arrive in later milestones; the
// shapes here are chosen so those slot in without reshaping the rule schema.

import type { KeywordPattern } from '@oct/shared';

// ---------------------------------------------------------------------------
// Chains and venues
// ---------------------------------------------------------------------------

/**
 * Phase 1 is Solana-only. `bsc` stays in the union because the rule schema and
 * executor registry are chain-generic by design, but no Phase 1 executor accepts
 * it — `ExecutorRegistry.resolve` throws rather than silently routing an EVM rule
 * to a Solana venue.
 */
export type Chain = 'sol' | 'bsc';

/**
 * How a fire is routed. Phase 1 ships Slotshark (Solana, custodial) and the
 * dry-run seam only.
 *
 * GMGN is deliberately NOT a Phase 1 venue. The operator's `GMGN_API_KEY` is
 * provisioned for enrichment/market data (see utils/gmgnClient.ts) and must never
 * become a trading credential — that would execute every user's snipes on the
 * operator's own GMGN account. When GMGN trading is added it arrives as a
 * per-user connected credential (ADR-012), never a shared server-side key.
 */
export type Venue = 'slotshark' | 'dryrun';

// ---------------------------------------------------------------------------
// Execution params — a chain-tagged union
// ---------------------------------------------------------------------------
//
// Solana and EVM price transactions differently, so the knobs are not shared:
// Solana bids a Jito-style tip + priority fee; BSC bids gas and (when submitting
// directly) picks a private relay. Modelling them as one flat bag would let a
// rule carry meaningless fields for its chain.

export interface SolanaExecParams {
  kind: 'sol';
  /**
   * SOL. An EXPLICIT per-rule override of the account-level tip
   * (`SniperFeeSettings.tip`). Omitted (undefined) means "not set on this rule":
   * the global applies, and when the global is zero the venue picks its auto
   * tip exactly as before. See fees.ts for the precedence rule.
   */
  tip?: number;
  /** SOL. Same override/inherit semantics as `tip`. */
  priorityFee?: number;
  /** Default true. Through GMGN this is a boolean the venue honours; the relay is not our choice. */
  antimev: boolean;
}

export interface EvmExecParams {
  kind: 'evm';
  /** wei. Omitted lets the venue price gas. */
  maxFeePerGas?: string;
  /** wei. */
  maxPriorityFeePerGas?: string;
  /** gas units. */
  gasLimit?: string;
  /**
   * Preferred private relay (bloXroute / 48Club / BlockRazor). Only actionable when
   * OCT submits directly; through GMGN, anti-MEV is a boolean and the venue picks.
   */
  mevRelay?: 'bloxroute' | '48club' | 'blockrazor' | null;
}

export type ExecParams = SolanaExecParams | EvmExecParams;

// ---------------------------------------------------------------------------
// Account-level fee settings
// ---------------------------------------------------------------------------

/**
 * ONE set of blockspace-bid settings per account, inherited by every rule that
 * does not explicitly override them. The operator sets these once instead of on
 * every rule; the console surfaces the combined figure (venue rate + tip +
 * priority fee) as a single readout.
 *
 * Native units (SOL today). Both components are REQUIRED and must be finite and
 * non-negative — see fees.ts:normalizeFeeSettings, which is the only way a
 * value from a store reaches the reservation arithmetic.
 */
export interface SniperFeeSettings {
  /** SOL. Jito-style tip bid on every Solana leg that does not override it. */
  tip: number;
  /** SOL. Priority fee bid on every Solana leg that does not override it. */
  priorityFee: number;
}

// ---------------------------------------------------------------------------
// Matcher — AND/OR/NOT over the shared KeywordPattern
// ---------------------------------------------------------------------------

export type MatcherNode =
  | { op: 'leaf'; pattern: KeywordPattern }
  | { op: 'and' | 'or'; children: MatcherNode[] }
  | { op: 'not'; child: MatcherNode };

/** Which tweet interactions arm a rule. */
export type InteractionType = 'tweet' | 'retweet' | 'quote' | 'reply' | 'pin';

// ---------------------------------------------------------------------------
// SnipeRule
// ---------------------------------------------------------------------------

export type RuleState = 'draft' | 'disabled' | 'armed';
export type EntryStyle = 'single' | 'ladder';
export type SizeUnit = 'SOL' | 'BNB' | 'USDC';

export interface SnipeRule {
  id: string;
  userId: string;
  name: string;
  state: RuleState;
  chain: Chain;
  venue: Venue;

  /** Watched accounts, lowercased. */
  handles: string[];
  interactionTypes: InteractionType[];
  matcher: MatcherNode;

  phase: 1 | 2;
  /** Phase 1 binds the mint up front. Phase 2 resolves it at trigger time (null here). */
  mint: string | null;

  entryStyle: EntryStyle;
  /** Fractional weights summing to 1; null when entryStyle === 'single'. */
  ladderSplit: number[] | null;

  sizeUnit: SizeUnit;
  /** Total spend per trigger, before splitting across legs/wallets. */
  sizeTotal: number;

  walletIds: string[];
  /** Caps one leg on one wallet. */
  perFireCap: number;
  /** Caps sizeTotal x walletIds.length — the whole tweet. */
  perTriggerCap: number;

  slippageBps: number;
  exec: ExecParams;

  /** Trigger eligibility: reject if the tweet is older than this (tweet clock). */
  maxTweetAgeMs: number;
  /** Retry budget from the first attempt (fire clock). */
  fireWindowMs: number;
  maxAttempts: number;
  /** Abort if a *pushed* market cap exceeds this. Never fetched inline. */
  mcapCeiling: number | null;

  autoDisableAfterFire: boolean;
  /** Per-rule dry run. The process-level OCT_SNIPER_DRY_RUN overrides this. */
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Tweets (normalized) — the matcher's input
// ---------------------------------------------------------------------------

export interface NormalizedTweet {
  /** The tweet id as observed on the wire. */
  tweetId: string;
  /**
   * Root of the retweet/quote lineage, when known. J7's enriched (p_v1) lane
   * carries this; the lean (p_v0) lane may not. Idempotency keys on this when
   * present so a retweet collapses onto the tweet it amplifies.
   */
  rootTweetId: string | null;
  handle: string;
  interaction: InteractionType;
  text: string;
  /** Tweet creation time, epoch ms. */
  createdAt: number;
  /** When social-stream first observed it, epoch ms. */
  firstSeenAt: number;
}

// ---------------------------------------------------------------------------
// Fire path
// ---------------------------------------------------------------------------

export interface FireIntent {
  ruleId: string;
  userId: string;
  chain: Chain;
  venue: Venue;
  mint: string;
  /** The idempotency discriminator: rootTweetId ?? tweetId. */
  triggerKey: string;
  /** Per-(wallet, leg) targets computed from sizeTotal, ladderSplit and walletIds. */
  legs: FireLeg[];
  slippageBps: number;
  exec: ExecParams;
}

export interface FireLeg {
  walletId: string;
  legNo: number;
  /** Native-unit amount for this leg (already split), EXCLUDING fees. */
  amount: number;
}

/** What an executor reports back for a single send. */
export type SendOutcome =
  | { kind: 'filled'; signature: string; amountIn: number; amountOut: number; feePaid: number }
  | { kind: 'dead'; reason: DeadReason; status: number }
  | { kind: 'unknown' };

/** Only provably-unsubmitted failures are retryable. Everything else is `unknown`. */
export type DeadReason = 'validation' | 'auth' | 'rate_limit' | 'network';

export interface Executor {
  readonly venue: Venue;
  readonly chains: readonly Chain[];
  send(intent: FireIntent, leg: FireLeg, correlationId: string): Promise<SendOutcome>;
}

// ---------------------------------------------------------------------------
// Risk / budget
// ---------------------------------------------------------------------------

/** One budget row per (walletId, chain, day). Amounts are in the wallet's native unit. */
export interface BudgetRow {
  walletId: string;
  chain: Chain;
  unit: SizeUnit;
  /** YYYY-MM-DD in UTC. */
  day: string;
  perFireCap: number;
  dailyCap: number;
  maxOpen: number;
  spentToday: number;
  openPositions: number;
}

export type ReservationResult =
  | { ok: true }
  // `contended` is the hosted store's concurrent-writer fallthrough: the SQL
  // debited zero rows and then failed every diagnostic predicate on re-read,
  // which means another fire moved the row in between. Widening the union is
  // the honest option — misreporting it as `daily_cap` would tell an operator
  // their cap is exhausted when it is not. The in-memory and JSON stores are
  // single-threaded with no await between check and mutation, so they never
  // return it.
  | {
      ok: false;
      reason: 'per_fire_cap' | 'daily_cap' | 'max_open' | 'unit_mismatch' | 'no_wallet' | 'contended';
    };

// ---------------------------------------------------------------------------
// Wallets and the fire log
// ---------------------------------------------------------------------------
//
// These live here rather than in store.ts because three store implementations
// (in-memory, JSON, Supabase) and the API layer all speak them; store.ts is now
// one implementation among three.

export interface WalletConfig {
  walletId: string;
  label: string;
  /** Custodial venue holding this wallet. `dryrun` is not a venue you can fund. */
  venue: Exclude<Venue, 'dryrun'>;
  /**
   * Venue-side pubkey, passed verbatim to Slotshark's POST /buy.
   * CASE-SENSITIVE — base58 lowercased is a different, still-plausible address,
   * which is a silent way to send funds nowhere. Never normalise this.
   */
  address: string;
  chain: Chain;
  unit: SizeUnit;
  /** Caps a single leg. The authoritative per-fire cap is min(this, rule.perFireCap). */
  perFireCap: number;
  /** Total native-unit spend allowed per UTC day. */
  dailyCap: number;
  /** Max simultaneously-open positions. */
  maxOpen: number;
}

export interface FireRecord {
  id: string;
  ruleId: string;
  userId: string;
  triggerKey: string;
  walletId: string;
  legNo: number;
  attempts: number;
  mint: string;
  amount: number;
  state: 'filled' | 'expired' | 'aborted' | 'unknown';
  /**
   * Whether this row spent real money. Taken from `registry.isDryRun(rule)` at
   * fire time, NOT from `rule.dryRun` — the process-level OCT_SNIPER_DRY_RUN
   * overrides the rule flag, so the rule flag alone would mislabel every row
   * fired while the process switch was on. Without this field a synthetic
   * dry-run fill and a real one are indistinguishable in the log, which is the
   * most dangerous ambiguity a money log can carry.
   */
  dryRun: boolean;
  venue: Venue;
  signature?: string;
  abortReason?: string;
  /** Human resolution of an `unknown` leg. See POST /sniper/v1/fires/:id/resolve. */
  resolution?: 'filled' | 'not_filled';
  resolvedAt?: number;
  resolvedNote?: string;
  at: number;
}
