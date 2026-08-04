// Corpus episode builder: walks flushed candle shards per pool and emits ONE
// ROW per dormancy-exit episode — decision-time features + graded outcome
// labels — to data/corpus/episodes.jsonl.
//
//   node src/corpus-episodes.js [--windows sol-w1,sol-w2,bsc-w1] [--keep-buckets]
//
// Same code path as the spike detector: IndicatorEngine + DormancyTracker.
// NO feature may peek past the episode-start minute; labels are computed from
// the forward tape only. Sparse shards are forward-filled here (workers write
// only minutes with trades).
//
// Two phases per window (shards are worker-ordered, not pool-ordered, and the
// full window does not fit in memory):
//   1. partition shard rows into 64 pool-hash buckets on disk
//   2. per bucket: group by pool, sort/dedupe, reconstruct the 1m series,
//      detect dormancy exits, snapshot features, walk forward for labels
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { IndicatorEngine } from './indicators.js';
import { DormancyTracker } from './detector.js';
import { C0, DETECTOR } from './config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.resolve(HERE, '../data/corpus');
const PLAN = JSON.parse(fs.readFileSync(path.join(CORPUS, 'plan.json'), 'utf8'));
const OUT_PATH = path.join(CORPUS, 'episodes.jsonl');

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const WINDOWS = opt('--windows', PLAN.windows.map((w) => w.name).join(',')).split(',');
const KEEP_BUCKETS = args.includes('--keep-buckets');
const N_BUCKETS = 64;
const HORIZONS = [['1h', 60], ['6h', 360], ['24h', 1440]];
const MIN_FORWARD_MIN = 360; // require >= 6h of observable forward tape

function bucketOf(pool) {
  let h = 0x811c9dc5;
  for (let i = 0; i < pool.length; i++) { h ^= pool.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0) % N_BUCKETS;
}

async function partitionWindow(w) {
  const dir = path.join(CORPUS, w.chain, w.name);
  const bucketDir = path.join(CORPUS, 'tmp-buckets', w.name);
  fs.mkdirSync(bucketDir, { recursive: true });
  const done = path.join(bucketDir, '.partitioned');
  if (fs.existsSync(done)) { console.log(`[${w.name}] buckets already partitioned`); return bucketDir; }

  const outs = Array.from({ length: N_BUCKETS }, (_, i) =>
    fs.createWriteStream(path.join(bucketDir, `b${i}.jsonl`), { flags: 'w' }));
  const bufs = Array.from({ length: N_BUCKETS }, () => []);
  const shards = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  let rows = 0;
  for (const shard of shards) {
    const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, shard)), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      const m = line.match(/"p":"([^"]+)"/);
      if (!m) continue;
      const b = bucketOf(m[1]);
      bufs[b].push(line);
      rows += 1;
      if (bufs[b].length >= 2000) { outs[b].write(bufs[b].join('\n') + '\n'); bufs[b].length = 0; }
    }
  }
  await Promise.all(outs.map((o, i) => new Promise((res) => {
    if (bufs[i].length) o.write(bufs[i].join('\n') + '\n');
    o.end(res);
  })));
  fs.writeFileSync(done, String(rows));
  console.log(`[${w.name}] partitioned ${rows} rows from ${shards.length} shards`);
  return bucketDir;
}

/**
 * Contiguous-coverage end of a window, from worker checkpoints.
 * Workers own consecutive block sub-ranges; the usable window is the span
 * covered without gaps from the window start: walk workers in range order and
 * stop at the first one that is unfinished (its lastTs caps the span) or
 * missing. Rows after this ts are DROPPED — a partially-covered tail from a
 * later worker would otherwise read as fake flat dormancy across the gap.
 */
function windowEndTs(w) {
  const tasks = PLAN.tasks
    .filter((t) => t.window === w.name)
    .sort((a, b) => a.start - b.start);
  let end = 0;
  for (const t of tasks) {
    const p = path.join(CORPUS, w.chain, w.name, `${t.id}.ckpt.json`);
    if (!fs.existsSync(p)) break;
    let ck;
    try { ck = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { break; }
    if (ck.lastTs) end = Math.max(end, ck.lastTs);
    if (!ck.done) break;
  }
  return end;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * Process one pool's sparse rows -> episode rows.
 * Rows must be sorted+deduped by ts. The series is reconstructed minute by
 * minute with forward-filled gaps (same shape the live scanner would see).
 */
function processPool(chain, windowName, pool, rows, endTs, out) {
  if (rows.length < 2) return 0;
  const eng = new IndicatorEngine(DETECTOR);
  const dorm = new DormancyTracker(C0);

  const startTs = rows[0].t;
  const seriesEnd = Math.min(endTs, rows[rows.length - 1].t + 1440 * 60);
  const nMin = Math.floor((seriesEnd - startTs) / 60) + 1;
  if (nMin < 60 || nMin > 40_000) return 0; // degenerate or absurd span

  // Reconstruct closes + per-minute stats, walking rows and filling gaps.
  const closes = new Float64Array(nMin);
  const snaps = new Array(nMin);
  let ri = 0, lastClose = rows[0].c;
  let wasDormant = false, prevQuiet = 0;
  const episodes = []; // {idx, feat}
  let blockedUntil = -1;
  let closeRing = []; // trailing closes for 10m displacement

  for (let i = 0; i < nMin; i++) {
    const ts = startTs + i * 60;
    let c;
    if (ri < rows.length && rows[ri].t === ts) {
      const r = rows[ri];
      c = {
        ts, open: r.o, high: r.h, low: r.l, close: r.c,
        volQuote: r.v, buyVolQuote: r.bv, sellVolQuote: r.sv,
        trades: r.n, uniqueBuyers: r.ub, uniqueSellers: r.us,
        buyerWallets: new Set(r.by),
      };
      lastClose = r.c;
      ri += 1;
    } else {
      c = {
        ts, open: lastClose, high: lastClose, low: lastClose, close: lastClose,
        volQuote: 0, buyVolQuote: 0, sellVolQuote: 0,
        trades: 0, uniqueBuyers: 0, uniqueSellers: 0, buyerWallets: new Set(),
      };
    }
    closes[i] = c.close;
    const ind = eng.push(c);
    const quietBefore = prevQuiet;
    const nowDormant = dorm.push(c);
    prevQuiet = dorm.quietMin;

    // flow extras the engine doesn't expose: 10m volume + displacement
    closeRing.push(c.close);
    if (closeRing.length > 11) closeRing.shift();

    if (wasDormant && !nowDormant && c.trades > 0 && i > blockedUntil) {
      const preIdx = Math.max(0, i - 30);
      const baseline = median(Array.from(closes.slice(preIdx, i)).filter((x) => x > 0)) ?? c.close;
      const vol10 = eng.flowWin.reduce((a, w) => a + w.buyVol + w.sellVol, 0);
      const disp10 = closeRing.length > 1 && closeRing[0] > 0 ? Math.abs(c.close / closeRing[0] - 1) : 0;
      episodes.push({
        idx: i,
        feat: {
          atrPctZ: round(ind.atrPctZ), atrPct: round(ind.atrPct),
          rvol: round(ind.rvol),
          uniqueBuyers10m: ind.uniqueBuyers,
          buySellRatio10m: round(ind.buySellRatio),
          vol10m: round(vol10),
          absorption: round(disp10 / Math.max(vol10, 0.5)), // |Δprice|/volume
          dispFromBaseline: baseline > 0 ? round(c.close / baseline - 1) : 0,
          dormancyHours: round(quietBefore / 60),
          tokenAgeMin: i, // minutes since pool first seen in-window (censored proxy)
          tradesInMinute: c.trades,
          hourUtc: Math.floor((ts % 86400) / 3600),
          dayOfWeek: new Date(ts * 1000).getUTCDay(),
          warm: ind.warm ? 1 : 0,
        },
        entry: c.close,
        baseline,
      });
      blockedUntil = i + C0.REVIVAL_WINDOW_MIN;
    }
    wasDormant = nowDormant;
  }

  // ---- forward labels (entry = decision-minute close; flat after tape end) ----
  let written = 0;
  const results = [];
  for (const ep of episodes) {
    const observedMin = Math.floor((endTs - (startTs + ep.idx * 60)) / 60);
    if (observedMin < MIN_FORWARD_MIN) continue;
    if (!(ep.entry > 0)) continue;
    const lastIdx = Math.min(nMin - 1, ep.idx + 1440);
    let peak = 0, peakIdx = ep.idx;
    const label = {};
    for (let i = ep.idx; i <= lastIdx; i++) {
      const m = closes[i] / ep.entry;
      if (m > peak) { peak = m; peakIdx = i; }
      for (const [name, mins] of HORIZONS) {
        if (i - ep.idx === Math.min(mins, observedMin)) label[`peak_${name}`] = round(peak);
      }
    }
    for (const [name, mins] of HORIZONS) {
      if (!(`peak_${name}` in label)) label[`peak_${name}`] = round(peak);
      const ti = Math.min(nMin - 1, ep.idx + Math.min(mins, observedMin));
      label[`terminal_${name}`] = round(closes[ti] / ep.entry);
    }
    let trough = peak;
    for (let i = peakIdx; i <= lastIdx; i++) {
      const m = closes[i] / ep.entry;
      if (m < trough) trough = m;
    }
    label.retraceFromPeak = peak > 0 ? round(1 - trough / peak) : null;
    label.minToPeak = peakIdx - ep.idx;
    label.label2x = label.peak_24h >= 2 ? 1 : 0;
    label.rugged90 = label.terminal_24h <= 0.1 ? 1 : 0;
    label.observedMin = Math.min(observedMin, 1440);

    results.push({ ep, label });
  }

  // prior-episode features need the chronological pass done above
  let prior = 0, prior2x = 0;
  for (const { ep, label } of results) {
    out.write(JSON.stringify({
      chain, window: windowName, pool,
      ts: startTs + ep.idx * 60,
      ...ep.feat,
      priorEpisodes: prior,
      prior2xEpisodes: prior2x,
      entryPrice: ep.entry,
      baselinePrice: ep.baseline,
      ...label,
    }) + '\n');
    prior += 1;
    if (label.label2x) prior2x += 1;
    written += 1;
  }
  return written;
}

function round(x) {
  return x == null || !isFinite(x) ? null : Number(x.toPrecision(6));
}

async function processBucket(w, bucketPath, endTs, out, tally) {
  const byPool = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(bucketPath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.t > endTs - 60) continue; // beyond contiguous coverage (see windowEndTs)
    let arr = byPool.get(r.p);
    if (!arr) { arr = []; byPool.set(r.p, arr); }
    arr.push(r);
  }
  for (const [pool, rows] of byPool) {
    rows.sort((a, b) => a.t - b.t || b.n - a.n);
    const dedup = [];
    for (const r of rows) {
      if (dedup.length && dedup[dedup.length - 1].t === r.t) continue; // keep max-n (sorted first)
      dedup.push(r);
    }
    tally.pools += 1;
    tally.rows += dedup.length;
    tally.episodes += processPool(w.chain, w.name, pool, dedup, endTs, out);
  }
}

async function main() {
  const out = fs.createWriteStream(OUT_PATH, { flags: 'w' });
  const summary = {};
  for (const w of PLAN.windows) {
    if (!WINDOWS.includes(w.name)) continue;
    const endTs = windowEndTs(w);
    if (!endTs) { console.error(`[${w.name}] no checkpoints — skipping`); continue; }
    const bucketDir = await partitionWindow(w);
    const tally = { pools: 0, rows: 0, episodes: 0 };
    for (let b = 0; b < N_BUCKETS; b++) {
      await processBucket(w, path.join(bucketDir, `b${b}.jsonl`), endTs, out, tally);
      if (b % 16 === 15) console.log(`[${w.name}] bucket ${b + 1}/${N_BUCKETS}: pools=${tally.pools} episodes=${tally.episodes}`);
    }
    summary[w.name] = { ...tally, endTs };
    console.log(`[${w.name}] DONE pools=${tally.pools} candleRows=${tally.rows} episodes=${tally.episodes}`);
    if (!KEEP_BUCKETS) fs.rmSync(bucketDir, { recursive: true, force: true });
  }
  await new Promise((res) => out.end(res));
  fs.writeFileSync(path.join(CORPUS, 'episodes-summary.json'), JSON.stringify({ generatedAt: new Date().toISOString(), summary }, null, 1));
  console.log(`wrote ${OUT_PATH}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
