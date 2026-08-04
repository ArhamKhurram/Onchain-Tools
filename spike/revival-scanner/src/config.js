// Shared spike configuration. Every number here is provisional/tunable.

// Fixed snapshot window so HTTP caching stays valid across reruns.
export const WINDOW_END = '2026-08-03T12:00:00Z';
// 14 days, not 28: amm_pool-filtered REST queries run at 8-11s against a ~10s
// server-side deadline, so backfill cost scales brutally with window size.
// The universe is still *sampled* across 28 days (universe.js uses its own
// span); only the backfilled tape is 14 days.
export const WINDOW_DAYS = 14;
export const WINDOW_START = new Date(
  Date.parse(WINDOW_END) - WINDOW_DAYS * 86400_000
).toISOString().replace('.000Z', 'Z');

export const WSOL = 'So11111111111111111111111111111111111111112';
export const MAJORS = new Set([
  WSOL,
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // jitoSOL
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', // wETH
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', // wBTC
]);

// Universe selection
export const UNIVERSE_TARGET = 130; // pools
export const SAMPLES_PER_DAY = 2;   // swap-page samples per day for discovery

// Backfill
export const MAX_PAGES_PER_POOL = 16; // 8k swaps cap per pool (hot pools truncate; they are not revival candidates)
export const PAGE_LIMIT = 500;        // plan-restricted maximum
// Concurrent amm_pool-filtered queries reliably 500 (server-side scan
// timeouts); serial requests succeed. Keep this at 1.
export const BACKFILL_CONCURRENCY = 1;

// ---- C0 operational definition (all provisional) ----
export const C0 = {
  // Dormancy: every one of D consecutive hours is quiet.
  DORMANT_HOURS: 6,          // D
  DORMANT_MAX_TRADES_PER_H: 30,  // T
  DORMANT_MAX_VOL_SOL_PER_H: 5,  // volume ceiling per hour (quote units, ~SOL)
  // Revival: within W minutes of activity resuming...
  REVIVAL_WINDOW_MIN: 60,    // W
  REVIVAL_MIN_GAIN: 0.30,    // X: +30% vs pre-move baseline
  REVIVAL_SUSTAIN_GAIN: 0.20,// must hold >= +20%...
  REVIVAL_SUSTAIN_MIN: 15,   // ...for Y consecutive minutes
  REVIVAL_MIN_UNIQUE_BUYERS: 15, // Z unique buyers in window
  REVIVAL_MIN_VOL_SOL: 25,   // volume floor over window (quote units)
};

// ---- Detector defaults (all provisional) ----
export const DETECTOR = {
  ATR_PERIOD: 14,
  BASELINE_MIN: 1440,        // 24h of 1m candles for baselines
  WARMUP_MIN: 360,           // require >= 6h history before any signal
  Z_TRIGGER: 3.0,            // ATR% expansion z-score threshold
  ATR_PCT_FLOOR: 0.001,      // absolute ATR% floor (0.1%) to suppress noise-on-zero
  PRICE_FLOOR: 1e-12,        // denominator floor
  RVOL_GATE: 3.0,            // rolling 5m volume vs 24h baseline
  BUYERS_GATE: 5,            // unique buyers in trailing 10m
  BUYSELL_GATE: 1.5,         // buy/sell volume ratio in trailing 10m
  ROLL_SHORT_MIN: 5,         // RVOL short window
  ROLL_FLOW_MIN: 10,         // buyers + buy/sell window
  COOLDOWN_MIN: 60,          // per-token alert cooldown
  DORMANCY_LOOKBACK_MIN: 120,// must have been dormant within this lookback to alert
};
