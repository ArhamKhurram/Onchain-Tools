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
  /** Require LP burned or locked. Off makes the LP gate abstain-only. */
  requireLpSecured: boolean;
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
};

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
  /** Normalised security facts, or null when the provider could not answer. */
  security: TokenSecurity | null;
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
): GateVerdict {
  return { decision, failed, abstainReason, liquidityRatio, caveats };
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

  // --- Security ------------------------------------------------------------
  const sec = input.security;
  if (!sec) {
    // Nothing to check against. Liquidity alone can still reject — see the
    // doc comment above — but it can never PASS a token on its own.
    return failed.length > 0
      ? verdict('reject', failed, null, ratio)
      : verdict('abstain', [], 'security lookup unavailable', ratio);
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

  if (failed.length > 0) return verdict('reject', failed, null, ratio);

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
    return verdict('abstain', [], '24h volume unknown', ratio);
  }

  const unknown = missingCriticalFields(sec, network, cfg);
  if (unknown) return verdict('abstain', [], unknown, ratio);

  return verdict('pass', [], null, ratio, caveats);
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
    requireLpSecured: envBool(
      'MCAP_CROSS_REQUIRE_LP_SECURED',
      DEFAULT_GATE_CONFIG.requireLpSecured,
    ),
  };
}
