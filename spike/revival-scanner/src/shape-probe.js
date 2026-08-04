// Dump full decoded messages from a short historical replay so the corpus
// normalizer can be written against the real field names (per chain).
//   node src/shape-probe.js [--endpoint URL] [--spkg PATH] [--module map_events]
//                           [--start N | --back N] [--blocks 3] [--max-tx 3]
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

const ENDPOINT = opt('--endpoint', 'https://solana.substreams.pinax.network:443');
const SPKG = path.resolve(HERE, opt('--spkg', '../data/dex-swaps-v0.5.2.spkg'));
const MODULE = opt('--module', 'map_events');
const N = Number(opt('--blocks', 3));
const MAX_TX = Number(opt('--max-tx', 3));

const substreamPackage = await readPackage(SPKG);
if (args.includes('--list')) {
  for (const m of substreamPackage.modules?.modules ?? []) {
    console.log(`${m.name}  ->  ${m.output?.type?.replace('proto:', '') ?? '?'}`);
  }
  process.exit(0);
}

const creds = getCreds();
const registry = createRegistry(substreamPackage);
const transport = createNodeTransport(ENDPOINT, creds.apiKey, registry);

let start = opt('--start', null);
const fromHead = args.includes('--head');
if (start == null && !fromHead) {
  // Solana anchor fallback
  const ANCHOR_BLOCK = 437159877, ANCHOR_MS = Date.parse('2026-08-04T10:42:16Z');
  start = ANCHOR_BLOCK + Math.floor(((Date.now() - ANCHOR_MS) / 1000) * 2.4) - Number(opt('--back', 5000));
} else if (start != null) start = Number(start);

const request = createRequest({
  substreamPackage, outputModule: MODULE,
  ...(fromHead
    ? { startBlockNum: -1 }
    : { startBlockNum: start, stopBlockNum: start + N, productionMode: true }),
});
const emitter = new BlockEmitter(transport, request, registry);
console.log(`endpoint=${ENDPOINT} module=${MODULE} range=[${start},${start + N})`);

emitter.on('session', (s) => console.log(`session trace=${s.traceId} resolvedStart=${s.resolvedStartBlock}`));
let lastProg = 0;
emitter.on('progress', (p) => {
  if (Date.now() - lastProg > 5000) {
    lastProg = Date.now();
    console.log(`progress: ${JSON.stringify(p.runningStages ?? p.stages ?? []).slice(0, 160)}`);
  }
});
const seen = [];
let blocksSeen = 0;
emitter.on('clock', (clock) => {
  blocksSeen += 1;
  if (fromHead) {
    console.log(`head block ${clock.number} @ ${clock.timestamp?.toDate?.().toISOString?.() ?? ''}`);
    if (blocksSeen >= N) { console.log('done (head probe)'); process.exit(0); }
  }
});
emitter.on('anyMessage', (msg, cursor, clock) => {
  const j = JSON.parse(JSON.stringify(msg, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  seen.push({ block: String(clock.number), keys: Object.keys(j) });
  const txs = j.transactions ?? j.tableChanges ?? j.events ?? j.swaps ?? [];
  console.log(`\n== block ${clock.number} ts=${clock.timestamp?.toDate?.().toISOString?.() ?? ''} topKeys=${Object.keys(j)} items=${txs.length}`);
  for (const tx of txs.slice(0, MAX_TX)) {
    console.log(JSON.stringify(tx, null, 1).slice(0, 3000));
  }
});
emitter.on('close', (e) => {
  console.log(`\nclosed${e ? ' err=' + e.message : ''}; messages=${seen.length}`);
  process.exit(0);
});
emitter.on('fatalError', (e) => { console.error('FATAL', e.message); process.exit(1); });
emitter.start();
