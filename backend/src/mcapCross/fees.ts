/**
 * "Total fees" for a market-cap-crossing token — Axiom's token-header figure,
 * reconstructed from data OCT already has. Pure; no I/O, no clock.
 *
 * WHAT THE NUMBER MEANS. Axiom's token header carries a `Total Fees` column
 * whose tooltip reads "Prio & Tip & Trading Fees": the cumulative cost traders
 * paid to trade this token. It is a TOKEN-LEVEL ACTIVITY metric — high means a
 * lot of real trading paying real cost — and it is the figure the operator has
 * been reading tokens by. Axiom prints it in the chain's native unit (ETH on
 * Robinhood/EVM, SOL on Solana); OCT prints USD. See UNITS below.
 *
 * THE MODEL, AND ITS ONE ASSUMPTION:
 *
 *     fees ≈ 24h volume  ×  (buyTax + sellTax) / 2
 *
 * The assumption is that buys and sells split the tape roughly evenly, so the
 * average traded dollar pays the average of the two rates. Both inputs are
 * already in hand: volume comes from the DexScreener batch the poller reads
 * anyway (#385), the rates from the GMGN `/v1/token/security` payload the gates
 * already fetch on fire. NO new request, on any path.
 *
 * IT IS AN APPROXIMATION OF AXIOM'S FIGURE, NOT A REPRODUCTION OF IT. Two
 * differences are structural and neither is fixable from here:
 *   - WINDOW. Axiom's column is cumulative over the token's life; this is the
 *     trailing 24h, because 24h volume is the only volume DexScreener reports.
 *     For a token that has just crossed 750K — hours or days old — those are
 *     close, and they diverge for an old token having a second run.
 *   - COMPONENTS. The tooltip names priority fees and tips, which are paid to
 *     validators per transaction and are not a function of notional at all.
 *     They are absent here. What survives is the trading-fee component, which
 *     is the part that scales with the money moving.
 * Worked against the operator's own screenshots: cyberbeer ($2.6M volume, 1%/1%
 * tax, 6.81 ETH shown) lands at $26K ≈ 6.8 ETH at a ~$3.8K ETH — within the
 * precision of the screenshot. MOON ($4M, 2%/2%, 11.05 ETH shown) lands at $80K
 * ≈ 2x the printed figure; the two screenshots cannot both be fitted by any
 * single per-token-rate model, and this file fits the ARITHMETIC of the metric
 * rather than the one reading that contradicts it. Precision claims about this
 * number belong in the same breath as the number.
 *
 * WHY IT IS NOT THE VOLUME FILTER WEARING A HAT. The rate VARIES per token —
 * 0.3%, 1% and 2% all appear in the operator's own sample — so two tokens with
 * identical volume get different fee figures, and a fee floor and a volume
 * floor rank the universe differently. Combining activity with cost-to-trade is
 * the whole point of the metric. (An earlier note in #385 dismissed this as
 * "volume rescaled by a constant"; that objection holds only for a protocol
 * fee that is genuinely constant across tokens, which a token's own transfer
 * tax is not.)
 *
 * UNITS: USD, EVERYWHERE, DELIBERATELY. Axiom shows ETH/SOL. Rendering those
 * would need a native-token price at the moment of the crossing, and the only
 * prices this pipeline holds are per-token USD quotes from DexScreener — there
 * is no trustworthy ETH/SOL spot in the repo on this path. A number in the
 * wrong unit is worse than a number in a different-but-labelled one, so every
 * surface (filter bounds, settings field, alert card) says USD out loud.
 *
 * UNKNOWN ⇒ NULL, NEVER ZERO. Both inputs are nullable and either one missing
 * makes the product unknown. `null` here is what makes `evaluateMcapGates`
 * ABSTAIN rather than reject, which matters most on SOLANA: `normalizeSecurity`
 * hard-nulls `buyTax`/`sellTax` there because a transfer tax cannot exist on
 * that chain, so a Solana token has no fee rate and this returns null for it
 * every time. A fee floor therefore abstains across Solana rather than
 * rejecting it — the filter goes quiet on that chain instead of pretending its
 * fees are zero. That is a real cost of the metric and it is stated in the
 * settings UI, not hidden.
 */

import type { TokenSecurity } from './security.js';

/**
 * The share of each traded dollar that is paid as tax, or null when unknown.
 *
 * BOTH SIDES ARE REQUIRED. A token that reports a buy tax and no sell tax has
 * not told us what a round trip costs, and averaging a known number with a
 * guess produces a figure that looks measured. Half a reading is not a reading.
 *
 * A REPORTED ZERO IS A READING. `buyTax: 0, sellTax: 0` — which is what GMGN
 * returns for an untaxed EVM token like CAKE — yields a rate of 0 and a fee
 * estimate of 0, which is a real, comparable answer that a floor may reject.
 * Only `null` (nobody said) is unknown. The two must never collapse.
 */
export function effectiveFeeRate(security: TokenSecurity | null | undefined): number | null {
  if (!security) return null;
  const { buyTax, sellTax } = security;
  if (buyTax == null || sellTax == null) return null;
  if (!Number.isFinite(buyTax) || !Number.isFinite(sellTax)) return null;
  // Outside 0-1 the payload is not a fraction and we do not know what it is.
  // Guessing (a "150" meaning 150%? 1.5%?) is how a garbage reading becomes a
  // confident number, so an out-of-range rate is UNKNOWN, not clamped.
  if (buyTax < 0 || buyTax > 1 || sellTax < 0 || sellTax > 1) return null;
  return (buyTax + sellTax) / 2;
}

/**
 * Estimated USD paid in trading fees/tax over the last 24h, or null when
 * either input is unknown.
 *
 * Null propagates on purpose: the caller must be able to tell "no fees were
 * paid" (0) from "we cannot say" (null), because only the first is evidence.
 */
export function estimateTotalFeesUsd(
  volume24hUsd: number | null | undefined,
  security: TokenSecurity | null | undefined,
): number | null {
  if (volume24hUsd == null || !Number.isFinite(volume24hUsd) || volume24hUsd < 0) return null;
  const rate = effectiveFeeRate(security);
  if (rate == null) return null;
  return volume24hUsd * rate;
}
