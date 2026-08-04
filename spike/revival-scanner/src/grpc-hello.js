// C1: Substreams gRPC hello-world.
// Streams Pinax's own dex-swaps package (the one behind REST /v1/svm/swaps)
// from Solana chain head and prints decoded swap messages.
//
//   node src/grpc-hello.js [--list] [--blocks N] [--module NAME]
//
// Package: dex-swaps-v0.5.2.spkg (pinax-network/substreams-svm release
// svm-dex-v0.5.2) — downloaded to data/ by the setup steps in README.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRegistry, createRequest } from '@substreams/core';
import { readPackage } from '@substreams/manifest';
import { BlockEmitter } from '@substreams/node';
import { createNodeTransport } from '@substreams/node/createNodeTransport';
import { getCreds } from './env.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPKG = path.resolve(HERE, '../data/dex-swaps-v0.5.2.spkg');
const ENDPOINT = process.env.SUBSTREAMS_ENDPOINT || 'https://solana.substreams.pinax.network:443';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const substreamPackage = await readPackage(SPKG);
const modules = substreamPackage.modules?.modules ?? [];

if (flag('--list')) {
  for (const m of modules) {
    const out = m.output?.type?.replace('proto:', '') ?? '?';
    console.log(`${m.name}  ->  ${out}`);
  }
  process.exit(0);
}

const outputModule = opt('--module', modules.find((m) => /map/.test(m.name))?.name ?? modules[0]?.name);
const nBlocks = Number(opt('--blocks', 5));
const creds = getCreds();
// --auth jwt | key  (which credential to present as the bearer token)
// VERIFIED 2026-08-04: Pinax substreams accepts the raw PINAX_API_KEY as the
// bearer and REJECTS the account JWT ("invalid api key") — key is the default.
const authMode = opt('--auth', 'key');
const bearer = authMode === 'key' ? creds.apiKey : creds.apiToken;
if (!bearer) throw new Error('credential missing for auth mode ' + authMode);

console.log(`endpoint=${ENDPOINT} module=${outputModule} blocks=${nBlocks} (from head)`);

const registry = createRegistry(substreamPackage);
const transport = createNodeTransport(ENDPOINT, bearer, registry);
const request = createRequest({
  substreamPackage,
  outputModule,
  startBlockNum: -1, // relative to head; stream until we count nBlocks then exit
});

const emitter = new BlockEmitter(transport, request, registry);
let messages = 0;
let blocks = 0;

emitter.on('session', (session) => {
  console.log(`session traceId=${session.traceId} resolvedStartBlock=${session.resolvedStartBlock}`);
});
emitter.on('clock', (clock) => {
  blocks += 1;
  console.log(`-- block ${clock.number} @ ${clock.timestamp?.toDate?.().toISOString?.() ?? ''}`);
  if (blocks >= nBlocks) {
    console.log(`\nSUCCESS: streamed ${blocks} blocks from head, decoded ${messages} messages.`);
    process.exit(0);
  }
});
emitter.on('anyMessage', (message, cursor, clock) => {
  messages += 1;
  const json = JSON.stringify(message, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
  console.log(json.length > 900 ? json.slice(0, 900) + `...(${json.length}B)` : json);
});
emitter.on('fatalError', (e) => {
  console.error('FATAL', e);
  process.exit(1);
});
emitter.on('close', (e) => {
  console.log(`\nstream closed${e ? ' with error: ' + e : ''}; decoded messages=${messages}`);
  process.exit(e ? 1 : 0);
});

emitter.start();
