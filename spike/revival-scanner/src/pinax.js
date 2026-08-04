// Minimal Pinax REST client: throttled, disk-cached, polite.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getCreds } from './env.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(HERE, '../data');
const CACHE_DIR = path.join(DATA_DIR, 'http-cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

export const BASE = 'https://api.pinax.network';

const MIN_INTERVAL_MS = Number(process.env.PINAX_MIN_INTERVAL_MS || 350);
let lastCall = 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function cachePath(url) {
  const h = crypto.createHash('sha256').update(url).digest('hex').slice(0, 40);
  return path.join(CACHE_DIR, h + '.json');
}

/**
 * GET a Pinax REST path with query params. Caches successful responses to
 * disk keyed by full URL so reruns are free. Pass {cache:false} to bypass.
 */
export async function pinaxGet(pathname, params = {}, opts = {}) {
  const { cache = true, maxRetries = 4 } = opts;
  const url = new URL(pathname, BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const full = url.toString();
  const cp = cachePath(full);
  if (cache && fs.existsSync(cp)) {
    return JSON.parse(fs.readFileSync(cp, 'utf8'));
  }

  const { apiKey } = getCreds();
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const wait = lastCall + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    let res;
    try {
      res = await fetch(full, {
        headers: { 'X-Api-Key': apiKey },
        signal: AbortSignal.timeout(45_000),
      });
    } catch (e) {
      console.error(`  pinax fetch error (${e.name ?? 'Error'}), attempt ${attempt + 1}/${maxRetries + 1}`);
      if (attempt === maxRetries) throw e;
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      const backoff = Math.min(10000, 1500 * 2 ** attempt);
      console.error(`  pinax ${res.status}, backing off ${(backoff / 1000).toFixed(0)}s (attempt ${attempt + 1}/${maxRetries + 1})`);
      await sleep(backoff);
      continue;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Pinax ${res.status} for ${pathname}: ${body.slice(0, 300)}`);
    }
    const json = await res.json();
    if (cache) fs.writeFileSync(cp, JSON.stringify(json));
    return json;
  }
  throw new Error(`Pinax retries exhausted for ${pathname}`);
}
