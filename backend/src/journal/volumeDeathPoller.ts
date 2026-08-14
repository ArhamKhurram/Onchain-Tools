/**
 * "Meta dying" poller — volume-collapse alerts for OPEN journal positions.
 *
 * Every OCT_JOURNAL_VOLDEATH_POLL_MS (default 3 min):
 * 1. Load OPEN journal positions (per-user via storage in local mode; one
 *    cross-user service query in hosted mode, the revival-poller split).
 * 2. Dedupe mints across positions/users and fetch each once from the keyless
 *    DexScreener token endpoint, spaced REQUEST_SPACING_MS (500ms ≈ 120
 *    req/min worst case, well under the ~300/min documented ceiling).
 * 3. Run the pure volume-death detector; on a `dying` verdict fan out to every
 *    user holding the token, EXCEPT holders whose position is dust
 *    (OCT_JOURNAL_VOLDEATH_MIN_POSITION_USD, default $10 — you cannot act on a
 *    ~$0 bag): `journal_alert` WS frame (toast + notification history
 *    client-side), Pushover at NORMAL priority (0, explicit — the emergency
 *    tier stays revival-only), one alert per position per
 *    OCT_JOURNAL_VOLDEATH_COOLDOWN_MS (default 30 min; in-memory v1, resets
 *    on reboot like revival's suppression).
 * 4. Side-write the observed price onto the position rows so the Journal tab
 *    shows current value without any extra requests.
 * 5. Run the ABANDONED-POSITION detector (abandoned.ts) over the same fetched
 *    pairs — ZERO extra upstream requests — and auto-close dead bags (no LP /
 *    worth ~$0 / untouched for days) as a sale at zero proceeds. A closed
 *    position leaves this sweep, so the request budget shrinks over time
 *    instead of growing forever.
 *
 * REQUEST BUDGET (DexScreener): 1 request per unique open-position mint per
 * cycle. A trader holding 10 tokens costs 10 requests / 3 min ≈ 3.3 req/min.
 *
 * This is a NEW INDEPENDENT SIGNAL. It reuses revival's CONCEPTS (pure
 * detector, cooldown floor, self-gating poller) and none of its code paths —
 * signals stay independent per CLAUDE.md. It deliberately does not touch
 * GeckoTerminal: revival owns that budget; this one polls DexScreener.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { JournalAlertData, JournalPosition } from '@oct/shared';
import type { WsServer } from '../ws/server.js';
import { getStorageProvider, isHostedMode } from '../storage/index.js';
import { getFomoServiceClient } from '../fomo/store.js';
import { sendPushover } from '../utils/pushover.js';
import { formatCompact } from '../wallets/balanceChecker.js';
import { isJournalEnabled } from './poller.js';
import { buildPositions } from './positions.js';
import {
  DEFAULT_ABANDON_CONFIG,
  abandonedMapFromPositions,
  evaluateAbandoned,
  type AbandonConfig,
  type AbandonFireReason,
} from './abandoned.js';
import {
  DEFAULT_MIN_POSITION_VALUE_USD,
  DEFAULT_VOLUME_DEATH_CONFIG,
  evaluateVolumeDeath,
  extractTokenVolumeSnapshot,
  isPositionWorthAlerting,
  shouldAlertVolumeDeath,
  type DexTokenPair,
  type VolumeDeathConfig,
} from './volumeDeath.js';

const LOCAL_USER_ID = 'local';
export const DEFAULT_VOLDEATH_POLL_MS = 180_000;
export const DEFAULT_VOLDEATH_COOLDOWN_MS = 1_800_000;
/** Polite spacing between keyless DexScreener requests. */
export const REQUEST_SPACING_MS = 500;

function envFlag(name: string): string | undefined {
  return process.env[`OCT_${name}`] ?? process.env[`TRENCHCORD_${name}`];
}

function resolvePollMs(): number {
  const parsed = Number.parseInt(envFlag('JOURNAL_VOLDEATH_POLL_MS') ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 60_000 ? parsed : DEFAULT_VOLDEATH_POLL_MS;
}

function resolveCooldownMs(): number {
  const parsed = Number.parseInt(envFlag('JOURNAL_VOLDEATH_COOLDOWN_MS') ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 60_000 ? parsed : DEFAULT_VOLDEATH_COOLDOWN_MS;
}

/**
 * Dust floor for the POSITION side, in USD. 0 disables the gate; junk falls
 * back to the default, like every other knob here.
 */
function resolveMinPositionUsd(): number {
  const parsed = Number.parseFloat(envFlag('JOURNAL_VOLDEATH_MIN_POSITION_USD') ?? '');
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MIN_POSITION_VALUE_USD;
}

/** Trades pulled for the rebuild that follows an auto-close. */
const REBUILD_TRADE_LIMIT = 20_000;

function envNumber(name: string, fallback: number, min = 0): number {
  const parsed = Number.parseFloat(envFlag(name) ?? '');
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

/** Abandonment knobs. Only an explicit falsy value disables (journal style). */
export function resolveAbandonConfig(): AbandonConfig {
  const raw = (envFlag('JOURNAL_ABANDON_ENABLED') ?? '').trim().toLowerCase();
  return {
    enabled: !(raw === 'false' || raw === '0' || raw === 'off'),
    minAgeDays: envNumber('JOURNAL_ABANDON_MIN_AGE_DAYS', DEFAULT_ABANDON_CONFIG.minAgeDays, 0),
    maxValueUsd: envNumber('JOURNAL_ABANDON_MAX_VALUE_USD', DEFAULT_ABANDON_CONFIG.maxValueUsd, 0),
    minLiquidityUsd: envNumber(
      'JOURNAL_ABANDON_MIN_LIQUIDITY_USD',
      DEFAULT_ABANDON_CONFIG.minLiquidityUsd,
      0,
    ),
  };
}

function resolveDetectorConfig(): VolumeDeathConfig {
  const parsed = Number.parseFloat(envFlag('JOURNAL_VOLDEATH_RATIO') ?? '');
  const ratio =
    Number.isFinite(parsed) && parsed > 0 && parsed < 1
      ? parsed
      : DEFAULT_VOLUME_DEATH_CONFIG.ratio;
  return { ...DEFAULT_VOLUME_DEATH_CONFIG, ratio };
}

interface PositionWithUser extends JournalPosition {
  userId: string;
}

class JournalVolumeDeathPoller {
  private wsServer: WsServer;
  private db: SupabaseClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private polling = false;
  /** position id → last alert epoch ms (in-memory v1, resets on reboot). */
  private lastAlertAt = new Map<string, number>();
  /**
   * Positions already auto-closed this process. The durable record is the
   * persisted `close_reason`; this only stops the work and the log line from
   * repeating every cycle if that column is missing (migration pending) and
   * the ingestion rebuild keeps re-opening the bag.
   */
  private abandonedThisProcess = new Set<string>();

  constructor(wsServer: WsServer) {
    this.wsServer = wsServer;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    if (!isJournalEnabled()) {
      console.log('[JournalVolDeath] Disabled via OCT_JOURNAL_ENABLED; poller idle.');
      return;
    }
    if (isHostedMode()) {
      this.db = getFomoServiceClient();
      if (!this.db) {
        console.log('[JournalVolDeath] Hosted mode without Supabase service client; poller idle.');
        return;
      }
    }

    const interval = resolvePollMs();
    const cfg = resolveDetectorConfig();
    console.log(
      `[JournalVolDeath] Started (interval ${interval}ms, ratio ${cfg.ratio}, ` +
        `cooldown ${resolveCooldownMs()}ms, min position $${resolveMinPositionUsd()}).`,
    );
    // No immediate poll: positions only exist after the ingestion poller has
    // run at least once, so the first useful cycle is one interval in.
    this.timer = setInterval(() => {
      void this.poll().catch((err) =>
        console.error('[JournalVolDeath] poll error:', (err as Error)?.message),
      );
    }, interval);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async loadOpenPositions(): Promise<PositionWithUser[]> {
    if (!isHostedMode()) {
      const positions = await getStorageProvider().listJournalPositions(LOCAL_USER_ID, 'open');
      return positions.map((p) => ({ ...p, userId: LOCAL_USER_ID }));
    }
    if (!this.db) return [];
    const { data, error } = await this.db
      .from('journal_positions')
      .select('*')
      .eq('status', 'open')
      .limit(1000);
    if (error) {
      if (!/does not exist|Could not find the table|schema cache/i.test(error.message ?? '')) {
        console.warn('[JournalVolDeath] Position load failed:', error.message);
      }
      return [];
    }
    return ((data ?? []) as any[]).map((row) => ({
      id: row.id,
      walletId: row.wallet_id,
      walletAddress: row.wallet_address,
      mint: row.mint,
      symbol: row.symbol ?? null,
      status: 'open' as const,
      acquiredToken: Number(row.acquired_token ?? 0),
      remainingToken: Number(row.remaining_token ?? 0),
      costSol: Number(row.cost_sol ?? 0),
      costUsd: row.cost_usd != null ? Number(row.cost_usd) : null,
      realizedPnlSol: Number(row.realized_pnl_sol ?? 0),
      realizedPnlUsd: row.realized_pnl_usd != null ? Number(row.realized_pnl_usd) : null,
      pnlIncomplete: !!row.pnl_incomplete,
      openedAt: row.opened_at,
      closedAt: null,
      closeReason: null,
      lastTradeAt: row.last_trade_at,
      lastPriceUsd: row.last_price_usd != null ? Number(row.last_price_usd) : null,
      lastPriceAt: row.last_price_at ?? null,
      userId: row.user_id as string,
    }));
  }

  private async fetchTokenPairs(mint: string): Promise<DexTokenPair[] | null> {
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        if (res.status === 429) console.warn('[JournalVolDeath] DexScreener rate-limited (429).');
        return null;
      }
      const body = (await res.json()) as { pairs?: DexTokenPair[] };
      return body.pairs ?? [];
    } catch (err) {
      console.warn('[JournalVolDeath] DexScreener fetch failed:', (err as Error).message);
      return null;
    }
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const positions = await this.loadOpenPositions();
      if (positions.length === 0) return;

      // One fetch per unique mint, whoever/however many hold it.
      const byMint = new Map<string, PositionWithUser[]>();
      for (const p of positions) {
        const list = byMint.get(p.mint) ?? [];
        list.push(p);
        byMint.set(p.mint, list);
      }

      const cfg = resolveDetectorConfig();
      const cooldownMs = resolveCooldownMs();
      const minPositionUsd = resolveMinPositionUsd();
      const abandonCfg = resolveAbandonConfig();
      let first = true;

      for (const [mint, holders] of byMint) {
        if (!first) await sleep(REQUEST_SPACING_MS);
        first = false;

        const pairs = await this.fetchTokenPairs(mint);
        // A failed/rate-limited request is a data gap, not a verdict — abstain
        // from BOTH detectors rather than closing a position on silence.
        if (pairs === null) continue;
        const snapshot = extractTokenVolumeSnapshot(pairs, mint);

        const nowIso = new Date().toISOString();

        // --- Abandonment sweep (zero extra requests: same `pairs` payload) ---
        // Runs before the volume-death gate so an auto-closed bag never also
        // fires a "meta dying" alert it can no longer act on.
        const live: PositionWithUser[] = [];
        for (const p of holders) {
          const verdict = evaluateAbandoned(
            p,
            {
              pairFound: snapshot != null,
              liquidityUsd: snapshot?.liquidityUsd ?? null,
              priceUsd: snapshot?.priceUsd ?? null,
            },
            Date.now(),
            abandonCfg,
          );
          if (!verdict.abandoned) {
            live.push(p);
            continue;
          }
          await this.closeAbandoned(p, verdict.reason, verdict.positionValueUsd, nowIso);
        }
        if (!snapshot || live.length === 0) continue;

        // Price side-write (free — same response), so the Journal tab can show
        // current value without its own market-data calls.
        if (snapshot.priceUsd != null) {
          for (const p of live) {
            try {
              await getStorageProvider().updateJournalPositionPrice(
                p.userId,
                p.id,
                snapshot.priceUsd,
                nowIso,
              );
            } catch {
              // best-effort; never blocks detection
            }
          }
        }

        const verdict = evaluateVolumeDeath(snapshot.windows, cfg);
        if (!verdict.dying || verdict.m5RateVsH1 == null || verdict.h1RateVsH6 == null) continue;

        for (const p of live) {
          const now = Date.now();
          const positionValueUsd =
            snapshot.priceUsd != null ? p.remainingToken * snapshot.priceUsd : null;

          // Dust gate FIRST, and deliberately BEFORE the cooldown stamp below:
          // a position skipped as dust must not burn its cooldown slot, or one
          // that later grows back into real money would be suppressed by a
          // cooldown it never actually spent an alert on. Gating here also
          // covers both delivery paths at once — the WS frame and Pushover are
          // the same alert, so they are gated once, together.
          if (!isPositionWorthAlerting(positionValueUsd, minPositionUsd)) continue;

          if (!shouldAlertVolumeDeath(this.lastAlertAt.get(p.id), now, cooldownMs)) continue;
          this.lastAlertAt.set(p.id, now);

          const symbol = p.symbol ?? snapshot.symbol;
          const data: JournalAlertData = {
            kind: 'volume_dying',
            mint,
            symbol,
            walletAddress: p.walletAddress,
            m5VolumeUsd: snapshot.windows.m5,
            h1VolumeUsd: snapshot.windows.h1,
            h6VolumeUsd: snapshot.windows.h6,
            m5RateVsH1: verdict.m5RateVsH1,
            h1RateVsH6: verdict.h1RateVsH6,
            positionValueUsd,
            triggeredAt: nowIso,
          };

          const sym = symbol ? `$${symbol}` : `${mint.slice(0, 6)}…`;
          console.log(
            `[JournalVolDeath] VOLUME DYING ${sym} (${mint.slice(0, 8)}…) ` +
              `m5/h1 ${verdict.m5RateVsH1.toFixed(2)} h1/h6 ${verdict.h1RateVsH6.toFixed(2)} ` +
              `held ${p.walletAddress.slice(0, 6)}… → user ${p.userId === LOCAL_USER_ID ? 'local' : p.userId.slice(0, 8)}`,
          );

          this.wsServer.sendToUser(p.userId, { type: 'journal_alert', data });
          void this.notifyPushover(p.userId, data, sym);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  /**
   * Auto-close one dead bag as a sale at ZERO proceeds.
   *
   * The close is applied by REBUILDING the wallet's episodes with the position
   * added to the abandoned map, not by patching the row: the FIFO engine owns
   * realized-PnL arithmetic, so the unrecovered cost is booked by the same lot
   * walk a real sell uses. `replaceJournalPositions` then persists
   * `close_reason='abandoned'`, which is what makes the close survive every
   * later rebuild (the ingestion poller and the summary route read it back).
   *
   * Logged ONCE at info: this is a state change that moves money in the
   * operator's realized numbers, unlike the silent dust-gate skip above.
   */
  private async closeAbandoned(
    p: PositionWithUser,
    reason: AbandonFireReason,
    positionValueUsd: number | null,
    nowIso: string,
  ): Promise<void> {
    if (this.abandonedThisProcess.has(p.id)) return;
    const storage = getStorageProvider();
    try {
      const closedRows = await storage.listJournalPositions(p.userId, 'closed');
      const abandoned = abandonedMapFromPositions(closedRows);
      if (abandoned.has(p.id)) return; // already recorded; nothing to do
      abandoned.set(p.id, nowIso);
      this.abandonedThisProcess.add(p.id);

      const trades = await storage.listJournalTrades(p.userId, REBUILD_TRADE_LIMIT, p.walletId);
      const { positions } = buildPositions(trades, { abandoned });
      await storage.replaceJournalPositions(p.userId, p.walletId, positions);

      const closed = positions.find((x) => x.id === p.id);
      const sym = p.symbol ? `$${p.symbol}` : `${p.mint.slice(0, 6)}…`;
      const value = positionValueUsd != null ? `~$${positionValueUsd.toFixed(2)}` : 'unknown value';
      console.log(
        `[JournalVolDeath] ABANDONED ${sym} (${p.mint.slice(0, 8)}…) reason=${reason} ` +
          `held ${p.walletAddress.slice(0, 6)}… ${value}, no trade since ${p.lastTradeAt} — ` +
          `closed at 0 proceeds, realized ${closed ? closed.realizedPnlSol.toFixed(3) : '?'} SOL ` +
          `(cost ${p.costSol.toFixed(3)} SOL) → user ${p.userId === LOCAL_USER_ID ? 'local' : p.userId.slice(0, 8)}`,
      );

      this.wsServer.sendToUser(p.userId, { type: 'journal_update', data: { walletId: p.walletId } });
    } catch (err) {
      console.warn('[JournalVolDeath] abandon close failed:', (err as Error)?.message);
    }
  }

  private async notifyPushover(userId: string, data: JournalAlertData, sym: string): Promise<void> {
    try {
      const config = await getStorageProvider().getConfig(userId);
      if (!config.pushover?.enabled) return;
      const held =
        data.positionValueUsd != null ? `, holding ~$${formatCompact(data.positionValueUsd)}` : '';
      // NORMAL priority, explicitly — never the user's configured priority and
      // never the emergency tier, which stays reserved for revival.
      await sendPushover(config.pushover, {
        title: `META DYING: ${sym} volume collapsing`,
        message:
          `${sym} volume is dying while you hold${held} — ` +
          `m5 rate ${(data.m5RateVsH1 * 100).toFixed(0)}% of h1, ` +
          `h1 rate ${(data.h1RateVsH6 * 100).toFixed(0)}% of h6 ` +
          `(h6 vol $${formatCompact(data.h6VolumeUsd)})`,
        url: `https://dexscreener.com/solana/${data.mint}`,
        urlTitle: 'Open chart',
        priority: 0,
      });
    } catch (err) {
      console.error('[JournalVolDeath] Pushover notify failed:', (err as Error)?.message);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let _poller: JournalVolumeDeathPoller | null = null;

export function startJournalVolumeDeathPoller(wsServer: WsServer): void {
  if (_poller) return;
  _poller = new JournalVolumeDeathPoller(wsServer);
  _poller.start();
}

export function stopJournalVolumeDeathPoller(): void {
  _poller?.stop();
  _poller = null;
}
