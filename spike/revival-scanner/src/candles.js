// C3 (part 1): 1m candles from normalized SwapEvents.
//
// Pricing follows the locked ATR mechanics: the candle's close is the
// per-candle VWAP (not the last raw execution price), and intra-candle
// high/low come from VWAPs of four 15s sub-buckets — a single sandwich swap
// cannot print a wick on its own. Empty minutes are forward-filled
// (O=H=L=C=prev close, zero volume) so dormancy produces TR ~ 0.
//
// This module is the ONE code path: the backtest replay and any future live
// mode both consume candles via CandleBuilder.push(swap) / flushTo(ts).

const MIN = 60; // seconds per candle

export class CandleBuilder {
  constructor() {
    this.candles = [];
    this.cur = null; // accumulating minute
    this.lastClose = null;
  }

  _newBucket(minuteTs) {
    return {
      ts: minuteTs,
      sub: [null, null, null, null].map(() => ({ q: 0, b: 0 })), // 15s VWAP buckets
      volQuote: 0, buyVolQuote: 0, sellVolQuote: 0,
      trades: 0,
      buyers: new Set(), sellers: new Set(),
      q: 0, b: 0, // whole-candle sums for VWAP
    };
  }

  _finalize(bucket) {
    const vwap = bucket.b > 0 ? bucket.q / bucket.b : this.lastClose;
    const subVwaps = bucket.sub.filter((s) => s.b > 0).map((s) => s.q / s.b);
    const high = subVwaps.length ? Math.max(...subVwaps) : vwap;
    const low = subVwaps.length ? Math.min(...subVwaps) : vwap;
    const open = subVwaps.length ? subVwaps[0] : vwap;
    const candle = {
      ts: bucket.ts,
      open, high, low, close: vwap, vwap,
      volQuote: bucket.volQuote,
      buyVolQuote: bucket.buyVolQuote,
      sellVolQuote: bucket.sellVolQuote,
      trades: bucket.trades,
      uniqueBuyers: bucket.buyers.size,
      uniqueSellers: bucket.sellers.size,
      buyerWallets: bucket.buyers, // kept for rolling unique-buyer windows
      filled: false,
    };
    this.lastClose = vwap;
    return candle;
  }

  _fill(minuteTs) {
    return {
      ts: minuteTs,
      open: this.lastClose, high: this.lastClose, low: this.lastClose,
      close: this.lastClose, vwap: this.lastClose,
      volQuote: 0, buyVolQuote: 0, sellVolQuote: 0,
      trades: 0, uniqueBuyers: 0, uniqueSellers: 0,
      buyerWallets: new Set(),
      filled: true,
    };
  }

  /** Emit all candles strictly before minute(ts); forward-fill gaps. */
  flushTo(ts) {
    const targetMin = Math.floor(ts / MIN) * MIN;
    const out = [];
    if (this.cur && this.cur.ts < targetMin) {
      out.push(this._finalize(this.cur));
      this.cur = null;
    }
    if (this.lastClose != null) {
      let next = out.length
        ? out[out.length - 1].ts + MIN
        : this.candles.length ? this.candles[this.candles.length - 1].ts + MIN : targetMin;
      for (; next < targetMin; next += MIN) out.push(this._fill(next));
    }
    this.candles.push(...out);
    return out;
  }

  /** Push one swap (must arrive in ascending ts order). Returns newly closed candles. */
  push(swap) {
    const minuteTs = Math.floor(swap.ts / MIN) * MIN;
    const closed = this.flushTo(swap.ts);
    if (!this.cur) this.cur = this._newBucket(minuteTs);
    const c = this.cur;
    const subIdx = Math.min(3, Math.floor((swap.ts - minuteTs) / 15));
    c.sub[subIdx].q += swap.amountQuote;
    c.sub[subIdx].b += swap.amountQuote / swap.price; // base amount
    c.q += swap.amountQuote;
    c.b += swap.amountQuote / swap.price;
    c.volQuote += swap.amountQuote;
    c.trades += 1;
    if (swap.side === 'buy') {
      c.buyVolQuote += swap.amountQuote;
      if (swap.wallet) c.buyers.add(swap.wallet);
    } else {
      c.sellVolQuote += swap.amountQuote;
      if (swap.wallet) c.sellers.add(swap.wallet);
    }
    return closed;
  }

  /** Close out everything up to and including endTs. */
  finish(endTs) {
    return this.flushTo(Math.floor(endTs / MIN) * MIN + MIN);
  }
}

/** Convenience: full series from an array of ascending swaps. */
export function buildCandles(swaps, endTs) {
  const cb = new CandleBuilder();
  for (const s of swaps) cb.push(s);
  cb.finish(endTs ?? (swaps.length ? swaps[swaps.length - 1].ts : 0));
  return cb.candles;
}
