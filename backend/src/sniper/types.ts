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
 * `bsc` has never had an executor: it stays in the union because the rule schema
 * and executor registry are chain-generic by design, and
 * `ExecutorRegistry.resolve` throws rather than silently routing a rule to a
 * venue that cannot serve its chain.
 *
 * `rhc` is Robinhood Chain (chainId 4663, an Arbitrum Orbit L3) and DOES have an
 * executor — `executors/evmUniswap.ts`. It is a distinct member rather than a
 * reuse of `bsc` because the two share nothing an executor cares about: a
 * different RPC, a different WETH, different routers, a different native unit.
 * Collapsing them would make a `bsc` rule silently routable to Robinhood pools.
 */
export type Chain = 'sol' | 'bsc' | 'rhc';

/**
 * How a fire is routed. Slotshark (Solana, custodial) and the dry-run seam were
 * Phase 1; `evm_uniswap` is the Robinhood Chain path.
 *
 * `evm_uniswap` differs from every other venue in one structural way: it is
 * NON-CUSTODIAL. Slotshark holds the wallet and OCT holds a bearer token, so a
 * leak drains a deliberately-small venue balance; `evm_uniswap` signs with a key
 * OCT reads at fire time, so a leak drains the wallet. See the key discipline at
 * the top of executors/evmUniswap.ts.
 *
 * GMGN is deliberately NOT a Phase 1 venue. The operator's `GMGN_API_KEY` is
 * provisioned for enrichment/market data (see utils/gmgnClient.ts) and must never
 * become a trading credential — that would execute every user's snipes on the
 * operator's own GMGN account. When GMGN trading is added it arrives as a
 * per-user connected credential (ADR-012), never a shared server-side key.
 */
export type Venue = 'slotshark' | 'dryrun' | 'evm_uniswap';

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
  /** SOL. Omitted (undefined) selects the venue's auto tip. */
  tip?: number;
  /** SOL. Omitted selects the venue's auto priority fee. */
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
/** Native sizing units. `ETH` is Robinhood Chain's native currency. */
export type SizeUnit = 'SOL' | 'BNB' | 'USDC' | 'ETH';

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
