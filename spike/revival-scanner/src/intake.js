// Labeled-token intake: capture a snapshot of a token's tape at label time.
//
//   node src/intake.js <mint> --label <revival|non-revival|fader> [--note "..."]
//
// Why this exists: minute-resolution candles expire from the public keyless
// APIs within days. When the operator labels a token ("this one revived",
// "this one faded and died"), the evidence must be captured AT LABEL TIME or
// it is gone. This script is the intake path for the labeled corpus — the
// operator keeps sending mints, each run writes a self-contained snapshot to
// data/labels/<symbol>-<mint8>-<YYYYMMDD>/.
//
// Sources (both keyless):
//   GeckoTerminal — all pools for the mint; minute + hourly OHLCV for the top
//     3 pools by 24h volume. Minute pages are walked backwards with
//     before_timestamp (up to MINUTE_PAGES pages ≈ 3.5 days) because a single
//     page (1000 min ≈ 16.6h) usually does not reach back to the event being
//     labeled.
//   DexScreener — token meta (symbol, liquidity, txn counts, priceNative
//     which pins the SOL/USD rate for unit conversion downstream).
//
// Idempotent: re-running for a mint finds the existing labels dir (matched on
// the 8-char mint prefix) and refreshes candles/meta in place.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LABELS_DIR = path.resolve(HERE, '../data/labels');

const GT_BASE = 'https://api.geckoterminal.com/api/v2';
const NETWORK = 'solana';
const TOP_POOLS = 3;
const MINUTE_PAGES = 5;       // 5 x 1000 min ≈ 3.5 days of minute tape
const GT_INTERVAL_MS = 2200;  // free tier: 30 calls/min — stay well under

const VALID_LABELS = new Set(['revival', 'non-revival', 'fader']);

function parseArgs(argv) {
  const args = argv.slice(2);
  const mint = args.find((a) => !a.startsWith('--'));
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : null;
  };
  return { mint, label: opt('--label'), note: opt('--note') };
}

let lastCall = 0;
async function throttledJson(url, opts = {}) {
  const wait = lastCall + GT_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  for (let attempt = 0; attempt < 4; attempt++) {
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(30_000), ...opts });
    } catch (e) {
      console.error(`  fetch error (${e.name ?? 'Error'}) attempt ${attempt + 1}/4: ${url}`);
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      const backoff = Math.min(20_000, 3000 * 2 ** attempt);
      console.error(`  HTTP ${res.status}, backing off ${(backoff / 1000).toFixed(0)}s`);
      await new Promise((r) => setTimeout(r, backoff));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
  throw new Error(`retries exhausted for ${url}`);
}

/** Fetch minute OHLCV walking backwards with before_timestamp. Ascending, deduped. */
async function fetchMinuteOhlcv(pool) {
  const all = new Map(); // ts -> row
  let before = null;
  let meta = null;
  for (let page = 0; page < MINUTE_PAGES; page++) {
    const url = new URL(`${GT_BASE}/networks/${NETWORK}/pools/${pool}/ohlcv/minute`);
    url.searchParams.set('aggregate', '1');
    url.searchParams.set('limit', '1000');
    url.searchParams.set('currency', 'usd');
    if (before != null) url.searchParams.set('before_timestamp', String(before));
    const json = await throttledJson(url.toString());
    const list = json?.data?.attributes?.ohlcv_list ?? [];
    meta = meta ?? json?.meta ?? null;
    if (!list.length) break;
    for (const row of list) all.set(row[0], row);
    const oldest = Math.min(...list.map((r) => r[0]));
    console.log(`    minute page ${page + 1}: ${list.length} candles (back to ${new Date(oldest * 1000).toISOString()})`);
    if (list.length < 1000) break; // reached the start of the tape
    before = oldest;
  }
  const rows = [...all.values()].sort((a, b) => a[0] - b[0]);
  return { meta, ohlcv: rows };
}

async function fetchHourOhlcv(pool) {
  const url = `${GT_BASE}/networks/${NETWORK}/pools/${pool}/ohlcv/hour?aggregate=1&limit=500&currency=usd`;
  const json = await throttledJson(url);
  const rows = (json?.data?.attributes?.ohlcv_list ?? []).sort((a, b) => a[0] - b[0]);
  return { meta: json?.meta ?? null, ohlcv: rows };
}

function sanitize(s) {
  return String(s ?? 'UNKNOWN').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16) || 'UNKNOWN';
}

/** Find an existing labels dir for this mint (idempotent re-runs). */
function findExistingDir(mint8) {
  if (!fs.existsSync(LABELS_DIR)) return null;
  const hit = fs.readdirSync(LABELS_DIR).find((d) => d.includes(`-${mint8}-`));
  return hit ? path.join(LABELS_DIR, hit) : null;
}

async function main() {
  const { mint, label, note } = parseArgs(process.argv);
  if (!mint || !label || !VALID_LABELS.has(label)) {
    console.error('usage: node src/intake.js <mint> --label <revival|non-revival|fader> [--note "..."]');
    process.exit(1);
  }

  console.log(`intake: ${mint} label=${label}`);

  // 1. All pools for the mint.
  const poolsJson = await throttledJson(
    `${GT_BASE}/networks/${NETWORK}/tokens/${mint}/pools?page=1`);
  const pools = poolsJson?.data ?? [];
  if (!pools.length) throw new Error('GeckoTerminal returned no pools for this mint');
  const ranked = [...pools].sort((a, b) =>
    Number(b.attributes?.volume_usd?.h24 ?? 0) - Number(a.attributes?.volume_usd?.h24 ?? 0));
  const top = ranked.slice(0, TOP_POOLS).map((p) => ({
    pool: p.attributes.address,
    name: p.attributes.name,
    dex: p.relationships?.dex?.data?.id ?? null,
    volumeUsd24h: Number(p.attributes.volume_usd?.h24 ?? 0),
    reserveUsd: Number(p.attributes.reserve_in_usd ?? 0),
    createdAt: p.attributes.pool_created_at ?? null,
  }));
  console.log(`  pools: ${pools.length} found, capturing top ${top.length} by 24h vol`);

  // 2. DexScreener meta.
  let dex = null;
  try {
    dex = await throttledJson(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
  } catch (e) {
    console.error(`  dexscreener failed (continuing): ${String(e).slice(0, 120)}`);
  }
  const dexPair = dex?.pairs?.length
    ? [...dex.pairs].sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0))[0]
    : null;
  const symbol = sanitize(dexPair?.baseToken?.symbol
    ?? top[0]?.name?.split('/')[0]?.trim());

  // 3. Resolve output dir (reuse existing for idempotency).
  const mint8 = mint.slice(0, 8);
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const dir = findExistingDir(mint8) ?? path.join(LABELS_DIR, `${symbol}-${mint8}-${today}`);
  fs.mkdirSync(dir, { recursive: true });
  console.log(`  dir: ${dir}`);

  fs.writeFileSync(path.join(dir, 'pools.json'), JSON.stringify(poolsJson, null, 2));
  if (dex) fs.writeFileSync(path.join(dir, 'dexscreener.json'), JSON.stringify(dex, null, 2));

  // 4. Candles for the top pools.
  for (const p of top) {
    console.log(`  pool ${p.pool} (${p.name}, $${Math.round(p.volumeUsd24h).toLocaleString()} 24h)`);
    const minute = await fetchMinuteOhlcv(p.pool);
    fs.writeFileSync(path.join(dir, `minute-${p.pool}.json`), JSON.stringify(minute));
    const hour = await fetchHourOhlcv(p.pool);
    fs.writeFileSync(path.join(dir, `hour-${p.pool}.json`), JSON.stringify(hour));
    p.minuteCandles = minute.ohlcv.length;
    p.hourCandles = hour.ohlcv.length;
    console.log(`    -> ${minute.ohlcv.length} minute candles, ${hour.ohlcv.length} hour candles`);
  }

  // 5. label.json — merge onto an existing one so re-runs refresh, not clobber.
  const labelPath = path.join(dir, 'label.json');
  const prev = fs.existsSync(labelPath) ? JSON.parse(fs.readFileSync(labelPath, 'utf8')) : {};
  const out = {
    mint,
    symbol,
    label,
    note: note ?? prev.note ?? null,
    firstCapturedAt: prev.firstCapturedAt ?? new Date().toISOString(),
    capturedAt: new Date().toISOString(),
    network: NETWORK,
    pools: top,
    dexscreener: dexPair ? {
      pair: dexPair.pairAddress,
      priceUsd: Number(dexPair.priceUsd ?? 0),
      priceNative: Number(dexPair.priceNative ?? 0),
      solUsd: Number(dexPair.priceNative) > 0
        ? Number(dexPair.priceUsd) / Number(dexPair.priceNative) : null,
      liquidityUsd: dexPair.liquidity?.usd ?? null,
      fdv: dexPair.fdv ?? null,
      marketCap: dexPair.marketCap ?? null,
      txns: dexPair.txns ?? null,
      volume: dexPair.volume ?? null,
    } : null,
  };
  fs.writeFileSync(labelPath, JSON.stringify(out, null, 2));
  console.log(`  wrote ${labelPath}`);
  console.log('done.');
}

main().catch((e) => { console.error(e); process.exit(1); });
