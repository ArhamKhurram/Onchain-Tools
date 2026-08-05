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

const REGION_BASE_URLS = {
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
      // Slotshark's `slippage` is 1-10000 in the same basis-point units our rule
      // uses, so pass it through verbatim. The previous `bps / 100 || 20` both
      // truncated (30bps -> 0) and then substituted a 20% default via `||`,
      // silently making a tight-slippage rule maximally slippage-tolerant.
      slippage: clampSlippageBps(intent.slippageBps),
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
 * Slotshark accepts slippage in 1-10000. Clamp rather than default: a rule that
 * somehow carries an out-of-range value must not silently become 20% tolerant.
 */
export function clampSlippageBps(bps: number): number {
  if (!Number.isFinite(bps)) return 1;
  return Math.min(10_000, Math.max(1, Math.round(bps)));
}

/** Pull a tx signature out of whatever shape Slotshark returns, if present. */
export function extractSignature(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const d = data as Record<string, unknown>;
  const nested = d.data as Record<string, unknown> | undefined;
  const candidate = d.signature ?? d.txid ?? d.tx ?? nested?.signature;
  return typeof candidate === 'string' ? candidate : undefined;
}
