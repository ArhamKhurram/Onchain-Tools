// One corpus range worker: streams [start, stop) of one chain over substreams,
// normalizes swaps, and aggregates IN-STREAM to per-pool 1m candles (VWAP
// close, sub-bucket VWAP high/low — same pricing mechanics as candles.js).
// Raw full-chain swaps are never stored.
//
//   node src/corpus-stream.js --chain solana --start N --stop M --out DIR --id w0
//
// Life-floor: a pool only materializes after >= LIFE_FLOOR swaps (tiny pools
// keep a counter + a small replay buffer, so the first swaps aren't lost when
// the pool crosses the floor). Idle pools are evicted-with-flush. Progress is
// checkpointed every flush; a killed worker resumes from --id's checkpoint and
// loses at most the open (unflushed-minute) candles.
//
// Output: JSONL rows  {p,t,o,h,l,c,v,bv,sv,n,ub,us,by:[walletHash...]}
// Only minutes with trades are written; the episode builder forward-fills.
import fs from 'node:fs';
import path from 'node:path';
import { createRegistry, createRequest } from '@substreams/core';
import { readPackage } from '@substreams/manifest';
import { BlockEmitter } from '@substreams/node';
import { createNodeTransport } from '@substreams/node/createNodeTransport';
import { getCreds } from './env.js';
import { CHAINS } from './corpus/chains.js';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};

const CHAIN = opt('--chain', 'solana');
const START = Number(opt('--start'));
const STOP = Number(opt('--stop'));
const OUT_DIR = opt('--out');
const ID = opt('--id', 'w0');
if (!CHAINS[CHAIN] || !isFinite(START) || !isFinite(STOP) || !OUT_DIR) {
  console.error('usage: corpus-stream --chain solana|bsc --start N --stop M --out DIR --id wK');
  process.exit(2);
}
const cfg = CHAINS[CHAIN];

const LIFE_FLOOR = 20;         // swaps before a pool materializes
const TINY_BUFFER_MAX = 24;    // replay buffer per tiny pool
const EVICT_IDLE_SEC = 90 * 60; // evict pools idle > 90 chain-minutes
const FLUSH_EVERY_BLOCKS = CHAIN === 'solana' ? 3000 : 4000;
const STATUS_EVERY_MS = 30_000;

fs.mkdirSync(OUT_DIR, { recursive: true });
const outPath = path.join(OUT_DIR, `${ID}.jsonl`);
const ckptPath = path.join(OUT_DIR, `${ID}.ckpt.json`);

// ---- resume ----
let resumeFrom = START;
let stats = { rows: 0, swaps: 0, blocks: 0, restarts: 0 };
if (fs.existsSync(ckptPath)) {
  const ck = JSON.parse(fs.readFileSync(ckptPath, 'utf8'));
  if (ck.done) { console.log(`[${ID}] already done`); process.exit(0); }
  resumeFrom = ck.lastBlock + 1;
  stats.rows = ck.rowsWritten ?? 0;
  stats.swaps = ck.swapsSeen ?? 0;
  stats.restarts = (ck.restarts ?? 0) + 1;
  console.log(`[${ID}] resuming from block ${resumeFrom} (restart #${stats.restarts})`);
}

// ---- per-pool aggregation ----
// materialized pool: { cur: minuteBucket|null, lastTs }
// tiny pool:         { n, buf: [swap...]|null, lastTs }
const pools = new Map();        // pool -> state
const materialized = new Set(); // pools that ever crossed the life floor (re-materialize instantly)
const pending = [];             // JSONL lines awaiting flush
let tinyDropped = 0;            // tiny pools evicted before crossing the floor
let poolsEverMaterialized = 0;

function newBucket(minuteTs) {
  return {
    ts: minuteTs,
    sub: [{ q: 0, b: 0 }, { q: 0, b: 0 }, { q: 0, b: 0 }, { q: 0, b: 0 }],
    q: 0, b: 0, v: 0, bv: 0, sv: 0, n: 0,
    buyers: new Set(), sellers: new Set(),
  };
}

const P = (x) => Number(x.toPrecision(7));

function finalizeBucket(pool, k) {
  if (!(k.b > 0)) return;
  const vwap = k.q / k.b;
  const subV = k.sub.filter((s) => s.b > 0).map((s) => s.q / s.b);
  const row = {
    p: pool, t: k.ts,
    o: P(subV[0] ?? vwap), h: P(Math.max(...subV, vwap)), l: P(Math.min(...subV, vwap)), c: P(vwap),
    v: P(k.v), bv: P(k.bv), sv: P(k.sv), n: k.n,
    ub: k.buyers.size, us: k.sellers.size,
    by: [...k.buyers],
  };
  pending.push(JSON.stringify(row));
}

function aggSwap(st, s) {
  const minuteTs = Math.floor(s.ts / 60) * 60;
  if (st.cur && st.cur.ts !== minuteTs) { finalizeBucket(st.pool, st.cur); st.cur = null; }
  if (!st.cur) st.cur = newBucket(minuteTs);
  const k = st.cur;
  const base = s.amountQuote / s.price;
  const sub = k.sub[Math.min(3, Math.floor((s.ts - minuteTs) / 15))];
  sub.q += s.amountQuote; sub.b += base;
  k.q += s.amountQuote; k.b += base;
  k.v += s.amountQuote; k.n += 1;
  if (s.side === 'buy') { k.bv += s.amountQuote; k.buyers.add(s.walletHash); }
  else { k.sv += s.amountQuote; k.sellers.add(s.walletHash); }
}

function onSwap(s) {
  stats.swaps += 1;
  let st = pools.get(s.pool);
  if (!st) {
    if (materialized.has(s.pool)) {
      st = { mat: true, pool: s.pool, cur: null, lastTs: s.ts };
      pools.set(s.pool, st);
    } else {
      st = { mat: false, n: 0, buf: [], lastTs: s.ts };
      pools.set(s.pool, st);
    }
  }
  st.lastTs = s.ts;
  if (st.mat) { aggSwap(st, s); return; }
  st.n += 1;
  if (st.buf.length < TINY_BUFFER_MAX) st.buf.push(s);
  if (st.n >= LIFE_FLOOR) {
    const buf = st.buf;
    const ns = { mat: true, pool: s.pool, cur: null, lastTs: s.ts };
    pools.set(s.pool, ns);
    materialized.add(s.pool);
    poolsEverMaterialized += 1;
    for (const b of buf) aggSwap(ns, b);
  }
}

function evictAndFlush(nowTs, { finalizeAll = false } = {}) {
  for (const [pool, st] of pools) {
    const idle = nowTs - st.lastTs;
    if (finalizeAll || idle > EVICT_IDLE_SEC) {
      if (st.mat && st.cur) finalizeBucket(pool, st.cur);
      if (!st.mat) tinyDropped += 1;
      pools.delete(pool);
    }
  }
  if (pending.length) {
    fs.appendFileSync(outPath, pending.join('\n') + '\n');
    stats.rows += pending.length;
    pending.length = 0;
  }
}

function writeCkpt(lastBlock, lastTs, done = false) {
  fs.writeFileSync(ckptPath, JSON.stringify({
    chain: CHAIN, id: ID, start: START, stop: STOP,
    lastBlock, lastTs, done,
    rowsWritten: stats.rows, swapsSeen: stats.swaps,
    poolsEverMaterialized, tinyDropped, restarts: stats.restarts,
    updatedAt: new Date().toISOString(),
  }));
}

// ---- stream ----
const substreamPackage = await readPackage(cfg.spkg);
const registry = createRegistry(substreamPackage);
const transport = createNodeTransport(cfg.endpoint, getCreds().apiKey, registry);
const request = createRequest({
  substreamPackage, outputModule: cfg.module,
  startBlockNum: resumeFrom, stopBlockNum: STOP,
  productionMode: true,
});
const emitter = new BlockEmitter(transport, request, registry);

let lastBlock = resumeFrom - 1, lastTs = 0, lastFlushBlock = resumeFrom - 1;
let firstTs = null;
const t0 = Date.now();
let lastStatus = 0;

emitter.on('session', (s) => console.log(`[${ID}] session trace=${s.traceId} start=${s.resolvedStartBlock}`));

emitter.on('anyMessage', (msg, cursor, clock) => {
  const ts = Number(clock.timestamp?.seconds ?? 0);
  if (!ts) return;
  if (firstTs == null) firstTs = ts;
  lastTs = ts;
  lastBlock = Number(clock.number);
  stats.blocks += 1;
  for (const s of cfg.normalizeBlock(msg, ts)) onSwap(s);

  if (lastBlock - lastFlushBlock >= FLUSH_EVERY_BLOCKS || pending.length > 80_000) {
    evictAndFlush(ts);
    writeCkpt(lastBlock, ts);
    lastFlushBlock = lastBlock;
  }
  const now = Date.now();
  if (now - lastStatus > STATUS_EVERY_MS) {
    lastStatus = now;
    const dt = (now - t0) / 1000;
    const doneBlocks = lastBlock - resumeFrom + 1;
    const total = STOP - resumeFrom;
    const rate = doneBlocks / dt;
    const etaMin = rate > 0 ? (total - doneBlocks) / rate / 60 : Infinity;
    console.log(`[${ID}] ${lastBlock} (${((doneBlocks / total) * 100).toFixed(1)}%) ${rate.toFixed(1)} blk/s swaps=${stats.swaps} rows=${stats.rows} pools=${pools.size}/${materialized.size} eta=${etaMin.toFixed(0)}m`);
  }
});

emitter.on('close', (err) => {
  if (err) {
    console.error(`[${ID}] closed with error: ${err.message ?? err}`);
    evictAndFlush(lastTs || 0);
    if (lastBlock >= resumeFrom) writeCkpt(lastBlock, lastTs);
    process.exit(1);
  }
  // clean end of range
  evictAndFlush(lastTs, { finalizeAll: true });
  writeCkpt(lastBlock, lastTs, true);
  const dt = (Date.now() - t0) / 1000;
  console.log(`[${ID}] DONE blocks=${stats.blocks} wall=${(dt / 60).toFixed(1)}m rate=${(stats.blocks / Math.max(dt, 1)).toFixed(1)} blk/s swaps=${stats.swaps} rows=${stats.rows} matPools=${materialized.size} span=[${firstTs},${lastTs}]`);
  process.exit(0);
});

emitter.on('fatalError', (e) => {
  console.error(`[${ID}] FATAL: ${e.message ?? e}`);
  evictAndFlush(lastTs || 0);
  if (lastBlock >= resumeFrom) writeCkpt(lastBlock, lastTs);
  process.exit(1);
});

console.log(`[${ID}] ${CHAIN} [${resumeFrom}, ${STOP}) -> ${outPath}`);
emitter.start();
