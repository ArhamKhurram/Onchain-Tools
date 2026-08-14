// Slotshark executor — Solana, custodial. OCT holds only a developer bearer token;
// the wallet is funded and held in Slotshark's own dashboard.
//
// SECURITY: that same token authorizes /sell and /wallets/withdraw, not just /buy
// (see docs/architecture/sniper-security.md, threat T3). A leak is a total drain of
// the funded balance, so the operational control is keeping that balance minimal and
// reconciling every fill against the fire log. This module never logs the token.
//
// The region is a fixed enum, never operator input: a free-form base URL would be an
// SSRF vector. Shape adapted from the prior-art reference at
// github.com/DanielHighETH/trenchcord (backend/src/utils/slotshark.ts).

import type { Chain, Executor, FireIntent, FireLeg, SendOutcome, Venue } from '../types.js';

/**
 * The two regional hosts. Exported because the dashboard API lives on these
 * same hosts (`{us,eu}.slotshark.xyz/api/dashboard/*`, per Slotshark's official
 * docs) and must index this one table rather than build a second one — the SSRF
 * argument on `narrowRegion` below only holds if there is exactly one.
 */
export const REGION_BASE_URLS = {
  us: 'https://us.slotshark.xyz',
  eu: 'https://eu.slotshark.xyz',
} as const;

export type SlotsharkRegion = keyof typeof REGION_BASE_URLS;

// Longer than a typical fetch timeout: a swap submitted with retries can take
// several seconds to land, and giving up while it succeeds is the worst outcome —
// the caller assumes failure, re-fires, and double-buys.
const SLOTSHARK_TIMEOUT_MS = 20_000;

export interface SlotsharkConfig {
  apiToken: string;
  region: SlotsharkRegion;
  /** Map our internal walletId to the Slotshark wallet pubkey (case-sensitive). */
  resolveWalletAddress: (walletId: string) => string | undefined;
}

export class SlotsharkExecutor implements Executor {
  readonly venue: Venue = 'slotshark';
  readonly chains: readonly Chain[] = ['sol'];

  constructor(private cfg: SlotsharkConfig) {}

  async send(intent: FireIntent, leg: FireLeg, _correlationId: string): Promise<SendOutcome> {
    const wallet = this.cfg.resolveWalletAddress(leg.walletId);
    if (!wallet) {
      return { kind: 'dead', reason: 'validation', status: 0 };
    }

    // Omitting tip/priorityFee is meaningful (selects auto pricing), so they are
    // added conditionally rather than sent as null.
    const body: Record<string, unknown> = {
      mint: intent.mint,
      solAmount: leg.amount,
      wallet,
      // Slotshark's `slippage` is PERCENT, not basis points. This was inferred
      // from their UI ("SLIPPAGE (%)" saving 50 as `"slippage": 50`) and from
      // the /sell doc range of 1-100; Slotshark's official Twitter Sniper docs
      // (2026-08-08) state it outright — `slippage | number (%)` — so the
      // conversion below is confirmed, not deduced. Do not "simplify" it back.
      //
      // Passing bps verbatim (what this did until 2026-08-08) sent a 5% rule as
      // `500`, read as 500%: no slippage protection at all, on every fire. Note
      // the failure was silent and one-directional — always toward MORE
      // tolerance, i.e. toward being sandwiched.
      //
      // Convert without rounding. bps/100 can be fractional (30bps -> 0.3) and
      // it is not verified that they accept fractions; if they floor or reject
      // it the fire fails, which is the safe direction. Never round UP to reach
      // their documented minimum of 1 — that would loosen a tight rule, which
      // is the exact bug being fixed here.
      slippage: toVenueSlippagePercent(intent.slippageBps),
      antimev: intent.exec.kind === 'sol' ? intent.exec.antimev : true,
      retries: true,
    };
    if (intent.exec.kind === 'sol') {
      if (typeof intent.exec.tip === 'number') body.tip = intent.exec.tip;
      if (typeof intent.exec.priorityFee === 'number') body.priorityFee = intent.exec.priorityFee;
    }

    try {
      const res = await fetch(`${REGION_BASE_URLS[this.cfg.region]}/buy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.cfg.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SLOTSHARK_TIMEOUT_MS),
      });

      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        // Non-JSON body (e.g. an HTML error page from a proxy) — keep going.
      }

      if (!res.ok) {
        // Only signals that PROVE the request never reached the chain are dead
        // (retryable). 5xx is not such a proof — a gateway can time out downstream
        // of a submission that landed — so it maps to unknown.
        if (res.status === 401 || res.status === 403) return { kind: 'dead', reason: 'auth', status: res.status };
        if (res.status === 429) return { kind: 'dead', reason: 'rate_limit', status: res.status };
        if (res.status >= 500) return { kind: 'unknown' };
        if (res.status >= 400) return { kind: 'dead', reason: 'validation', status: res.status };
        return { kind: 'unknown' };
      }

      const signature = extractSignature(parsed);
      if (!signature) return { kind: 'unknown' };
      return { kind: 'filled', signature, amountIn: leg.amount, amountOut: 0, feePaid: 0 };
    } catch (err) {
      // DEFAULT TO `unknown`. Only failures that PROVE the request never reached
      // Slotshark may be `dead`, because `dead` is what executeFire retries — and
      // retrying a request that actually landed is a double buy.
      //
      // A bare `network` catch-all is wrong: "socket hang up" / ECONNRESET /
      // EPIPE all fire AFTER the bytes went out, so the trade may well have
      // executed. Only a refused connection or a DNS failure prove otherwise.
      const e = err as NodeJS.ErrnoException & { name?: string; cause?: NodeJS.ErrnoException };
      const code = e?.code ?? e?.cause?.code;
      if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        return { kind: 'dead', reason: 'network', status: 0 };
      }
      // TimeoutError, ECONNRESET, EPIPE, ETIMEDOUT, and anything unrecognized.
      return { kind: 'unknown' };
    }
  }
}

/**
 * The `region` column on sniper_venue_credentials is free text; SlotsharkRegion
 * is a two-member union that indexes a compile-time base-URL table. Narrowing
 * here is threat T4 (SSRF) enforcement: an unrecognised value must fall back to
 * a known host, never be interpolated into one. Never `new URL(input, base)` —
 * `//evil.com/x` escapes to another host.
 */
export function narrowRegion(raw: string | null | undefined): SlotsharkRegion {
  const v = raw?.trim().toLowerCase();
  return v === 'eu' ? 'eu' : 'us';
}

/**
 * Our rules carry slippage in basis points (1-10000 = 0.01%-100%, enforced by
 * validateRule and by the `slippage_bps` CHECK). Slotshark's field is percent —
 * their official docs state `slippage | number (%)`. This is the one conversion
 * between those two domains.
 *
 * Every clamp here is toward LESS tolerance, never more:
 * - a non-finite value collapses to the tightest expressible slippage rather
 *   than to a permissive default, so a corrupt rule fails closed;
 * - the ceiling is 100 (= 100%), our bps ceiling, well inside the 1-10000 their
 *   /buy accepts — we deliberately do not expose their wider range, because a
 *   value above 100% is not a tolerance, it is the absence of one;
 * - there is no floor. Rounding 0.3% up to their documented minimum of 1% would
 *   loosen a deliberately tight rule, which is the bug this function exists to
 *   prevent. If they reject or floor a fraction, the fire fails and no money
 *   moves — the acceptable outcome.
 */
export function toVenueSlippagePercent(bps: number): number {
  if (!Number.isFinite(bps) || bps <= 0) return 0.01;
  return Math.min(100, bps / 100);
}

/** Pull a tx signature out of whatever shape Slotshark returns, if present. */
export function extractSignature(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const d = data as Record<string, unknown>;
  const nested = d.data as Record<string, unknown> | undefined;
  const candidate = d.signature ?? d.txid ?? d.tx ?? nested?.signature;
  return typeof candidate === 'string' ? candidate : undefined;
}
