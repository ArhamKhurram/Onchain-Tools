/**
 * Daily signal digest DMs — opt-in only.
 *
 * Once a day (OCT_DIGEST_HOUR_UTC, default 13:00 UTC) every linked user who
 * enabled the `dailyDigest` trigger gets ONE DM summarizing their last 24h:
 *
 *   • Revival alerts they received: symbol, chain, MC at alert, and the peak
 *     multiple so far for each outcome window (closed or still tracking) —
 *     read per user through the storage provider, the same rows the revival
 *     subsystem itself writes. Zero alerts is said out loud ("Quiet night"),
 *     never silently skipped.
 *   • Top pump.fun callouts of the day: the most recent callouts by callers on
 *     the Top Callers board (the same operator-controlled caller set the public
 *     callout channel uses — see calloutDiscord.ts). The persisted callout
 *     store (pump_callout_observations) deliberately keeps no coin/mcap
 *     columns, so this section reads a bounded slice of the live recent feed
 *     at digest time instead; MC-at-call comes straight off the feed row.
 *   • Caller-board movers: top 3 callers by call count in the window via the
 *     pump_top_callers_window RPC (one cheap grouped read). If that windowed
 *     read fails, the all-time board is shown labelled "current top callers" —
 *     honesty over cleverness.
 *
 * The three sections are independent signals routed into one message; nothing
 * here fuses their detections (repo rule: signals stay independent).
 *
 * Discipline mirrors releaseNotes.ts, the existing DM broadcast: sequential
 * sends with a floor gap, 429 retry-after handling, a hard recipient cap, and
 * a per-user failure (closed DMs, no shared server) that logs once and never
 * aborts the loop. The scheduler self-gates like every background subsystem:
 * without Supabase (local mode) or a bot token it logs one line and stays idle.
 */

import type { Client } from 'discord.js';
import type { RevivalAlertEntry } from '@oct/shared';
import { revivalNetworkLabel } from '@oct/shared';
import { getFomoServiceClient } from '../fomo/store.js';
import { getStorageProvider } from '../storage/index.js';
import { getBotClient, isBotEnabled } from './index.js';
import { resolveDiscordIdByOctUser } from './identity.js';
import {
  botFooter,
  compactUsd,
  makeContainer,
  makeSeparator,
  makeText,
  shortAddress,
} from './layout.js';
import { DM_INTERVAL_MS, MAX_RECIPIENTS, retryDelayMs } from './releaseNotes.js';
import {
  getPumpCalloutFeedClient,
  type CalloutCoin,
  type CalloutUser,
  type RecentCallout,
} from '../pumpfun/calloutFeedClient.js';
import {
  topCallersAllTime,
  topCallersWindowed,
  type BoardCaller,
} from '../pumpfun/callerBoardStore.js';
import { resolveCalloutDiscordConfig } from '../pumpfun/calloutDiscord.js';

/** Discord's "cannot send messages to this user". */
const DISCORD_CANNOT_DM = 50007;

/**
 * Digest accent: a neutral dark slate. Digests are their own message class —
 * deliberately NOT the changelog red (SITE_ACCENT) and NOT the callout gold.
 */
export const DIGEST_ACCENT = 0x2b2d31;

export const DEFAULT_DIGEST_HOUR_UTC = 13;
export const DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;
const DAY_MS = DIGEST_WINDOW_MS;

/** Cap the alert list so one loud night can't blow the component size limit. */
export const MAX_ALERT_LINES = 8;
export const TOP_CALLOUTS_CAP = 3;
export const TOP_CALLERS_CAP = 3;

// The live-feed slice the callout section may read per run. 5×30 = 150 rows,
// newest first — since the section wants the newest 3 matches, shallow paging
// biased toward "recent" is exactly right, and the work stays bounded.
const FEED_PAGE_LIMIT = 30;
const FEED_MAX_PAGES = 5;

// --- Config ----------------------------------------------------------------

/** `OCT_DIGEST_HOUR_UTC` with the repo-standard `TRENCHCORD_*` fallback.
 *  Anything that isn't an integer 0–23 falls back to the default. */
export function resolveDigestHourUtc(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OCT_DIGEST_HOUR_UTC ?? env.TRENCHCORD_DIGEST_HOUR_UTC;
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : DEFAULT_DIGEST_HOUR_UTC;
}

// --- Pure scheduling / window math (no Date.now() in here) -----------------

/** The 24h window a digest fired at `fireAtMs` covers: [start, end). */
export function digestWindow(fireAtMs: number): { startMs: number; endMs: number } {
  return { startMs: fireAtMs - DIGEST_WINDOW_MS, endMs: fireAtMs };
}

/**
 * Milliseconds until the next occurrence of `hourUtc`:00 UTC STRICTLY after
 * `nowMs`. At exactly the hour this returns a full day — the caller has just
 * fired (or just booted on the boundary) and must not fire twice.
 */
export function msUntilNextDigestFire(nowMs: number, hourUtc: number): number {
  const now = new Date(nowMs);
  const todayFire = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hourUtc,
    0,
    0,
    0,
  );
  return todayFire > nowMs ? todayFire - nowMs : todayFire + DAY_MS - nowMs;
}

// --- Opt-in (mirrors isReleaseNotesOptIn: settings is an untyped blob) ------

/** Both gates must pass: the DM master switch AND the dailyDigest trigger. */
export function isDailyDigestOptIn(settings: unknown): boolean {
  if (!settings || typeof settings !== 'object') return false;
  const dm = (settings as Record<string, unknown>).discordBotDm;
  if (!dm || typeof dm !== 'object') return false;
  const prefs = dm as { enabled?: unknown; triggers?: unknown };
  if (prefs.enabled !== true) return false;
  if (!prefs.triggers || typeof prefs.triggers !== 'object') return false;
  return (prefs.triggers as Record<string, unknown>).dailyDigest === true;
}

interface UserConfigRow {
  user_id: string;
  settings: unknown;
}

/** OCT user ids that opted into the digest, capped at MAX_RECIPIENTS. */
export function selectDigestOptIns(rows: UserConfigRow[]): { userIds: string[]; truncated: boolean } {
  const all = rows.filter((r) => isDailyDigestOptIn(r.settings)).map((r) => r.user_id);
  return { userIds: all.slice(0, MAX_RECIPIENTS), truncated: all.length > MAX_RECIPIENTS };
}

// --- Pure data assembly -----------------------------------------------------

/** Alerts triggered inside [startMs, endMs), newest first. */
export function selectWindowAlerts(
  entries: RevivalAlertEntry[],
  windowStartMs: number,
  windowEndMs: number,
): RevivalAlertEntry[] {
  return entries
    .filter((e) => {
      const t = new Date(e.triggeredAt).getTime();
      return Number.isFinite(t) && t >= windowStartMs && t < windowEndMs;
    })
    .sort((a, b) => new Date(b.triggeredAt).getTime() - new Date(a.triggeredAt).getTime());
}

/**
 * The digest's callout picks: feed rows inside the window whose caller is in
 * the allowed (Top Callers) set, newest first, capped. Rows without a
 * timestamp can't be placed in the window and are dropped.
 */
export function selectWindowCallouts(
  callouts: RecentCallout[],
  allowed: ReadonlySet<string>,
  windowStartMs: number,
  windowEndMs: number,
  cap: number = TOP_CALLOUTS_CAP,
): RecentCallout[] {
  return callouts
    .filter(
      (c) =>
        c.createdAt != null &&
        c.createdAt >= windowStartMs &&
        c.createdAt < windowEndMs &&
        allowed.has(c.callerAddress),
    )
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .slice(0, cap);
}

/** One enriched callout line, ready to render. */
export interface DigestCallout {
  callerAddress: string;
  callerName: string | null;
  mint: string;
  symbol: string | null;
  marketCapUsd: number | null;
}

export interface DigestTopCallers {
  callers: BoardCaller[];
  /** 'window' = real 24h read; 'all_time' = fallback, labelled honestly. */
  source: 'window' | 'all_time';
}

export interface DigestRenderInput {
  /** End of the covered window (the fire moment). */
  windowEndMs: number;
  /** This user's revival alerts inside the window, newest first. */
  alerts: RevivalAlertEntry[];
  /** Global callout picks; null = the feed was unavailable this run. */
  callouts: DigestCallout[] | null;
  /** Global caller-board movers; null = the board was unavailable this run. */
  topCallers: DigestTopCallers | null;
}

function alertLine(e: RevivalAlertEntry): string {
  const sym = e.symbol ? `$${e.symbol.replace(/^\$/, '')}` : `\`${shortAddress(e.mint)}\``;
  const chain = revivalNetworkLabel(e.network);
  const mc = e.mcapUsd != null ? compactUsd(e.mcapUsd) : '—';
  const peak = e.peakMultiple != null ? `${e.peakMultiple.toFixed(2)}×` : '—';
  const status = e.outcomeWindowClosedAt != null ? '24h peak' : 'peak so far';
  return `**${sym}** · ${chain} · MC at alert ${mc} · ${status} ${peak}`;
}

function calloutLine(c: DigestCallout): string {
  const who = c.callerName?.trim() || `\`${shortAddress(c.callerAddress)}\``;
  const coin = c.symbol ? `$${c.symbol.replace(/^\$/, '')}` : `\`${shortAddress(c.mint)}\``;
  const mc = c.marketCapUsd != null ? compactUsd(c.marketCapUsd) : '—';
  return `**${who}** → ${coin} · MC at call ${mc}`;
}

function callerLine(c: BoardCaller, rank: number, source: DigestTopCallers['source']): string {
  const who = c.username?.trim() || `\`${shortAddress(c.callerAddress)}\``;
  const calls = `${c.calloutCount} call${c.calloutCount === 1 ? '' : 's'}`;
  return `${rank}. **${who}** — ${source === 'all_time' ? `${calls} all-time` : calls}`;
}

/**
 * Render one digest as a branded Components V2 container (neutral dark accent
 * — its own message class, distinct from alerts, callouts and announcements).
 */
export function buildDigestComponents(input: DigestRenderInput): unknown[] {
  const { alerts, callouts, topCallers } = input;
  const body: unknown[] = [
    makeText('# 📊 OCT daily digest'),
    makeText(`-# Your last 24h of signals · <t:${Math.floor(input.windowEndMs / 1000)}:f>`),
    makeSeparator(1),
  ];

  // Revival alerts — a zero day is said in one line, never skipped silently.
  if (alerts.length === 0) {
    body.push(makeText('**Revival alerts**\nQuiet night — 0 revival alerts.'));
  } else {
    const shown = alerts.slice(0, MAX_ALERT_LINES);
    const lines = shown.map(alertLine);
    if (alerts.length > shown.length) {
      lines.push(`-# +${alerts.length - shown.length} more alert(s) not shown`);
    }
    const plural = alerts.length === 1 ? 'alert' : 'alerts';
    body.push(makeText(`**Revival alerts — ${alerts.length} ${plural}**\n${lines.join('\n')}`));
  }

  body.push(makeSeparator(1));
  if (callouts === null) {
    body.push(makeText('**Top pump.fun callouts**\n-# Callout feed unavailable today.'));
  } else if (callouts.length === 0) {
    body.push(makeText('**Top pump.fun callouts**\n-# No callouts from top callers in this window.'));
  } else {
    body.push(makeText(`**Top pump.fun callouts**\n${callouts.map(calloutLine).join('\n')}`));
  }

  body.push(makeSeparator(1));
  if (topCallers === null) {
    body.push(makeText('**Top callers**\n-# Caller board unavailable today.'));
  } else {
    // The windowed read gets the real label; the all-time fallback says what
    // it actually is rather than pretending to be a 24h read.
    const heading = topCallers.source === 'window' ? '**Top callers (24h)**' : '**Current top callers**';
    const rows =
      topCallers.callers.length === 0
        ? '-# No caller activity recorded.'
        : topCallers.callers
            .slice(0, TOP_CALLERS_CAP)
            .map((c, i) => callerLine(c, i + 1, topCallers.source))
            .join('\n');
    body.push(makeText(`${heading}\n${rows}`));
  }

  body.push(makeText(botFooter('Daily digest · manage in OCT → Settings → Discord Bot')));
  return [makeContainer(DIGEST_ACCENT, body)];
}

// --- Delivery ---------------------------------------------------------------

export interface DigestRunResult {
  eligible: number;
  delivered: number;
  /** Users who can't be DMed (closed DMs / no shared server). Not a failure. */
  blocked: number;
  failed: number;
  truncated: boolean;
}

/** Seams for tests; realDigestDeps wires the live implementations. */
export interface DailyDigestDeps {
  getClient: () => Client | null;
  loadOptIns: () => Promise<{ userIds: string[]; truncated: boolean }>;
  listAlerts: (userId: string) => Promise<RevivalAlertEntry[]>;
  /** Newest-first recent-feed slice reaching back to (about) windowStartMs. */
  loadRecentCallouts: (windowStartMs: number) => Promise<RecentCallout[]>;
  /** The operator-controlled caller set the callout section filters by. */
  loadBoardAddresses: () => Promise<string[]>;
  loadTopCallers: () => Promise<DigestTopCallers>;
  resolveDiscordId: (octUserId: string) => Promise<string | null>;
  resolveUsers: (addresses: string[]) => Promise<Map<string, CalloutUser>>;
  resolveCoins: (mints: string[]) => Promise<Map<string, CalloutCoin>>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const realDigestDeps: DailyDigestDeps = {
  getClient: getBotClient,
  loadOptIns: async () => {
    const db = getFomoServiceClient();
    if (!db) return { userIds: [], truncated: false };
    const { data, error } = await db.from('user_configs').select('user_id, settings');
    if (error) {
      console.warn('[DailyDigest] Failed to load user configs:', error.message);
      return { userIds: [], truncated: false };
    }
    return selectDigestOptIns((data ?? []) as UserConfigRow[]);
  },
  // The same rows the revival subsystem reads/writes, via the storage provider.
  listAlerts: (userId) => getStorageProvider().listRevivalAlerts(userId, 100),
  loadRecentCallouts: async (windowStartMs) => {
    const client = getPumpCalloutFeedClient();
    const out: RecentCallout[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < FEED_MAX_PAGES; page++) {
      const { callouts, nextPageToken } = await client.getRecentCallouts(FEED_PAGE_LIMIT, pageToken);
      if (callouts.length === 0) break;
      out.push(...callouts);
      const oldest = callouts[callouts.length - 1]?.createdAt;
      if (!nextPageToken || (oldest != null && oldest < windowStartMs)) break;
      pageToken = nextPageToken;
    }
    return out;
  },
  loadBoardAddresses: async () => {
    // Same caller-set resolution as the public callout channel: the operator
    // allowlist when set, else the global Top Callers board slice. The follow
    // graph (pump_tracked_callers) is deliberately never read here.
    const cfg = resolveCalloutDiscordConfig();
    if (cfg.allowlist) return [...cfg.allowlist];
    const rows = await topCallersWindowed(cfg.boardWindowMs, 'count', cfg.boardMinCalls, cfg.boardLimit);
    return rows.map((r) => r.callerAddress);
  },
  loadTopCallers: async () => {
    try {
      const callers = await topCallersWindowed(DIGEST_WINDOW_MS, 'count', 1, TOP_CALLERS_CAP);
      return { callers, source: 'window' };
    } catch (err) {
      console.warn(
        '[DailyDigest] Windowed caller board read failed; falling back to all-time:',
        (err as Error)?.message,
      );
      const callers = await topCallersAllTime('count', 1, TOP_CALLERS_CAP);
      return { callers, source: 'all_time' };
    }
  },
  resolveDiscordId: resolveDiscordIdByOctUser,
  resolveUsers: (addresses) => getPumpCalloutFeedClient().resolveUsers(addresses),
  resolveCoins: (mints) => getPumpCalloutFeedClient().resolveCoins(mints),
  now: () => Date.now(),
  sleep,
};

/** Build the global callout section once per run (it is not per-user data). */
async function loadTopCallouts(
  deps: DailyDigestDeps,
  windowStartMs: number,
  windowEndMs: number,
): Promise<DigestCallout[]> {
  const allowed = new Set(await deps.loadBoardAddresses());
  if (allowed.size === 0) return [];
  const recent = await deps.loadRecentCallouts(windowStartMs);
  const picked = selectWindowCallouts(recent, allowed, windowStartMs, windowEndMs);
  if (picked.length === 0) return [];

  // Identity/ticker enrichment is decorative — never fail the section over it.
  const [users, coins] = await Promise.all([
    deps.resolveUsers([...new Set(picked.map((c) => c.callerAddress))]).catch(() => new Map<string, CalloutUser>()),
    deps.resolveCoins([...new Set(picked.map((c) => c.coinMint))]).catch(() => new Map<string, CalloutCoin>()),
  ]);
  return picked.map((c) => ({
    callerAddress: c.callerAddress,
    callerName: users.get(c.callerAddress)?.username ?? null,
    mint: c.coinMint,
    symbol: coins.get(c.coinMint)?.symbol ?? null,
    marketCapUsd: c.marketCapUsd,
  }));
}

/**
 * Compose and DM the digest to every opted-in linked user. Never throws: each
 * global section degrades to an honest "unavailable" line, and a per-user
 * delivery failure logs once and moves on. Returns counts so the caller can
 * report what actually happened.
 */
export async function runDailyDigest(deps: DailyDigestDeps = realDigestDeps): Promise<DigestRunResult> {
  const result: DigestRunResult = { eligible: 0, delivered: 0, blocked: 0, failed: 0, truncated: false };

  const client = deps.getClient();
  if (!client) {
    // Bot configured but not (yet) connected — skip this fire, keep the schedule.
    console.log('[DailyDigest] Bot client not connected; skipping this run.');
    return result;
  }

  const { userIds, truncated } = await deps.loadOptIns();
  result.eligible = userIds.length;
  result.truncated = truncated;
  if (truncated) {
    console.warn(`[DailyDigest] Recipient list capped at ${MAX_RECIPIENTS}; some opt-ins were skipped.`);
  }
  if (userIds.length === 0) return result;

  const { startMs: windowStartMs, endMs: windowEndMs } = digestWindow(deps.now());

  // Global sections are computed once per run; per-user work stays per-user.
  let callouts: DigestCallout[] | null = null;
  try {
    callouts = await loadTopCallouts(deps, windowStartMs, windowEndMs);
  } catch (err) {
    console.warn('[DailyDigest] Callout section unavailable:', (err as Error)?.message);
  }
  let topCallers: DigestTopCallers | null = null;
  try {
    topCallers = await deps.loadTopCallers();
  } catch (err) {
    console.warn('[DailyDigest] Caller board section unavailable:', (err as Error)?.message);
  }

  for (const userId of userIds) {
    try {
      const discordId = await deps.resolveDiscordId(userId);
      if (!discordId) continue; // opted in but never linked Discord

      const entries = await deps.listAlerts(userId);
      const alerts = selectWindowAlerts(entries, windowStartMs, windowEndMs);
      const components = buildDigestComponents({ windowEndMs, alerts, callouts, topCallers });

      const user = await client.users.fetch(discordId);
      await user.send({ flags: 1 << 15 /* IsComponentsV2 */, components } as any);
      result.delivered++;
    } catch (err: any) {
      // One log line per failing user, never an aborted loop.
      if (err?.code === DISCORD_CANNOT_DM) {
        result.blocked++;
      } else if (err?.status === 429 || err?.code === 429) {
        await deps.sleep(retryDelayMs(err));
        result.failed++;
      } else {
        result.failed++;
        console.error('[DailyDigest] DM failed for one user:', err?.message ?? err);
      }
    }
    await deps.sleep(DM_INTERVAL_MS);
  }

  console.log(
    `[DailyDigest] Sent ${result.delivered}/${result.eligible} digest(s) ` +
      `(${result.blocked} blocked, ${result.failed} failed).`,
  );
  return result;
}

// --- Scheduler ---------------------------------------------------------------

let digestTimer: NodeJS.Timeout | null = null;

function scheduleNextFire(hourUtc: number): void {
  // MISSED-BOOT BEHAVIOUR (deliberate): we always schedule the NEXT occurrence
  // of the digest hour. If the process was down when the hour passed, no
  // catch-up digest is sent on boot — a 3pm "morning digest" is noise, not
  // signal. The next scheduled fire covers a full 24h window, so a missed day
  // simply folds into the next one.
  //
  // The 60s floor guards the reschedule path: if the timer ever fired a hair
  // early, recomputing "next occurrence" could otherwise land milliseconds
  // away and double-send.
  const delayMs = Math.max(msUntilNextDigestFire(Date.now(), hourUtc), 60_000);
  digestTimer = setTimeout(() => {
    void runDailyDigest()
      .catch((err) => console.error('[DailyDigest] Run failed:', (err as Error)?.message ?? err))
      .finally(() => scheduleNextFire(hourUtc));
  }, delayMs);
}

/**
 * Start the once-a-day digest timer. Self-gates like the other background
 * subsystems: without Supabase (local mode — no linked identities, no
 * user_configs table) or without a bot token it logs one line and stays idle,
 * with zero errors and zero recurring log spam.
 */
export function startDailyDigestScheduler(): void {
  if (digestTimer) return;
  if (!getFomoServiceClient()) {
    console.log('[DailyDigest] Supabase not configured; daily digest idle.');
    return;
  }
  if (!isBotEnabled()) {
    console.log('[DailyDigest] DISCORD_BOT_TOKEN not set; daily digest idle.');
    return;
  }
  const hourUtc = resolveDigestHourUtc();
  console.log(`[DailyDigest] Scheduled daily at ${String(hourUtc).padStart(2, '0')}:00 UTC.`);
  scheduleNextFire(hourUtc);
}

/** Test/shutdown seam. */
export function stopDailyDigestScheduler(): void {
  if (digestTimer) clearTimeout(digestTimer);
  digestTimer = null;
}
