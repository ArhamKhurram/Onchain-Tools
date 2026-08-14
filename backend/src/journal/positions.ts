/**
 * FIFO position pairing for the trade journal. Pure — takes a wallet's trades
 * (oldest→newest), returns episodes + the realized-PnL events the summary
 * curve is built from. Unit-tested in journalPositions.test.ts.
 *
 * Model:
 * - An EPISODE per (wallet, token): opens on the first buy from flat,
 *   accumulates buy lots, sells consume lots FIFO.
 * - An episode CLOSES when the remaining balance falls below DUST_RATIO (2%)
 *   of everything acquired in the episode — memecoin sells rarely go to
 *   exactly zero (dust from slippage/rounding), and a 98%-out position is
 *   closed in every sense that matters. A later buy opens a NEW episode.
 *   These closes carry `closeReason: 'sold'`.
 * - An episode can ALSO be closed from outside as ABANDONED (a dead bag: no
 *   LP or worth ~$0 and untouched for days — see abandoned.ts). Caller passes
 *   `opts.abandoned` (episode id → closedAt); the episode is then booked as a
 *   sale of the whole remainder at ZERO proceeds, so the unrecovered cost
 *   lands in realized PnL exactly as a 0-proceeds sell would. No price is
 *   invented and `remainingToken` stays factual — the operator still holds
 *   the tokens, they are just worth nothing.
 * - Sells with no open lots (transfer-in-derived tokens) realize nothing:
 *   transfer-ins are excluded from PnL by design, so their proceeds are
 *   ignored rather than booked as pure profit.
 * - PnL components are computed only where both sides carry a value; a
 *   missing leg (stable-paid, token-to-token, unpriced) marks the episode
 *   `pnlIncomplete` instead of fabricating a number.
 */

import type { JournalCloseReason, JournalPosition, JournalTrade } from '@oct/shared';

/** Episode closes when remaining < this fraction of total acquired. */
export const DUST_RATIO = 0.02;

export interface RealizedEvent {
  ts: string;
  mint: string;
  symbol: string | null;
  walletId: string;
  pnlSol: number | null;
  pnlUsd: number | null;
}

export interface PairingResult {
  positions: JournalPosition[];
  /** One event per realizing sell (curve/day-list source). */
  events: RealizedEvent[];
}

interface Lot {
  qty: number;
  solPerToken: number | null;
  usdPerToken: number | null;
}

interface OpenEpisode {
  openedAt: string;
  symbol: string | null;
  acquired: number;
  remaining: number;
  costSol: number;
  costUsd: number;
  costUsdKnown: boolean;
  realizedSol: number;
  realizedUsd: number;
  realizedUsdKnown: boolean;
  pnlIncomplete: boolean;
  lastTradeAt: string;
  lots: Lot[];
}

export function episodeId(walletId: string, mint: string, openedAt: string): string {
  return `${walletId}|${mint}|${openedAt}`;
}

/**
 * Build every episode for one wallet from its full trade list. Trades may
 * arrive in any order; they are sorted by (ts, buy-before-sell) so a same-tx
 * buy+sell pair (token-to-token) buys first.
 */
export interface BuildPositionsOptions {
  dustRatio?: number;
  /**
   * Episode id → closedAt ISO. Episodes still open at the end of the walk and
   * listed here close as ABANDONED at zero proceeds. Sourced from the
   * persisted `close_reason` column (see abandoned.ts
   * `abandonedMapFromPositions`) so the close survives every rebuild.
   */
  abandoned?: ReadonlyMap<string, string>;
}

export function buildPositions(
  trades: JournalTrade[],
  opts: BuildPositionsOptions = {},
): PairingResult {
  const dustRatio = opts.dustRatio ?? DUST_RATIO;
  const abandoned = opts.abandoned;
  const ordered = [...trades].sort((a, b) => {
    const dt = new Date(a.ts).getTime() - new Date(b.ts).getTime();
    if (dt !== 0) return dt;
    if (a.side !== b.side) return a.side === 'buy' ? -1 : 1;
    return 0;
  });

  const positions: JournalPosition[] = [];
  const events: RealizedEvent[] = [];
  // key: walletId|mint → open episode
  const open = new Map<string, OpenEpisode>();
  // walletId → walletAddress (trades carry both; positions need the address).
  const walletAddressByWalletId = new Map<string, string>();

  const finalize = (
    key: string,
    ep: OpenEpisode,
    status: 'open' | 'closed',
    closedAt: string | null,
    closeReason: JournalCloseReason | null = null,
  ): void => {
    const [walletId, mint] = splitKey(key);
    const walletAddress = walletAddressByWalletId.get(walletId) ?? '';
    positions.push({
      id: episodeId(walletId, mint, ep.openedAt),
      walletId,
      walletAddress,
      mint,
      symbol: ep.symbol,
      status,
      acquiredToken: ep.acquired,
      remainingToken: Math.max(ep.remaining, 0),
      costSol: ep.costSol,
      costUsd: ep.costUsdKnown ? ep.costUsd : null,
      realizedPnlSol: ep.realizedSol,
      realizedPnlUsd: ep.realizedUsdKnown ? ep.realizedUsd : null,
      pnlIncomplete: ep.pnlIncomplete,
      openedAt: ep.openedAt,
      closedAt,
      closeReason,
      lastTradeAt: ep.lastTradeAt,
      lastPriceUsd: null,
      lastPriceAt: null,
    });
  };

  for (const t of ordered) {
    if (!(t.amountToken > 0)) continue;
    walletAddressByWalletId.set(t.walletId, t.walletAddress);
    const key = `${t.walletId}|${t.mint}`;

    if (t.side === 'buy') {
      let ep = open.get(key);
      if (!ep) {
        ep = {
          openedAt: t.ts,
          symbol: t.symbol,
          acquired: 0,
          remaining: 0,
          costSol: 0,
          costUsd: 0,
          costUsdKnown: true,
          realizedSol: 0,
          realizedUsd: 0,
          realizedUsdKnown: true,
          pnlIncomplete: false,
          lastTradeAt: t.ts,
          lots: [],
        };
        open.set(key, ep);
      }
      ep.symbol = ep.symbol ?? t.symbol;
      ep.acquired += t.amountToken;
      ep.remaining += t.amountToken;
      ep.lastTradeAt = t.ts;
      if (t.amountSol != null) ep.costSol += t.amountSol;
      else ep.pnlIncomplete = ep.pnlIncomplete || t.amountUsd == null;
      if (t.amountUsd != null) ep.costUsd += t.amountUsd;
      else ep.costUsdKnown = false;
      ep.lots.push({
        qty: t.amountToken,
        solPerToken: t.amountSol != null ? t.amountSol / t.amountToken : null,
        usdPerToken: t.amountUsd != null ? t.amountUsd / t.amountToken : null,
      });
      continue;
    }

    // SELL
    const ep = open.get(key);
    if (!ep) {
      // No open episode: transfer-in-derived tokens (or dust of a closed
      // episode). Excluded from PnL by design.
      continue;
    }
    ep.symbol = ep.symbol ?? t.symbol;
    ep.lastTradeAt = t.ts;

    const sellSolPerToken = t.amountSol != null ? t.amountSol / t.amountToken : null;
    const sellUsdPerToken = t.amountUsd != null ? t.amountUsd / t.amountToken : null;

    let qtyToMatch = Math.min(t.amountToken, ep.remaining);
    // Anything beyond the episode's remaining balance is unmatched (dust
    // accounting drift / transfer-ins mid-episode) — excluded from PnL.
    if (t.amountToken > ep.remaining + 1e-9) ep.pnlIncomplete = true;

    let eventSol: number | null = null;
    let eventUsd: number | null = null;

    while (qtyToMatch > 1e-12 && ep.lots.length > 0) {
      const lot = ep.lots[0];
      const q = Math.min(qtyToMatch, lot.qty);

      if (sellSolPerToken != null && lot.solPerToken != null) {
        const pnl = (sellSolPerToken - lot.solPerToken) * q;
        ep.realizedSol += pnl;
        eventSol = (eventSol ?? 0) + pnl;
      } else {
        ep.pnlIncomplete = true;
      }
      if (sellUsdPerToken != null && lot.usdPerToken != null) {
        const pnl = (sellUsdPerToken - lot.usdPerToken) * q;
        ep.realizedUsd += pnl;
        eventUsd = (eventUsd ?? 0) + pnl;
      } else {
        ep.realizedUsdKnown = false;
      }

      lot.qty -= q;
      if (lot.qty <= 1e-12) ep.lots.shift();
      qtyToMatch -= q;
    }

    ep.remaining = Math.max(ep.remaining - t.amountToken, 0);

    if (eventSol != null || eventUsd != null) {
      events.push({
        ts: t.ts,
        mint: t.mint,
        symbol: ep.symbol,
        walletId: t.walletId,
        pnlSol: eventSol,
        pnlUsd: eventUsd,
      });
    }

    // Dust close: episode is over once ≤ dustRatio of acquired remains.
    if (ep.acquired > 0 && ep.remaining <= dustRatio * ep.acquired) {
      finalize(key, ep, 'closed', t.ts, 'sold');
      open.delete(key);
    }
  }

  for (const [key, ep] of open) {
    const [walletId, mint] = splitKey(key);
    const closedAt = abandoned?.get(episodeId(walletId, mint, ep.openedAt));
    if (closedAt == null) {
      finalize(key, ep, 'open', null);
      continue;
    }

    // ABANDONED: sell the whole remainder for ZERO proceeds. Same lot walk as
    // a real sell with sellPerToken = 0, so the unrecovered cost books as the
    // loss it is. Nothing is invented; a lot with no priced leg marks the
    // episode incomplete exactly as an unpriced sell would.
    let lossSol = 0;
    let lossUsd = 0;
    let matched = 0;
    let eventUsdKnown = true;
    for (const lot of ep.lots) {
      matched += lot.qty;
      if (lot.solPerToken != null) lossSol += lot.solPerToken * lot.qty;
      else ep.pnlIncomplete = true;
      if (lot.usdPerToken != null) lossUsd += lot.usdPerToken * lot.qty;
      else eventUsdKnown = false;
    }
    ep.lots = [];
    ep.realizedSol -= lossSol;
    ep.realizedUsd -= lossUsd;
    if (!eventUsdKnown) ep.realizedUsdKnown = false;

    if (matched > 0) {
      events.push({
        ts: closedAt,
        mint,
        symbol: ep.symbol,
        walletId,
        pnlSol: -lossSol,
        pnlUsd: eventUsdKnown ? -lossUsd : null,
      });
    }

    // remaining is left FACTUAL — the tokens are still held, just worthless.
    finalize(key, ep, 'closed', closedAt, 'abandoned');
  }

  // Oldest-opened first, stable ordering for persistence.
  positions.sort((a, b) => new Date(a.openedAt).getTime() - new Date(b.openedAt).getTime());
  events.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  return { positions, events };
}

function splitKey(key: string): [string, string] {
  const idx = key.indexOf('|');
  return [key.slice(0, idx), key.slice(idx + 1)];
}
