// Reads Pinax credentials at runtime from the OCT backend .env.
// Never logs, copies, or commits the values.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function findBackendEnv() {
  const candidates = [
    // canonical checkout
    'D:/Projects/Coding/active/Onchain Tools/backend/.env',
    // relative fallback (spike/revival-scanner/src -> repo root -> backend)
    path.resolve(HERE, '../../../backend/.env'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('backend/.env not found; set PINAX_API_KEY / PINAX_API_TOKEN in env instead');
}

function parseDotenv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

let cached = null;
export function getCreds() {
  if (cached) return cached;
  let apiKey = process.env.PINAX_API_KEY;
  let apiToken = process.env.PINAX_API_TOKEN;
  if (!apiKey || !apiToken) {
    const env = parseDotenv(fs.readFileSync(findBackendEnv(), 'utf8'));
    apiKey = apiKey || env.PINAX_API_KEY;
    apiToken = apiToken || env.PINAX_API_TOKEN;
  }
  if (!apiKey) throw new Error('PINAX_API_KEY missing');
  cached = { apiKey, apiToken };
  return cached;
}
