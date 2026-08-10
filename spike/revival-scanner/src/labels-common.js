// Shared loader for data/labels snapshots (see data/labels/README.md).
// Turns a GeckoTerminal OHLCV capture into the spike's candle format so the
// SAME candles->indicators->detector chain can replay it.
//
// Honest limitations of OHLCV-derived candles vs the swap-derived ones:
//   - no per-swap wallets  -> uniqueBuyers = 0, buyerWallets empty
//   - no buy/sell split    -> buyVolQuote = sellVolQuote = 0 (ratio unusable)
//   - no trade counts      -> trades = 0 everywhere so the dormancy trade
//     ceiling is genuinely vacuous and the volume test carries dormancy.
//     (Setting trades=1 per traded minute instead silently turns the
//     30-trades/h ceiling into a 30-active-minutes/h test — fake data.)
//   - high/low are raw trade extremes, not 15s sub-bucket VWAPs. On thin meme
//     pools dust/MEV trades print +/-50% wicks that the spike's VWAP
//     sub-bucket candles are DESIGNED to suppress; feeding raw wicks into the
//     ATR baseline inflates its std ~50x and no z-score ever clears the
//     trigger (verified on MANLET: z peaked at 0.18 during a 3x-in-10min
//     move). Default is therefore wickless candles (high=low=close, TR =
//     close-to-close) — the closest OHLCV approximation of the locked
//     mechanics. Pass {wicks:true} to keep raw extremes.
//   - GT's close is the LAST TRADE of the minute, not VWAP. Dust/MEV prints
//     land in it (MANLET carried a single 200x-down print at Aug 10 12:20
//     that put a ~97% std into the ATR baseline and deadened the z-score for
//     the following 24h). A Hampel-style filter therefore clamps any traded
//     close deviating >3x from the median of its 5 traded neighbors either
//     side back to that median. Real multi-minute moves are untouched — only
//     isolated spike-and-revert prints get clamped.
// Volumes are converted USD -> SOL via the DexScreener priceUsd/priceNative
// ratio captured in label.json, so RVOL/dormancy floors keep their units.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LABELS_DIR = path.resolve(HERE, '../data/labels');

export function listSnapshotDirs() {
  if (!fs.existsSync(LABELS_DIR)) return [];
  return fs.readdirSync(LABELS_DIR)
    .map((d) => path.join(LABELS_DIR, d))
    .filter((p) => fs.existsSync(path.join(p, 'label.json')));
}

/** Resolve a snapshot dir from a mint, mint prefix, symbol, or full path. */
export function resolveSnapshotDir(ref) {
  if (ref && fs.existsSync(path.join(ref, 'label.json'))) return ref;
  const dirs = listSnapshotDirs();
  const hit = dirs.find((d) => {
    const base = path.basename(d);
    if (base.toLowerCase().includes(String(ref).toLowerCase().slice(0, 24))) return true;
    const label = JSON.parse(fs.readFileSync(path.join(d, 'label.json'), 'utf8'));
    return label.mint === ref;
  });
  if (!hit) throw new Error(`no labels snapshot matches "${ref}" under ${LABELS_DIR}`);
  return hit;
}

/**
 * Load one snapshot: label.json + the best pool's minute tape as spike-format
 * candles (forward-filled, volumes in SOL). "Best" = the pool whose minute
 * tape reaches back furthest (usually the launch pool).
 */
export function loadSnapshot(dirRef, { wicks = false } = {}) {
  const dir = resolveSnapshotDir(dirRef);
  const label = JSON.parse(fs.readFileSync(path.join(dir, 'label.json'), 'utf8'));
  const solUsd = label.dexscreener?.solUsd;
  if (!(solUsd > 0)) throw new Error(`label.json lacks a usable solUsd rate (${dir})`);

  let best = null;
  for (const p of label.pools) {
    const mp = path.join(dir, `minute-${p.pool}.json`);
    if (!fs.existsSync(mp)) continue;
    const { ohlcv } = JSON.parse(fs.readFileSync(mp, 'utf8'));
    if (!ohlcv?.length) continue;
    if (!best || ohlcv[0][0] < best.ohlcv[0][0]
      || (ohlcv[0][0] === best.ohlcv[0][0] && ohlcv.length > best.ohlcv.length)) {
      best = { pool: p.pool, ohlcv };
    }
  }
  if (!best) throw new Error(`no minute candles in ${dir}`);

  // Hampel-style bad-print filter on traded closes (see header comment).
  const rows = best.ohlcv.map((r) => [...r]);
  const closes = rows.map((r) => r[4]);
  const med = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  let clamped = 0;
  for (let i = 0; i < rows.length; i++) {
    const nb = [];
    for (let j = Math.max(0, i - 5); j <= Math.min(rows.length - 1, i + 5); j++) {
      if (j !== i) nb.push(closes[j]);
    }
    if (nb.length < 4) continue;
    const m = med(nb);
    if (m > 0 && (closes[i] > 3 * m || closes[i] < m / 3)) {
      rows[i][4] = m;
      rows[i][1] = rows[i][2] = rows[i][3] = m; // o/h/l too (wickless path uses close)
      clamped += 1;
    }
  }
  if (clamped) console.error(`  [labels-common] clamped ${clamped} bad print(s) in ${path.basename(dir)}/${best.pool.slice(0, 8)}`);

  const candles = [];
  let lastClose = null;
  let next = rows[0][0];
  for (const [ts, o, h, l, c, volUsd] of rows) {
    for (; next < ts; next += 60) {
      candles.push({
        ts: next, open: lastClose, high: lastClose, low: lastClose,
        close: lastClose, volQuote: 0, buyVolQuote: 0, sellVolQuote: 0,
        trades: 0, uniqueBuyers: 0, uniqueSellers: 0, buyerWallets: new Set(),
        filled: true,
      });
    }
    candles.push({
      ts,
      open: wicks ? o : c,
      high: wicks ? h : c,
      low: wicks ? l : c,
      close: c,
      volQuote: volUsd / solUsd, buyVolQuote: 0, sellVolQuote: 0,
      trades: 0, uniqueBuyers: 0, uniqueSellers: 0, buyerWallets: new Set(),
      filled: false,
    });
    lastClose = c;
    next = ts + 60;
  }
  return { dir, label, pool: best.pool, candles, solUsd };
}
