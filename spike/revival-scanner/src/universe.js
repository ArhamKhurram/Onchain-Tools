// C2 (part 1): build a universe of active-ish Solana meme pools by sampling
// global swap pages at time points spread across the window. Selecting per
// sample-day (not just "hot right now") reduces survivorship bias: pools that
// were busy two weeks ago and are quiet today still make the cut.
import fs from 'node:fs';
import path from 'node:path';
import { pinaxGet, DATA_DIR } from './pinax.js';
import {
  WINDOW_START, WINDOW_END, WINDOW_DAYS, SAMPLES_PER_DAY,
  WSOL, MAJORS, UNIVERSE_TARGET, PAGE_LIMIT,
} from './config.js';

const OUT = path.join(DATA_DIR, 'universe.json');

function* sampleTimes() {
  const start = Date.parse(WINDOW_START);
  const end = Date.parse(WINDOW_END);
  const step = 86400_000 / SAMPLES_PER_DAY;
  // offset by 3h so samples do not all land at midnight UTC
  for (let t = start + 3 * 3600_000; t < end; t += step) yield t;
}

function classify(swap) {
  // Returns { base, quote, symbol } for a SOL-quoted pool swap, else null.
  const im = swap.input_mint, om = swap.output_mint;
  if (im === WSOL && !MAJORS.has(om)) {
    return { base: om, symbol: swap.output_token?.symbol ?? null };
  }
  if (om === WSOL && !MAJORS.has(im)) {
    return { base: im, symbol: swap.input_token?.symbol ?? null };
  }
  return null;
}

async function main() {
  /** pool -> { pool, base, symbol, protocol, trades, days:Set, firstSeen, lastSeen } */
  const pools = new Map();
  const perSlot = []; // [{slot, topPools: [...]}] for balanced selection

  for (const t of sampleTimes()) {
    const iso = new Date(t).toISOString().replace('.000Z', 'Z');
    const endIso = new Date(t + 10 * 60_000).toISOString().replace('.000Z', 'Z');
    const res = await pinaxGet('/v1/svm/swaps', {
      network: 'solana', start_time: iso, end_time: endIso, limit: PAGE_LIMIT, page: 1,
    });
    const slotCounts = new Map();
    for (const s of res.data ?? []) {
      const c = classify(s);
      if (!c || !s.amm_pool) continue;
      const key = s.amm_pool;
      let p = pools.get(key);
      if (!p) {
        p = { pool: key, base: c.base, symbol: c.symbol, protocol: s.protocol,
              trades: 0, days: new Set(), firstSeen: iso, lastSeen: iso };
        pools.set(key, p);
      }
      p.trades += 1;
      p.days.add(iso.slice(0, 10));
      p.lastSeen = iso;
      if (c.symbol && !p.symbol) p.symbol = c.symbol;
      slotCounts.set(key, (slotCounts.get(key) ?? 0) + 1);
    }
    const top = [...slotCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k]) => k);
    perSlot.push({ slot: iso, sampled: res.data?.length ?? 0, top });
    console.log(`${iso}  swaps=${res.data?.length ?? 0}  pools=${slotCounts.size}`);
  }

  // Balanced selection: round-robin the per-slot top pools so every sample day
  // contributes, then fill remaining seats by total trade count.
  const selected = new Set();
  let added = true;
  for (let rank = 0; added && selected.size < UNIVERSE_TARGET; rank++) {
    added = false;
    for (const slot of perSlot) {
      if (selected.size >= UNIVERSE_TARGET) break;
      const p = slot.top[rank];
      if (p && !selected.has(p)) { selected.add(p); added = true; }
    }
  }
  if (selected.size < UNIVERSE_TARGET) {
    for (const [k] of [...pools.entries()].sort((a, b) => b[1].trades - a[1].trades)) {
      if (selected.size >= UNIVERSE_TARGET) break;
      selected.add(k);
    }
  }

  const universe = [...selected].map((k) => {
    const p = pools.get(k);
    return { ...p, days: [...p.days].sort() };
  });
  fs.writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    window: { start: WINDOW_START, end: WINDOW_END, days: WINDOW_DAYS },
    slots: perSlot.length,
    poolsSeen: pools.size,
    universe,
  }, null, 2));
  console.log(`\nSelected ${universe.length} pools out of ${pools.size} seen -> ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
