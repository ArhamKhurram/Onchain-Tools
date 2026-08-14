/**
 * Journal ingestion poller.
 *
 * Every OCT_JOURNAL_POLL_MS (default 2 min):
 * 1. Enumerate every user's journal wallets (storage provider in local mode;
 *    a service-role query in hosted mode, the same split the revival poller
 *    uses for its universe).
 * 2. Per wallet: fetch transactions newer than the cursor from the Helius
 *    Enhanced Transactions API (a freshly added wallet backfills up to
 *    OCT_JOURNAL_BACKFILL_PAGES × 100 txs), normalize them into swap legs
 *    (journal/normalize.ts — delta method, wSOL fold, fee add-back), resolve
 *    symbols via DAS getAssetBatch, price SOL legs with the daily SOL price,
 *    persist trades idempotently, rebuild the wallet's FIFO positions, then
 *    advance the cursor. Cursor advances ONLY after a fully successful cycle,
 *    so a mid-walk failure re-fetches rather than gaps.
 * 3. On new trades: `journal_update` WS nudge to that user (data refresh
 *    signal, no payload the client must trust).
 *
 * REQUEST BUDGET (Helius): steady state = 1 page request per wallet per cycle
 * (+1 getAssetBatch per 100 previously-unseen mints). A backfill costs up to
 * OCT_JOURNAL_BACKFILL_PAGES requests once per wallet. Pages are spaced 300ms
 * inside helius.ts.
 *
 * Self-gates: no HELIUS_API_KEY → log once and idle. Hosted mode without a
 * Supabase service client → idle. Missing journal tables (migration applied
 * by hand) → the repo warns once and every read returns empty, so cycles
 * no-op cleanly.
 */

import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { JournalTrade, JournalWallet } from '@oct/shared';
import type { WsServer } from '../ws/server.js';
import { getStorageProvider, isHostedMode } from '../storage/index.js';
import { getFomoServiceClient } from '../fomo/store.js';
import { getHeliusApiKey, fetchNewTransactions, resolveTokenSymbols } from './helius.js';
import { normalizeWalletTransactions } from './normalize.js';
import { abandonedMapFromPositions } from './abandoned.js';
import { buildPositions } from './positions.js';
import { dayOf, ensureDailySolPrices, getCurrentSolPrice, solPriceForDay } from './solPrice.js';

const LOCAL_USER_ID = 'local';
export const DEFAULT_JOURNAL_POLL_MS = 120_000;
export const DEFAULT_BACKFILL_PAGES = 10;

function envFlag(name: string): string | undefined {
  return process.env[`OCT_${name}`] ?? process.env[`TRENCHCORD_${name}`];
}

export function isJournalEnabled(): boolean {
  const v = (envFlag('JOURNAL_ENABLED') ?? '').trim().toLowerCase();
  // Default ON; only an explicit falsy value disables (matches revival).
  return !(v === 'false' || v === '0' || v === 'off');
}

function resolvePollMs(): number {
  const parsed = Number.parseInt(envFlag('JOURNAL_POLL_MS') ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 30_000 ? parsed : DEFAULT_JOURNAL_POLL_MS;
}

function resolveBackfillPages(): number {
  const parsed = Number.parseInt(envFlag('JOURNAL_BACKFILL_PAGES') ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 100 ? parsed : DEFAULT_BACKFILL_PAGES;
}

interface WalletWithUser extends JournalWallet {
  userId: string;
}

class JournalPoller {
  private wsServer: WsServer;
  private db: SupabaseClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private nudgeTimer: NodeJS.Timeout | null = null;
  private started = false;
  private polling = false;
  private pollMs = DEFAULT_JOURNAL_POLL_MS;
  /** mint → symbol, resolved once per process (symbols don't change). */
  private symbolCache = new Map<string, string>();

  constructor(wsServer: WsServer) {
    this.wsServer = wsServer;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    if (!isJournalEnabled()) {
      console.log('[JournalPoller] Disabled via OCT_JOURNAL_ENABLED; poller idle.');
      return;
    }
    if (!getHeliusApiKey()) {
      console.log('[JournalPoller] HELIUS_API_KEY not configured; journal ingestion idle.');
      return;
    }
    if (isHostedMode()) {
      this.db = getFomoServiceClient();
      if (!this.db) {
        console.log('[JournalPoller] Hosted mode without Supabase service client; poller idle.');
        return;
      }
    }

    this.pollMs = resolvePollMs();
    console.log(
      `[JournalPoller] Started (interval ${this.pollMs}ms, backfill cap ${resolveBackfillPages()} pages/wallet).`,
    );
    void this.poll().catch((err) =>
      console.error('[JournalPoller] initial poll error:', (err as Error)?.message),
    );
    this.timer = setInterval(() => {
      void this.poll().catch((err) =>
        console.error('[JournalPoller] poll error:', (err as Error)?.message),
      );
    }, this.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    this.timer = null;
    this.nudgeTimer = null;
  }

  /** Run a cycle soon (a wallet was just added; don't wait out the interval). */
  nudge(): void {
    if (!this.started || !this.timer) return;
    if (this.nudgeTimer) return;
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null;
      void this.poll().catch((err) =>
        console.error('[JournalPoller] nudge poll error:', (err as Error)?.message),
      );
    }, 1_000);
  }

  private async loadWallets(): Promise<WalletWithUser[]> {
    if (!isHostedMode()) {
      const wallets = await getStorageProvider().listJournalWallets(LOCAL_USER_ID);
      return wallets.map((w) => ({ ...w, userId: LOCAL_USER_ID }));
    }
    if (!this.db) return [];
    const { data, error } = await this.db
      .from('journal_wallets')
      .select('*')
      .order('created_at', { ascending: true })
      .limit(500);
    if (error) {
      // Missing table = migration pending; the repo already warned once.
      if (!/does not exist|Could not find the table|schema cache/i.test(error.message ?? '')) {
        console.warn('[JournalPoller] Wallet load failed:', error.message);
      }
      return [];
    }
    return ((data ?? []) as any[]).map((row) => ({
      id: row.id,
      address: row.address,
      label: row.label ?? null,
      chain: 'solana' as const,
      lastSignature: row.last_signature ?? null,
      lastPolledAt: row.last_polled_at ?? null,
      createdAt: row.created_at,
      userId: row.user_id as string,
    }));
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const wallets = await this.loadWallets();
      if (wallets.length === 0) return;

      for (const wallet of wallets) {
        try {
          await this.ingestWallet(wallet);
        } catch (err) {
          console.warn(
            `[JournalPoller] ingest failed for ${wallet.address.slice(0, 8)}…:`,
            (err as Error)?.message,
          );
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private async ingestWallet(wallet: WalletWithUser): Promise<void> {
    const storage = getStorageProvider();
    const isBackfill = wallet.lastSignature == null;
    const maxPages = isBackfill ? resolveBackfillPages() : 5;

    const result = await fetchNewTransactions(wallet.address, wallet.lastSignature, maxPages);
    if (result === null) return; // hard failure — keep old cursor, retry next cycle

    const nowIso = new Date().toISOString();
    if (result.transactions.length === 0) {
      await storage.updateJournalWalletCursor(
        wallet.userId,
        wallet.id,
        result.newestSignature,
        nowIso,
      );
      return;
    }
    if (result.truncated) {
      console.warn(
        `[JournalPoller] ${wallet.address.slice(0, 8)}…: page cap reached before the cursor — ` +
          `history older than the ${result.transactions.length} fetched txs is skipped.`,
      );
    }

    const { swaps, unclassified } = normalizeWalletTransactions(result.transactions, wallet.address);
    if (unclassified.length > 0) {
      console.log(
        `[JournalPoller] ${wallet.address.slice(0, 8)}…: ${unclassified.length} unclassified tx(s) skipped.`,
      );
    }

    // Price SOL legs: daily prices for the swap span (one CoinGecko call on
    // backfill), current DexScreener price stamps today.
    if (swaps.length > 0) {
      const tsMin = Math.min(...swaps.map((s) => new Date(s.ts).getTime()));
      const tsMax = Math.max(...swaps.map((s) => new Date(s.ts).getTime()));
      await getCurrentSolPrice();
      if (dayOf(new Date(tsMin).toISOString()) !== dayOf(nowIso)) {
        await ensureDailySolPrices(tsMin, tsMax);
      }
    }

    // Symbols for unseen mints (≤1 DAS request per 100 new mints, cached).
    const unseenMints = [...new Set(swaps.map((s) => s.mint))].filter(
      (m) => !this.symbolCache.has(m),
    );
    if (unseenMints.length > 0) {
      const resolved = await resolveTokenSymbols(unseenMints);
      for (const [mint, sym] of resolved) this.symbolCache.set(mint, sym);
    }

    const trades: JournalTrade[] = swaps.map((s) => {
      const dayPrice = solPriceForDay(dayOf(s.ts));
      const amountUsd =
        s.amountUsd != null
          ? s.amountUsd
          : s.amountSol != null && dayPrice != null
            ? Math.round(s.amountSol * dayPrice * 100) / 100
            : null;
      return {
        id: randomUUID(),
        walletId: wallet.id,
        walletAddress: wallet.address,
        mint: s.mint,
        symbol: this.symbolCache.get(s.mint) ?? null,
        side: s.side,
        amountToken: s.amountToken,
        amountSol: s.amountSol,
        amountUsd,
        txSignature: s.signature,
        dex: s.dex,
        ts: s.ts,
      };
    });

    const added = await storage.addJournalTrades(wallet.userId, trades);

    // Rebuild the wallet's positions from its FULL trade history (pure,
    // deterministic ids → the repo upserts in place). Positions already
    // auto-closed as ABANDONED are fed back in so the rebuild re-applies the
    // same zero-proceeds close instead of re-opening a dead bag.
    if (added > 0 || isBackfill) {
      const all = await storage.listJournalTrades(wallet.userId, 20_000, wallet.id);
      const closedRows = await storage.listJournalPositions(wallet.userId, 'closed');
      const { positions } = buildPositions(all, {
        abandoned: abandonedMapFromPositions(closedRows),
      });
      await storage.replaceJournalPositions(wallet.userId, wallet.id, positions);
    }

    // Cursor LAST — everything above succeeded, so the walk never gaps.
    await storage.updateJournalWalletCursor(wallet.userId, wallet.id, result.newestSignature, nowIso);

    if (added > 0) {
      console.log(
        `[JournalPoller] ${wallet.address.slice(0, 8)}…: +${added} trade(s)` +
          (isBackfill ? ` (backfill, ${result.pagesFetched} pages)` : ''),
      );
      this.wsServer.sendToUser(wallet.userId, { type: 'journal_update', data: { walletId: wallet.id } });
    }
  }
}

let _poller: JournalPoller | null = null;

export function startJournalPoller(wsServer: WsServer): void {
  if (_poller) return;
  _poller = new JournalPoller(wsServer);
  _poller.start();
}

export function stopJournalPoller(): void {
  _poller?.stop();
  _poller = null;
}

/** Called by the wallet-add route so a new wallet backfills within seconds. */
export function nudgeJournalPoller(): void {
  _poller?.nudge();
}
