// C2 (part 2): backfill raw swaps for every universe pool over the window and
// store normalized SwapEvents as JSONL (one file per pool). HTTP pages are
// disk-cached by pinax.js, so reruns cost nothing.
import fs from 'node:fs';
import path from 'node:path';
import { pinaxGet, DATA_DIR } from './pinax.js';
import {
  WINDOW_START, WINDOW_END, WSOL, MAJORS, MAX_PAGES_PER_POOL, PAGE_LIMIT,
  BACKFILL_CONCURRENCY,
} from './config.js';

const SWAP_DIR = path.join(DATA_DIR, 'swaps');
fs.mkdirSync(SWAP_DIR, { recursive: true });

/**
 * Normalize a Pinax swap row into the spike's SwapEvent.
 * Price is in quote units (SOL) per base token. Returns null for rows that
 * are not base-vs-SOL or have degenerate amounts.
 */
export function normalizeSwap(row, baseMint) {
  const im = row.input_mint, om = row.output_mint;
  let side, quoteAmt, baseAmt;
  if (im === WSOL && om === baseMint) {
    side = 'buy'; quoteAmt = row.input_value; baseAmt = row.output_value;
  } else if (im === baseMint && om === WSOL) {
    side = 'sell'; quoteAmt = row.output_value; baseAmt = row.input_value;
  } else {
    return null; // token-token route or wrong pair
  }
  if (!(quoteAmt > 0) || !(baseAmt > 0)) return null;
  return {
    ts: row.timestamp,               // unix seconds
    pool: row.amm_pool,
    token: baseMint,
    price: quoteAmt / baseAmt,       // SOL per token
    amountQuote: quoteAmt,           // SOL notional
    side,
    wallet: row.user || row.signer || row.fee_payer,
    txHash: row.signature,
  };
}

async function backfillPool(entry) {
  const out = path.join(SWAP_DIR, `${entry.pool}.jsonl`);
  const meta = path.join(SWAP_DIR, `${entry.pool}.meta.json`);
  if (fs.existsSync(meta)) {
    const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
    // Failed pools are retried only when explicitly asked (RETRY_FAILED=1) —
    // their pages are cached, so a retry only pays for the pages it lacks.
    if (!m.failed || !process.env.RETRY_FAILED) return m;
  }

  const events = [];
  let pages = 0;
  let truncated = false;
  let hot = false;
  let earliest = Infinity;
  const endSec = Math.floor(Date.parse(WINDOW_END) / 1000);
  let failed = false;
  for (let page = 1; page <= MAX_PAGES_PER_POOL; page++) {
    let res;
    try {
      res = await pinaxGet('/v1/svm/swaps', {
        network: 'solana', amm_pool: entry.pool,
        start_time: WINDOW_START, end_time: WINDOW_END,
        limit: PAGE_LIMIT, page,
      });
    } catch (e) {
      // Persistent 500s on this pool's scan: keep whatever pages we already
      // have (they are cached; a later rerun picks up where we stopped).
      failed = true; truncated = true;
      break;
    }
    pages = page;
    const rows = res.data ?? [];
    for (const row of rows) {
      if (row.timestamp < earliest) earliest = row.timestamp;
      const ev = normalizeSwap(row, entry.base);
      if (ev) events.push(ev);
    }
    if (rows.length < PAGE_LIMIT) break;
    // Early stop for ultra-hot pools: pagination is newest-first, so if 8
    // pages have not even reached 36h back, the pool trades far too densely
    // to ever satisfy the 6h dormancy precondition — further pages are
    // wasted request budget for this measurement.
    if (page >= 8 && endSec - earliest < 36 * 3600) {
      truncated = true; hot = true;
      break;
    }
    if (page === MAX_PAGES_PER_POOL) truncated = true;
  }
  // API returns newest-first; store ascending.
  events.sort((a, b) => a.ts - b.ts);
  const lines = events.map((e) => JSON.stringify(e)).join('\n');
  fs.writeFileSync(out, lines + (lines ? '\n' : ''));
  const m = {
    pool: entry.pool, base: entry.base, symbol: entry.symbol, protocol: entry.protocol,
    swaps: events.length, pages, truncated, hot, failed,
    firstTs: events[0]?.ts ?? null, lastTs: events[events.length - 1]?.ts ?? null,
  };
  fs.writeFileSync(meta, JSON.stringify(m));
  return m;
}

async function main() {
  const uni = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'universe.json'), 'utf8'));
  const queue = [...uni.universe];
  let done = 0, totalSwaps = 0;
  async function worker() {
    for (;;) {
      const entry = queue.shift();
      if (!entry) return;
      try {
        const m = await backfillPool(entry);
        done++; totalSwaps += m.swaps;
        console.log(`[${done}/${uni.universe.length}] ${m.symbol ?? m.pool.slice(0, 8)}  swaps=${m.swaps}${m.truncated ? ' TRUNCATED' : ''}`);
      } catch (e) {
        done++;
        console.error(`[${done}/${uni.universe.length}] ${entry.symbol ?? entry.pool.slice(0, 8)}  FAILED: ${String(e).slice(0, 120)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: BACKFILL_CONCURRENCY }, worker));
  console.log(`\nBackfill complete: ${done} pools, ${totalSwaps} normalized swaps.`);
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
