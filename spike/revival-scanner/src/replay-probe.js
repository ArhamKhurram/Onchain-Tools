// Measure substreams HISTORICAL replay throughput: stream map_events over a
// past block range and report blocks/sec + payload volume. Sizes the corpus
// window before we commit to a long job.
//   node src/replay-probe.js [--back 50000] [--blocks 2000] [--endpoint URL] [--spkg PATH]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRegistry, createRequest } from '@substreams/core';
import { readPackage } from '@substreams/manifest';
import { BlockEmitter } from '@substreams/node';
import { createNodeTransport } from '@substreams/node/createNodeTransport';
import { getCreds } from './env.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const ENDPOINT = opt('--endpoint', process.env.SUBSTREAMS_ENDPOINT || 'https://solana.substreams.pinax.network:443');
const SPKG = path.resolve(HERE, opt('--spkg', '../data/dex-swaps-v0.5.2.spkg'));
const BACK = Number(opt('--back', 50_000));
const N = Number(opt('--blocks', 2_000));
const MODULE = opt('--module', 'map_events');

const substreamPackage = await readPackage(SPKG);
const creds = getCreds();
const registry = createRegistry(substreamPackage);
const transport = createNodeTransport(ENDPOINT, creds.apiKey, registry);

// Start block: explicit --start, or derived from a known recent head anchor.
// (A separate head-discovery emitter on the same transport wedges; avoid it.)
const startOpt = opt('--start', null);
// Anchor: Solana block 437159877 observed at 2026-08-04T10:42:16Z (~2.4 blk/s).
const ANCHOR_BLOCK = 437159877, ANCHOR_MS = Date.parse('2026-08-04T10:42:16Z');
const headEst = ANCHOR_BLOCK + Math.floor(((Date.now() - ANCHOR_MS) / 1000) * 2.4);
const start = startOpt ? Number(startOpt) : headEst - BACK;
const headBlock = headEst;
console.log(`head=${headBlock} → replaying [${start}, ${start + N}) (${BACK} blocks back)`);

const request = createRequest({
  substreamPackage, outputModule: MODULE,
  startBlockNum: start, stopBlockNum: start + N,
  productionMode: true, // dev mode backprocesses historical ranges silently
});
const emitter = new BlockEmitter(transport, request, registry);
console.log('connecting…');
emitter.on('session', (s) => console.log(`session trace=${s.traceId} resolvedStart=${s.resolvedStartBlock}`));
emitter.on('progress', (p) => {
  const stages = p.runningStages ?? p.stages ?? [];
  console.log(`progress: ${JSON.stringify(stages).slice(0, 160)}`);
});

let blocks = 0, bytes = 0, swaps = 0, t0 = null, firstTs = null, lastTs = null;
emitter.on('anyMessage', (msg) => {
  const j = JSON.stringify(msg);
  bytes += j.length;
  for (const tx of msg.transactions ?? []) swaps += (tx.swaps ?? []).length;
});
emitter.on('clock', (clock) => {
  if (t0 == null) t0 = Date.now();
  blocks += 1;
  const ts = Number(clock.timestamp?.seconds ?? 0);
  if (firstTs == null) firstTs = ts;
  lastTs = ts;
  if (blocks % 500 === 0) {
    const dt = (Date.now() - t0) / 1000;
    console.log(`  ${blocks} blocks in ${dt.toFixed(1)}s (${(blocks / dt).toFixed(1)} blk/s, ${(bytes / 1e6).toFixed(1)} MB, ${swaps} swaps)`);
  }
});
emitter.on('close', (err) => {
  const dt = (Date.now() - (t0 ?? Date.now())) / 1000;
  const chainSpanH = firstTs && lastTs ? (lastTs - firstTs) / 3600 : 0;
  console.log(`\nDONE${err ? ' (with error: ' + err.message + ')' : ''}`);
  console.log(`blocks=${blocks} wall=${dt.toFixed(1)}s rate=${(blocks / Math.max(dt, 0.01)).toFixed(1)} blk/s`);
  console.log(`payload=${(bytes / 1e6).toFixed(1)} MB swaps=${swaps} chainSpan=${chainSpanH.toFixed(2)}h`);
  if (blocks > 0 && dt > 0) {
    const rate = blocks / dt;
    const daySec = 86400 * 2.5; // ~solana blocks/day at 2.5 blk/s... computed from data below
    const blocksPerDay = firstTs && lastTs && lastTs > firstTs ? blocks / ((lastTs - firstTs) / 86400) : daySec;
    console.log(`≈${(blocksPerDay / rate / 60).toFixed(1)} min of wall-clock per chain-day at this rate`);
  }
  process.exit(err ? 1 : 0);
});
emitter.on('fatalError', (e) => { console.error('FATAL:', e.message); process.exit(1); });
emitter.start();
