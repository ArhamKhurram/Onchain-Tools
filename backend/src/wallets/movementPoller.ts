// Tracked-wallet on-chain movement fan-out poller.
//
// Polls each distinct SOLANA wallet in the Directory (user_tracked_wallets) for
// its recent swaps via the KEYLESS profile-api.pump.fun/transactions/{wallet}
// endpoint (PumpfunClient.getWalletTransactions), deduped across users, and fans
// each NEW buy/sell out to every user tracking that wallet — respecting their
// per-wallet alerts_on_toast / alerts_on_feed / alerts_on_bubble toggles — over a
// WS `wallet_movement` frame (which lands in the console's notification history)
// plus Pushover.
//
// Dedup model mirrors the pump CALLOUT poller, not the FOMO store-and-fan-out one:
// a single per-wallet cursor (newest seen swap tx_hash) means each swap is
// processed exactly once per poll cycle, so there is no per-subscriber delivery
// table. `cursor_seeded` guards cold start so a backlog is recorded, never pinged.
//
// SCOPE (v1): SOLANA only. EVM tracked wallets (ethereum/bsc/base) are ignored —
// profile-api.pump.fun is a Solana source. Robinhood is not an on-chain wallet.
//
// Self-gates on Supabase like the FOMO / callout / missed-runner pollers, so local
// mode (no service client) stays completely clean.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { WsServer } from '../ws/server.js';
import { getStorageProvider } from '../storage/index.js';
import { sendPushover } from '../utils/pushover.js';
import { getPumpfunClient } from '../pumpfun/client.js';
import type { PumpSwapTransaction } from '../pumpfun/types.js';
import {
  getWalletServiceClient,
  loadTrackedSolanaWallets,
  loadMovementCursors,
  upsertMovementCursor,
  type WalletTrackerRow,
} from './movementStore.js';

const DEFAULT_INTERVAL_MS = Number.parseInt(process.env.WALLET_MOVEMENT_POLL_INTERVAL_MS ?? '', 10) || 30_000;
const IDLE_INTERVAL_MS = Number.parseInt(process.env.WALLET_MOVEMENT_IDLE_INTERVAL_MS ?? '', 10) || 90_000;
// Bound the upstream load per poll: a big Directory can hold hundreds of wallets,
// so each cycle polls at most this many, rotating through the full set across
// cycles (every wallet is covered within ceil(total / cap) polls). Keeps the poll
// from hammering profile-api regardless of how many wallets are tracked. Kept
// deliberately modest — profile-api is a flaky, unmetered public origin, so a
// smaller slice polled more gently beats a big one that trips 502s.
const MAX_WALLETS_PER_POLL = Number.parseInt(process.env.WALLET_MOVEMENT_MAX_PER_POLL ?? '', 10) || 25;
// Space out the per-wallet requests within a cycle instead of firing the whole
// slice back-to-back, so the origin sees a trickle rather than a burst. 0 disables.
const REQUEST_SPACING_MS = Number.parseInt(process.env.WALLET_MOVEMENT_REQUEST_SPACING_MS ?? '', 10) || 150;
// profile-api.pump.fun times out and 502s often enough that the default 10s
// single-shot budget is too tight for a background poller. Give the transactions
// call a longer budget and a couple of retries on TRANSIENT failures only. Both
// are env-tunable; setting retries to 0 restores single-attempt behavior.
const TX_TIMEOUT_MS = Number.parseInt(process.env.WALLET_MOVEMENT_TX_TIMEOUT_MS ?? '', 10) || 20_000;
const TX_RETRIES = Number.parseInt(process.env.WALLET_MOVEMENT_TX_RETRIES ?? '', 10);
const TX_RETRIES_RESOLVED = Number.isFinite(TX_RETRIES) && TX_RETRIES >= 0 ? TX_RETRIES : 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type NormalizedSide = 'buy' | 'sell' | null;

function normalizeSide(side: string | null): NormalizedSide {
  const s = (side ?? '').toUpperCase();
  if (s === 'BUY') return 'buy';
  if (s === 'SELL') return 'sell';
  return null;
}

function compactSol(value: number | null): string {
  if (value == null) return '—';
  const abs = Math.abs(value);
  if (abs >= 1000) return `${(abs / 1000).toFixed(1)}K SOL`;
  if (abs >= 1) return `${abs.toFixed(2)} SOL`;
  return `${abs.toFixed(4)} SOL`;
}

class WalletMovementPoller {
  private wsServer: WsServer;
  private db: SupabaseClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private polling = false;
  private pollIntervalMs = DEFAULT_INTERVAL_MS;
  private lastPollError: string | null = null;
  // Rotation pointer into the sorted address list, so successive polls cover
  // different slices of a Directory larger than MAX_WALLETS_PER_POLL.
  private rotationOffset = 0;

  constructor(wsServer: WsServer) {
    this.wsServer = wsServer;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    const db = getWalletServiceClient();
    if (!db) {
      console.log('[WalletMovementPoller] Supabase not configured; wallet-movement poller idle.');
      return;
    }
    this.db = db;
    console.log(`[WalletMovementPoller] Started (interval ${DEFAULT_INTERVAL_MS}ms, cap ${MAX_WALLETS_PER_POLL}/poll).`);
    void this.poll().catch((err) =>
      console.error('[WalletMovementPoller] initial poll error:', (err as Error)?.message),
    );
    this.scheduleNext();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private resolveInterval(): number {
    return this.wsServer.getAuthenticatedClientCount() > 0 ? DEFAULT_INTERVAL_MS : IDLE_INTERVAL_MS;
  }

  private scheduleNext(): void {
    if (this.timer) clearTimeout(this.timer);
    this.pollIntervalMs = this.resolveInterval();
    this.timer = setTimeout(() => {
      void this.poll()
        .catch((err) => console.error('[WalletMovementPoller] poll error:', (err as Error)?.message))
        .finally(() => this.scheduleNext());
    }, this.pollIntervalMs);
  }

  private async poll(): Promise<void> {
    if (this.polling || !this.db) return;
    this.polling = true;
    try {
      const trackers = await loadTrackedSolanaWallets();
      if (trackers.size === 0) {
        this.lastPollError = null;
        return;
      }

      // Stable sort so the rotation window advances deterministically across polls.
      const allAddresses = [...trackers.keys()].sort();
      const slice = this.nextSlice(allAddresses);
      const cursors = await loadMovementCursors(this.db, slice);

      let hadError = false;
      let first = true;
      for (const wallet of slice) {
        const followers = trackers.get(wallet);
        if (!followers || followers.length === 0) continue;
        // Trickle the requests out rather than firing the whole slice at once, so
        // a big Directory does not burst the origin. Skip the delay before the
        // first request.
        if (!first && REQUEST_SPACING_MS > 0) await sleep(REQUEST_SPACING_MS);
        first = false;
        try {
          await this.pollWallet(wallet, followers, cursors.get(wallet));
        } catch (err) {
          hadError = true;
          this.lastPollError = (err as Error)?.message ?? String(err);
          // A transient upstream failure here has already exhausted its retries in
          // the client, so it is expected-and-handled noise, not a hard error:
          // warn (never error) so it stops looking like a fault, and the wallet is
          // simply picked up next cycle.
          console.warn(`[WalletMovementPoller] poll failed for ${wallet.slice(0, 8)}…:`, this.lastPollError);
        }
      }
      if (!hadError) this.lastPollError = null;
    } finally {
      this.polling = false;
    }
  }

  /** The next up-to-cap window of addresses, advancing the rotation pointer. */
  private nextSlice(all: string[]): string[] {
    if (all.length <= MAX_WALLETS_PER_POLL) {
      this.rotationOffset = 0;
      return all;
    }
    if (this.rotationOffset >= all.length) this.rotationOffset = 0;
    const start = this.rotationOffset;
    const slice = all.slice(start, start + MAX_WALLETS_PER_POLL);
    this.rotationOffset = start + MAX_WALLETS_PER_POLL;
    return slice;
  }

  private async pollWallet(
    wallet: string,
    followers: WalletTrackerRow[],
    cursorRow: { last_tx_hash: string | null; cursor_seeded: boolean } | undefined,
  ): Promise<void> {
    // First page of recent activity is enough at a sane interval; we only care
    // about SWAP rows (buys/sells), so transfers/fee-claims are dropped here.
    const page = await getPumpfunClient().getWalletTransactions(wallet, {
      timeoutMs: TX_TIMEOUT_MS,
      retries: TX_RETRIES_RESOLVED,
    });
    const swaps = page.items.filter((t): t is PumpSwapTransaction => t.type === 'SWAP');

    const newestTxHash = swaps[0]?.txHash ?? null;
    const seeded = cursorRow?.cursor_seeded ?? false;

    // First run: seed the cursor to the newest swap and fire nothing (never ping a
    // cold-start backlog of historical swaps).
    if (!seeded) {
      await upsertMovementCursor(this.db!, wallet, newestTxHash, true);
      return;
    }

    const cursor = cursorRow?.last_tx_hash ?? null;
    const fresh: PumpSwapTransaction[] = [];
    for (const swap of swaps) {
      if (swap.txHash === cursor) break;
      fresh.push(swap);
    }

    // Oldest-first so the newest movement lands last (top of the toast stack).
    for (const swap of fresh.reverse()) {
      this.dispatch(wallet, swap, followers);
    }

    if (newestTxHash && newestTxHash !== cursor) {
      await upsertMovementCursor(this.db!, wallet, newestTxHash, true);
    }
  }

  /**
   * Fan one swap out to every user tracking the wallet. Each tracker carries its
   * own alert toggles + display metadata (name/emoji/sound), so the frame is built
   * per tracker. `notify` gates the client toast/sound the same way FOMO does; the
   * three alerts_on_* flags ride along so the console can route toast/feed/bubble.
   * Pushover is sent when the tracker has the toast channel on (the active-alert
   * channel, the closest analogue to "notify me").
   */
  private dispatch(wallet: string, swap: PumpSwapTransaction, followers: WalletTrackerRow[]): void {
    const side = normalizeSide(swap.side);
    const base = {
      txHash: swap.txHash,
      walletAddress: wallet,
      side,
      tokenMint: swap.token,
      tokenSymbol: swap.tokenSymbol,
      amount: swap.amount,
      solValue: swap.solValue,
      blockTime: swap.blockTime,
    };

    for (const f of followers) {
      // A tracker only hears about a channel it enabled; skip a follower who has
      // silenced every channel (already excluded by loadTrackedSolanaWallets, but
      // cheap to re-assert).
      if (!f.alertsOnToast && !f.alertsOnFeed && !f.alertsOnBubble) continue;

      this.wsServer.sendToUser(f.userId, {
        type: 'wallet_movement',
        data: {
          ...base,
          name: f.name,
          emoji: f.emoji,
          sound: f.sound,
          alertsOnToast: f.alertsOnToast,
          alertsOnFeed: f.alertsOnFeed,
          alertsOnBubble: f.alertsOnBubble,
          // Live dispatch to a subscriber — carries the toast/sound gate.
          notify: f.alertsOnToast,
        },
      });

      if (f.alertsOnToast) void this.notifyPushover(f.userId, wallet, swap, side, f);
    }
  }

  private async notifyPushover(
    userId: string,
    wallet: string,
    swap: PumpSwapTransaction,
    side: NormalizedSide,
    tracker: WalletTrackerRow,
  ): Promise<void> {
    try {
      const config = await getStorageProvider().getConfig(userId);
      if (!config.pushover?.enabled) return;
      const who = tracker.name ? `${tracker.emoji ? `${tracker.emoji} ` : ''}${tracker.name}` : `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;
      const verb = side === 'sell' ? 'SOLD' : side === 'buy' ? 'BOUGHT' : 'TRADED';
      const coin = swap.tokenSymbol ? `$${swap.tokenSymbol}` : swap.token ? `${swap.token.slice(0, 4)}…` : 'a token';
      const val = swap.solValue != null ? ` (${compactSol(swap.solValue)})` : '';
      await sendPushover(config.pushover, {
        title: `Wallet: ${who} ${verb} ${coin}`,
        message: `${who} ${verb} ${coin}${val}`,
      });
    } catch (err) {
      console.error('[WalletMovementPoller] Pushover notify failed:', (err as Error)?.message);
    }
  }
}

let _poller: WalletMovementPoller | null = null;

export function startWalletMovementPoller(wsServer: WsServer): void {
  if (_poller) return;
  _poller = new WalletMovementPoller(wsServer);
  _poller.start();
}
