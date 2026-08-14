/**
 * GeckoTerminal candle source for the revival detector.
 *
 * Multi-chain: every call takes a GeckoTerminal network id (see
 * REVIVAL_NETWORKS in @oct/shared). Solana, BNB Chain and Robinhood Chain are
 * all indexed keylessly under the same endpoint shape, so a second chain is a
 * path parameter, not a second integration.
 *
 * Keyless public API. The "~30 calls/min" figure this module used to be built
 * around was WRONG — it came from third-party write-ups, not from measurement.
 * Measured by hand on 2026-08-11 from two independent IPs (a home connection
 * and a Railway egress IP), against the same endpoints this file calls:
 *
 *   8 requests spaced 2200ms  → 1-5 OK, 6 and 7 got 429, 8 OK
 *   12 requests spaced 5000ms → 7 OK, 5 got 429
 *     (200 200 200 429 429 200 429 200 429 200 429 200)
 *
 * Two conclusions, both of which this file is now shaped by:
 *
 * 1. The SUSTAINABLE rate is roughly 6-8 successful requests per minute, not
 *    30. Prod at 2200ms spacing was asking for ~27/min — about 4x what the API
 *    actually grants — and the logs showed it being cut off at 6 req/60s.
 * 2. A 429 is intermittent NOISE, not a clean "you are over, wait N seconds"
 *    signal. Even the 5000ms run (12/min, still over) got 429s interleaved
 *    with 200s in no discernible pattern. So a single 429 must not be read as
 *    "stop everything" — it is one unlucky request.
 *
 * Being a polite client therefore means:
 * - EVERY request goes through one global serial queue with a minimum spacing
 *   (see `schedule` below). This module — not its callers — owns the rate
 *   budget: the poller and the outcome tracker each used to pace themselves,
 *   which meant their requests interleaved and the true rate was the SUM of
 *   two "safe" rates;
 * - spacing defaults to 10s (≈6 req/min, the low end of the measured band)
 *   with ±15% random jitter so we never march in a predictable lockstep;
 * - a 429 re-queues THAT request and widens the global spacing a notch
 *   (`noteRateLimited`), recovering after a few consecutive successes. It no
 *   longer halts every chain for 30s — that over-correction cost far more
 *   coverage than the 429s did;
 * - a hard safety valve still exists: if more than half of the requests in a
 *   rolling 2-minute window are rate-limited, we are genuinely unwelcome and
 *   a real exponential backoff engages, loudly;
 * - token → top-pool resolution is cached (1h TTL), keyed by NETWORK + address
 *   so two chains can never collide on a same-looking address;
 * - hour candles are cached (45m TTL) — they change at most once an hour, and
 *   at 6 req/min every avoided refetch is a token we get to scan instead;
 * - tokens GeckoTerminal doesn't index are negative-cached (30m) so an
 *   unlisted contract isn't re-requested every cycle.
 *
 * Endpoints:
 *   GET /networks/{network}/tokens/{address}/pools?page=1
 *   GET /networks/{network}/pools/{pool}/ohlcv/{minute|hour}?aggregate=1&limit=N&currency=usd
 */

import type { RevivalNetwork } from '@oct/shared';
import type { Candle } from './detector.js';

const BASE_URL = 'https://api.geckoterminal.com/api/v2';
const POOL_CACHE_TTL_MS = 3_600_000; // 1h
const POOL_MISS_TTL_MS = 30 * 60_000; // 30m — don't re-ask for unindexed tokens
/**
 * 45m (was 20m). Hour buckets change at most once an hour, and the dormancy
 * gate reads 6h/72h VOLUME windows — a bucket up to 45 minutes stale moves
 * those sums by a fraction of one bucket out of six and cannot flip a verdict.
 * At 6 req/min every refetch we skip is a token we get to scan instead, so the
 * longer TTL is what keeps the steady-state cost near 1.2 req/token.
 */
const HOUR_CACHE_TTL_MS = 45 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 15 * 60_000;

/**
 * MEASURED sustainable rate for GeckoTerminal's keyless tier, in successful
 * requests per minute (see the measurement table in the module header).
 *
 * This replaces a `GECKOTERMINAL_RATE_LIMIT_PER_MIN = 30` that was never
 * measured and was wrong by ~4x. Two IPs, two spacings, same answer: about
 * 6-8 requests per minute get through. 6 is the conservative end and the
 * number DEFAULT_REQUEST_SPACING_MS is derived from; 8 is the ceiling the
 * pacing test refuses to let a config exceed.
 */
export const GECKOTERMINAL_SUSTAINED_REQUESTS_PER_MIN = 6;
export const GECKOTERMINAL_MAX_REQUESTS_PER_MIN = 8;

/**
 * Minimum gap between two GeckoTerminal requests: 10000ms = 6 req/min, the
 * conservative end of the measured band. Jittered ±15% at call time.
 */
export const DEFAULT_REQUEST_SPACING_MS = 10_000;
/**
 * Floor for the env override. 7500ms = 8 req/min = the TOP of the measured
 * band; anything faster is known-bad, so the knob refuses it rather than
 * obeying it. This knob exists to slow us DOWN.
 */
const MIN_REQUEST_SPACING_MS = 7_500;

/**
 * Random spread applied to each gap. The mean rate is unchanged; the point is
 * that our requests stop arriving on an exact 10.000s grid, which is both
 * easier for a rate limiter to single out and what produced the tidy runs of
 * consecutive 429s in the measurements.
 */
const SPACING_JITTER_RATIO = 0.15;

// --- Adaptive slowdown (the replacement for the old global halt) -----------
/** Each 429 multiplies the global spacing by this much… */
const SLOWDOWN_FACTOR = 1.5;
/** …up to this ceiling (10s → 30s ≈ 2 req/min at full slowdown). */
const MAX_SPACING_MULTIPLIER = 3;
/** …and this many consecutive successes walk one notch back off. */
const RECOVERY_SUCCESSES = 4;
/** A 429'd request is re-queued this many times before we give up on it. */
const RETRIES_PER_REQUEST = 1;

// --- Hard safety valve ------------------------------------------------------
/** Rolling window over which the failure rate is judged. */
const VALVE_WINDOW_MS = 120_000;
/** Below this many samples the rate is noise, not evidence. */
const VALVE_MIN_SAMPLES = 8;
/** Above this failure rate we are genuinely unwelcome — back off properly. */
const VALVE_FAILURE_RATE = 0.5;

function envFlag(name: string): string | undefined {
  return process.env[`OCT_${name}`] ?? process.env[`TRENCHCORD_${name}`];
}

/**
 * Spacing between requests, tunable without a deploy via
 * `OCT_REVIVAL_REQUEST_SPACING_MS` (`TRENCHCORD_` fallback). Values below the
 * floor are ignored rather than obeyed — this knob exists to slow us DOWN.
 */
export function resolveRequestSpacingMs(): number {
  if (spacingOverrideMs != null) return spacingOverrideMs;
  const parsed = Number.parseInt(envFlag('REVIVAL_REQUEST_SPACING_MS') ?? '', 10);
  return Number.isFinite(parsed) && parsed >= MIN_REQUEST_SPACING_MS
    ? parsed
    : DEFAULT_REQUEST_SPACING_MS;
}

/**
 * Test seam only: bypass the queue's spacing so a unit test asserting request
 * SHAPE doesn't sit through real 10s gaps. Never set in production code — the
 * env knob is the supported way to change spacing.
 */
let spacingOverrideMs: number | null = null;
export function _setRequestSpacingForTest(ms: number | null): void {
  spacingOverrideMs = ms;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The gap actually waited before the next request: configured spacing, times
 * the adaptive slowdown multiplier, times ±SPACING_JITTER_RATIO. A spacing of
 * 0 (the test seam) stays 0 — jitter of nothing is nothing.
 */
function nextGapMs(): number {
  const base = resolveRequestSpacingMs() * spacingMultiplier;
  const jitter = 1 + (Math.random() * 2 - 1) * SPACING_JITTER_RATIO;
  return base * jitter;
}

// --- The one global request queue -----------------------------------------
// Serial by construction: each scheduled call chains onto the previous one and
// waits out the remaining spacing before firing. Every revival consumer shares
// this budget, so adding a caller can never multiply the request rate.
let queueTail: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;
/** Request timestamps in the trailing minute — for the 429 diagnostic only. */
const recentRequests: number[] = [];

/** Monotonic since boot; the poller diffs these to build its coverage line. */
let totalRequestsSent = 0;
let totalRateLimited = 0;
let totalRetries = 0;

export interface RevivalRequestCounters {
  /** Requests actually put on the wire (retries included). */
  sent: number;
  /** Responses that came back 429. */
  rateLimited: number;
  /** Requests re-queued after a 429. */
  retried: number;
}

export function revivalRequestCounters(): RevivalRequestCounters {
  return { sent: totalRequestsSent, rateLimited: totalRateLimited, retried: totalRetries };
}

function noteRequestSent(now: number): void {
  totalRequestsSent += 1;
  recentRequests.push(now);
  while (recentRequests.length > 0 && recentRequests[0] < now - 60_000) {
    recentRequests.shift();
  }
}

export function requestsInLastMinute(now: number = Date.now()): number {
  while (recentRequests.length > 0 && recentRequests[0] < now - 60_000) {
    recentRequests.shift();
  }
  return recentRequests.length;
}

function schedule<T>(fn: () => Promise<T>): Promise<T> {
  const run = queueTail.then(async () => {
    const wait = lastRequestAt + nextGapMs() - Date.now();
    if (wait > 0) await sleep(wait);
    const now = Date.now();
    lastRequestAt = now;
    noteRequestSent(now);
    return fn();
  });
  // The tail must never reject, or one failure would poison the whole queue.
  queueTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export interface ResolvedPool {
  poolAddress: string;
  /** Parsed from the pool name ("SYM / SOL"), best-effort. */
  symbol: string | null;
  /**
   * Implied circulating/total supply = (fdv or mcap USD) / price at resolution
   * time. Lets the poller estimate a current mcap from the latest close without
   * re-fetching pool metadata every cycle.
   */
  impliedSupply: number | null;
  resolvedAt: number;
}

/** Cache key — the network is part of it, so chains can never share an entry. */
function cacheKey(network: RevivalNetwork, address: string): string {
  return `${network}:${address}`;
}

const poolCache = new Map<string, ResolvedPool>();
/** network:address → epoch ms of a resolution that found no pools. */
const poolMisses = new Map<string, number>();

// --- 429 handling ----------------------------------------------------------
//
// Judgment call, revised. GeckoTerminal's keyless limit is per-CLIENT (per IP),
// not per network, so a 429 earned on Solana does say something about the next
// Robinhood request — that part of the old reasoning holds, and the response is
// still global. What did NOT hold is the SHAPE of the response.
//
// The old code treated one 429 as "stop every revival fetch for 30s, doubling".
// The measurements show 429s arriving intermittently even at compliant rates
// (5 of 12 at 5000ms spacing, interleaved with successes). Under that regime a
// full 30s halt per 429 is a self-inflicted outage: prod spent most of its life
// paused, scanned a fraction of the universe, and logged it as silence.
//
// So: a 429 now (a) re-queues that one request, and (b) widens the global
// spacing by one notch, which decays back after RECOVERY_SUCCESSES consecutive
// successes. The full stop survives only as a safety valve for SUSTAINED
// failure — see checkSafetyValve. Coverage is otherwise preserved by the
// poller's per-network rotation, as before.
let backoffUntil = 0;
let backoffMs = BACKOFF_BASE_MS;
let spacingMultiplier = 1;
let consecutiveSuccesses = 0;
/** Rolling outcomes over VALVE_WINDOW_MS: true = rate-limited. */
const outcomeWindow: { at: number; limited: boolean }[] = [];

export function isBackedOff(now: number = Date.now()): boolean {
  return now < backoffUntil;
}

/** Current global slowdown factor — 1 when healthy. Exposed for tests/logs. */
export function currentSpacingMultiplier(): number {
  return spacingMultiplier;
}

/** Effective gap the queue is currently pacing to, jitter aside. */
export function effectiveSpacingMs(): number {
  return resolveRequestSpacingMs() * spacingMultiplier;
}

function recordOutcome(limited: boolean, now: number): void {
  outcomeWindow.push({ at: now, limited });
  while (outcomeWindow.length > 0 && outcomeWindow[0].at < now - VALVE_WINDOW_MS) {
    outcomeWindow.shift();
  }
}

/**
 * Failure rate over the rolling window, or null when there isn't enough
 * evidence yet. Pure so the valve threshold is testable without timers.
 */
export function rollingFailureRate(now: number = Date.now()): number | null {
  while (outcomeWindow.length > 0 && outcomeWindow[0].at < now - VALVE_WINDOW_MS) {
    outcomeWindow.shift();
  }
  if (outcomeWindow.length < VALVE_MIN_SAMPLES) return null;
  const limited = outcomeWindow.reduce((n, o) => n + (o.limited ? 1 : 0), 0);
  return limited / outcomeWindow.length;
}

/**
 * The one path that can still stop everything. Trips only on SUSTAINED
 * failure — at that point we are not being unlucky, we are unwelcome, and
 * continuing to ask is hammering. Says so at warn level, with the numbers.
 */
function checkSafetyValve(now: number): void {
  const rate = rollingFailureRate(now);
  if (rate == null || rate <= VALVE_FAILURE_RATE) return;

  backoffUntil = now + backoffMs;
  console.warn(
    `[Revival] GeckoTerminal sustained rate limiting — ${Math.round(rate * 100)}% of the last ` +
      `${outcomeWindow.length} requests were 429 (${requestsInLastMinute(now)} req in the last 60s, ` +
      `effective spacing ${Math.round(effectiveSpacingMs())}ms, measured sustainable rate ` +
      `~${GECKOTERMINAL_SUSTAINED_REQUESTS_PER_MIN}/min). Pausing all revival fetches for ` +
      `${Math.round(backoffMs / 1000)}s.`,
  );
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  // Clear the evidence: the next window should judge life AFTER the pause,
  // otherwise one bad patch re-trips the valve on its own stale samples.
  outcomeWindow.length = 0;
}

function noteRateLimited(network: RevivalNetwork): void {
  const now = Date.now();
  totalRateLimited += 1;
  consecutiveSuccesses = 0;
  recordOutcome(true, now);

  const before = spacingMultiplier;
  spacingMultiplier = Math.min(spacingMultiplier * SLOWDOWN_FACTOR, MAX_SPACING_MULTIPLIER);
  if (spacingMultiplier !== before) {
    // Logged only when the multiplier actually moves. Individual 429s at a
    // compliant rate are expected noise and are counted into the poller's
    // per-cycle coverage line instead of one warn each.
    console.warn(
      `[Revival] GeckoTerminal 429 on ${network} — widening spacing to ` +
        `${Math.round(effectiveSpacingMs())}ms (${(60_000 / effectiveSpacingMs()).toFixed(1)} req/min).`,
    );
  }
  checkSafetyValve(now);
}

function noteSuccess(): void {
  recordOutcome(false, Date.now());
  backoffMs = BACKOFF_BASE_MS;
  consecutiveSuccesses += 1;
  if (spacingMultiplier > 1 && consecutiveSuccesses >= RECOVERY_SUCCESSES) {
    spacingMultiplier = Math.max(1, spacingMultiplier / SLOWDOWN_FACTOR);
    consecutiveSuccesses = 0;
  }
}

type FetchOutcome =
  | { status: 'ok'; json: any }
  | { status: 'rate_limited' }
  | { status: 'error' };

/** The wire call itself. Always runs inside a queue slot. */
async function doFetch(network: RevivalNetwork, path: string): Promise<FetchOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (res.status === 429) {
      noteRateLimited(network);
      return { status: 'rate_limited' };
    }
    if (!res.ok) return { status: 'error' };
    noteSuccess();
    return { status: 'ok', json: await res.json() };
  } catch {
    return { status: 'error' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One paced GeckoTerminal GET, re-queued once on 429.
 *
 * The retry is the cheap half of the new strategy: the queue is serial and the
 * spacing has just been widened, so a re-queued request simply takes the next
 * (slower) slot rather than triggering a global stop. If the retry is also
 * refused we give up on this request — the poller's rotation will come back to
 * the token next cycle.
 *
 * The safety-valve backoff is re-checked INSIDE the queue slot as well as
 * before enqueuing: a request queued before the valve tripped must not fire
 * afterwards.
 */
async function gtFetch(network: RevivalNetwork, path: string): Promise<any | null> {
  for (let attempt = 0; attempt <= RETRIES_PER_REQUEST; attempt++) {
    if (isBackedOff()) return null;
    const outcome = await schedule<FetchOutcome>(async () => {
      if (isBackedOff()) return { status: 'error' };
      return doFetch(network, path);
    });
    if (outcome.status === 'ok') return outcome.json;
    if (outcome.status === 'error') return null;
    if (attempt < RETRIES_PER_REQUEST) totalRetries += 1;
  }
  return null;
}

function parseNum(v: unknown): number | null {
  const n = typeof v === 'string' ? Number.parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Top pool by 24h volume for a token ON `network`. Cached 1h; null when
 * unresolvable. A "no pools" answer is remembered for 30m so tokens
 * GeckoTerminal doesn't index (or an address mapped to the wrong chain) cost
 * one request per half hour rather than one per poll cycle.
 */
export async function resolveTopPool(
  network: RevivalNetwork,
  address: string,
): Promise<ResolvedPool | null> {
  const key = cacheKey(network, address);
  const cached = poolCache.get(key);
  if (cached && Date.now() - cached.resolvedAt < POOL_CACHE_TTL_MS) return cached;

  const missedAt = poolMisses.get(key);
  if (missedAt != null && Date.now() - missedAt < POOL_MISS_TTL_MS) return cached ?? null;

  const json = await gtFetch(network, `/networks/${network}/tokens/${address}/pools?page=1`);
  const pools: any[] = Array.isArray(json?.data) ? json.data : [];
  if (pools.length === 0) {
    // Only a real (non-backed-off, non-error) answer counts as a miss.
    if (json != null) poolMisses.set(key, Date.now());
    return cached ?? null;
  }
  poolMisses.delete(key);

  let best: any = null;
  let bestVol = -1;
  for (const p of pools) {
    const vol = parseNum(p?.attributes?.volume_usd?.h24) ?? 0;
    if (vol > bestVol) {
      bestVol = vol;
      best = p;
    }
  }
  const poolAddress: string | undefined = best?.attributes?.address;
  if (!poolAddress) return cached ?? null;

  const name: string | undefined = best?.attributes?.name;
  const symbol = typeof name === 'string' && name.includes('/')
    ? name.split('/')[0].trim() || null
    : null;

  const price = parseNum(best?.attributes?.base_token_price_usd);
  const fdv = parseNum(best?.attributes?.fdv_usd) ?? parseNum(best?.attributes?.market_cap_usd);
  const impliedSupply = price && price > 0 && fdv ? fdv / price : null;

  const resolved: ResolvedPool = {
    poolAddress,
    symbol,
    impliedSupply,
    resolvedAt: Date.now(),
  };
  poolCache.set(key, resolved);
  return resolved;
}

function parseOhlcv(json: any): Candle[] {
  const list: any[] = json?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) return [];
  const out: Candle[] = [];
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [ts, open, high, low, close, volume] = row.map((v: unknown) => parseNum(v));
    if (ts == null || open == null || high == null || low == null || close == null || volume == null) continue;
    out.push({ ts: ts * 1000, open, high, low, close, volume });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/** network:pool:timeframe:limit → cached hour candles. */
const hourCache = new Map<string, { candles: Candle[]; fetchedAt: number }>();

/**
 * OHLCV for one pool. Hour candles are served from a 45-minute cache: the
 * dormancy gate reads 6h/72h volume windows, so a bucket that is at most 45
 * minutes stale changes nothing about the verdict, and skipping that refetch
 * is what holds the steady-state cost near 1.2 requests per token. Minute
 * candles — the ones the ATR/RVOL gates actually key off — are always fresh.
 */
export async function fetchOhlcv(
  network: RevivalNetwork,
  poolAddress: string,
  timeframe: 'minute' | 'hour',
  limit: number,
): Promise<Candle[]> {
  const key = `${network}:${poolAddress}:${timeframe}:${limit}`;
  if (timeframe === 'hour') {
    const cached = hourCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < HOUR_CACHE_TTL_MS) return cached.candles;
  }

  const json = await gtFetch(
    network,
    `/networks/${network}/pools/${poolAddress}/ohlcv/${timeframe}?aggregate=1&limit=${limit}&currency=usd`,
  );
  if (!json) {
    // Backed off / failed: a stale hour set still beats no dormancy history.
    if (timeframe === 'hour') return hourCache.get(key)?.candles ?? [];
    return [];
  }
  const candles = parseOhlcv(json);
  if (timeframe === 'hour' && candles.length > 0) {
    hourCache.set(key, { candles, fetchedAt: Date.now() });
  }
  return candles;
}

export interface RevivalCandleSet {
  pool: ResolvedPool;
  /** ~16h of 1m candles (ATR / RVOL / warmup). */
  minute: Candle[];
  /** ~4 days of 1h candles (relative-dormancy lookback). */
  hour: Candle[];
}

/**
 * Everything the detector needs for one token on one chain: minute candles
 * (1000 ≈ 16.6h) for ATR/RVOL, hour candles (100 ≈ 4d) for the 72h dormancy
 * lookback. Null when the pool can't be resolved or we're rate-limit backed off.
 */
export async function fetchRevivalCandles(
  network: RevivalNetwork,
  address: string,
): Promise<RevivalCandleSet | null> {
  const pool = await resolveTopPool(network, address);
  if (!pool) return null;
  const minute = await fetchOhlcv(network, pool.poolAddress, 'minute', 1000);
  if (minute.length === 0) return null;
  const hour = await fetchOhlcv(network, pool.poolAddress, 'hour', 100);
  return { pool, minute, hour };
}

/** Test seam. */
export function _clearPoolCacheForTest(): void {
  poolCache.clear();
  poolMisses.clear();
  hourCache.clear();
  backoffUntil = 0;
  backoffMs = BACKOFF_BASE_MS;
  spacingMultiplier = 1;
  consecutiveSuccesses = 0;
  outcomeWindow.length = 0;
  lastRequestAt = 0;
  recentRequests.length = 0;
  totalRequestsSent = 0;
  totalRateLimited = 0;
  totalRetries = 0;
  queueTail = Promise.resolve();
  spacingOverrideMs = null;
}
