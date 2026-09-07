/**
 * Manufactured-launch flags for the market-cap crossing gates — GMGN's
 * bundler / sniper / insider concentration, normalised into fractions.
 *
 * THE HEADLINE FINDING, WRITTEN DOWN SO NOBODY RE-DOES THE RESEARCH. The
 * operator kept getting 750K alerts on "fake charts" — bundled/sniped pumps
 * that a human spots instantly on GMGN's token panel, which prints Insiders %,
 * Bundler %, Sniper % and Bot % for exactly this purpose. OCT's security gate
 * (`security.ts`, `/v1/token/security`) does NOT carry any of it: that payload
 * is honeypot/renounce/tax/LP/top-10 and nothing else. So the question was
 * whether those flags are reachable server-side with the repo's own key.
 *
 * WHERE GMGN'S UI GETS THEM IS 403 TO US. The token panel is fed by GMGN's
 * INTERNAL API — `gmgn.ai/defi/quotation/v1/...` and
 * `gmgn.ai/api/v1/mutil_window_token_security_launchpad/{chain}/{addr}`.
 * Probed live on 2026-09-07 with `X-APIKEY`: both return HTTP 403 with a
 * Cloudflare "Just a moment..." challenge (server: cloudflare, cf-ray set).
 * That is the browser-gated path the fomo-worker exists to get around, and it
 * is NOT reachable from the backend. If this file only had that path, the
 * honest answer would have been "cannot fetch, do not build".
 *
 * BUT THE OPENAPI `/v1/token/info` CARRIES THE SAME NUMBERS, AND OUR KEY WORKS.
 * `openapi.gmgn.ai/v1/token/info` (the endpoint `gmgnEnrichment.ts` already
 * calls for missed-runner market caps) answers HTTP 200 / `code: 0` server-side
 * and its `stat` sub-object holds the launch analytics as fractions. Probed
 * live against a pump.fun launch (`…Yrrpump`, "MPGA"):
 *
 *   stat.top_bundler_trader_percentage   "0.2273"   ← BUNDLER %  (bundlerRate)
 *   stat.top70_sniper_hold_rate          "0.127…"   ← SNIPER %   (sniperRate)
 *   stat.top_rat_trader_percentage       "0"        ← INSIDER %  (insiderRate)
 *   stat.top_entrapment_trader_percentage"0.0048"   ← see below, NOT used
 *   stat.top_bot_degen_percentage        "0.571"    ← bot %, available, unused
 *
 * WHY `top_rat_trader_percentage` IS THE INSIDER PROXY AND `entrapment` IS NOT.
 * GMGN has no field literally named "insider", so the mapping is a judgement,
 * and it was made from live readings rather than the name that looked closest:
 *   - BONK (established, obviously not a rug): rat 0.0006, bundler 0.0017,
 *     sniper70 ~3e-7 — all near zero, as a clean token should read. But its
 *     ENTRAPMENT was 0.7256. Entrapment is high for a legitimate token, so it
 *     is not a manipulation signal on this axis and using it as "insider %"
 *     would reject BONK. Rejected on the evidence.
 *   - pump.fun MPGA (bundled pump): bundler 0.2273, sniper70 0.127, bot 0.571.
 * So insider ← rat_trader (low for legit, the early-privileged-wallet concept),
 * NOT entrapment. Bot % is available too but is not wired to a filter here —
 * the task named bundler/sniper/insider; bot can be added the same way.
 *
 * PER-CHAIN COVERAGE IS ASYMMETRIC AND STATED HONESTLY (measured, not assumed):
 *   - SOLANA — full. Launch analytics are populated and discriminate (BONK vs
 *     MPGA above). This is where the operator's "fake charts" live and where
 *     the filter does its work.
 *   - ROBINHOOD — populated. CHILL returned sniper70 0.00025, bot 0.3877,
 *     entrapment 0.4019, bundler_wallets 114. Real numbers, so the filter bites.
 *   - BNB — effectively ABSENT. Every BSC token sampled (CAKE and one other)
 *     returned the whole `stat` block as zeros. A zero on a MAX ceiling is
 *     harmless — it can never FALSE-REJECT — but it also provides no protection,
 *     so this filter is Solana/Robinhood in practice and does nothing on BNB.
 *
 * ABSTAIN-TO-FIRE, NOT ABSTAIN-TO-SUPPRESS — THE OPPOSITE OF security.ts. The
 * security gates put their must-have fields in `missingCriticalFields`, so a
 * missing freeze authority SUPPRESSES the crossing (a data gap is never a clean
 * bill of health). These flags are the reverse: they are a DISCRIMINATOR bolted
 * on top of a signal that already fires, so an unknown flag must let the
 * crossing through, exactly like the momentum gate. A token GMGN has never
 * indexed (blank payload → null here), a whole chain that returns nothing, or a
 * rate-limit ban all read as "unknown", and unknown FIRES (subject to every
 * other gate). Only a KNOWN rate above a SET ceiling ever drops a crossing.
 * That is why none of these fields is in `missingCriticalFields`.
 *
 * COST. This is a SECOND GMGN call, distinct from the security call, because
 * the two endpoints carry disjoint fields. It runs ONLY at the fire step —
 * once per crossing, ~30-80/day — never per universe token per cycle, and it
 * shares `gmgnLimiter` with every other GMGN call. See the poller's fire block.
 */

import { gmgnGet } from '../utils/gmgnClient.js';
import { isRecord, num as untrustedNum } from '../utils/untrusted.js';
import type { RevivalNetwork } from '@oct/shared';

/** GMGN's chain slug per watched network. Same table security.ts uses. */
const GMGN_CHAIN: Record<RevivalNetwork, string> = {
  solana: 'sol',
  bsc: 'bsc',
  robinhood: 'robinhood',
};

/**
 * What the gates consume. Every field is a FRACTION 0-1, or null for UNKNOWN —
 * and null means FIRE here, not suppress (see the module header). The type is
 * the abstain-to-fire rule made structural: a gate reads a null and does
 * nothing, it never reads absence as zero.
 */
export interface TokenManipulation {
  /** Fraction of supply held by bundler wallets. GMGN `top_bundler_trader_percentage`. */
  bundlerRate: number | null;
  /** Fraction held by snipers (top-70). GMGN `top70_sniper_hold_rate`. */
  sniperRate: number | null;
  /** Fraction held by rat-trader / insider wallets. GMGN `top_rat_trader_percentage`. */
  insiderRate: number | null;
}

/**
 * A fraction in [0, 1], or null.
 *
 * Out of range is UNKNOWN, never clamped: a payload that hands us a "150" is
 * not a fraction and we do not know what it is — guessing (150%? 1.5%?) is how
 * a garbage reading becomes a confident number. Same discipline as `fees.ts`.
 * `''`, missing, non-finite → null, courtesy of the untrusted `num`.
 */
function frac01(value: unknown): number | null {
  const n = untrustedNum(value);
  if (n == null) return null;
  if (n < 0 || n > 1) return null;
  return n;
}

/**
 * Does this `/v1/token/info` payload actually describe a token?
 *
 * GMGN (via `enrichFromGmgn`) treats a payload with no `address` as "not
 * indexed" — the same success-with-blanks shape `security.ts` guards against.
 * Reading its zero-valued `stat` as data would turn "never heard of it" into
 * "measured zero manipulation", which for a MAX ceiling is harmless but still
 * dishonest. A blank payload is UNKNOWN → the caller abstains-to-fire.
 */
export function isBlankTokenInfo(raw: unknown): boolean {
  if (!isRecord(raw)) return true;
  const address = raw.address;
  return typeof address !== 'string' || address.trim() === '';
}

/**
 * Normalise one raw `/v1/token/info` payload into the launch-analytics facts.
 * Pure; unit-tested against the live shapes recorded in the module header.
 *
 * Not chain-conditional, unlike `normalizeSecurity`: these fields are not
 * chain-exclusive the way tax/renounce are — every chain's payload carries the
 * `stat` keys, BNB simply fills them with zeros. A zero on a MAX ceiling never
 * false-rejects, so there is nothing to null out per chain; the honest limit is
 * documented (BNB has no real coverage) rather than encoded.
 */
export function normalizeManipulation(raw: unknown): TokenManipulation | null {
  if (isBlankTokenInfo(raw)) return null;
  const record = raw as Record<string, unknown>;
  const stat = isRecord(record.stat) ? record.stat : {};

  return {
    bundlerRate: frac01(stat.top_bundler_trader_percentage),
    sniperRate: frac01(stat.top70_sniper_hold_rate),
    insiderRate: frac01(stat.top_rat_trader_percentage),
  };
}

/**
 * Fetch and normalise. Null means ABSTAIN-TO-FIRE — GMGN unconfigured,
 * rate-limit banned, request failed, or a blank payload for an unindexed
 * address. The caller lets the crossing through in every one of those cases;
 * only a KNOWN rate above a SET ceiling ever drops it.
 */
export async function fetchTokenManipulation(
  network: RevivalNetwork,
  address: string,
): Promise<TokenManipulation | null> {
  const result = await gmgnGet<Record<string, unknown>>('/v1/token/info', {
    chain: GMGN_CHAIN[network],
    address,
  });
  if (!result.ok) {
    // RATE_LIMIT_BANNED included. A ban is not a verdict about a token, and a
    // manipulation lookup that could not run must never suppress an alert.
    console.warn(
      `[McapCross] Manipulation lookup unavailable for ${address.slice(0, 8)}… on ${network}: ${result.error}`,
    );
    return null;
  }
  return normalizeManipulation(result.data ?? {});
}
