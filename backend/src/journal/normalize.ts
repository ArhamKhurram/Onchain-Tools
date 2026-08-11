/**
 * Swap normalization for journal wallets — the part the wallet audit proved
 * you cannot get wrong. Every rule here was learned from real Helius payloads:
 *
 * - Use WALLET-PERSPECTIVE balance deltas (tokenTransfers + accountData
 *   nativeBalanceChange), NOT Helius `events.swap` — the parsed swap event is
 *   unreliable on Jupiter routes (wSOL legs go missing from tokenInputs).
 * - Fold the NET wSOL balance change into native SOL. wSOL tokenTransfers are
 *   transfer VOLUME; when SOL is wrapped/unwrapped inside the same tx that
 *   volume is already in nativeBalanceChange, so counting both double-counts
 *   the SOL leg. Net balance change is 0 for a transient wrap→swap→close and
 *   real for persistent wSOL holdings — exactly what we want.
 * - Add the tx fee back when the wallet was fee payer, so the swap-attributable
 *   SOL amount is isolated from the fee.
 * - Decode pump.fun bonding-curve txs (typed UNKNOWN/TRANSFER) from the same
 *   deltas — do not drop them; they are most of a memecoin trader's flow.
 * - Ignore aggregator routing residue: a mint that flowed both in AND out with
 *   a net under 1% of its gross volume is an intermediate hop / rebate dust
 *   (Jupiter USDC hops), not a position change.
 * - Ignore plain transfers and airdrops. Token-in with nothing paid is a
 *   transfer-in (surfaced separately, excluded from PnL); token-out with
 *   nothing received is a transfer-out/burn.
 *
 * Pure functions only — no I/O, fully unit-tested (journalNormalize.test.ts).
 */

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** Stablecoin mints treated as USD face value. */
export const STABLE_MINTS: Record<string, string> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
};

/** SOL moves under this are noise (tips, rent, aggregator dust). */
export const SOL_EPS = 0.0005;
/** Token dust threshold. */
export const TOKEN_EPS = 1e-9;
/** Routing-residue filter: |net| < this fraction of gross flow → ignore mint. */
export const RESIDUE_NET_FRACTION = 0.01;

// --- Helius Enhanced Transactions payload (the subset we read) --------------

export interface HeliusTokenTransfer {
  mint?: string;
  tokenAmount?: number | string;
  fromUserAccount?: string | null;
  toUserAccount?: string | null;
}

export interface HeliusTokenBalanceChange {
  mint?: string;
  userAccount?: string | null;
  rawTokenAmount?: { tokenAmount?: string; decimals?: number };
}

export interface HeliusAccountData {
  account?: string;
  nativeBalanceChange?: number;
  tokenBalanceChanges?: HeliusTokenBalanceChange[];
}

export interface HeliusEnhancedTx {
  signature: string;
  timestamp: number;
  type?: string;
  source?: string;
  fee?: number;
  feePayer?: string;
  transactionError?: unknown;
  tokenTransfers?: HeliusTokenTransfer[];
  accountData?: HeliusAccountData[];
}

// --- Output shapes ----------------------------------------------------------

/** One normalized swap leg (pre-persistence — no ids/wallet metadata yet). */
export interface NormalizedSwap {
  signature: string;
  /** ISO timestamp derived from the tx's unix timestamp. */
  ts: string;
  side: 'buy' | 'sell';
  mint: string;
  /** Token quantity (positive). */
  amountToken: number;
  /** SOL leg when the tx paid/received SOL and the split is attributable. */
  amountSol: number | null;
  /** USD from a stable leg's face value; SOL legs are priced later. */
  amountUsd: number | null;
  dex: string | null;
}

export interface TransferInNote {
  signature: string;
  ts: string;
  mint: string;
  amountToken: number;
}

export interface NormalizeResult {
  swaps: NormalizedSwap[];
  /** Tokens that arrived with nothing paid — excluded from PnL by design. */
  transferIns: TransferInNote[];
  /** Signatures the classifier could not decode into any known shape. */
  unclassified: string[];
}

// --- Per-tx deltas ----------------------------------------------------------

export interface TxDeltas {
  /** mint → net token delta (UI amounts), wSOL and residue excluded. */
  tokenDelta: Map<string, number>;
  /** stable mint → net delta (USD face value). */
  stableDelta: Map<string, number>;
  /** Swap-attributable SOL delta: lamports + net wSOL + fee add-back, in SOL. */
  nativeSol: number;
}

/**
 * Wallet-perspective deltas for one tx. See the module docblock for why each
 * step exists — every line here is a bug the audit hit.
 */
export function txDeltas(tx: HeliusEnhancedTx, wallet: string): TxDeltas {
  const tokenDelta = new Map<string, number>();
  const grossFlow = new Map<string, number>();

  for (const tt of tx.tokenTransfers ?? []) {
    const mint = tt.mint;
    if (!mint || mint === WSOL_MINT) continue;
    const amt = Number(tt.tokenAmount) || 0;
    if (!amt) continue;
    if (tt.toUserAccount === wallet) {
      tokenDelta.set(mint, (tokenDelta.get(mint) ?? 0) + amt);
      grossFlow.set(mint, (grossFlow.get(mint) ?? 0) + amt);
    }
    if (tt.fromUserAccount === wallet) {
      tokenDelta.set(mint, (tokenDelta.get(mint) ?? 0) - amt);
      grossFlow.set(mint, (grossFlow.get(mint) ?? 0) + amt);
    }
  }

  // Aggregator routing residue (Jupiter hops, rebate dust): both-ways flow
  // with a net under 1% of gross is not a position change.
  for (const [mint, net] of tokenDelta) {
    const gross = grossFlow.get(mint) ?? 0;
    if (gross > 0 && Math.abs(net) < RESIDUE_NET_FRACTION * gross && Math.abs(net) < gross) {
      tokenDelta.delete(mint);
    }
  }

  // Native delta: main-account lamports + NET wSOL balance change on
  // wallet-owned token accounts (raw amount is lamports, 9dp).
  let nativeLamports = 0;
  for (const ad of tx.accountData ?? []) {
    if (ad.account === wallet) nativeLamports += ad.nativeBalanceChange ?? 0;
    for (const tbc of ad.tokenBalanceChanges ?? []) {
      if (tbc.mint === WSOL_MINT && tbc.userAccount === wallet) {
        nativeLamports += Number(tbc.rawTokenAmount?.tokenAmount) || 0;
      }
    }
  }

  // Isolate swap-attributable SOL: add the fee back when we paid it.
  const fee = tx.feePayer === wallet ? (tx.fee ?? 0) : 0;
  const nativeSol = (nativeLamports + fee) / 1e9;

  const stableDelta = new Map<string, number>();
  for (const [mint, d] of tokenDelta) {
    if (STABLE_MINTS[mint]) {
      stableDelta.set(mint, d);
      tokenDelta.delete(mint);
    }
  }

  return { tokenDelta, stableDelta, nativeSol };
}

// --- Classification ---------------------------------------------------------

/**
 * Normalize a batch of enhanced transactions into swap legs. Input order does
 * not matter (dedupes by signature, sorts oldest→newest); failed txs are
 * skipped. Pump.fun bonding-curve txs (type UNKNOWN/TRANSFER) classify by the
 * same delta rules — the tx `type` is never trusted for classification.
 */
export function normalizeWalletTransactions(
  txs: HeliusEnhancedTx[],
  wallet: string,
): NormalizeResult {
  const seen = new Set<string>();
  const ordered = txs
    .filter((t) => {
      if (!t.signature || seen.has(t.signature)) return false;
      seen.add(t.signature);
      return true;
    })
    .sort((a, b) => a.timestamp - b.timestamp);

  const swaps: NormalizedSwap[] = [];
  const transferIns: TransferInNote[] = [];
  const unclassified: string[] = [];

  for (const tx of ordered) {
    if (tx.transactionError) continue;
    const iso = new Date(tx.timestamp * 1000).toISOString();
    const dex = tx.source && tx.source !== 'UNKNOWN' ? tx.source : null;
    const { tokenDelta, stableDelta, nativeSol } = txDeltas(tx, wallet);

    const tokens = [...tokenDelta.entries()].filter(([, d]) => Math.abs(d) > TOKEN_EPS);
    const stables = [...stableDelta.entries()].filter(([, d]) => Math.abs(d) > 1e-6);
    const tokensIn = tokens.filter(([, d]) => d > 0);
    const tokensOut = tokens.filter(([, d]) => d < 0);
    const stableIn = stables.filter(([, d]) => d > 0).reduce((s, [, d]) => s + d, 0);
    const stableOut = stables.filter(([, d]) => d < 0).reduce((s, [, d]) => s - d, 0);

    const solSpent = nativeSol < -SOL_EPS ? -nativeSol : 0;
    const solRecv = nativeSol > SOL_EPS ? nativeSol : 0;

    if (tokens.length === 0 && stables.length === 0) {
      // Pure SOL movement — plain transfer, staking, fees. Not a trade.
      continue;
    }

    const hasBuySide = tokensIn.length > 0;
    const hasSellSide = tokensOut.length > 0;
    const paidNative = solSpent > 0 || stableOut > 0;
    const recvNative = solRecv > 0 || stableIn > 0;

    if (hasBuySide && !hasSellSide && paidNative) {
      // BUY: spent SOL/stable for token(s).
      const useSol = solSpent > 0;
      const amtNativeTotal = useSol ? solSpent : stableOut;
      for (const [mint, d] of tokensIn) {
        // Multi-token buys can't attribute the native split — record the token
        // leg with unknown native amounts rather than guessing.
        const attributable = tokensIn.length === 1;
        swaps.push({
          signature: tx.signature,
          ts: iso,
          side: 'buy',
          mint,
          amountToken: d,
          amountSol: attributable && useSol ? amtNativeTotal : null,
          amountUsd: attributable && !useSol ? round2(amtNativeTotal) : null,
          dex,
        });
      }
    } else if (hasSellSide && !hasBuySide && recvNative) {
      // SELL: gave token(s), received SOL/stable.
      const useSol = solRecv > 0;
      const amtNativeTotal = useSol ? solRecv : stableIn;
      for (const [mint, d] of tokensOut) {
        const attributable = tokensOut.length === 1;
        swaps.push({
          signature: tx.signature,
          ts: iso,
          side: 'sell',
          mint,
          amountToken: -d,
          amountSol: attributable && useSol ? amtNativeTotal : null,
          amountUsd: attributable && !useSol ? round2(amtNativeTotal) : null,
          dex,
        });
      }
    } else if (hasBuySide && hasSellSide) {
      // TOKEN-TO-TOKEN: sell leg + buy leg sharing the signature. Native
      // amounts unknown; a stable leg (if any) prices single-token sides.
      const stableLegUsd = stableOut > 0 ? round2(stableOut) : stableIn > 0 ? round2(stableIn) : null;
      for (const [mint, d] of tokensOut) {
        swaps.push({
          signature: tx.signature,
          ts: iso,
          side: 'sell',
          mint,
          amountToken: -d,
          amountSol: null,
          amountUsd: tokensOut.length === 1 ? stableLegUsd : null,
          dex,
        });
      }
      for (const [mint, d] of tokensIn) {
        swaps.push({
          signature: tx.signature,
          ts: iso,
          side: 'buy',
          mint,
          amountToken: d,
          amountSol: null,
          amountUsd: tokensIn.length === 1 ? stableLegUsd : null,
          dex,
        });
      }
    } else if (hasBuySide && !paidNative) {
      // Tokens in, nothing paid → transfer-in / airdrop. Recorded for
      // observability, EXCLUDED from PnL (a sell of these later finds no lot
      // and its proceeds are ignored by the pairing engine).
      for (const [mint, d] of tokensIn) {
        transferIns.push({ signature: tx.signature, ts: iso, mint, amountToken: d });
      }
    } else if (hasSellSide && !recvNative) {
      // Tokens out, nothing received → transfer-out or burn. Not a trade.
      continue;
    } else if (stables.length > 0 && tokens.length === 0) {
      // Stable ↔ SOL swap or plain stable transfer — treasury movement, not a
      // memecoin trade. The journal deliberately skips it.
      continue;
    } else {
      unclassified.push(tx.signature);
    }
  }

  return { swaps, transferIns, unclassified };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
