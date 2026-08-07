// Sniper domain types for the console, mirrored from backend/src/sniper/types.ts.
//
// Duplicated rather than imported: the frontend has no path alias and no
// tsconfig reference into backend/src, and `@oct/shared` — the only
// cross-workspace import — does not export sniper types. Standing alone is also
// the house idiom for a page's own vocabulary (types/fomo.ts, types/portfolio.ts,
// types/wallets.ts are all standalone and none is re-exported through
// types/index.ts). Promoting these into packages/shared would touch its curated
// barrel and is a separate change.
//
// The pure helpers at the bottom mirror backend/src/sniper/{legs,fees}.ts so the
// form can warn about a rule the server would reject at arm time, BEFORE the
// operator saves it. They are the unit-test targets — see frontend/test/sniperRules.test.ts.

import type { KeywordPattern } from '@oct/shared';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type Chain = 'sol' | 'bsc';
/** GMGN is deliberately absent — see backend/src/sniper/types.ts:24-33. */
export type Venue = 'slotshark' | 'dryrun';
export type RuleState = 'draft' | 'disabled' | 'armed';
export type EntryStyle = 'single' | 'ladder';
export type SizeUnit = 'SOL' | 'BNB' | 'USDC';
export type InteractionType = 'tweet' | 'retweet' | 'quote' | 'reply' | 'pin';

export type MatcherNode =
  | { op: 'leaf'; pattern: KeywordPattern }
  | { op: 'and' | 'or'; children: MatcherNode[] }
  | { op: 'not'; child: MatcherNode };

export interface SolanaExecParams {
  kind: 'sol';
  /** SOL. Omitted selects the venue's auto tip. */
  tip?: number;
  /** SOL. Omitted selects the venue's auto priority fee. */
  priorityFee?: number;
  antimev: boolean;
}

export interface EvmExecParams {
  kind: 'evm';
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  gasLimit?: string;
  mevRelay?: 'bloxroute' | '48club' | 'blockrazor' | null;
}

export type ExecParams = SolanaExecParams | EvmExecParams;

export interface SnipeRule {
  id: string;
  userId: string;
  name: string;
  state: RuleState;
  chain: Chain;
  venue: Venue;

  /**
   * INERT in the alpha. OCT runs no tweet feed — Slotshark's own Twitter
   * triggers carry the automatic path and never call back into OCT. These are
   * persisted so a rule written today still means the same thing when M2 lands.
   * The form renders them inside a disabled fieldset that says so.
   */
  handles: string[];
  interactionTypes: InteractionType[];
  matcher: MatcherNode;

  phase: 1 | 2;
  mint: string | null;

  entryStyle: EntryStyle;
  ladderSplit: number[] | null;

  sizeUnit: SizeUnit;
  /** Spend per WALLET per trigger, before the ladder split. */
  sizeTotal: number;

  walletIds: string[];
  perFireCap: number;
  perTriggerCap: number;

  slippageBps: number;
  exec: ExecParams;

  maxTweetAgeMs: number;
  fireWindowMs: number;
  maxAttempts: number;
  mcapCeiling: number | null;

  autoDisableAfterFire: boolean;
  dryRun: boolean;
}

export interface FireLeg {
  walletId: string;
  legNo: number;
  /** Native-unit amount for this leg, EXCLUDING fees. */
  amount: number;
}

/** Mirrors backend `WalletConfig`. `address` is a public on-chain address. */
export interface SniperWallet {
  walletId: string;
  label: string;
  venue: Exclude<Venue, 'dryrun'>;
  /** Venue-side pubkey. CASE-SENSITIVE — never lowercase a base58 address. */
  address: string;
  chain: Chain;
  unit: SizeUnit;
  perFireCap: number;
  dailyCap: number;
  maxOpen: number;
}

export type FireState = 'filled' | 'expired' | 'aborted' | 'unknown';

/** Mirrors backend `FireRecord`. */
export interface SniperFire {
  id: string;
  ruleId: string;
  userId: string;
  triggerKey: string;
  walletId: string;
  legNo: number;
  attempts: number;
  mint: string;
  amount: number;
  state: FireState;
  /** Whether this row spent real money. A `filled` dry-run row moved nothing. */
  dryRun: boolean;
  venue: Venue;
  signature?: string;
  abortReason?: string;
  resolution?: 'filled' | 'not_filled';
  resolvedAt?: number;
  resolvedNote?: string;
  at: number;
}

export interface BudgetRow {
  walletId: string;
  chain: Chain;
  unit: SizeUnit;
  /** YYYY-MM-DD, UTC. */
  day: string;
  perFireCap: number;
  dailyCap: number;
  maxOpen: number;
  spentToday: number;
  openPositions: number;
}

/** Venue connection METADATA. There is no token field, by design. */
export interface VenueConnection {
  venue: Venue;
  connected: boolean;
  region: string | null;
  walletAddress: string | null;
  label: string | null;
  updatedAt: string | null;
}

export interface KillState {
  on: boolean;
  reason: string | null;
  trippedAt: number | null;
}

export interface SniperStatus {
  mode: 'local' | 'hosted';
  /** OCT_SNIPER_DRY_RUN. Env is unreadable from the browser, so the API reports it. */
  processDryRun: boolean;
  /** Where triggers actually live. A literal from the API, not a frontend guess. */
  triggerSource: string;
  kill: KillState;
  venue: VenueConnection;
  counts: {
    rules: number;
    armedRules: number;
    wallets: number;
    unresolvedUnknown: number;
  };
}

export interface FireLegResult {
  walletId: string;
  legNo: number;
  amount: number;
  state: FireState;
  reason?: string;
  signature?: string;
  attempts: number;
}

export interface FireResponse {
  outcome: 'suppressed' | 'aborted' | 'fired';
  reason?: string;
  legs: FireLegResult[];
  ruleDisabled: boolean;
  tweetId: string;
  dryRun: boolean;
}

/**
 * The RLS-readable half of `sniper_venue_credentials`. Snake_case because it is
 * a Supabase row read directly by the browser, not an OCT API response — same
 * shape convention as types/wallets.ts `TrackedWallet`.
 *
 * There is no secret column here and no way to read one back:
 * `sniper_get_venue_secret` has no `authenticated` grant.
 */
export interface SniperVenueCredential {
  id: string;
  venue: string;
  wallet_address: string | null;
  region: string | null;
  label: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Pure helpers — mirrors of the backend's leg/fee math
// ---------------------------------------------------------------------------

/** The subset of a rule that determines its legs. Lets a draft be previewed. */
export type LegShape = Pick<SnipeRule, 'entryStyle' | 'ladderSplit' | 'sizeTotal' | 'walletIds'>;
/** The subset that determines a leg's fees. */
export type FeeShape = Pick<SnipeRule, 'venue' | 'exec'>;

export const MAX_LADDER_LEGS = 10;

/**
 * Anchored, and deliberately NOT `SOL_ADDRESS_REGEX` from `@oct/shared`: that
 * one carries the /g flag (packages/shared/src/contract.ts), and `.test()` on a
 * /g regex is stateful through `lastIndex` — alternate calls on the same valid
 * address return false, so every second wallet an operator pasted would be
 * rejected as malformed. Matches the backend router's local copy exactly.
 */
export function isSolAddress(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,48}$/.test(value.trim());
}

/** Parse the ladder-split text field. Returns null when it is not a number list. */
export function parseLadderSplit(raw: string): number[] | null {
  const parts = raw
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return nums;
}

export type LadderSplitProblem = 'empty' | 'negative' | 'not_normalized' | 'too_many';

/**
 * Mirrors backend/src/sniper/legs.ts:12-23, including the 1e-9 tolerance, so the
 * form refuses exactly what arm time refuses. A looser tolerance would let
 * weights summing to 1.5 through the form and spend 50% over sizeTotal.
 */
export function validateLadderSplit(
  split: number[] | null,
): { ok: true } | { ok: false; reason: LadderSplitProblem } {
  if (!split || split.length === 0) return { ok: false, reason: 'empty' };
  if (split.length > MAX_LADDER_LEGS) return { ok: false, reason: 'too_many' };
  if (split.some((w) => !Number.isFinite(w) || w <= 0)) return { ok: false, reason: 'negative' };
  const sum = split.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 1e-9) return { ok: false, reason: 'not_normalized' };
  return { ok: true };
}

/**
 * Mirrors backend/src/sniper/legs.ts:27-44. One leg per (wallet x ladder step),
 * and an INVALID split collapses to one full-size leg rather than scaling spend
 * down — copying that exactly is the point, so the preview cannot under-report.
 */
export function computeLegsPreview(rule: LegShape): FireLeg[] {
  const usable =
    rule.entryStyle === 'ladder' && validateLadderSplit(rule.ladderSplit).ok ? rule.ladderSplit : null;
  const weights = usable ?? [1];

  const legs: FireLeg[] = [];
  for (const walletId of rule.walletIds) {
    weights.forEach((w, i) => {
      legs.push({ walletId, legNo: i, amount: rule.sizeTotal * w });
    });
  }
  return legs;
}

/** Slotshark charges 0.5%; the dry-run seam mirrors it so caps are exercised realistically. */
const VENUE_FEE_RATE: Record<Venue, number> = {
  slotshark: 0.005,
  dryrun: 0.005,
};

/** Mirrors backend/src/sniper/fees.ts. Native units; EVM gas is not modelled. */
export function estimateFeesPreview(rule: FeeShape, legAmount: number): number {
  const rate = VENUE_FEE_RATE[rule.venue] ?? 0.005;
  let fee = legAmount * rate;
  if (rule.exec.kind === 'sol') {
    fee += rule.exec.tip ?? 0;
    fee += rule.exec.priorityFee ?? 0;
  }
  return fee;
}

/**
 * What the WHOLE trigger spends: Σ over every leg of (amount + fees). This is the
 * number `perTriggerCap` bounds, and the number the fire modal shows — a rule
 * whose trigger total exceeds its own cap aborts at executeFire step 2 on every
 * trigger, so the form warns before the server rejects it at arm time.
 */
export function triggerTotalPreview(rule: LegShape & FeeShape): number {
  return computeLegsPreview(rule).reduce((sum, leg) => sum + leg.amount + estimateFeesPreview(rule, leg.amount), 0);
}

/**
 * Plain words for the abort/refusal vocabulary the API returns verbatim. An
 * unmapped reason falls through to itself rather than to a generic string: a
 * money log that says "something went wrong" is worse than one that says a
 * word the operator can grep the docs for.
 */
export function describeAbortReason(reason: string): string {
  switch (reason) {
    case 'per_trigger_cap':
      return 'Per-trigger cap — the whole trigger cost more than the rule allows.';
    case 'per_fire_cap':
      return 'Per-fire cap — this single leg cost more than one fire may.';
    case 'daily_cap':
      return "Daily cap — today's spend on this wallet is exhausted.";
    case 'max_open':
      return 'Max open — this wallet already holds its maximum open positions.';
    case 'unit_mismatch':
      return "Unit mismatch — the rule sizes in a unit this wallet's budget is not denominated in.";
    case 'kill_switch':
      return 'Kill switch — the console kill switch was on.';
    case 'mcap_ceiling':
      return 'Market-cap ceiling — a pushed market cap exceeded the rule ceiling.';
    case 'no_wallet':
      return 'No wallet — the leg targeted a wallet that does not exist.';
    case 'no_mint':
      return 'No mint — a phase 1 rule must bind its mint up front.';
    case 'no_credential':
      return 'No credential — no venue token is connected, so nothing could be sent.';
    case 'no_wallet_address':
      return 'No wallet address — a targeted wallet has no venue-side address.';
    case 'venue_unsupported':
      return 'Venue unsupported — no executor accepts this rule’s venue/chain pair.';
    case 'contended':
      return 'Contended — another fire moved the budget row mid-reservation. Nothing was spent.';
    default:
      return reason;
  }
}
