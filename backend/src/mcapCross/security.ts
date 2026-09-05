/**
 * Token security facts for the market-cap crossing gates — GMGN's
 * `/v1/token/security`, normalised into one per-chain-honest shape.
 *
 * THE HEADLINE FINDING, WRITTEN DOWN SO NOBODY RE-DOES THE RESEARCH. Before
 * this file there was ZERO honeypot/rug-check code in the repo, and the obvious
 * next step looked like adding GoPlus or RugCheck as a new dependency. It was
 * not necessary. GMGN — already wired, already keyed (GMGN_API_KEY), already
 * rate-limited through gmgnLimiter — serves a security endpoint that covers all
 * three watched chains from one call. Probed live on 2026-09-05 with the
 * repo's own key:
 *
 *   sol / BONK   → renounced_mint true, renounced_freeze_account true,
 *                  burn_status "none", lock_summary.is_locked false,
 *                  top_10_holder_rate "0.3174", is_honeypot null
 *   bsc / CAKE   → is_renounced true, is_honeypot false, buy_tax/sell_tax "0",
 *                  lock_summary.lock_detail [{percent "0.95", is_blackhole true}]
 *   robinhood/amc→ is_honeypot false, lock_detail [{percent "0.95", pool
 *                  "burnt", is_blackhole true}], top_10_holder_rate "0.2783"
 *
 * The ONE endpoint OCT already called (`/v1/token/info`, via gmgnEnrichment.ts)
 * does NOT carry any of it: its payload is price/supply/liquidity/pool/dev/stat,
 * and the only overlapping field is `top_10_holder_rate`. So this is a second
 * GMGN path, not a new provider.
 *
 * THE CHAIN ASYMMETRY IS REAL AND THE FIELDS LIE ACROSS IT. Measured, not
 * assumed:
 *   - `renounced_mint` / `renounced_freeze_account` are Solana concepts. On BNB
 *     and Robinhood every token sampled returned `false` for both — including
 *     PancakeSwap's own CAKE. A universal "must be renounced" gate would reject
 *     100% of EVM tokens forever, silently.
 *   - `is_honeypot` / `buy_tax` / `sell_tax` are EVM concepts. On Solana they
 *     come back null/"0" because a transfer-tax honeypot cannot exist there.
 *     The Solana equivalent is the FREEZE AUTHORITY — a dev who can freeze
 *     holder wallets has the same power as a sell trapdoor — which is why the
 *     freeze gate is not optional on that chain.
 *   - `is_honeypot` is frequently NULL even on BNB (CAKE returned null). Null
 *     is "not evaluated", not "clean" and not "dirty". See `evaluateGates`.
 *
 * A SUCCESSFUL RESPONSE CAN STILL BE EMPTY. Asked about an address GMGN does
 * not know, the API answers `code: 0` with every string field blank and every
 * boolean `false` — including `renounced_mint: false`. Reading that literally
 * would turn "we have never heard of this token" into "this token's mint
 * authority is live", i.e. a confident rejection built on nothing. `isBlank`
 * below catches it and the caller ABSTAINS. Same rule as `crossing.ts`: missing
 * data is a gap, never a verdict.
 *
 * RATE LIMITS. gmgnClient already tracks a RATE_LIMIT_BANNED state; a ban comes
 * back here as `null`, which is an abstain — never "safe". The cost model makes
 * this affordable: this call happens ONLY after a token has actually crossed
 * 750K, which is a few times an hour, not once per token in the universe.
 */

import { gmgnGet } from '../utils/gmgnClient.js';
import type { RevivalNetwork } from '@oct/shared';

/** GMGN's chain slug per watched network. Same table gmgnEnrichment.ts uses. */
const GMGN_CHAIN: Record<RevivalNetwork, string> = {
  solana: 'sol',
  bsc: 'bsc',
  robinhood: 'robinhood',
};

/** The raw payload, typed to the fields observed on the live API. */
export interface GmgnSecurityRaw {
  address?: string;
  top_10_holder_rate?: string | number | null;
  burn_ratio?: string | number | null;
  burn_status?: string | null;
  is_honeypot?: boolean | null;
  honeypot?: number | null;
  is_blacklist?: boolean | null;
  is_open_source?: boolean | null;
  renounced_mint?: boolean | null;
  renounced_freeze_account?: boolean | null;
  is_renounced?: boolean | null;
  can_not_sell?: number | null;
  buy_tax?: string | number | null;
  sell_tax?: string | number | null;
  flags?: unknown[] | null;
  lock_summary?: {
    is_locked?: boolean | null;
    lock_detail?: { percent?: string | number | null; is_blackhole?: boolean | null }[] | null;
  } | null;
}

/**
 * What the gates actually consume. Every field is nullable and null means
 * UNKNOWN — the type is the abstain rule made structural, so a gate cannot
 * accidentally read "absent" as "false".
 */
export interface TokenSecurity {
  /** Fraction 0-1 held by the top 10 holders. GMGN excludes pool/LP accounts. */
  top10HolderRate: number | null;
  /** Solana: mint authority revoked. Null on EVM (the concept does not exist). */
  mintRenounced: boolean | null;
  /** Solana: freeze authority revoked — THE Solana honeypot. Null on EVM. */
  freezeRenounced: boolean | null;
  /** LP burned or locked, by any of GMGN's three ways of saying it. */
  lpSecured: boolean | null;
  /** EVM: explicitly flagged as a honeypot. Null = not evaluated. */
  honeypot: boolean | null;
  /** EVM: buy tax as a fraction (0.05 = 5%). Null = unknown. */
  buyTax: number | null;
  /** EVM: sell tax as a fraction. Null = unknown. */
  sellTax: number | null;
}

function num(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'string' ? Number.parseFloat(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Does this payload actually say anything?
 *
 * GMGN answers `code: 0` for addresses it has never indexed, with a blank
 * `address` and default-valued everything else. Treating that as data is how a
 * data gap becomes a false rejection — see the module header.
 */
export function isBlankSecurity(raw: GmgnSecurityRaw | null | undefined): boolean {
  if (!raw) return true;
  return typeof raw.address !== 'string' || raw.address.trim() === '';
}

/**
 * Is the LP burned or locked?
 *
 * GMGN says this three different ways depending on chain and launchpad, and no
 * single field is present everywhere:
 *   - `burn_status === 'burn'` with `burn_ratio` 1 (pump.fun-style Solana);
 *   - `lock_summary.is_locked` (EVM lockers, and some Solana);
 *   - `lock_summary.lock_detail[].percent` with `is_blackhole` (LP sent to the
 *     zero address — a burn expressed as a lock).
 * Any of them counts. NONE of them present is `null`, not `false`: an older
 * Solana token whose LP situation GMGN simply has no record of must abstain,
 * not be rejected. (BONK is exactly that case — burn_status "none",
 * is_locked false, and it is obviously not a rug.)
 */
export function readLpSecured(raw: GmgnSecurityRaw): boolean | null {
  const burnRatio = num(raw.burn_ratio);
  const status = (raw.burn_status ?? '').toString().trim().toLowerCase();
  const summary = raw.lock_summary ?? null;
  const detail = Array.isArray(summary?.lock_detail) ? summary!.lock_detail! : [];

  if (status === 'burn' || (burnRatio != null && burnRatio >= 0.95)) return true;
  if (summary?.is_locked === true) return true;
  for (const d of detail) {
    const pct = num(d?.percent);
    if (pct != null && pct >= 0.9) return true;
  }

  // Nothing positive. Only call it INSECURE when GMGN evidently looked: a
  // burn_status string it filled in, or a lock summary it returned.
  if (status !== '' || summary != null) return false;
  return null;
}

/**
 * Normalise one raw payload for one chain. Pure; unit-tested against the live
 * shapes recorded in the module header.
 *
 * Chain-conditional by construction: Solana-only fields are null on EVM and
 * vice versa, so the gates never get to compare an EVM token against a rule
 * that cannot apply to it.
 */
export function normalizeSecurity(
  raw: GmgnSecurityRaw,
  network: RevivalNetwork,
): TokenSecurity | null {
  if (isBlankSecurity(raw)) return null;
  const solana = network === 'solana';

  return {
    top10HolderRate: num(raw.top_10_holder_rate),
    mintRenounced: solana ? (raw.renounced_mint ?? null) : null,
    freezeRenounced: solana ? (raw.renounced_freeze_account ?? null) : null,
    lpSecured: readLpSecured(raw),
    // EVM only. `honeypot` (the 0/1 twin) is read only when the boolean is
    // absent, and a 0 there is NOT evidence of cleanliness — it is the default.
    honeypot: solana ? null : (raw.is_honeypot ?? (raw.honeypot === 1 ? true : null)),
    buyTax: solana ? null : num(raw.buy_tax),
    sellTax: solana ? null : num(raw.sell_tax),
  };
}

/**
 * Fetch and normalise. Null means ABSTAIN — GMGN unconfigured, rate-limit
 * banned, request failed, or a blank payload for an address it does not index.
 * The caller must retry on a later cycle rather than recording a rejection.
 */
export async function fetchTokenSecurity(
  network: RevivalNetwork,
  address: string,
): Promise<TokenSecurity | null> {
  const result = await gmgnGet<GmgnSecurityRaw>('/v1/token/security', {
    chain: GMGN_CHAIN[network],
    address,
  });
  if (!result.ok) {
    // RATE_LIMIT_BANNED included. A ban is not a verdict about a token.
    console.warn(
      `[McapCross] Security lookup unavailable for ${address.slice(0, 8)}… on ${network}: ${result.error}`,
    );
    return null;
  }
  return normalizeSecurity(result.data ?? {}, network);
}
