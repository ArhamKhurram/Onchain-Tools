/**
 * Revival ignition poller.
 *
 * Every OCT_REVIVAL_POLL_MS (default 5 min):
 * 1. Build the per-user token universe: contracts detected in the user's feed
 *    within the last 48h on any WATCHED chain (OCT_REVIVAL_NETWORKS; Solana +
 *    BNB + Robinhood by default), capped at 30/user.
 * 2. Dedupe tokens across users (each token is fetched/evaluated once per
 *    cycle, like the FOMO poller dedupes tracked traders). Both the per-user
 *    and the per-cycle caps are filled ROUND-ROBIN across chains so the
 *    Solana-dominated feed can't starve BNB/Robinhood out of the universe.
 * 3. Fetch minute + hour candles from GeckoTerminal and run the ATR-gate
 *    detector. Request pacing is NOT done here — candles.ts owns one global
 *    queue shared with the outcome tracker (see the request-budget note below).
 * 3b. Emit one coverage line per cycle (tokens scanned / universe size,
 *    requests spent, 429s absorbed, estimated full-sweep latency). Coverage
 *    loss used to be invisible: a rate-limited poller and a quiet market
 *    produce the same empty log.
 * 4. On ignition (subject to run-state suppression — see
 *    evaluateRunSuppression — with the 60-min per-token cooldown surviving
 *    only as a floor that saves the candle fetch): fan out a `revival_alert`
 *    WS frame to every subscribed user and send Pushover at EMERGENCY
 *    priority (2, retry 30s, expire 30min) — revival is the loudest alert
 *    class in the app; every other alert keeps its configured priority.
 *
 * Self-gates cleanly: local mode reads the JSON contract log (no Supabase
 * required); hosted mode reads the contracts table via the service client.
 * Suppression state is in-memory (v1, resets on reboot); fired alerts are persisted via the storage
 * provider (revival-alerts.json locally, revival_alerts in hosted mode) and
 * their outcomes tracked for 24h by RevivalOutcomeTracker — open windows are
 * resumed from storage on boot.
 *
 * Revival is its own signal end-to-end. It is never fused with convergence,
 * missed-runner, or FOMO detections.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { WsServer } from '../ws/server.js';
import type { RevivalAlertData, RevivalNetwork } from '@oct/shared';
import {
  REVIVAL_NETWORK_CHAIN_SLUGS,
  buildRevivalContractUrl,
  revivalNetworkForChain,
  revivalNetworkLabel,
} from '@oct/shared';
import { getStorageProvider, isHostedMode } from '../storage/index.js';
import { getFomoServiceClient } from '../fomo/store.js';
import { sendPushover } from '../utils/pushover.js';
import { formatCompact } from '../wallets/balanceChecker.js';
import { evaluateRevival } from './detector.js';
import {
  fetchRevivalCandles,
  isBackedOff,
  resolveRequestSpacingMs,
  revivalRequestCounters,
} from './candles.js';
import { resolveRevivalNetworks } from './networks.js';
import {
  buildAlertEntry,
  partitionOpenAlerts,
  OUTCOME_WINDOW_MS,
  RevivalOutcomeTracker,
} from './outcomeTracker.js';
import type { RevivalAlertEntry } from '@oct/shared';

const LOCAL_USER_ID = 'local';
export const DEFAULT_POLL_MS = 300_000; // 5 min
const UNIVERSE_LOOKBACK_MS = 48 * 3_600_000;
const MAX_TOKENS_PER_USER = 30;

// --- Repeat-alert suppression -------------------------------------------
// A fixed cooldown is the WRONG SHAPE for this signal. The original 60-min
// cooldown let a 6h run re-alert five more times, each one later and higher,
// because every detector gate stays satisfied mid-run (see detector.ts). What
// actually ends an alert's validity is not elapsed time, it is the token
// leaving the run state.
//
// So: once a token alerts it is suppressed until it has GENUINELY returned to
// dormancy — dormancy holds again AND price is back near a freshly computed
// baseline — or a long absolute ceiling elapses, whichever comes first. The
// short cooldown survives only as a floor, and only because it lets the poll
// loop skip the candle fetch entirely for the first hour (request budget).
/** Floor: never re-alert a token within this, and skip its fetch meanwhile. */
export const ALERT_COOLDOWN_MS = 60 * 60_000;
/** Ceiling: suppression lapses after this no matter what the token did. */
export const RUN_SUPPRESSION_CEILING_MS = 24 * 3_600_000;
/**
 * "Back near a fresh baseline": the token must be within this multiple of the
 * baseline computed from its NEW dormant window. A token still mid-run reads
 * between this and maxRunFromBaseline (3.0) — above 3.0 the detector never
 * fired in the first place.
 */
export const REENTRY_MAX_RUN_MULTIPLE = 1.5;

/** In-memory per-token suppression record (v1 — resets on reboot). */
export interface RunSuppression {
  /** Epoch ms of the alert that opened this suppression. */
  alertedAt: number;
}

export interface SuppressionDecision {
  suppress: boolean;
  reason: 'cooldown' | 'run-in-progress' | 'unknown-baseline' | null;
}

/**
 * Should this qualifying ignition be suppressed as a repeat of a run we have
 * already alerted on? Pure — the caller owns the state map.
 *
 * `runMultiple == null` (no usable baseline) is treated as NOT a proven return
 * to dormancy: the detector abstains from vetoing on a missing baseline, but
 * "we cannot tell" must not be enough to re-open the loudest alert in the app.
 */
export function evaluateRunSuppression(
  prior: RunSuppression | undefined,
  verdict: { dormant: boolean; runMultiple: number | null },
  now: number,
  opts: {
    cooldownMs?: number;
    ceilingMs?: number;
    reentryMaxRunMultiple?: number;
  } = {},
): SuppressionDecision {
  if (!prior) return { suppress: false, reason: null };

  const cooldownMs = opts.cooldownMs ?? ALERT_COOLDOWN_MS;
  const ceilingMs = opts.ceilingMs ?? RUN_SUPPRESSION_CEILING_MS;
  const reentry = opts.reentryMaxRunMultiple ?? REENTRY_MAX_RUN_MULTIPLE;

  const elapsed = now - prior.alertedAt;
  if (elapsed >= ceilingMs) return { suppress: false, reason: null };
  if (elapsed < cooldownMs) return { suppress: true, reason: 'cooldown' };

  if (!verdict.dormant) return { suppress: true, reason: 'run-in-progress' };
  if (verdict.runMultiple == null) return { suppress: true, reason: 'unknown-baseline' };
  if (verdict.runMultiple > reentry) return { suppress: true, reason: 'run-in-progress' };
  return { suppress: false, reason: null };
}

// --- Request budget -------------------------------------------------------
// Pacing itself lives in candles.ts (one global serial queue, 10s apart ≈ 6
// req/min — the MEASURED sustainable GeckoTerminal keyless rate, not the ~30
// req/min this subsystem was originally built around; see the measurement
// table in candles.ts). What lives HERE is the per-cycle token cap, which has
// to be sized so a cycle's requests fit inside the poll interval:
//
//   slots per cycle      = 300_000ms / 10_000ms        =  30 requests
//   reserved for the outcome tracker (shares the queue) =  3 requests
//   available to the poller                             =  27 requests
//   steady-state cost per token
//     minute candles, every cycle                       = 1
//   + hour candles, 45m cache / 5m cycle                ≈ 0.111
//   + pool resolution, 1h cache / 5m cycle              ≈ 0.083
//                                                       ≈ 1.19, budgeted 1.25
//   → 15 tokens × 1.25 ≈ 18.75 + 3 = 21.75 requests, ~73% of the interval.
//
// Full-sweep latency at 15 tokens per 5 minutes = 3 tokens/min:
//   30-token universe  → 2 cycles → ~10 min
//   37-token universe  → 3 cycles → ~15 min
//   100-token universe → 7 cycles → ~35 min
// The 100-token figure is close to the floor the API itself imposes: 100
// tokens × 1.19 req ≈ 119 requests, which at 6 req/min cannot be done in less
// than ~20 min by any config. Revival runs last tens of minutes to hours, so
// minutes of latency are acceptable; what is not acceptable is never reaching
// the tail of the universe at all (see seedRotationOffset).
//
// COLD START is the exception: with empty caches a token costs 3 requests
// (pool + minute + hour), so the first cycle after boot needs ~48 slots and
// spills ~3 min past the interval. That is harmless — the `polling` guard
// skips the overlapping tick and the caches are warm from the second cycle on.
//
// The real coverage limit is the global rate, not this cap: rotation (see
// selectCycleSlice) sweeps universes larger than the cap across cycles, so a
// smaller cap costs coverage LATENCY, never coverage.
export const MAX_TOKENS_PER_CYCLE = 15;
/** Steady-state GeckoTerminal requests per token per cycle (planning figure). */
export const STEADY_STATE_REQUESTS_PER_TOKEN = 1.25;
/** Cold-cache worst case: pool resolution + minute + hour. */
export const COLD_START_REQUESTS_PER_TOKEN = 3;
/**
 * Slots held back for RevivalOutcomeTracker, which shares the same queue. It
 * sweeps every 10 min and costs ~1-2 requests per open alert; 3 per 5-minute
 * cycle covers a handful of concurrently-tracked alerts.
 */
export const OUTCOME_TRACKER_RESERVED_REQUESTS = 3;

export interface RevivalCyclePlan {
  /** Requests the interval affords at the configured spacing. */
  slots: number;
  /** Steady-state requests a full cycle costs, tracker reserve included. */
  steadyStateRequests: number;
  /** Cold-cache requests a full cycle costs, tracker reserve included. */
  coldStartRequests: number;
  /** Requests/min the spacing implies — must stay under the API ceiling. */
  requestsPerMinute: number;
  /** Fraction of the interval a steady-state cycle consumes. */
  steadyStateUtilization: number;
}

/**
 * The pacing arithmetic above, as a function — so a future edit to the cap,
 * the interval or the spacing is checked by a test instead of silently
 * reintroducing the 429 storm. Every previous iteration of this config failed
 * the same way: over-budget pacing reads in the logs as "the signal is quiet"
 * rather than "we are rate-limited". That is also why the poller now emits a
 * coverage line every cycle (see summarizeCycle).
 */
export function planRevivalCycle(
  spacingMs: number,
  pollMs: number = DEFAULT_POLL_MS,
  tokensPerCycle: number = MAX_TOKENS_PER_CYCLE,
): RevivalCyclePlan {
  const slots = Math.floor(pollMs / spacingMs);
  return {
    slots,
    steadyStateRequests:
      tokensPerCycle * STEADY_STATE_REQUESTS_PER_TOKEN + OUTCOME_TRACKER_RESERVED_REQUESTS,
    coldStartRequests:
      tokensPerCycle * COLD_START_REQUESTS_PER_TOKEN + OUTCOME_TRACKER_RESERVED_REQUESTS,
    requestsPerMinute: 60_000 / spacingMs,
    steadyStateUtilization:
      (tokensPerCycle * STEADY_STATE_REQUESTS_PER_TOKEN + OUTCOME_TRACKER_RESERVED_REQUESTS) /
      slots,
  };
}

// --- Coverage reporting ----------------------------------------------------

export interface RevivalCycleSummary {
  /** Tokens eligible this cycle across every watched chain. */
  universeSize: number;
  /** Tokens this cycle actually attempted a candle fetch for. */
  scanned: number;
  /** GeckoTerminal requests the cycle consumed (retries included). */
  requests: number;
  /** Responses that came back 429 during the cycle. */
  rateLimited: number;
  /** Estimated wall time for one full pass over the universe, or null when
   *  the cycle scanned nothing and no honest estimate exists. */
  fullSweepMs: number | null;
  /** True when the safety-valve backoff cut the cycle short. */
  pausedEarly: boolean;
}

/**
 * Per-cycle coverage arithmetic. Pure so the numbers the operator reads during
 * a data-collection bake are unit-tested rather than assembled inline.
 *
 * The sweep estimate deliberately extrapolates from `scanned`, not from the
 * configured cap: a cycle that got rate-limited into scanning 4 tokens should
 * report the slow sweep it is actually achieving, not the fast one the config
 * hoped for. Scanning nothing yields null rather than a fabricated number —
 * silence must not be mistakable for coverage.
 */
export function summarizeCycle(input: {
  universeSize: number;
  scanned: number;
  requests: number;
  rateLimited: number;
  pollMs: number;
  pausedEarly: boolean;
}): RevivalCycleSummary {
  const { universeSize, scanned, requests, rateLimited, pollMs, pausedEarly } = input;
  const cyclesForSweep = scanned > 0 ? Math.ceil(universeSize / scanned) : null;
  return {
    universeSize,
    scanned,
    requests,
    rateLimited,
    fullSweepMs: cyclesForSweep != null ? cyclesForSweep * pollMs : null,
    pausedEarly,
  };
}

/** One-line, info-level rendering of the summary above. */
export function formatCycleSummary(s: RevivalCycleSummary): string {
  const sweep =
    s.fullSweepMs != null ? `full sweep ~${Math.round(s.fullSweepMs / 60_000)}min` : 'full sweep STALLED';
  const paused = s.pausedEarly ? ', paused early (rate-limit backoff)' : '';
  return (
    `[RevivalPoller] cycle: ${s.scanned}/${s.universeSize} tokens scanned, ` +
    `${s.requests} requests, ${s.rateLimited} rate-limited, ${sweep}${paused}`
  );
}

/**
 * Where a chain's rotation pointer starts on a fresh process.
 *
 * The pointers are in-memory (a persisted cursor would mean a new table in two
 * storage backends for one integer per chain). On its own that is a fairness
 * bug: Railway redeploys often, the universe is ordered newest-first, and a
 * pointer that resets to 0 every boot means the head of the universe is
 * re-scanned forever while the tail is never reached.
 *
 * Deriving the FIRST offset from wall-clock time fixes that for free. The
 * cursor advances at exactly the rate a continuously-running process would
 * have advanced it, so a restart resumes roughly where the old process was
 * instead of at zero — no persistence, no I/O, no new schema. Subsequent
 * cycles advance the pointer incrementally as before, which is what keeps it
 * correct when the universe changes size mid-run.
 */
export function seedRotationOffset(
  keyCount: number,
  cap: number = MAX_TOKENS_PER_CYCLE,
  pollMs: number = DEFAULT_POLL_MS,
  now: number = Date.now(),
): number {
  if (keyCount <= 0 || cap <= 0 || pollMs <= 0) return 0;
  return (Math.floor(now / pollMs) * cap) % keyCount;
}

function envFlag(name: string): string | undefined {
  return process.env[`OCT_${name}`] ?? process.env[`TRENCHCORD_${name}`];
}

export function isRevivalEnabled(): boolean {
  const v = (envFlag('REVIVAL_ENABLED') ?? '').trim().toLowerCase();
  // Default ON in both modes; only an explicit falsy value disables.
  return !(v === 'false' || v === '0' || v === 'off');
}

/**
 * Floor raised from 30s to 60s alongside the pacing recalibration: at 10s
 * spacing a 30-second cycle affords 3 requests, which cannot complete a single
 * token's cold fetch.
 */
function resolvePollMs(): number {
  const parsed = Number.parseInt(envFlag('REVIVAL_POLL_MS') ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 60_000 ? parsed : DEFAULT_POLL_MS;
}

/** One watched token: an address ON a specific chain, plus who wants it. */
export interface UniverseEntry {
  address: string;
  network: RevivalNetwork;
  subscribers: Set<string>;
}

/** `network:address` → entry. The network is part of the key: the same 0x
 * contract can exist on two chains and they are different tokens. */
export type RevivalUniverse = Map<string, UniverseEntry>;

export function universeKey(network: RevivalNetwork, address: string): string {
  return `${network}:${address}`;
}

export interface UserContractRow {
  userId: string;
  address: string;
  network: RevivalNetwork;
  timestamp: string;
}

/**
 * Per-user cap + cross-user dedupe.
 *
 * Rows must be sorted newest-first. The per-user cap is filled ROUND-ROBIN
 * across chains rather than straight down the recency list: OCT's feed is
 * overwhelmingly Solana, so "the 30 most recent contracts" would in practice
 * be 30 Solana mints and a BNB/Robinhood revival could never enter the
 * universe. Round-robin gives each chain an equal claim on the cap while
 * letting a busy chain absorb the slack an idle one leaves (30 tokens with
 * only 2 Robinhood contracts = 2 Robinhood + 28 split across the rest), and
 * within each chain recency still decides.
 */
export function buildUniverse(
  rows: UserContractRow[],
  maxPerUser: number = MAX_TOKENS_PER_USER,
): RevivalUniverse {
  // userId → network → ordered, deduped keys (recency preserved).
  const perUser = new Map<string, Map<RevivalNetwork, string[]>>();
  const seenPerUser = new Map<string, Set<string>>();
  const meta = new Map<string, { address: string; network: RevivalNetwork }>();

  for (const row of rows) {
    const key = universeKey(row.network, row.address);
    let seen = seenPerUser.get(row.userId);
    if (!seen) {
      seen = new Set();
      seenPerUser.set(row.userId, seen);
    }
    if (seen.has(key)) continue;
    seen.add(key);
    meta.set(key, { address: row.address, network: row.network });

    let byNetwork = perUser.get(row.userId);
    if (!byNetwork) {
      byNetwork = new Map();
      perUser.set(row.userId, byNetwork);
    }
    const list = byNetwork.get(row.network) ?? [];
    list.push(key);
    byNetwork.set(row.network, list);
  }

  const universe: RevivalUniverse = new Map();
  for (const [userId, byNetwork] of perUser) {
    const lists = [...byNetwork.values()];
    const taken = new Array<number>(lists.length).fill(0);
    let picked = 0;
    let progressed = true;
    while (picked < maxPerUser && progressed) {
      progressed = false;
      for (let i = 0; i < lists.length && picked < maxPerUser; i++) {
        if (taken[i] >= lists[i].length) continue;
        const key = lists[i][taken[i]];
        taken[i] += 1;
        picked += 1;
        progressed = true;

        const existing = universe.get(key);
        if (existing) {
          existing.subscribers.add(userId);
        } else {
          const m = meta.get(key)!;
          universe.set(key, {
            address: m.address,
            network: m.network,
            subscribers: new Set([userId]),
          });
        }
      }
    }
  }
  return universe;
}

export interface NetworkRotation {
  network: RevivalNetwork;
  keys: string[];
  /** Index into `keys` this cycle starts at (rotates across cycles). */
  offset: number;
}

/**
 * Pick this cycle's tokens, round-robin across chains, each chain resuming
 * where it left off last cycle.
 *
 * Two properties matter and both need the per-network offsets:
 * - fairness WITHIN a cycle — a chain with 200 tokens can't consume the whole
 *   40-token budget and hide a 3-token chain;
 * - full coverage ACROSS cycles — each chain's own pointer walks its own list,
 *   so a big Solana universe is still swept end to end, just interleaved.
 *
 * Returns the selected keys plus the advanced offsets (pure — the caller
 * stores them).
 */
export function selectCycleSlice(
  rotations: NetworkRotation[],
  cap: number,
): { selected: string[]; offsets: Map<RevivalNetwork, number> } {
  const taken = new Array<number>(rotations.length).fill(0);
  const selected: string[] = [];
  let progressed = true;
  while (selected.length < cap && progressed) {
    progressed = false;
    for (let i = 0; i < rotations.length && selected.length < cap; i++) {
      const r = rotations[i];
      if (r.keys.length === 0 || taken[i] >= r.keys.length) continue;
      const idx = (r.offset + taken[i]) % r.keys.length;
      selected.push(r.keys[idx]);
      taken[i] += 1;
      progressed = true;
    }
  }

  const offsets = new Map<RevivalNetwork, number>();
  for (let i = 0; i < rotations.length; i++) {
    const r = rotations[i];
    offsets.set(r.network, r.keys.length > 0 ? (r.offset + taken[i]) % r.keys.length : 0);
  }
  return { selected, offsets };
}

class RevivalPoller {
  private wsServer: WsServer;
  private db: SupabaseClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private polling = false;
  /** `network:address` → run-state suppression (in-memory v1; resets on reboot).
   *  Subsumes the old per-token cooldown map — the 60-min floor is one of the
   *  reasons evaluateRunSuppression can return, not a separate mechanism. */
  private suppression = new Map<string, RunSuppression>();
  /** Per-network rotation pointers so every chain is fully covered over time.
   *  Absent on the first cycle — seeded from wall clock, see seedRotationOffset. */
  private rotationOffsets = new Map<RevivalNetwork, number>();
  /** Resolved once at start(); the cycle summary reports against it. */
  private pollMs = DEFAULT_POLL_MS;
  /** 24h peak tracking for fired alerts (slow cadence, write-on-improvement). */
  private outcomes = new RevivalOutcomeTracker();

  constructor(wsServer: WsServer) {
    this.wsServer = wsServer;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    if (!isRevivalEnabled()) {
      console.log('[RevivalPoller] Disabled via OCT_REVIVAL_ENABLED; poller idle.');
      return;
    }
    if (isHostedMode()) {
      this.db = getFomoServiceClient();
      if (!this.db) {
        console.log('[RevivalPoller] Hosted mode without Supabase service client; poller idle.');
        return;
      }
    }

    const interval = resolvePollMs();
    this.pollMs = interval;
    const plan = planRevivalCycle(resolveRequestSpacingMs(), interval, MAX_TOKENS_PER_CYCLE);
    console.log(
      `[RevivalPoller] Started (interval ${interval}ms, cap ${MAX_TOKENS_PER_CYCLE} tokens/cycle, ` +
        `${plan.requestsPerMinute.toFixed(1)} req/min budget, ${Math.round(plan.steadyStateUtilization * 100)}% utilization, ` +
        `networks: ${resolveRevivalNetworks().join(', ')}).`,
    );
    this.outcomes.start();
    void this.resumeOpenOutcomes().catch((err) =>
      console.error('[RevivalPoller] outcome resume error:', (err as Error)?.message),
    );
    void this.poll().catch((err) => console.error('[RevivalPoller] initial poll error:', (err as Error)?.message));
    this.timer = setInterval(() => {
      void this.poll().catch((err) => console.error('[RevivalPoller] poll error:', (err as Error)?.message));
    }, interval);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.outcomes.stop();
  }

  /**
   * Boot resilience: reload alerts whose 24h outcome window is still open and
   * hand them back to the tracker (this is why peak state lives in the row,
   * not memory). Windows that expired during downtime get their close stamped
   * so the log never shows a permanent "tracking…".
   */
  private async resumeOpenOutcomes(): Promise<void> {
    const rows: (RevivalAlertEntry & { userId: string })[] = [];

    if (!isHostedMode()) {
      const entries = await getStorageProvider().listRevivalAlerts(LOCAL_USER_ID, 200);
      for (const e of entries) rows.push({ ...e, userId: LOCAL_USER_ID });
    } else {
      if (!this.db) return;
      const { data, error } = await this.db
        .from('revival_alerts')
        .select('*')
        .is('outcome_window_closed_at', null)
        .limit(500);
      if (error) {
        console.warn('[RevivalPoller] Open-outcome load failed:', error.message);
        return;
      }
      for (const r of (data ?? []) as any[]) {
        rows.push({
          id: r.id,
          mint: r.mint,
          symbol: r.symbol ?? null,
          network: r.network ?? 'solana',
          priceUsd: r.price_usd != null ? Number(r.price_usd) : null,
          mcapUsd: r.mcap_usd != null ? Number(r.mcap_usd) : null,
          atrZ: Number(r.atr_z ?? 0),
          rvol: Number(r.rvol ?? 0),
          baselinePriceUsd: r.baseline_price_usd != null ? Number(r.baseline_price_usd) : null,
          runMultiple: r.run_multiple != null ? Number(r.run_multiple) : null,
          triggeredAt: r.triggered_at,
          peakPriceUsd: r.peak_price_usd != null ? Number(r.peak_price_usd) : null,
          peakMcapUsd: r.peak_mcap_usd != null ? Number(r.peak_mcap_usd) : null,
          peakMultiple: r.peak_multiple != null ? Number(r.peak_multiple) : null,
          peakAt: r.peak_at ?? null,
          outcomeWindowClosedAt: r.outcome_window_closed_at ?? null,
          userId: r.user_id as string,
        });
      }
    }

    const { open, expired } = partitionOpenAlerts(rows, Date.now());
    for (const e of expired) {
      const closedAt = new Date(new Date(e.triggeredAt).getTime() + OUTCOME_WINDOW_MS).toISOString();
      try {
        await getStorageProvider().updateRevivalAlertOutcome(e.userId, e.id, {
          outcomeWindowClosedAt: closedAt,
        });
      } catch (err) {
        console.warn('[RevivalPoller] Failed to close expired outcome:', (err as Error)?.message);
      }
    }
    this.outcomes.resumeEntries(open.map((e) => ({ entry: e, userId: e.userId })));
  }

  private async loadUniverse(): Promise<RevivalUniverse> {
    const since = new Date(Date.now() - UNIVERSE_LOOKBACK_MS).toISOString();
    const enabled = new Set(resolveRevivalNetworks());
    if (enabled.size === 0) return new Map();

    if (!isHostedMode()) {
      const contracts = await getStorageProvider().getContracts(LOCAL_USER_ID, 500, since);
      const rows: UserContractRow[] = [];
      for (const c of contracts) {
        // Contracts whose chain hasn't resolved yet (EVM address, background
        // lookup pending) or whose chain we don't watch are simply skipped.
        const network = revivalNetworkForChain(c.chain, c.evmChain);
        if (!network || !enabled.has(network)) continue;
        rows.push({
          userId: LOCAL_USER_ID,
          address: c.address,
          network,
          timestamp: c.timestamp,
        });
      }
      rows.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      return buildUniverse(rows);
    }

    if (!this.db) return new Map();
    // Column-scoped read (mirrors the missed-runner poller's slim load): the
    // universe needs only user/address/chain/recency, never the message
    // payloads. The chain filter is pushed into the query so a Solana-heavy
    // feed doesn't crowd EVM rows out of the row limit.
    const orParts: string[] = [];
    if (enabled.has('solana')) orParts.push('chain.eq.sol');
    const evmSlugs = [...enabled]
      .filter((n) => n !== 'solana')
      .map((n) => REVIVAL_NETWORK_CHAIN_SLUGS[n]);
    if (evmSlugs.length > 0) orParts.push(`evm_chain.in.(${evmSlugs.join(',')})`);
    if (orParts.length === 0) return new Map();

    const { data, error } = await this.db
      .from('contracts')
      .select('user_id, address, chain, evm_chain, timestamp')
      .or(orParts.join(','))
      .gt('timestamp', since)
      .order('timestamp', { ascending: false })
      .limit(2000);
    if (error) {
      console.warn('[RevivalPoller] Universe load failed:', error.message);
      return new Map();
    }
    const rows: UserContractRow[] = [];
    for (const r of (data ?? []) as any[]) {
      const network = revivalNetworkForChain(r.chain, r.evm_chain);
      if (!network || !enabled.has(network)) continue;
      rows.push({
        userId: r.user_id as string,
        address: r.address as string,
        network,
        timestamp: r.timestamp as string,
      });
    }
    return buildUniverse(rows);
  }

  /**
   * Next up-to-cap window of tokens, round-robin across chains, advancing each
   * chain's own rotation pointer (see selectCycleSlice).
   */
  private nextSlice(universe: RevivalUniverse): string[] {
    const byNetwork = new Map<RevivalNetwork, string[]>();
    for (const [key, entry] of universe) {
      const list = byNetwork.get(entry.network) ?? [];
      list.push(key);
      byNetwork.set(entry.network, list);
    }
    const rotations: NetworkRotation[] = [...byNetwork].map(([network, keys]) => {
      // A chain we have no pointer for yet (first cycle of this process) starts
      // from the wall-clock-derived cursor, not from 0 — otherwise frequent
      // redeploys would re-scan the head of the universe forever.
      const stored = this.rotationOffsets.get(network);
      const offset =
        stored != null
          ? Math.min(stored, Math.max(keys.length - 1, 0))
          : seedRotationOffset(keys.length, MAX_TOKENS_PER_CYCLE, this.pollMs);
      return { network, keys, offset };
    });

    const { selected, offsets } = selectCycleSlice(rotations, MAX_TOKENS_PER_CYCLE);
    this.rotationOffsets = offsets;
    return selected;
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    const before = revivalRequestCounters();
    let scanned = 0;
    let pausedEarly = false;
    let universeSize = 0;
    try {
      const universe = await this.loadUniverse();
      universeSize = universe.size;
      if (universe.size === 0) return;

      const slice = this.nextSlice(universe);
      for (const key of slice) {
        // Only the hard safety valve can stop a cycle now. An ordinary 429 is
        // absorbed inside candles.ts (re-queue + widened spacing) and shows up
        // here only as a higher rate-limited count in the summary below.
        if (isBackedOff()) {
          pausedEarly = true;
          break;
        }
        const entry = universe.get(key);
        if (!entry || entry.subscribers.size === 0) continue;

        // Cheap pre-fetch skip only. The real control (run-state suppression)
        // needs the verdict, so it runs after evaluation in evaluateToken;
        // this floor just spares the candle request during the first hour.
        const prior = this.suppression.get(key);
        if (prior != null && Date.now() - prior.alertedAt < ALERT_COOLDOWN_MS) continue;

        // No sleep here: candles.ts owns the request spacing for every revival
        // consumer. Pacing in both places is what let the poller and the
        // outcome tracker each stay "under the limit" while their SUM was not.
        scanned += 1;
        try {
          await this.evaluateToken(key, entry);
        } catch (err) {
          console.warn(`[RevivalPoller] evaluate failed for ${key.slice(0, 20)}…:`, (err as Error)?.message);
        }
      }
    } finally {
      this.polling = false;
      // Emitted on EVERY cycle, including empty and cut-short ones. During a
      // multi-day bake this line is the only thing that distinguishes "the
      // universe is quiet" from "we are only reaching a third of it".
      if (universeSize > 0) {
        const after = revivalRequestCounters();
        console.log(
          formatCycleSummary(
            summarizeCycle({
              universeSize,
              scanned,
              requests: after.sent - before.sent,
              rateLimited: after.rateLimited - before.rateLimited,
              pollMs: this.pollMs,
              pausedEarly,
            }),
          ),
        );
      }
    }
  }

  private async evaluateToken(key: string, target: UniverseEntry): Promise<void> {
    const { address: mint, network, subscribers } = target;
    const candles = await fetchRevivalCandles(network, mint);
    if (!candles) return;

    const now = Date.now();
    const verdict = evaluateRevival(candles.minute, candles.hour, now);
    if (!verdict.fired) return;

    // Repeat suppression: is this a fresh ignition, or the same run we already
    // alerted on still satisfying every gate?
    const decision = evaluateRunSuppression(this.suppression.get(key), verdict, now);
    if (decision.suppress) {
      if (decision.reason !== 'cooldown') {
        console.log(
          `[RevivalPoller] Suppressed repeat ignition for ${key.slice(0, 24)}… (${decision.reason}, run ${verdict.runMultiple?.toFixed(2) ?? '?'}x).`,
        );
      }
      return;
    }

    this.suppression.set(key, { alertedAt: now });

    const price = verdict.price;
    const mcapUsd =
      price != null && candles.pool.impliedSupply != null
        ? price * candles.pool.impliedSupply
        : null;
    const data: RevivalAlertData = {
      mint,
      network,
      symbol: candles.pool.symbol,
      price,
      mcapUsd,
      atrZ: verdict.atrZ ?? 0,
      rvol: verdict.rvol ?? 0,
      baselinePrice: verdict.baselinePrice,
      runMultiple: verdict.runMultiple,
      triggeredAt: new Date(now).toISOString(),
    };

    const sym = data.symbol ? `$${data.symbol}` : `${mint.slice(0, 6)}…`;
    console.log(
      `[RevivalPoller] IGNITION ${sym} on ${revivalNetworkLabel(network)} (${mint.slice(0, 8)}…) atrZ=${data.atrZ.toFixed(1)} rvol=${data.rvol.toFixed(1)} run=${data.runMultiple != null ? `${data.runMultiple.toFixed(2)}x` : '?'} → ${subscribers.size} user(s)`,
    );

    for (const userId of subscribers) {
      // Persist before broadcast so a client refetching the revival log on
      // frame arrival always finds the row. A storage failure never blocks
      // the live alert — the broadcast/pushover fan-out still runs.
      try {
        const entry = buildAlertEntry(data);
        await getStorageProvider().logRevivalAlert(userId, entry);
        this.outcomes.track({
          alertId: entry.id,
          userId,
          mint: entry.mint,
          network,
          alertPriceUsd: entry.priceUsd,
          peakPriceUsd: entry.peakPriceUsd,
          triggeredAtMs: now,
        });
      } catch (err) {
        console.error('[RevivalPoller] Failed to persist alert:', (err as Error)?.message);
      }
      this.wsServer.broadcastRevivalAlert(data, userId);
      void this.notifyPushover(userId, data, sym);
    }
  }

  private async notifyPushover(userId: string, data: RevivalAlertData, sym: string): Promise<void> {
    try {
      const config = await getStorageProvider().getConfig(userId);
      if (!config.pushover?.enabled) return;
      const mc = data.mcapUsd != null ? formatCompact(data.mcapUsd) : '—';
      // Chain-aware link: a BNB or Robinhood revival must not open on the EVM
      // template's default chain (Base).
      const url = buildRevivalContractUrl(data.mint, data.network, config.contractLinkTemplates);
      const chain = revivalNetworkLabel(data.network);
      // EMERGENCY tier is reserved for revival: re-alerts every 30s for 30min
      // until acknowledged. Every other alert keeps the user's configured
      // priority — only revival overrides it.
      await sendPushover(config.pushover, {
        title: `REVIVAL: ${sym} igniting on ${chain}`,
        message: `${sym} igniting on ${chain} — mcap ${mc}, RVOL ${data.rvol.toFixed(1)}x, ATR z ${data.atrZ.toFixed(1)}`,
        url,
        urlTitle: 'Open token',
        priority: 2,
        retry: 30,
        expire: 1800,
      });
    } catch (err) {
      console.error('[RevivalPoller] Pushover notify failed:', (err as Error)?.message);
    }
  }
}

let _poller: RevivalPoller | null = null;

export function startRevivalPoller(wsServer: WsServer): void {
  if (_poller) return;
  _poller = new RevivalPoller(wsServer);
  _poller.start();
}

export function stopRevivalPoller(): void {
  _poller?.stop();
  _poller = null;
}
