// C3 (part 2): incremental indicators — O(1) per candle, no recompute jobs.
// ATR% (Wilder 14) with floored denominators, ATR%-expansion z-score vs the
// token's own trailing 24h baseline, RVOL, rolling unique buyers, buy/sell
// volume ratio. Consumed one candle at a time by the detector (same path for
// backtest and live).
import { DETECTOR } from './config.js';

class RollingStats {
  // Fixed-capacity ring buffer with O(1) mean/std.
  constructor(cap) {
    this.cap = cap; this.buf = new Array(cap); this.n = 0; this.i = 0;
    this.sum = 0; this.sumSq = 0;
  }
  push(x) {
    if (this.n === this.cap) {
      const old = this.buf[this.i];
      this.sum -= old; this.sumSq -= old * old;
    } else {
      this.n += 1;
    }
    this.buf[this.i] = x;
    this.sum += x; this.sumSq += x * x;
    this.i = (this.i + 1) % this.cap;
  }
  get mean() { return this.n ? this.sum / this.n : 0; }
  get std() {
    if (this.n < 2) return 0;
    const v = Math.max(0, this.sumSq / this.n - this.mean ** 2);
    return Math.sqrt(v);
  }
}

export class IndicatorEngine {
  constructor(cfg = DETECTOR) {
    this.cfg = cfg;
    this.prevClose = null;
    this.atr = null;          // Wilder ATR (price units)
    this.trWarm = [];         // first ATR_PERIOD TRs for seeding
    this.count = 0;

    this.atrPctBase = new RollingStats(cfg.BASELINE_MIN); // trailing 24h ATR%
    this.volBase = new RollingStats(cfg.BASELINE_MIN);    // trailing 24h 1m volume

    this.shortVol = [];       // last ROLL_SHORT_MIN candle volumes
    this.flowWin = [];        // last ROLL_FLOW_MIN {buyers:Set, buyVol, sellVol}
  }

  /** Feed one candle; returns the indicator snapshot for that candle. */
  push(c) {
    const cfg = this.cfg;
    this.count += 1;

    // --- True range on VWAP-based OHLC, Wilder smoothing ---
    let tr = 0;
    if (c.close != null) {
      tr = this.prevClose != null
        ? Math.max(
            c.high - c.low,
            Math.abs(c.high - this.prevClose),
            Math.abs(this.prevClose - c.low),
          )
        : c.high - c.low;
      this.prevClose = c.close;
    }
    if (c.close != null) {
      if (this.atr == null) {
        this.trWarm.push(tr);
        if (this.trWarm.length >= cfg.ATR_PERIOD) {
          this.atr = this.trWarm.reduce((a, b) => a + b, 0) / cfg.ATR_PERIOD;
        }
      } else {
        this.atr = (this.atr * (cfg.ATR_PERIOD - 1) + tr) / cfg.ATR_PERIOD;
      }
    }
    const close = Math.max(c.close ?? 0, cfg.PRICE_FLOOR);
    const atrPct = this.atr != null ? this.atr / close : 0;

    // --- ATR% expansion z-score vs trailing baseline (baseline EXCLUDES current) ---
    const baseMean = this.atrPctBase.mean;
    const baseStd = this.atrPctBase.std;
    // Floor the std so expansion from a flat-zero baseline cannot divide by ~0.
    const stdFloor = Math.max(baseStd, baseMean * 0.25, 1e-5);
    const atrPctZ = this.atrPctBase.n >= cfg.WARMUP_MIN ? (atrPct - baseMean) / stdFloor : 0;
    if (this.atr != null) this.atrPctBase.push(atrPct);

    // --- RVOL: rolling 5m volume vs trailing 24h per-5m baseline ---
    this.shortVol.push(c.volQuote);
    if (this.shortVol.length > cfg.ROLL_SHORT_MIN) this.shortVol.shift();
    const short = this.shortVol.reduce((a, b) => a + b, 0);
    const basePerMin = this.volBase.mean;
    const baseShort = Math.max(basePerMin * cfg.ROLL_SHORT_MIN, 0.5); // floor: 0.5 SOL per 5m
    const rvol = this.volBase.n >= cfg.WARMUP_MIN ? short / baseShort : 0;
    this.volBase.push(c.volQuote);

    // --- Rolling flow window (unique buyers, buy/sell ratio) ---
    this.flowWin.push({ buyers: c.buyerWallets ?? new Set(), buyVol: c.buyVolQuote, sellVol: c.sellVolQuote });
    if (this.flowWin.length > cfg.ROLL_FLOW_MIN) this.flowWin.shift();
    const buyersUnion = new Set();
    let buyVol = 0, sellVol = 0;
    for (const w of this.flowWin) {
      for (const b of w.buyers) buyersUnion.add(b);
      buyVol += w.buyVol; sellVol += w.sellVol;
    }
    const buySellRatio = buyVol / Math.max(sellVol, 0.05); // floor 0.05 SOL

    return {
      ts: c.ts,
      close: c.close,
      atr: this.atr,
      atrPct,
      atrPctZ,
      rvol,
      uniqueBuyers: buyersUnion.size,
      buySellRatio,
      warm: this.atrPctBase.n >= cfg.WARMUP_MIN,
    };
  }
}
