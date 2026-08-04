// Per-chain corpus configuration + swap normalizers for the substreams
// training-corpus pipeline. Everything downstream of normalizeBlock() is
// chain-agnostic: it sees {ts, pool, walletHash, side, price, amountQuote}.
//
// amountQuote is expressed in SOL-EQUIVALENT units so the C0 volume floors
// (written in SOL) apply across chains. The conversion constants are rough
// (SOL≈$150, BNB≈$650) — they only gate volume floors/dormancy ceilings,
// never labels (labels are per-pool price ratios, which cancel decimals and
// quote units entirely).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------- base58 (Solana addresses; no deps) ----------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = Object.fromEntries([...B58].map((c, i) => [c, i]));

export function base58Decode(s) {
  let n = 0n;
  for (const c of s) {
    const v = B58_MAP[c];
    if (v === undefined) throw new Error('bad base58 char');
    n = n * 58n + BigInt(v);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c === '1') bytes.unshift(0); else break; }
  return Buffer.from(bytes);
}

export function base58Encode(buf) {
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b === 0) out = '1' + out; else break; }
  return out;
}

const b58ToB64 = (addr) => base58Decode(addr).toString('base64');

// ---------- wallet hashing (fnv1a-32; buyers stored as compact ints) ----------
export function walletHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ---------- Solana ----------
// map_events -> dex.swaps.v1.Events: transactions[].swaps[] with base64
// addresses and raw integer amounts. Routers (Jupiter etc.) re-report the
// underlying AMM swap: dedupe within a tx by (pool,inputMint,inputAmount),
// keeping the deepest stackHeight (the actual pool execution).
const SOL_QUOTES = {
  [b58ToB64('So11111111111111111111111111111111111111112')]: { div: 1e9, solRate: 1 },        // WSOL
  [b58ToB64('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')]: { div: 1e6, solRate: 1 / 150 }, // USDC
  [b58ToB64('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB')]: { div: 1e6, solRate: 1 / 150 }, // USDT
};

const poolB58Cache = new Map(); // base64 -> base58 (pools repeat heavily)
function poolId(b64) {
  let v = poolB58Cache.get(b64);
  if (!v) {
    v = base58Encode(Buffer.from(b64, 'base64'));
    if (poolB58Cache.size > 400_000) poolB58Cache.clear();
    poolB58Cache.set(b64, v);
  }
  return v;
}

function* normalizeSolanaBlock(msg, blockTs) {
  for (const tx of msg.transactions ?? []) {
    const swaps = tx.swaps ?? [];
    if (!swaps.length) continue;
    // dedupe router duplicates, keep deepest stackHeight
    const best = new Map();
    for (const s of swaps) {
      const k = `${s.ammPool}|${s.inputMint}|${s.inputAmount}`;
      const prev = best.get(k);
      if (!prev || (s.stackHeight ?? 0) > (prev.stackHeight ?? 0)) best.set(k, s);
    }
    const w = walletHash(tx.feePayer ?? '');
    for (const s of best.values()) {
      if (!s.ammPool || !s.inputMint || !s.outputMint) continue; // partial decode
      const qi = SOL_QUOTES[s.inputMint], qo = SOL_QUOTES[s.outputMint];
      if (qi && qo) continue;       // quote-quote pool (majors), not a memecoin pair
      if (!qi && !qo) continue;     // token-token leg, unpriceable here
      const inAmt = Number(s.inputAmount), outAmt = Number(s.outputAmount);
      if (!(inAmt > 0) || !(outAmt > 0)) continue;
      const side = qi ? 'buy' : 'sell';
      const q = qi ?? qo;
      const quoteRaw = qi ? inAmt : outAmt;
      const baseRaw = qi ? outAmt : inAmt;
      yield {
        ts: blockTs,
        pool: poolId(s.ammPool),
        walletHash: w,
        side,
        price: quoteRaw / baseRaw,                    // raw ratio; decimals cancel per pool
        amountQuote: (quoteRaw / q.div) * q.solRate,  // SOL-equivalent notional
      };
    }
  }
}

// ---------- BSC ----------
// evm-dex-v0.5.0 db_out -> DatabaseChanges. Warm Pinax cache (this is the
// package behind their REST). Rows are self-describing string fields with hex
// addresses. kyber_elastic_swap re-claims uniswap_v3 logs -> dedupe on
// (tx_hash, log_ordinal) and skip kyber entirely.
const BSC_QUOTES = {
  '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': { div: 1e18, solRate: 650 / 150 }, // WBNB
  '0x55d398326f99059ff775485246999027b3197955': { div: 1e18, solRate: 1 / 150 },   // USDT
  '0xe9e7cea3dedca5984780bafc599bd69add087d56': { div: 1e18, solRate: 1 / 150 },   // BUSD
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': { div: 1e18, solRate: 1 / 150 },   // USDC
};

const BSC_SWAP_TABLES = new Set(['uniswap_v2_swap', 'uniswap_v3_swap', 'uniswap_v4_swap']);

function fieldsToObj(tc) {
  const o = {};
  for (const f of tc.fields ?? []) o[f.name] = f.newValue;
  return o;
}

function* normalizeBscBlock(msg, blockTs) {
  const seen = new Set(); // tx_hash|log_ordinal dedupe across protocol decoders
  for (const tc of msg.tableChanges ?? []) {
    if (!BSC_SWAP_TABLES.has(tc.table)) continue;
    const r = fieldsToObj(tc);
    const dk = `${r.tx_hash}|${r.log_ordinal}`;
    if (seen.has(dk)) continue;
    seen.add(dk);

    let pool, t0, t1, amt0, amt1;
    if (tc.table === 'uniswap_v2_swap') {
      pool = r.log_address; t0 = r.token0; t1 = r.token1;
      amt0 = Number(r.amount0_in) - Number(r.amount0_out);   // + = into pool
      amt1 = Number(r.amount1_in) - Number(r.amount1_out);
    } else if (tc.table === 'uniswap_v3_swap') {
      pool = r.log_address; t0 = r.token0; t1 = r.token1;
      amt0 = Number(r.amount0);                              // + = into pool
      amt1 = Number(r.amount1);
    } else { // uniswap_v4_swap: user perspective, + = user receives
      pool = r.id; t0 = r.currency0; t1 = r.currency1;
      amt0 = -Number(r.amount0);                             // flip to pool perspective
      amt1 = -Number(r.amount1);
    }
    if (!pool || !t0 || !t1) continue;
    const q0 = BSC_QUOTES[t0], q1 = BSC_QUOTES[t1];
    if (q0 && q1) continue;
    if (!q0 && !q1) continue;
    const q = q0 ?? q1;
    const quoteAmt = q0 ? amt0 : amt1;
    const baseAmt = q0 ? amt1 : amt0;
    if (!isFinite(quoteAmt) || !isFinite(baseAmt) || quoteAmt === 0 || baseAmt === 0) continue;
    if (quoteAmt > 0 === baseAmt > 0) continue; // same-sign: not a swap shape we price
    const side = quoteAmt > 0 ? 'buy' : 'sell'; // quote flowed INTO the pool = buy
    yield {
      ts: blockTs,
      pool,
      walletHash: walletHash(r.tx_from ?? ''),
      side,
      price: Math.abs(quoteAmt) / Math.abs(baseAmt),
      amountQuote: (Math.abs(quoteAmt) / q.div) * q.solRate,
    };
  }
}

// ---------- registry ----------
export const CHAINS = {
  solana: {
    endpoint: 'https://solana.substreams.pinax.network:443',
    spkg: path.resolve(HERE, '../../data/dex-swaps-v0.5.2.spkg'),
    module: 'map_events',
    normalizeBlock: normalizeSolanaBlock,
    // head anchor for block<->time math
    anchorBlock: 437159877, anchorMs: Date.parse('2026-08-04T10:42:16Z'), blkPerSec: 2.4,
  },
  bsc: {
    endpoint: 'https://bsc.substreams.pinax.network:443',
    spkg: path.resolve(HERE, '../../data/evm-dex-v0.5.0.spkg'),
    module: 'db_out',
    normalizeBlock: normalizeBscBlock,
    anchorBlock: 113959676, anchorMs: Date.parse('2026-08-04T11:13:45Z'), blkPerSec: 2.222,
  },
};

export function estimateHead(chain) {
  const c = CHAINS[chain];
  return c.anchorBlock + Math.floor(((Date.now() - c.anchorMs) / 1000) * c.blkPerSec);
}

export function blockAtTime(chain, msEpoch) {
  const c = CHAINS[chain];
  return c.anchorBlock + Math.round(((msEpoch - c.anchorMs) / 1000) * c.blkPerSec);
}
