// Slotshark's Twitter Sniper CONFIGS — the standing tweet -> buy rules that live
// inside the operator's own Slotshark account. This module is the pure half:
// types, normalization and validation. It builds request bodies and never talks
// to the network; SlotsharkDashboard owns the HTTP and the response narrowing.
//
// WHAT THIS DOES NOT CHANGE. Authoring a config here still does not put OCT in
// the loop when one fires: Slotshark runs the tweet feed, executes the buy from
// its own balance, and notifies out of band (its Telegram bot). No callback
// reaches OCT, so OCT's caps, kill switch and fire log continue to bind exactly
// one thing — buys fired from this console through executeFire. The console's
// permanent notice stays true, and this module must not be described as if it
// brought automatic buys under OCT's controls.
//
// SHAPE, AND WHY IT IS THIS SHAPE. The vendor contract is now official (docs
// supplied by Slotshark, 2026-08-08) and it has four sharp edges that a naive
// "spread the caller's object into JSON" client falls off:
//
//  1. `engagement` spells its keyword filters SINGULAR (`keywordInclude` /
//     `keywordExclude`); every other mode uses the plural pair. Sending the
//     wrong form is a 400. So there is one serializer PER MODE and no shared
//     field-writer — the field names are literal in five separate functions,
//     which makes a mismatch a compile error rather than a runtime 400.
//  2. PATCH merges one level deep into `snipeParams`, `params` and `taskTiming`,
//     but ARRAYS ARE REPLACED WHOLESALE. A caller who sends two of an existing
//     five handles silently loses three. Every array in a patch is therefore
//     wrapped in `ArrayReplacement<T>` — you cannot express one without typing
//     the word `replaceAll`.
//  3. Sizing is exclusive: mention/engagement/pfp_update take EXACTLY ONE of
//     `amount` or `sellPercent` (both is a 400, neither is a 400). That is
//     modelled as a union, so "both" is unrepresentable rather than validated.
//  4. Fees, slippage and limit sells live INSIDE `snipeParams`; a top-level
//     `tip` or `sellTip` is a 400. Bodies here are assembled key by key from an
//     allow-list and never by spreading caller input, so a stray top-level key
//     cannot ride along.
//
// FAILING CLOSED. Every check below refuses rather than repairs, because the
// thing being authored spends money on a loop OCT cannot see. A config that
// fails to save is visible and fixable; a config that saves with the wrong size
// buys wrong every time it fires and nothing here would ever learn about it.

/** The five modes. `modeType` CANNOT be changed after create — delete and recreate. */
export const TWITTER_MODES = ['ca_scanner', 'mention', 'engagement', 'follow_unfollow', 'pfp_update'] as const;
export type TwitterMode = (typeof TWITTER_MODES)[number];

export const SNIPE_PLATFORMS = ['pumpfun', 'raydium', 'meteora', 'moonshot'] as const;
export type SnipePlatform = (typeof SNIPE_PLATFORMS)[number];

/** Path under the regional dashboard base. Exported so the client and its tests agree. */
export const TWITTER_CONFIGS_PATH = '/twitter/configs';

const MAX_NAME_LEN = 40;
const MAX_HANDLES = 50;

/**
 * Anchored and LOCAL, for the same reason router.ts keeps its own copy: the
 * shared `SOL_ADDRESS_REGEX` carries /g, and `.test()` on a /g regex is stateful
 * via lastIndex, so alternate calls on the same valid mint return false.
 */
const SOL_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,48}$/;

/**
 * Handles are stored bare and lowercase at the venue; 1-15 chars of
 * [A-Za-z0-9_]. Tested after normalization, hence the lowercase-only class.
 */
const BARE_HANDLE = /^[a-z0-9_]{1,15}$/;

// ---------------------------------------------------------------------------
// Result vocabulary
// ---------------------------------------------------------------------------

/**
 * A frozen vocabulary, like `ValidationReason` in validateRule.ts: a route
 * renders these directly, so a respelling changes what an operator is told.
 */
export type TwitterConfigReason =
  | 'invalid_name'
  | 'invalid_handle'
  | 'no_handles'
  | 'too_many_handles'
  | 'invalid_keyword'
  | 'no_trigger_selected'
  | 'ca_scanner_requires_sol_amount'
  | 'sol_amount_not_allowed'
  | 'sizing_required'
  | 'invalid_amount'
  | 'invalid_sell_percent'
  | 'invalid_token_address'
  | 'engagement_scope_ambiguous'
  | 'invalid_snipe_params'
  | 'invalid_limit_sell'
  | 'invalid_max_buy_count'
  | 'invalid_task_timing'
  | 'invalid_platforms'
  | 'empty_patch';

export type TwitterConfigResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: TwitterConfigReason; detail?: string };

/** The JSON body of a create/replace/patch request, ready to send. */
export type TwitterConfigBody = Record<string, unknown>;

const ok = <T>(value: T): TwitterConfigResult<T> => ({ ok: true, value });
const fail = <T>(reason: TwitterConfigReason, detail?: string): TwitterConfigResult<T> => ({
  ok: false,
  reason,
  detail,
});

/**
 * Refused BEFORE the request left OCT. Deliberately not one of the Vendor*
 * errors: those mean Slotshark said no and the operator may need to retry or
 * wait, this means OCT said no and the input has to change.
 */
export class TwitterConfigValidationError extends Error {
  constructor(
    readonly reason: TwitterConfigReason,
    readonly detail?: string,
  ) {
    super(`Slotshark twitter config rejected locally (${reason})${detail ? `: ${detail}` : ''}`);
    this.name = 'TwitterConfigValidationError';
  }
}

// ---------------------------------------------------------------------------
// Array replacement — the PATCH trap, made unrepresentable
// ---------------------------------------------------------------------------

/**
 * A patch value for an array field.
 *
 * The vendor merges `params`, `snipeParams` and `taskTiming` ONE LEVEL DEEP and
 * REPLACES arrays wholesale — `{params:{targetHandles:['a']}}` against a config
 * tracking five handles leaves it tracking one. The wrapper exists so that
 * losing four handles is something a caller had to type `replaceAll` to do.
 */
export interface ArrayReplacement<T> {
  readonly replaceAll: readonly T[];
}

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

/**
 * EXACTLY ONE of `amount` or `sellPercent` for mention / engagement /
 * pfp_update. Both is a 400 and neither is a 400, so the union makes both
 * unrepresentable instead of merely invalid.
 */
export type TwitterSizing = { kind: 'buy'; amount: number } | { kind: 'sell'; sellPercent: number };

/**
 * `follow_unfollow` is the sole exception: `amount` fires on follow and
 * `sellPercent` on unfollow, so the two may coexist. At least one is required,
 * which the union still guarantees.
 */
export type FollowUnfollowSizing = TwitterSizing | { kind: 'both'; amount: number; sellPercent: number };

// ---------------------------------------------------------------------------
// snipeParams
// ---------------------------------------------------------------------------

/**
 * One rung of a limit-sell ladder.
 *
 * `value` is UNIT-POLYMORPHIC and that is the whole hazard: for `time` it is
 * SECONDS and must be > 0; for `pnl` it is PERCENT and a NEGATIVE value is a
 * stop-loss. Reading 30 as "30 seconds" when the type is `pnl` builds a rung
 * that never triggers.
 */
export interface LimitSell {
  type: 'time' | 'pnl';
  /** 1-100. */
  sellPercent: number;
  value: number;
  tip?: number;
  priorityFee?: number;
  slippage?: number;
  antimev?: boolean;
  retries?: boolean;
}

/**
 * Fees, slippage and limit sells live HERE, never at the top level of a config —
 * a top-level `tip` or `sellTip` is a 400.
 */
export interface SnipeParams {
  solAmount?: number;
  /** PERCENT, not basis points — same domain as /buy's `slippage`. */
  slippage?: number;
  tip?: number;
  priorityFee?: number;
  sellSlippage?: number;
  sellTip?: number;
  sellPriorityFee?: number;
  antimev?: boolean;
  sellAntimev?: boolean;
  /** Basis points, 0-5000. */
  migrationBuffer?: number;
  minMarketCap?: number;
  maxMarketCap?: number;
  minLiquidity?: number;
  minTokenAgeSecs?: number;
  maxTokenAgeSecs?: number;
  maxPoolTax?: number;
  skipIfBought?: boolean;
  retries?: boolean;
  safeSlippage?: boolean;
  skipSusPools?: boolean;
  limitSells?: readonly LimitSell[];
}

/** `ca_scanner` sizes from here and nowhere else, so `solAmount` is required. */
export type CaScannerSnipeParams = SnipeParams & { solAmount: number };

/** The patch form: same fields, but `limitSells` must be replaced wholesale. */
export type SnipeParamsPatch = Omit<SnipeParams, 'limitSells'> & {
  limitSells?: ArrayReplacement<LimitSell>;
};

interface NumberRule {
  /** Inclusive unless `exclusiveMin`. */
  min: number;
  max?: number;
  exclusiveMin?: boolean;
  integer?: boolean;
}

/**
 * The numeric allow-list. Ranges are enforced only where the docs state one:
 * inventing a ceiling would refuse a config the venue would have accepted, and
 * the whole point of the allow-list is that unknown keys never ship at all.
 *
 * The two exceptions are the slippage pair, capped at 100 for the same reason
 * executors/slotshark.ts caps it: a tolerance above 100% is not a tolerance, it
 * is the absence of one, and this is the field that decides whether a fill can
 * be sandwiched.
 */
const SNIPE_NUMERIC: Readonly<Record<string, NumberRule>> = {
  solAmount: { min: 0, exclusiveMin: true },
  slippage: { min: 0, exclusiveMin: true, max: 100 },
  tip: { min: 0 },
  priorityFee: { min: 0 },
  sellSlippage: { min: 0, exclusiveMin: true, max: 100 },
  sellTip: { min: 0 },
  sellPriorityFee: { min: 0 },
  migrationBuffer: { min: 0, max: 5000, integer: true },
  minMarketCap: { min: 0 },
  maxMarketCap: { min: 0 },
  minLiquidity: { min: 0 },
  minTokenAgeSecs: { min: 0, integer: true },
  maxTokenAgeSecs: { min: 0, integer: true },
  maxPoolTax: { min: 0 },
};

const SNIPE_BOOLEAN = [
  'antimev',
  'sellAntimev',
  'skipIfBought',
  'retries',
  'safeSlippage',
  'skipSusPools',
] as const;

// ---------------------------------------------------------------------------
// Per-mode params
// ---------------------------------------------------------------------------

/** `mainTweet` OR `retweet` must be true — the other two only narrow. */
export interface CaScannerTriggers {
  mainTweet: boolean;
  retweet: boolean;
  quote: boolean;
  reply: boolean;
}

export interface MentionTriggers {
  tweet: boolean;
  retweet: boolean;
  reply: boolean;
  quote: boolean;
  bioUpdate: boolean;
}

export interface EngagementActions {
  reply: boolean;
  retweet: boolean;
  quote: boolean;
}

/**
 * No `tokenAddress`: ca_scanner DISCOVERS the mint in the tweet at fire time.
 * A mint here would be meaningless, so the field does not exist rather than
 * being accepted and dropped.
 */
export interface CaScannerParams {
  targetHandles: readonly string[];
  triggers: CaScannerTriggers;
  firstBuyOnly?: boolean;
  keywordsInclude?: readonly string[];
  keywordsExclude?: readonly string[];
}

export interface MentionParams {
  targetHandle: string;
  /** At least one true. */
  targetTriggers: MentionTriggers;
  keywordsInclude?: readonly string[];
  keywordsExclude?: readonly string[];
  tokenAddress: string;
  sizing: TwitterSizing;
}

/** `targetTweetId` and `reactedToHandles` are alternatives; both at once is refused. */
export type EngagementScope =
  | { kind: 'tweet'; targetTweetId: string }
  | { kind: 'reactedTo'; reactedToHandles: readonly string[] };

export interface EngagementParams {
  targetHandle: string;
  scope?: EngagementScope;
  /** At least one true. */
  targetActions: EngagementActions;
  /** SINGULAR here and only here. See the header. */
  keywordInclude?: readonly string[];
  keywordExclude?: readonly string[];
  tokenAddress: string;
  sizing: TwitterSizing;
}

export interface FollowUnfollowParams {
  followerHandles: readonly string[];
  followedHandles: readonly string[];
  fireOnFollow: boolean;
  fireOnUnfollow: boolean;
  tokenAddress: string;
  sizing: FollowUnfollowSizing;
}

export interface PfpUpdateParams {
  targetHandle: string;
  tokenAddress: string;
  sizing: TwitterSizing;
}

/** Epoch milliseconds. */
export interface TaskTiming {
  startMs: number;
  endMs: number;
}

interface CommonInput {
  name: string;
  /** Integer >= 1. OMITTED MEANS UNLIMITED — do not default it to a number. */
  maxBuyCount?: number;
  taskTiming?: TaskTiming;
  /** Subset of SNIPE_PLATFORMS. An empty array is rejected; OMIT for all. */
  allowedPlatforms?: readonly SnipePlatform[];
}

/**
 * A whole config, as create (POST) and replace (PUT) both take it. `mode`
 * selects the serializer and is emitted as `modeType`; on PUT it must equal the
 * config's existing mode, because the vendor refuses a mode change — the only
 * way to change mode is DELETE then POST.
 */
export type TwitterConfigInput =
  | ({ mode: 'ca_scanner'; params: CaScannerParams; snipeParams: CaScannerSnipeParams } & CommonInput)
  | ({ mode: 'mention'; params: MentionParams; snipeParams?: SnipeParams } & CommonInput)
  | ({ mode: 'engagement'; params: EngagementParams; snipeParams?: SnipeParams } & CommonInput)
  | ({ mode: 'follow_unfollow'; params: FollowUnfollowParams; snipeParams?: SnipeParams } & CommonInput)
  | ({ mode: 'pfp_update'; params: PfpUpdateParams; snipeParams?: SnipeParams } & CommonInput);

// ---------------------------------------------------------------------------
// Per-mode params, patch form
// ---------------------------------------------------------------------------
//
// `sizing` is absent from every patch type, and so is engagement's `scope`.
// Both are pairs where one key must be ABSENT for the other to be legal, and a
// one-level merge can add a key but never remove one — patching `amount` onto a
// config that carries `sellPercent` produces the both-at-once body the vendor
// 400s. Changing either is a PUT (full config), which is why buildFullBody
// exists alongside buildPatchBody.

export interface CaScannerParamsPatch {
  targetHandles?: ArrayReplacement<string>;
  /** Whole object: it sits one level below `params`, so it is replaced, not merged. */
  triggers?: CaScannerTriggers;
  firstBuyOnly?: boolean;
  keywordsInclude?: ArrayReplacement<string>;
  keywordsExclude?: ArrayReplacement<string>;
}

export interface MentionParamsPatch {
  targetHandle?: string;
  targetTriggers?: MentionTriggers;
  keywordsInclude?: ArrayReplacement<string>;
  keywordsExclude?: ArrayReplacement<string>;
  tokenAddress?: string;
}

export interface EngagementParamsPatch {
  targetHandle?: string;
  targetActions?: EngagementActions;
  keywordInclude?: ArrayReplacement<string>;
  keywordExclude?: ArrayReplacement<string>;
  tokenAddress?: string;
}

export interface FollowUnfollowParamsPatch {
  followerHandles?: ArrayReplacement<string>;
  followedHandles?: ArrayReplacement<string>;
  /** Send the pair or neither — "at least one true" is uncheckable from half of it. */
  fireOnFollow?: boolean;
  fireOnUnfollow?: boolean;
  tokenAddress?: string;
}

export interface PfpUpdateParamsPatch {
  targetHandle?: string;
  tokenAddress?: string;
}

interface CommonPatch {
  name?: string;
  maxBuyCount?: number;
  /** Both keys or neither: `endMs > startMs` is uncheckable from half of it. */
  taskTiming?: TaskTiming;
  allowedPlatforms?: ArrayReplacement<SnipePlatform>;
}

/**
 * `mode` here is a SERIALIZER SELECTOR, not a field: it picks the params writer
 * (engagement's singular keywords) and is never emitted. A patch body carries no
 * `modeType` at all, so no patch can attempt the mode change the vendor refuses.
 */
export type TwitterConfigPatch =
  | ({ mode: 'ca_scanner'; params?: CaScannerParamsPatch; snipeParams?: SnipeParamsPatch } & CommonPatch)
  | ({ mode: 'mention'; params?: MentionParamsPatch; snipeParams?: SnipeParamsPatch } & CommonPatch)
  | ({ mode: 'engagement'; params?: EngagementParamsPatch; snipeParams?: SnipeParamsPatch } & CommonPatch)
  | ({ mode: 'follow_unfollow'; params?: FollowUnfollowParamsPatch; snipeParams?: SnipeParamsPatch } & CommonPatch)
  | ({ mode: 'pfp_update'; params?: PfpUpdateParamsPatch; snipeParams?: SnipeParamsPatch } & CommonPatch);

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Bare, lowercase, one leading '@' stripped — how the venue stores handles.
 * Returns null for anything that is not 1-15 of [A-Za-z0-9_] afterwards, which
 * includes a pasted profile URL and a second '@'. Refusing beats guessing: a
 * handle we mangled into something valid-looking would track the wrong account.
 */
export function normalizeHandle(raw: string): string | null {
  const bare = raw.trim().replace(/^@/, '').toLowerCase();
  return BARE_HANDLE.test(bare) ? bare : null;
}

/**
 * Normalize a handle list and enforce the documented 1-50 bound.
 *
 * Deduplicates AFTER normalization, because normalization creates duplicates
 * that were not in the input ('@Elon' and 'elon' collapse). The count is checked
 * on the deduplicated list, which is what the venue will store.
 */
function normalizeHandles(raw: readonly string[], field: string): TwitterConfigResult<string[]> {
  const out: string[] = [];
  for (const entry of raw) {
    const h = normalizeHandle(entry);
    if (h === null) return fail('invalid_handle', `${field}: ${JSON.stringify(entry)}`);
    if (!out.includes(h)) out.push(h);
  }
  if (out.length === 0) return fail('no_handles', field);
  if (out.length > MAX_HANDLES) return fail('too_many_handles', `${field}: ${out.length} > ${MAX_HANDLES}`);
  return ok(out);
}

/**
 * Trim keywords and refuse an empty one rather than dropping it. An empty
 * string matches every tweet: as `keywordsInclude` it disables the filter the
 * operator thought they set, as `keywordsExclude` it silences the config
 * entirely. Both are silent, and one of them costs money.
 */
function normalizeKeywords(raw: readonly string[], field: string): TwitterConfigResult<string[]> {
  const out: string[] = [];
  for (const entry of raw) {
    const k = entry.trim();
    if (k.length === 0) return fail('invalid_keyword', `${field}: empty keyword`);
    if (!out.includes(k)) out.push(k);
  }
  return ok(out);
}

function normalizeName(raw: string): TwitterConfigResult<string> {
  // Length only. Uniqueness is PER MODE and the vendor owns it — checking it
  // here would need a list read whose answer is stale by the time we POST, and
  // their 400 already names the collision.
  const name = raw.trim();
  if (name.length === 0 || name.length > MAX_NAME_LEN) return fail('invalid_name', `1-${MAX_NAME_LEN} chars`);
  return ok(name);
}

function normalizeMint(raw: string, field = 'tokenAddress'): TwitterConfigResult<string> {
  const mint = raw.trim();
  if (!SOL_MINT.test(mint)) return fail('invalid_token_address', field);
  return ok(mint);
}

// ---------------------------------------------------------------------------
// Shared value checks
// ---------------------------------------------------------------------------

function checkNumber(key: string, value: number, rule: NumberRule): string | null {
  if (!Number.isFinite(value)) return `${key} is not finite`;
  if (rule.integer && !Number.isInteger(value)) return `${key} must be an integer`;
  if (rule.exclusiveMin ? value <= rule.min : value < rule.min) return `${key} must be > ${rule.min}`;
  if (rule.max !== undefined && value > rule.max) return `${key} must be <= ${rule.max}`;
  return null;
}

function writeSizing(
  out: TwitterConfigBody,
  sizing: FollowUnfollowSizing,
): TwitterConfigResult<TwitterConfigBody> {
  // Only the keys the union carries are written, so the "exactly one" rule is
  // enforced by construction rather than by a count of what the caller sent.
  //
  // But the union is only a compile-time guarantee. This client will be driven
  // by an NL layer parsing untrusted JSON, so a `sizing` with a missing or bogus
  // `kind` must be rejected — otherwise both branches fall through and a config
  // is built with no buy size, which sizes every fire at 0 SOL and never fills.
  if (sizing.kind !== 'buy' && sizing.kind !== 'sell' && sizing.kind !== 'both') {
    return fail('sizing_required');
  }
  if (sizing.kind === 'buy' || sizing.kind === 'both') {
    if (!Number.isFinite(sizing.amount) || sizing.amount <= 0) return fail('invalid_amount');
    out.amount = sizing.amount;
  }
  if (sizing.kind === 'sell' || sizing.kind === 'both') {
    if (!Number.isFinite(sizing.sellPercent) || sizing.sellPercent <= 0 || sizing.sellPercent > 100) {
      return fail('invalid_sell_percent');
    }
    out.sellPercent = sizing.sellPercent;
  }
  return ok(out);
}

// ---------------------------------------------------------------------------
// snipeParams serializer
// ---------------------------------------------------------------------------

function serializeLimitSells(rungs: readonly LimitSell[]): TwitterConfigResult<TwitterConfigBody[]> {
  const out: TwitterConfigBody[] = [];
  for (const [i, rung] of rungs.entries()) {
    if (rung.type !== 'time' && rung.type !== 'pnl') return fail('invalid_limit_sell', `limitSells[${i}].type`);
    if (!Number.isFinite(rung.sellPercent) || rung.sellPercent < 1 || rung.sellPercent > 100) {
      return fail('invalid_limit_sell', `limitSells[${i}].sellPercent must be 1-100`);
    }
    if (!Number.isFinite(rung.value)) return fail('invalid_limit_sell', `limitSells[${i}].value`);
    // `time` is SECONDS and a rung at t<=0 either fires instantly or never; the
    // `pnl` sibling is PERCENT and negative is the legitimate stop-loss case, so
    // the sign check applies to one type only.
    if (rung.type === 'time' && rung.value <= 0) {
      return fail('invalid_limit_sell', `limitSells[${i}].value must be > 0 seconds`);
    }
    const row: TwitterConfigBody = { type: rung.type, sellPercent: rung.sellPercent, value: rung.value };
    for (const key of ['tip', 'priorityFee', 'slippage'] as const) {
      const v = rung[key];
      if (v === undefined) continue;
      const problem = checkNumber(`limitSells[${i}].${key}`, v, key === 'slippage' ? { min: 0, exclusiveMin: true, max: 100 } : { min: 0 });
      if (problem) return fail('invalid_limit_sell', problem);
      row[key] = v;
    }
    if (rung.antimev !== undefined) row.antimev = rung.antimev;
    if (rung.retries !== undefined) row.retries = rung.retries;
    out.push(row);
  }
  return ok(out);
}

/**
 * `snipeParams`, assembled from an allow-list.
 *
 * `allowSolAmount` is false for every mode except ca_scanner. Those modes size
 * from `params.amount`/`params.sellPercent`, so a `snipeParams.solAmount`
 * alongside is a second sizing field with no documented precedence — refusing it
 * costs a save, accepting it risks buying the wrong size on every fire.
 */
function serializeSnipeParams(
  sp: SnipeParams | SnipeParamsPatch,
  opts: { allowSolAmount: boolean; limitSells?: readonly LimitSell[] },
): TwitterConfigResult<TwitterConfigBody> {
  const out: TwitterConfigBody = {};

  for (const [key, rule] of Object.entries(SNIPE_NUMERIC)) {
    const v = (sp as Record<string, unknown>)[key];
    if (v === undefined) continue;
    if (typeof v !== 'number') return fail('invalid_snipe_params', `${key} must be a number`);
    if (key === 'solAmount' && !opts.allowSolAmount) {
      return fail('sol_amount_not_allowed', 'this mode sizes from params.amount / params.sellPercent');
    }
    const problem = checkNumber(key, v, rule);
    if (problem) return fail('invalid_snipe_params', problem);
    out[key] = v;
  }

  for (const key of SNIPE_BOOLEAN) {
    const v = sp[key];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') return fail('invalid_snipe_params', `${key} must be a boolean`);
    out[key] = v;
  }

  // A window whose floor is above its ceiling matches nothing, which reads as a
  // dead config rather than as a bad filter.
  if (typeof out.minMarketCap === 'number' && typeof out.maxMarketCap === 'number' && out.minMarketCap > out.maxMarketCap) {
    return fail('invalid_snipe_params', 'minMarketCap > maxMarketCap');
  }
  if (
    typeof out.minTokenAgeSecs === 'number' &&
    typeof out.maxTokenAgeSecs === 'number' &&
    out.minTokenAgeSecs > out.maxTokenAgeSecs
  ) {
    return fail('invalid_snipe_params', 'minTokenAgeSecs > maxTokenAgeSecs');
  }

  if (opts.limitSells !== undefined) {
    const rungs = serializeLimitSells(opts.limitSells);
    if (!rungs.ok) return rungs;
    // An empty array is emitted, not omitted: on a patch it is the only way to
    // say "clear the ladder", and omitting it would make that request a no-op
    // the caller cannot distinguish from success.
    out.limitSells = rungs.value;
  }

  return ok(out);
}

// ---------------------------------------------------------------------------
// Per-mode params serializers — CREATE / PUT
//
// Five functions, five literal sets of field names, no shared field-writer. The
// singular/plural keyword split lives here and nowhere else.
// ---------------------------------------------------------------------------

function serializeCaScannerParams(p: CaScannerParams): TwitterConfigResult<TwitterConfigBody> {
  const handles = normalizeHandles(p.targetHandles, 'targetHandles');
  if (!handles.ok) return handles;
  // mainTweet OR retweet. quote/reply only narrow what those two admit, so a
  // config with neither of the first two never fires, silently.
  if (!p.triggers.mainTweet && !p.triggers.retweet) {
    return fail('no_trigger_selected', 'triggers.mainTweet or triggers.retweet must be true');
  }
  const out: TwitterConfigBody = {
    targetHandles: handles.value,
    triggers: {
      mainTweet: p.triggers.mainTweet,
      retweet: p.triggers.retweet,
      quote: p.triggers.quote,
      reply: p.triggers.reply,
    },
  };
  if (p.firstBuyOnly !== undefined) out.firstBuyOnly = p.firstBuyOnly;
  return writePluralKeywords(out, p.keywordsInclude, p.keywordsExclude);
}

function serializeMentionParams(p: MentionParams): TwitterConfigResult<TwitterConfigBody> {
  const handle = normalizeHandle(p.targetHandle);
  if (handle === null) return fail('invalid_handle', 'targetHandle');
  const t = p.targetTriggers;
  if (!t.tweet && !t.retweet && !t.reply && !t.quote && !t.bioUpdate) {
    return fail('no_trigger_selected', 'targetTriggers');
  }
  const mint = normalizeMint(p.tokenAddress);
  if (!mint.ok) return mint;

  const out: TwitterConfigBody = {
    targetHandle: handle,
    targetTriggers: {
      tweet: t.tweet,
      retweet: t.retweet,
      reply: t.reply,
      quote: t.quote,
      bioUpdate: t.bioUpdate,
    },
    tokenAddress: mint.value,
  };
  const keyworded = writePluralKeywords(out, p.keywordsInclude, p.keywordsExclude);
  if (!keyworded.ok) return keyworded;
  return writeSizing(out, p.sizing);
}

function serializeEngagementParams(p: EngagementParams): TwitterConfigResult<TwitterConfigBody> {
  const handle = normalizeHandle(p.targetHandle);
  if (handle === null) return fail('invalid_handle', 'targetHandle');
  const a = p.targetActions;
  if (!a.reply && !a.retweet && !a.quote) return fail('no_trigger_selected', 'targetActions');
  const mint = normalizeMint(p.tokenAddress);
  if (!mint.ok) return mint;

  const out: TwitterConfigBody = {
    targetHandle: handle,
    targetActions: { reply: a.reply, retweet: a.retweet, quote: a.quote },
    tokenAddress: mint.value,
  };

  if (p.scope) {
    if (p.scope.kind === 'tweet') {
      const id = p.scope.targetTweetId.trim();
      if (!/^\d{1,25}$/.test(id)) return fail('engagement_scope_ambiguous', 'targetTweetId must be numeric');
      out.targetTweetId = id;
    } else {
      const reactors = normalizeHandles(p.scope.reactedToHandles, 'reactedToHandles');
      if (!reactors.ok) return reactors;
      out.reactedToHandles = reactors.value;
    }
  }

  // SINGULAR — engagement and only engagement. Written literally here so the
  // plural writer can never reach this mode.
  if (p.keywordInclude !== undefined) {
    const kw = normalizeKeywords(p.keywordInclude, 'keywordInclude');
    if (!kw.ok) return kw;
    if (kw.value.length > 0) out.keywordInclude = kw.value;
  }
  if (p.keywordExclude !== undefined) {
    const kw = normalizeKeywords(p.keywordExclude, 'keywordExclude');
    if (!kw.ok) return kw;
    if (kw.value.length > 0) out.keywordExclude = kw.value;
  }

  return writeSizing(out, p.sizing);
}

function serializeFollowUnfollowParams(p: FollowUnfollowParams): TwitterConfigResult<TwitterConfigBody> {
  const followers = normalizeHandles(p.followerHandles, 'followerHandles');
  if (!followers.ok) return followers;
  const followed = normalizeHandles(p.followedHandles, 'followedHandles');
  if (!followed.ok) return followed;
  if (!p.fireOnFollow && !p.fireOnUnfollow) {
    return fail('no_trigger_selected', 'fireOnFollow or fireOnUnfollow must be true');
  }
  const mint = normalizeMint(p.tokenAddress);
  if (!mint.ok) return mint;

  const out: TwitterConfigBody = {
    followerHandles: followers.value,
    followedHandles: followed.value,
    fireOnFollow: p.fireOnFollow,
    fireOnUnfollow: p.fireOnUnfollow,
    tokenAddress: mint.value,
  };
  return writeSizing(out, p.sizing);
}

function serializePfpUpdateParams(p: PfpUpdateParams): TwitterConfigResult<TwitterConfigBody> {
  const handle = normalizeHandle(p.targetHandle);
  if (handle === null) return fail('invalid_handle', 'targetHandle');
  const mint = normalizeMint(p.tokenAddress);
  if (!mint.ok) return mint;
  const out: TwitterConfigBody = { targetHandle: handle, tokenAddress: mint.value };
  return writeSizing(out, p.sizing);
}

/** The PLURAL pair. Never reachable from the engagement serializer. */
function writePluralKeywords(
  out: TwitterConfigBody,
  include: readonly string[] | undefined,
  exclude: readonly string[] | undefined,
): TwitterConfigResult<TwitterConfigBody> {
  if (include !== undefined) {
    const kw = normalizeKeywords(include, 'keywordsInclude');
    if (!kw.ok) return kw;
    // On create an empty list says nothing, so it is omitted rather than sent.
    if (kw.value.length > 0) out.keywordsInclude = kw.value;
  }
  if (exclude !== undefined) {
    const kw = normalizeKeywords(exclude, 'keywordsExclude');
    if (!kw.ok) return kw;
    if (kw.value.length > 0) out.keywordsExclude = kw.value;
  }
  return ok(out);
}

// ---------------------------------------------------------------------------
// Per-mode params serializers — PATCH
// ---------------------------------------------------------------------------

function patchCaScannerParams(p: CaScannerParamsPatch): TwitterConfigResult<TwitterConfigBody> {
  const out: TwitterConfigBody = {};
  if (p.targetHandles) {
    const handles = normalizeHandles(p.targetHandles.replaceAll, 'targetHandles');
    if (!handles.ok) return handles;
    out.targetHandles = handles.value;
  }
  if (p.triggers) {
    if (!p.triggers.mainTweet && !p.triggers.retweet) {
      return fail('no_trigger_selected', 'triggers.mainTweet or triggers.retweet must be true');
    }
    out.triggers = {
      mainTweet: p.triggers.mainTweet,
      retweet: p.triggers.retweet,
      quote: p.triggers.quote,
      reply: p.triggers.reply,
    };
  }
  if (p.firstBuyOnly !== undefined) out.firstBuyOnly = p.firstBuyOnly;
  return patchPluralKeywords(out, p.keywordsInclude, p.keywordsExclude);
}

function patchMentionParams(p: MentionParamsPatch): TwitterConfigResult<TwitterConfigBody> {
  const out: TwitterConfigBody = {};
  if (p.targetHandle !== undefined) {
    const handle = normalizeHandle(p.targetHandle);
    if (handle === null) return fail('invalid_handle', 'targetHandle');
    out.targetHandle = handle;
  }
  if (p.targetTriggers) {
    const t = p.targetTriggers;
    if (!t.tweet && !t.retweet && !t.reply && !t.quote && !t.bioUpdate) {
      return fail('no_trigger_selected', 'targetTriggers');
    }
    out.targetTriggers = { tweet: t.tweet, retweet: t.retweet, reply: t.reply, quote: t.quote, bioUpdate: t.bioUpdate };
  }
  if (p.tokenAddress !== undefined) {
    const mint = normalizeMint(p.tokenAddress);
    if (!mint.ok) return mint;
    out.tokenAddress = mint.value;
  }
  return patchPluralKeywords(out, p.keywordsInclude, p.keywordsExclude);
}

function patchEngagementParams(p: EngagementParamsPatch): TwitterConfigResult<TwitterConfigBody> {
  const out: TwitterConfigBody = {};
  if (p.targetHandle !== undefined) {
    const handle = normalizeHandle(p.targetHandle);
    if (handle === null) return fail('invalid_handle', 'targetHandle');
    out.targetHandle = handle;
  }
  if (p.targetActions) {
    const a = p.targetActions;
    if (!a.reply && !a.retweet && !a.quote) return fail('no_trigger_selected', 'targetActions');
    out.targetActions = { reply: a.reply, retweet: a.retweet, quote: a.quote };
  }
  if (p.tokenAddress !== undefined) {
    const mint = normalizeMint(p.tokenAddress);
    if (!mint.ok) return mint;
    out.tokenAddress = mint.value;
  }
  // SINGULAR, again literally, in the patch writer for this mode only.
  if (p.keywordInclude) {
    const kw = normalizeKeywords(p.keywordInclude.replaceAll, 'keywordInclude');
    if (!kw.ok) return kw;
    out.keywordInclude = kw.value;
  }
  if (p.keywordExclude) {
    const kw = normalizeKeywords(p.keywordExclude.replaceAll, 'keywordExclude');
    if (!kw.ok) return kw;
    out.keywordExclude = kw.value;
  }
  return ok(out);
}

function patchFollowUnfollowParams(p: FollowUnfollowParamsPatch): TwitterConfigResult<TwitterConfigBody> {
  const out: TwitterConfigBody = {};
  if (p.followerHandles) {
    const h = normalizeHandles(p.followerHandles.replaceAll, 'followerHandles');
    if (!h.ok) return h;
    out.followerHandles = h.value;
  }
  if (p.followedHandles) {
    const h = normalizeHandles(p.followedHandles.replaceAll, 'followedHandles');
    if (!h.ok) return h;
    out.followedHandles = h.value;
  }
  const hasFollow = p.fireOnFollow !== undefined;
  const hasUnfollow = p.fireOnUnfollow !== undefined;
  if (hasFollow !== hasUnfollow) {
    // Half the pair cannot be validated: patching fireOnFollow:false onto a
    // config whose fireOnUnfollow is already false leaves it firing on nothing,
    // and the merge gives us no way to see the other half.
    return fail('no_trigger_selected', 'send fireOnFollow and fireOnUnfollow together');
  }
  if (hasFollow && hasUnfollow) {
    if (!p.fireOnFollow && !p.fireOnUnfollow) {
      return fail('no_trigger_selected', 'fireOnFollow or fireOnUnfollow must be true');
    }
    out.fireOnFollow = p.fireOnFollow;
    out.fireOnUnfollow = p.fireOnUnfollow;
  }
  if (p.tokenAddress !== undefined) {
    const mint = normalizeMint(p.tokenAddress);
    if (!mint.ok) return mint;
    out.tokenAddress = mint.value;
  }
  return ok(out);
}

function patchPfpUpdateParams(p: PfpUpdateParamsPatch): TwitterConfigResult<TwitterConfigBody> {
  const out: TwitterConfigBody = {};
  if (p.targetHandle !== undefined) {
    const handle = normalizeHandle(p.targetHandle);
    if (handle === null) return fail('invalid_handle', 'targetHandle');
    out.targetHandle = handle;
  }
  if (p.tokenAddress !== undefined) {
    const mint = normalizeMint(p.tokenAddress);
    if (!mint.ok) return mint;
    out.tokenAddress = mint.value;
  }
  return ok(out);
}

function patchPluralKeywords(
  out: TwitterConfigBody,
  include: ArrayReplacement<string> | undefined,
  exclude: ArrayReplacement<string> | undefined,
): TwitterConfigResult<TwitterConfigBody> {
  if (include) {
    const kw = normalizeKeywords(include.replaceAll, 'keywordsInclude');
    if (!kw.ok) return kw;
    // Empty IS emitted on a patch: `replaceAll: []` is how a filter is cleared.
    out.keywordsInclude = kw.value;
  }
  if (exclude) {
    const kw = normalizeKeywords(exclude.replaceAll, 'keywordsExclude');
    if (!kw.ok) return kw;
    out.keywordsExclude = kw.value;
  }
  return ok(out);
}

// ---------------------------------------------------------------------------
// Common (top-level) fields
// ---------------------------------------------------------------------------

function writeMaxBuyCount(out: TwitterConfigBody, v: number | undefined): TwitterConfigResult<TwitterConfigBody> {
  if (v === undefined) return ok(out); // Omitted means UNLIMITED — never defaulted.
  if (!Number.isInteger(v) || v < 1) return fail('invalid_max_buy_count', 'integer >= 1');
  // Lowering it below the buys already made is refused BY THE VENUE; that count
  // is not knowable here, so their 400 is the guard and it passes through.
  out.maxBuyCount = v;
  return ok(out);
}

function writeTaskTiming(out: TwitterConfigBody, t: TaskTiming | undefined): TwitterConfigResult<TwitterConfigBody> {
  if (t === undefined) return ok(out);
  if (!Number.isInteger(t.startMs) || !Number.isInteger(t.endMs) || t.startMs <= 0 || t.endMs <= 0) {
    return fail('invalid_task_timing', 'startMs and endMs must be positive epoch milliseconds');
  }
  if (t.endMs <= t.startMs) return fail('invalid_task_timing', 'endMs must be after startMs');
  out.taskTiming = { startMs: t.startMs, endMs: t.endMs };
  return ok(out);
}

function writePlatforms(
  out: TwitterConfigBody,
  platforms: readonly SnipePlatform[] | undefined,
): TwitterConfigResult<TwitterConfigBody> {
  if (platforms === undefined) return ok(out);
  const deduped: SnipePlatform[] = [];
  for (const p of platforms) {
    if (!SNIPE_PLATFORMS.includes(p)) return fail('invalid_platforms', String(p));
    if (!deduped.includes(p)) deduped.push(p);
  }
  // An empty array is REJECTED by the venue and means "all" to nobody. Refusing
  // it locally keeps "I selected no platforms" from silently meaning "every
  // platform", which is what omitting the field does.
  if (deduped.length === 0) return fail('invalid_platforms', 'empty — omit the field to allow all platforms');
  out.allowedPlatforms = deduped;
  return ok(out);
}

// ---------------------------------------------------------------------------
// Public builders
// ---------------------------------------------------------------------------

/**
 * The body for POST (create) and PUT (full replace) — the two are the same
 * document. On PUT `modeType` must equal the config's current mode; the vendor
 * refuses a change, and delete-then-create is the only way to move a config
 * between modes.
 */
export function buildFullBody(input: TwitterConfigInput): TwitterConfigResult<TwitterConfigBody> {
  const name = normalizeName(input.name);
  if (!name.ok) return name;

  let params: TwitterConfigResult<TwitterConfigBody>;
  switch (input.mode) {
    case 'ca_scanner':
      params = serializeCaScannerParams(input.params);
      break;
    case 'mention':
      params = serializeMentionParams(input.params);
      break;
    case 'engagement':
      params = serializeEngagementParams(input.params);
      break;
    case 'follow_unfollow':
      params = serializeFollowUnfollowParams(input.params);
      break;
    case 'pfp_update':
      params = serializePfpUpdateParams(input.params);
      break;
  }
  if (!params.ok) return params;

  const isScanner = input.mode === 'ca_scanner';
  const snipeInput: SnipeParams | undefined = input.snipeParams;

  // THE ca_scanner GUARD. Their engine sizes a scanner buy from
  // snipeParams.solAmount and there is no fallback: without it every buy is
  // 0 SOL and never fills, with no error anywhere. The type makes it required
  // and this makes it required at runtime too, because a route hands us a
  // parsed request body, not a value the compiler ever saw.
  if (isScanner && (snipeInput === undefined || typeof snipeInput.solAmount !== 'number')) {
    return fail('ca_scanner_requires_sol_amount', 'snipeParams.solAmount sizes every ca_scanner buy');
  }

  const body: TwitterConfigBody = {
    name: name.value,
    modeType: input.mode,
    params: params.value,
  };

  if (snipeInput !== undefined) {
    const snipe = serializeSnipeParams(snipeInput, {
      allowSolAmount: isScanner,
      limitSells: snipeInput.limitSells,
    });
    if (!snipe.ok) return snipe;
    // Omitted when it carries nothing, so a caller passing `snipeParams: {}`
    // sends the same document as one passing nothing at all.
    if (Object.keys(snipe.value).length > 0) body.snipeParams = snipe.value;
  }

  const withCount = writeMaxBuyCount(body, input.maxBuyCount);
  if (!withCount.ok) return withCount;
  const withTiming = writeTaskTiming(body, input.taskTiming);
  if (!withTiming.ok) return withTiming;
  const withPlatforms = writePlatforms(body, input.allowedPlatforms);
  if (!withPlatforms.ok) return withPlatforms;

  return ok(body);
}

/**
 * The body for PATCH (partial). Carries no `modeType`: `mode` on the input only
 * selects which params serializer runs.
 *
 * Remember what the vendor does with this: `params`, `snipeParams` and
 * `taskTiming` MERGE one level deep, every array REPLACES. So an omitted key
 * keeps its old value and a present array discards the old one entirely.
 */
export function buildPatchBody(patch: TwitterConfigPatch): TwitterConfigResult<TwitterConfigBody> {
  const body: TwitterConfigBody = {};

  if (patch.name !== undefined) {
    const name = normalizeName(patch.name);
    if (!name.ok) return name;
    body.name = name.value;
  }

  if (patch.params) {
    let params: TwitterConfigResult<TwitterConfigBody>;
    switch (patch.mode) {
      case 'ca_scanner':
        params = patchCaScannerParams(patch.params);
        break;
      case 'mention':
        params = patchMentionParams(patch.params);
        break;
      case 'engagement':
        params = patchEngagementParams(patch.params);
        break;
      case 'follow_unfollow':
        params = patchFollowUnfollowParams(patch.params);
        break;
      case 'pfp_update':
        params = patchPfpUpdateParams(patch.params);
        break;
    }
    if (!params.ok) return params;
    // An empty `params: {}` is dropped rather than sent — it would be a no-op
    // that reads like a successful edit.
    if (Object.keys(params.value).length > 0) body.params = params.value;
  }

  if (patch.snipeParams) {
    const snipe = serializeSnipeParams(patch.snipeParams, {
      allowSolAmount: patch.mode === 'ca_scanner',
      limitSells: patch.snipeParams.limitSells?.replaceAll,
    });
    if (!snipe.ok) return snipe;
    if (Object.keys(snipe.value).length > 0) body.snipeParams = snipe.value;
  }

  const withCount = writeMaxBuyCount(body, patch.maxBuyCount);
  if (!withCount.ok) return withCount;
  const withTiming = writeTaskTiming(body, patch.taskTiming);
  if (!withTiming.ok) return withTiming;
  if (patch.allowedPlatforms) {
    const withPlatforms = writePlatforms(body, patch.allowedPlatforms.replaceAll);
    if (!withPlatforms.ok) return withPlatforms;
  }

  // A patch that would send `{}` is refused instead of issued: the vendor would
  // answer 200 and nothing would have changed, which is the one outcome an
  // operator cannot tell from a successful edit.
  if (Object.keys(body).length === 0) return fail('empty_patch');

  return ok(body);
}
