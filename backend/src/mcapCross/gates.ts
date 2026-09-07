/**
 * The market-cap crossing gates — pure, boolean, per-chain. No I/O, no clock.
 * Unit-tested in backend/test/mcapCrossGates.test.ts.
 *
 * WHAT THIS SIGNAL IS. A user asked for one thing: "ping me when ANY coin
 * crosses $750K market cap, but not the scams." The threshold is the feature.
 * At 750K across Solana, BNB and Robinhood the alert self-limits to roughly
 * 30-80 tokens a day — one or two pings an hour, which a person can actually
 * read. Lowering it does not make the alert better, it makes it unread, which
 * is the same failure the Telegram flood incident produced by another route
 * (see tgbot/alertPolicy.ts). Do not "improve" the threshold downward.
 *
 * GATES, NOT A SCORE. Every rule below is a hard boolean with a stated
 * threshold, exactly like revival/detector.ts. There is deliberately no
 * weighted composite and no 0-100 "risk number": a score lets a token with a
 * live freeze authority pass because its liquidity is deep, which is precisely
 * the trade nobody wants made on their behalf. A token clears every applicable
 * gate or it is dropped.
 *
 * THE COST MODEL IS WHY THIS FILE IS SEPARATE FROM DISCOVERY. The universe is
 * thousands of tokens; the ~50/day that actually cross 750K are the only ones
 * that ever cost a security API call. Discovery and market-cap polling are
 * cheap and run over everything; THESE gates run once, on fire. Anything that
 * moves a security lookup earlier in the pipeline breaks the economics of the
 * whole feature.
 *
 * THREE DECISIONS, NOT TWO. `reject` and `pass` are not enough:
 *
 *   pass    — every applicable gate held. Fire.
 *   reject  — a gate failed on data we HAVE. Drop it, log it, and record the
 *             crossing so we do not re-evaluate the same move next cycle.
 *   abstain — we could not tell. The security provider errored, was rate-limit
 *             banned, or returned a payload about a token it does not index.
 *             Do NOT fire and do NOT record: this is the same rule
 *             `crossing.ts` applies to a missing price, for the same reason.
 *             Missing data has never been evidence of safety.
 *
 * PER-CHAIN, BECAUSE THE THREATS ARE PER-CHAIN. "Honeypot" in the EVM sense —
 * a transfer tax or a sell trapdoor — cannot exist on Solana. The Solana
 * equivalents are an unrevoked mint authority (the dev can print) and an
 * unrevoked FREEZE authority (the dev can freeze your wallet, which is a sell
 * trapdoor by another name). Conversely `renounced_mint` comes back false for
 * every BNB and Robinhood token GMGN indexes, CAKE included, because it is not
 * an EVM concept. One universal gate set would therefore either reject every
 * EVM token or excuse every Solana one. See security.ts for the measurements.
 *
 * THRESHOLDS ARE PROVISIONAL AND AWAIT OPERATOR SIGN-OFF. Every number below
 * is env-tunable (OCT_MCAP_CROSS_*, TRENCHCORD_ fallback) precisely because
 * none of them has been calibrated against labelled cases the way revival's
 * 3.0x and 0.35 were. They are defensible starting points, not measurements.
 */

import type { RevivalNetwork } from '@oct/shared';
import type { TokenSecurity } from './security.js';
import type { TokenManipulation } from './manipulation.js';
import { estimateTotalFeesUsd } from './fees.js';

/** The market cap a token must cross. The whole point of the signal. */
export const DEFAULT_TARGET_MCAP_USD = 750_000;

export interface McapGateConfig {
  /** Below this the move is unexitable, whatever the market cap says. */
  minLiquidityUsd: number;
  /**
   * Liquidity as a fraction of market cap. Catches the fake-mcap shape: a
   * 900K "market cap" sitting on 4K of pooled value is a supply number
   * multiplied by a price nobody can actually transact at.
   */
  minLiquidityToMcapRatio: number;
  /** Top-10 concentration ceiling, as a fraction. GMGN excludes LP accounts. */
  maxTop10HolderRate: number;
  /** EVM: each of buy tax and sell tax must be strictly below this. */
  maxTaxRate: number;
  /**
   * MINIMUM traded USD over 24h, summed across the token's pools.
   *
   * `null` — NOT 0 — means the filter is switched off, and null is the shipped
   * default. This is the only threshold in the set that has no baseline value,
   * and the distinction is load-bearing in two directions:
   *
   *   - 0 is a real threshold that every listed token clears, so it cannot also
   *     mean "off". A user who types 0 has said "I do not care about volume",
   *     which reads identically to off but is reached by a different route.
   *   - Off must mean the gate is NOT EVALUATED AT ALL, not "evaluated and
   *     passed". A token whose volume is unknown abstains when the filter is
   *     set and is untouched when it is not — which is what makes shipping this
   *     a no-op for every existing user. See `missingCriticalFields`.
   */
  minVolume24hUsd: number | null;
  /**
   * MINIMUM estimated USD paid in trading fees/tax over 24h — Axiom's
   * "Total Fees" (Prio & Tip & Trading Fees) shape, approximated as
   * `24h volume × (buyTax + sellTax) / 2`. See `fees.ts` for the model, its
   * two structural differences from Axiom's column, and why the unit is USD
   * rather than the ETH/SOL Axiom prints.
   *
   * `null` — not 0 — means OFF, exactly as for `minVolume24hUsd`, and for the
   * same reason: "enough fee flow" is a preference, not a safety floor, so it
   * ships unevaluated and the user names it.
   *
   * IT NEEDS TWO INPUTS AND EITHER ONE MISSING IS AN ABSTAIN. The fee rate is
   * an EVM concept — `normalizeSecurity` hard-nulls the tax fields on Solana
   * because a transfer tax cannot exist there — so with this floor set, Solana
   * tokens abstain rather than fail. The gate goes QUIET on that chain; it
   * never rejects it for having "no fees".
   */
  minTotalFees: number | null;
  /** Require LP burned or locked. Off makes the LP gate abstain-only. */
  requireLpSecured: boolean;
  /**
   * THE FIRST-RUN-UP DISCRIMINATOR. Minimum 24h price change, as a FRACTION
   * (0 = flat, 0.5 = +50%, -0.2 = -20%), that a crossing must show to be read
   * as a token climbing THROUGH the target rather than falling back through it.
   *
   * WHY IT SHIPS AT 0 AND IS NOT NULL. The owner reported the signal firing on
   * tokens that had already run and were oscillating DOWN through 750K — a
   * dead-cat bounce, not a first run. The strongest cheap signal for that is
   * the trend at the cross: a genuine first run-up is strongly positive over
   * 24h, while a fall-back is negative or weak even as price ticks up for a
   * moment (LOOM: chart ATH 2.14M, 24h -20.52%, and it "crossed" 750K upward).
   * So unlike the volume/fee PREFERENCES this ships ON, at 0 — "do not alert me
   * on a token that is net DOWN over the day" — which is the fix, applied to
   * everyone who has not tuned it. It is a floor like liquidity, not an
   * off-by-default preference.
   *
   * REJECTS ONLY ON A KNOWN VALUE. An UNKNOWN 24h change (DexScreener quiet) is
   * abstain-to-FIRE, never abstain-to-suppress: this gate is deliberately NOT
   * in `missingCriticalFields`, because a discriminator that muted every
   * crossing whose momentum it could not read would quietly kill the whole
   * signal the first time the upstream went quiet. Missing momentum fires
   * (subject to every other gate); only measured downward momentum drops.
   */
  minPriceChangeH24: number;
  /**
   * CORROBORATING, AND OFF BY DEFAULT. Maximum pool age in DAYS, or null (not
   * evaluated). A first run-up is typically a young pool; a 46-day-old pool
   * crossing "for the first time" as far as our state knows is almost always a
   * re-cross. But age is a CORROBORATING signal, never a sole gate — a genuine
   * slow-burn exists — so this ships null (off) and no crossing is ever dropped
   * on age alone in the shipped config. An operator who wants to additionally
   * require young pools sets OCT_MCAP_CROSS_MAX_POOL_AGE_DAYS; even then it
   * rejects only on a KNOWN age, and an unknown age fires.
   *
   * OPERATOR-ONLY, not a per-user filter, for a concrete reason: the per-user
   * filter surfaces (console + the Telegram ladder) format every threshold as
   * either USD or a percentage, and "days" is neither. Adding a third unit
   * would mean editing the shared bot panel, which this change must not touch.
   * Age therefore stays an env knob; the per-user discriminator is momentum.
   */
  maxPoolAgeDays: number | null;
  /**
   * THE MANUFACTURED-LAUNCH DISCRIMINATORS. Maximum fraction of supply held by
   * bundler / sniper / insider (rat-trader) wallets — GMGN's own launch-analytics
   * flags, the thing that actually separates a bundled/sniped pump from an
   * organic run. Each `null` (OFF) by shipped default, so nothing changes for
   * anyone until an operator or user sets one. Source and per-chain coverage:
   * `manipulation.ts`.
   *
   * ABSTAIN-TO-FIRE, UNLIKE THE SECURITY GATES. These reject ONLY a KNOWN rate
   * above the ceiling. An unknown flag (GMGN did not index it, a whole chain —
   * BNB — returns nothing, a rate-limit ban) lets the crossing through, exactly
   * like `minPriceChangeH24`. They are deliberately NOT in
   * `missingCriticalFields`: a discriminator that muted every crossing it could
   * not read would silence the signal the first time the upstream went quiet.
   */
  maxBundlerRate: number | null;
  maxSniperRate: number | null;
  maxInsiderRate: number | null;
}

/**
 * Defaults. Reasoning per number, since none of these is a measurement:
 *
 * - minLiquidityUsd 20_000 — above broadUniverse's 15_000 revival floor on
 *   purpose. That floor answers "could this move be traded at all"; this one
 *   answers "could the operator get OUT of a 750K token", which is a harder
 *   question and deserves the wider margin.
 * - minLiquidityToMcapRatio 0.02 — 2% of market cap in the pool. Real 750K
 *   tokens in the sample sat far above it (OPENAI: 334K liquidity on 6.6M
 *   mcap ≈ 5%); the scam shape sits near zero.
 * - maxTop10HolderRate 0.60 — the sampled rug-shaped BNB tokens returned
 *   exactly 1.0 (one holder owns everything). Legitimate tokens in the same
 *   sample: 0.14, 0.15, 0.19, 0.28. 0.60 is a wide corridor between them,
 *   chosen wide because a false negative here costs a missed alert while a
 *   false positive costs the user's trust in the whole feed.
 * - maxTaxRate 0.10 — 10% each way. Above that the token is a fee farm even
 *   if it is not technically a trapdoor.
 *
 * The suggested "top holder < 30%" gate is NOT implemented: GMGN's security
 * payload carries top-10 concentration but no single-largest-holder figure, and
 * inventing one from a second endpoint would double the per-fire cost. Flagged
 * rather than faked.
 */
export const DEFAULT_GATE_CONFIG: McapGateConfig = {
  minLiquidityUsd: 20_000,
  minLiquidityToMcapRatio: 0.02,
  maxTop10HolderRate: 0.6,
  maxTaxRate: 0.1,
  requireLpSecured: true,
  // OFF by shipped default, and there is no defensible number to put here.
  // What counts as "enough volume" at a 750K market cap depends entirely on
  // what the reader is looking for — a floor that filters a quiet launch out of
  // one person's feed is the exact alert another person wanted. Every other
  // default in this table is a safety floor with a stated sample behind it;
  // this one is a preference, so it ships unset and the user names it.
  minVolume24hUsd: null,
  // Same reasoning, plus one of its own: this gate can only be EVALUATED where
  // a tax rate exists, so a shipped default would silently narrow EVM alerts
  // while leaving Solana abstaining. Off unless somebody asks for it.
  minTotalFees: null,
  // The one NEW floor that ships ON, because it is the fix (see the field doc):
  // 0 means "must not be net-down over 24h". Every chain reports this figure,
  // and an unknown reading fires rather than muting.
  minPriceChangeH24: 0,
  // Corroborating, off by default — never a sole reason to drop a crossing.
  maxPoolAgeDays: null,
  // The manufactured-launch discriminators, all OFF by shipped default. Purely
  // additive: with these null nothing changes for any existing user, and an
  // unknown flag fires rather than mutes (see the field docs and gate below).
  maxBundlerRate: null,
  maxSniperRate: null,
  maxInsiderRate: null,
};

/**
 * How far above the target a token must have been SEEN before, for a later
 * crossing to be read as a re-cross rather than a first run. Used by
 * `isWatermarkReCross` from the poller's per-token high-watermark. 1.3 = "we
 * watched it 30% above the target already"; the 24h cooldown catches the tight
 * oscillation, this catches the one that returns days later. Env-tunable.
 */
export const DEFAULT_RECROSS_WATERMARK_FACTOR = 1.3;

export interface McapGateInput {
  network: RevivalNetwork;
  /** Market cap observed at the crossing. */
  mcapUsd: number | null;
  /** Deepest-pair USD liquidity at the crossing. */
  liquidityUsd: number | null;
  /**
   * Traded USD over 24h, summed across pools. Null means UNKNOWN — the token
   * is unlisted, the batch read failed, or no pool reported a figure. It never
   * means zero, and the gate below never treats it as one.
   */
  volume24hUsd: number | null;
  /**
   * 24h price change at the crossing, as a FRACTION. Null means UNKNOWN (no
   * pool reported one, or the batch read failed) — never zero, and the momentum
   * gate below abstains-to-fire on it rather than dropping. Optional so callers
   * and tests written before the discriminator existed are unaffected.
   */
  priceChangeH24?: number | null;
  /**
   * Pool age in ms at the crossing, computed by the poller (which holds the
   * clock; this module stays clockless). Null means UNKNOWN. Optional for the
   * same back-compat reason as `priceChangeH24`.
   */
  poolAgeMs?: number | null;
  /** Normalised security facts, or null when the provider could not answer. */
  security: TokenSecurity | null;
  /**
   * Normalised manufactured-launch facts (bundler/sniper/insider), or null when
   * GMGN could not answer. Optional so callers and tests written before the
   * discriminator existed are unaffected — absent reads identically to null,
   * i.e. UNKNOWN, i.e. fire (see the manipulation gate below).
   */
  manipulation?: TokenManipulation | null;
}

export type GateDecision = 'pass' | 'reject' | 'abstain';

export interface GateVerdict {
  decision: GateDecision;
  /** Gate names that failed, in evaluation order. Empty unless `reject`. */
  failed: string[];
  /** Why we could not decide. Null unless `abstain`. */
  abstainReason: string | null;
  /** Liquidity / mcap, for the log line and the alert card. Null when unknown. */
  liquidityRatio: number | null;
  /**
   * Estimated 24h trading fees in USD, for the alert card. Null whenever the
   * volume or the tax rate was unknown — including EVERY Solana token, whose
   * tax fields do not exist. Computed whether or not the fee floor is set, so
   * the card can show the number that justifies an alert without the reader
   * having to switch a filter on to see it.
   */
  totalFeesUsd: number | null;
  /**
   * Things that did NOT fail a gate but that the reader deserves to know, e.g.
   * `honeypotUnknown`. Empty on a clean pass.
   *
   * WHY THIS EXISTS. The EVM honeypot gate rejects only an explicit `true`,
   * because `is_honeypot` is null far more often than it is false and abstaining
   * on null would silence BNB almost entirely. That is the right call for
   * DELIVERY and the wrong one for SILENCE: a reader who sees "Scam-filtered"
   * on a token whose honeypot status was never evaluated has been told something
   * untrue. So the permissiveness is kept and surfaced, rather than hidden.
   * A caveat never blocks; it only ever adds a line to the card.
   */
  caveats: string[];
}

function verdict(
  decision: GateDecision,
  failed: string[],
  abstainReason: string | null,
  liquidityRatio: number | null,
  caveats: string[] = [],
  totalFeesUsd: number | null = null,
): GateVerdict {
  return { decision, failed, abstainReason, liquidityRatio, caveats, totalFeesUsd };
}

/**
 * Evaluate every applicable gate.
 *
 * REJECT WINS OVER ABSTAIN, deliberately. A token missing its freeze-authority
 * field but sitting on 3K of liquidity is not an open question — the liquidity
 * gate already answered it. Only a token that fails NOTHING it can be measured
 * against, and is missing something load-bearing, abstains. The alternative
 * (abstain wins) would make every unindexed rug come back for a free security
 * lookup every cycle forever.
 */
export function evaluateMcapGates(
  input: McapGateInput,
  cfg: McapGateConfig = DEFAULT_GATE_CONFIG,
): GateVerdict {
  const { mcapUsd, liquidityUsd, network } = input;
  const failed: string[] = [];
  const caveats: string[] = [];

  // --- Market data ---------------------------------------------------------
  // No market cap means there is nothing to have crossed; the poller should
  // never reach here without one, but a gate that trusts its caller is a gate
  // that fires on NaN one day.
  if (mcapUsd == null || !Number.isFinite(mcapUsd) || mcapUsd <= 0) {
    return verdict('abstain', [], 'no market cap', null);
  }
  const ratio =
    liquidityUsd != null && Number.isFinite(liquidityUsd) ? liquidityUsd / mcapUsd : null;

  if (liquidityUsd == null || !Number.isFinite(liquidityUsd)) {
    // DexScreener reported a pair but no USD reserve. Unknowable, not bad.
    return verdict('abstain', [], 'no liquidity figure', null);
  }
  if (liquidityUsd < cfg.minLiquidityUsd) failed.push('liquidity');
  if (ratio != null && ratio < cfg.minLiquidityToMcapRatio) failed.push('liquidityRatio');

  // 24h volume. Rejects only on a KNOWN figure below a SET threshold; an
  // unknown figure is handled in `missingCriticalFields`, and an unset
  // threshold is not evaluated at all. Those three cases are the whole gate.
  const volume = input.volume24hUsd;
  if (
    cfg.minVolume24hUsd != null &&
    volume != null &&
    Number.isFinite(volume) &&
    volume < cfg.minVolume24hUsd
  ) {
    failed.push('volume24h');
  }

  // --- First run-up discriminator ------------------------------------------
  // MOMENTUM is the primary signal separating a token climbing THROUGH the
  // target from one falling back through it. Reject ONLY on a known 24h change
  // below the floor; an unknown change is not evaluated here and never lands in
  // `missingCriticalFields`, so it fires rather than muting. This sits with the
  // market-data gates (not the security ones) because it comes from the same
  // DexScreener read and can reject a token before any security lookup — a
  // fall-back through 750K should not even cost a security call.
  const chg = input.priceChangeH24;
  if (chg != null && Number.isFinite(chg) && chg < cfg.minPriceChangeH24) {
    failed.push('momentum');
  }

  // POOL AGE corroborates, and only when an operator has opted in. Off (null)
  // it does nothing; set, it rejects only a KNOWN age above the ceiling, so a
  // token whose age we cannot read still fires. Never a sole gate in the
  // shipped config — see the field doc and requirement that a slow-burn survive.
  if (cfg.maxPoolAgeDays != null) {
    const ageMs = input.poolAgeMs;
    const ceilingMs = cfg.maxPoolAgeDays * 86_400_000;
    if (ageMs != null && Number.isFinite(ageMs) && ageMs > ceilingMs) failed.push('poolAge');
  }

  // --- Manufactured-launch discriminators ----------------------------------
  // Bundler / sniper / insider concentration, from GMGN's launch analytics
  // (manipulation.ts). Each rejects ONLY on a KNOWN rate above a SET ceiling;
  // an unknown flag — or a whole chain that reports nothing — does nothing here
  // and never lands in `missingCriticalFields`, so it fires. Evaluated before
  // the security block, and independent of it, so a bundled token drops even
  // when the security lookup was unavailable (same shape as the momentum gate).
  const manip = input.manipulation ?? null;
  if (cfg.maxBundlerRate != null && manip?.bundlerRate != null && manip.bundlerRate > cfg.maxBundlerRate) {
    failed.push('bundlerRate');
  }
  if (cfg.maxSniperRate != null && manip?.sniperRate != null && manip.sniperRate > cfg.maxSniperRate) {
    failed.push('sniperRate');
  }
  if (cfg.maxInsiderRate != null && manip?.insiderRate != null && manip.insiderRate > cfg.maxInsiderRate) {
    failed.push('insiderRate');
  }

  // --- Security ------------------------------------------------------------
  const sec = input.security;
  if (!sec) {
    // Nothing to check against. Liquidity alone can still reject — see the
    // doc comment above — but it can never PASS a token on its own.
    return failed.length > 0
      ? verdict('reject', failed, null, ratio)
      : verdict('abstain', [], 'security lookup unavailable', ratio);
  }

  // Volume × fee rate, computed here because this is the first point where BOTH
  // halves are in hand. Always computed — the card wants it even with the floor
  // off — and null wherever either half is missing. See fees.ts.
  const totalFeesUsd = estimateTotalFeesUsd(input.volume24hUsd, sec);
  if (cfg.minTotalFees != null && totalFeesUsd != null && totalFeesUsd < cfg.minTotalFees) {
    failed.push('totalFees');
  }

  if (sec.top10HolderRate != null && sec.top10HolderRate > cfg.maxTop10HolderRate) {
    failed.push('top10Concentration');
  }

  if (network === 'solana') {
    // Explicit `false` only. A null is "GMGN did not say", which is an
    // abstain condition below, not a rejection.
    if (sec.mintRenounced === false) failed.push('mintAuthority');
    if (sec.freezeRenounced === false) failed.push('freezeAuthority');
  } else {
    // EVM. `honeypot` is null far more often than it is false (CAKE returned
    // null), so only an EXPLICIT true rejects. Judgement call, flagged: the
    // strict alternative — abstain on null — would silence BNB almost
    // entirely, and the concentration, liquidity and tax gates still stand.
    if (sec.honeypot === true) failed.push('honeypot');
    // Null is "GMGN did not evaluate it", not "clean". It does not reject —
    // see GateVerdict.caveats for why — but it is carried onto the card so the
    // footer never claims a check that did not happen.
    else if (sec.honeypot == null) caveats.push('honeypotUnknown');
    if (sec.buyTax != null && sec.buyTax >= cfg.maxTaxRate) failed.push('buyTax');
    if (sec.sellTax != null && sec.sellTax >= cfg.maxTaxRate) failed.push('sellTax');
  }

  if (cfg.requireLpSecured && sec.lpSecured === false) failed.push('lpSecured');

  if (failed.length > 0) return verdict('reject', failed, null, ratio, [], totalFeesUsd);

  // --- Nothing failed. Is that because everything passed, or because we
  //     could not see? -----------------------------------------------------
  // A SET volume floor that could not be measured is an open question, not a
  // pass — the same rule the security fields follow, applied to market data.
  // It sits here rather than in `missingCriticalFields` because that helper is
  // about the SECURITY payload; this is about the DexScreener read.
  //
  // CHAIN COVERAGE IS WHY THIS IS THE ONLY SAFE SHAPE. `volume24hUsd` comes
  // from the same DexScreener batch that already supplies market cap and
  // liquidity, so it covers Solana, BNB and Robinhood identically — there is no
  // chain on which this metric is structurally absent, the way `buyTax` is
  // absent on Solana. But a token DexScreener happens not to report volume for
  // must still abstain rather than fail, because a floor that treats silence as
  // zero rejects exactly the tokens the data is thinnest about.
  if (cfg.minVolume24hUsd != null && (input.volume24hUsd == null || !Number.isFinite(input.volume24hUsd))) {
    return verdict('abstain', [], '24h volume unknown', ratio, [], totalFeesUsd);
  }

  // A SET fee floor that could not be computed is the same open question, and
  // it is open on a whole CHAIN rather than a stray token: Solana has no tax
  // fields at all, so every Solana crossing lands here while this floor is on.
  // Abstaining is still the only honest answer — a token whose fee flow was
  // never measured has neither passed nor failed a fee test — but it does mean
  // this filter effectively silences Solana, which is why the settings copy
  // says so instead of leaving the user to discover a quiet chain.
  if (cfg.minTotalFees != null && totalFeesUsd == null) {
    return verdict('abstain', [], 'total fees unknown', ratio, [], null);
  }

  const unknown = missingCriticalFields(sec, network, cfg);
  if (unknown) return verdict('abstain', [], unknown, ratio, [], totalFeesUsd);

  return verdict('pass', [], null, ratio, caveats, totalFeesUsd);
}

/**
 * The fields whose absence must NOT be read as a pass, per chain.
 *
 * This is the half of the abstain rule that is easy to forget: a token can fail
 * no gate simply because every gate's input was null. On Solana that is the
 * mint and freeze authorities — the two facts the whole Solana gate set rests
 * on. On EVM there is no equivalent must-have (honeypot is routinely null even
 * for blue chips), so concentration is the one field required to be present.
 */
function missingCriticalFields(
  sec: TokenSecurity,
  network: RevivalNetwork,
  cfg: McapGateConfig,
): string | null {
  if (network === 'solana') {
    if (sec.mintRenounced == null) return 'mint authority unknown';
    if (sec.freezeRenounced == null) return 'freeze authority unknown';
  }
  if (sec.top10HolderRate == null) return 'holder concentration unknown';
  if (cfg.requireLpSecured && sec.lpSecured == null) return 'LP burn/lock unknown';
  return null;
}

// --- Env plumbing ------------------------------------------------------------

function envFlag(name: string): string | undefined {
  return process.env[`OCT_${name}`] ?? process.env[`TRENCHCORD_${name}`];
}

function envNum(name: string, fallback: number): number {
  const raw = Number(envFlag(name));
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/**
 * Like `envNum` but SIGNED — momentum floors are legitimately negative (an
 * operator loosening the discriminator to "allow a mild dip"), so the `>= 0`
 * guard of `envNum` would wrongly reject them back to the default.
 */
function envSignedNum(name: string, fallback: number): number {
  const raw = Number(envFlag(name));
  return Number.isFinite(raw) ? raw : fallback;
}

/**
 * An OPTIONAL numeric threshold: unset (or unparseable) stays `null`, which
 * means the gate is not evaluated. Distinct from `envNum`, whose fallback is a
 * real number, because for this one field "no value" is a meaningful state.
 */
function envNumOrNull(name: string, fallback: number | null): number | null {
  const raw = envFlag(name)?.trim();
  if (raw == null || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = envFlag(name)?.trim().toLowerCase();
  if (raw == null || raw === '') return fallback;
  return !(raw === 'false' || raw === '0' || raw === 'off' || raw === 'no');
}

/** The target market cap. Tunable, but see the header before lowering it. */
export function resolveTargetMcapUsd(): number {
  const value = envNum('MCAP_CROSS_TARGET_USD', DEFAULT_TARGET_MCAP_USD);
  return value > 0 ? value : DEFAULT_TARGET_MCAP_USD;
}

/** Read the gate thresholds from env, falling back to DEFAULT_GATE_CONFIG. */
export function resolveGateConfig(): McapGateConfig {
  return {
    minLiquidityUsd: envNum('MCAP_CROSS_MIN_LIQUIDITY_USD', DEFAULT_GATE_CONFIG.minLiquidityUsd),
    minLiquidityToMcapRatio: envNum(
      'MCAP_CROSS_MIN_LIQ_MCAP_RATIO',
      DEFAULT_GATE_CONFIG.minLiquidityToMcapRatio,
    ),
    maxTop10HolderRate: envNum(
      'MCAP_CROSS_MAX_TOP10_RATE',
      DEFAULT_GATE_CONFIG.maxTop10HolderRate,
    ),
    maxTaxRate: envNum('MCAP_CROSS_MAX_TAX_RATE', DEFAULT_GATE_CONFIG.maxTaxRate),
    minVolume24hUsd: envNumOrNull(
      'MCAP_CROSS_MIN_VOLUME_24H_USD',
      DEFAULT_GATE_CONFIG.minVolume24hUsd,
    ),
    minTotalFees: envNumOrNull(
      'MCAP_CROSS_MIN_TOTAL_FEES_USD',
      DEFAULT_GATE_CONFIG.minTotalFees,
    ),
    requireLpSecured: envBool(
      'MCAP_CROSS_REQUIRE_LP_SECURED',
      DEFAULT_GATE_CONFIG.requireLpSecured,
    ),
    minPriceChangeH24: envSignedNum(
      'MCAP_CROSS_MIN_PRICE_CHANGE_H24',
      DEFAULT_GATE_CONFIG.minPriceChangeH24,
    ),
    maxPoolAgeDays: envNumOrNull('MCAP_CROSS_MAX_POOL_AGE_DAYS', DEFAULT_GATE_CONFIG.maxPoolAgeDays),
    maxBundlerRate: envNumOrNull('MCAP_CROSS_MAX_BUNDLER_RATE', DEFAULT_GATE_CONFIG.maxBundlerRate),
    maxSniperRate: envNumOrNull('MCAP_CROSS_MAX_SNIPER_RATE', DEFAULT_GATE_CONFIG.maxSniperRate),
    maxInsiderRate: envNumOrNull('MCAP_CROSS_MAX_INSIDER_RATE', DEFAULT_GATE_CONFIG.maxInsiderRate),
  };
}

/** The re-cross watermark factor, env-tunable and floored at 1 (below 1 is meaningless). */
export function resolveReCrossWatermarkFactor(): number {
  const value = envNum('MCAP_CROSS_RECROSS_WATERMARK_FACTOR', DEFAULT_RECROSS_WATERMARK_FACTOR);
  return value >= 1 ? value : DEFAULT_RECROSS_WATERMARK_FACTOR;
}

/**
 * Was this token already seen WELL above the target before this crossing? If
 * so the crossing is a re-cross, not a first run, and the poller suppresses it
 * (like the cooldown, and before any security call).
 *
 * THE HONEST LIMIT, STATED. This only knows what OUR state watched. A token
 * discovered on the way DOWN — already past its peak when it entered our
 * universe (LOOM: ATH 2.14M, found near 765K) — has a watermark that never saw
 * the peak, so this returns false for it and momentum has to carry that case.
 * Watermark catches the tokens we witnessed run and fall; momentum catches the
 * ones we met too late. Neither alone is sufficient, which is why both exist.
 */
export function isWatermarkReCross(
  priorWatermarkMcap: number | null | undefined,
  targetUsd: number,
  factor: number = DEFAULT_RECROSS_WATERMARK_FACTOR,
): boolean {
  if (priorWatermarkMcap == null || !Number.isFinite(priorWatermarkMcap)) return false;
  if (!Number.isFinite(targetUsd) || targetUsd <= 0) return false;
  if (!Number.isFinite(factor) || factor < 1) return false;
  return priorWatermarkMcap >= targetUsd * factor;
}
