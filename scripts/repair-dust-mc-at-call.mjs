#!/usr/bin/env node
/**
 * One-off repair: null out the dust MC@call readings already stored in
 * `caller_calls`.
 *
 * WHAT NEEDS RECOMPUTING AND WHAT DOES NOT
 *
 * Nothing about the *board* needs recomputing. Caller aggregates are not
 * materialized — `caller_quality_aggregate` joins `caller_calls` to
 * `token_peaks` on every read — so the moment the migration
 * 20260905120000_caller_quality_mc_floor.sql is applied, every dust row stops
 * being rated and the absurd multiples disappear. No backfill, no re-derive.
 *
 * What DOES need a one-off touch is the stored readings themselves. The upsert
 * in `caller_calls_upsert` only ever fills a NULL `fdv_at_call` (a later
 * repost must not overwrite a point-in-time reading), so a row that already
 * holds a dust value can never be re-priced — enrichment will produce a good
 * MC@call minutes later and the upsert will decline to take it, forever. Set
 * those readings to NULL and the normal reconcile pass can fill them in.
 *
 * That is a WRITE to production data, so it is deliberately not automatic and
 * not part of any deploy. Run it by hand, once, after the migration is applied.
 *
 * The rows are unrated either way, so skipping this script is a perfectly
 * valid choice — it costs nothing but the chance of those calls ever scoring.
 *
 * Scope, deliberately narrow:
 *   - `caller_calls` only. `contracts` is left alone (its dust values are the
 *     historical record of what enrichment said, and the scoring path no
 *     longer reads them for anything).
 *   - No deletes. `fdv_at_call` is set to NULL; every other column is
 *     untouched, and the call still counts toward the caller's `calls`.
 *
 * Env (read from backend/.env if present, else the process env):
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY)
 *
 * Flags:
 *   (default)  dry run — prints every affected row, writes nothing
 *   --apply    perform the update
 *
 * Usage:
 *   node scripts/repair-dust-mc-at-call.mjs
 *   node scripts/repair-dust-mc-at-call.mjs --apply
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The floor lives in packages/shared (MIN_MC_AT_CALL). Restated as a literal
// here on purpose: this script is run by hand from a checkout that may not be
// built, and a repair script must not depend on a build step.
const MIN_MC_AT_CALL = 1000;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apply = process.argv.includes('--apply');

function loadEnv() {
  const envPath = path.join(root, 'backend', '.env');
  const out = { ...process.env };
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && !process.env[m[1]]) out[m[1]] = m[2].trim();
    }
  }
  return out;
}

const env = loadEnv();
const url = env.SUPABASE_URL?.trim();
const key = (env.SUPABASE_SERVICE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY)?.trim();
if (!url || !key) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required.');
  process.exit(1);
}

const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

const listUrl =
  `${url}/rest/v1/caller_calls` +
  `?select=user_id,caller_key,display_name,address,fdv_at_call,called_at` +
  `&fdv_at_call=not.is.null&fdv_at_call=lt.${MIN_MC_AT_CALL}` +
  `&order=fdv_at_call.asc&limit=5000`;

const res = await fetch(listUrl, { headers });
if (!res.ok) {
  console.error(`Read failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const rows = await res.json();

console.log(`Rows with fdv_at_call < $${MIN_MC_AT_CALL}: ${rows.length}`);
for (const r of rows) {
  console.log(
    `  ${String(r.fdv_at_call).padStart(16)}  ${r.caller_key.padEnd(28)}  ` +
      `${(r.display_name ?? '').slice(0, 26).padEnd(26)}  ${r.address}`,
  );
}

if (rows.length === 0) process.exit(0);

if (!apply) {
  console.log('\nDry run — nothing written. Re-run with --apply to null these readings.');
  process.exit(0);
}

// PATCH by the primary key (user_id, caller_key, address), one row at a time.
// A filtered bulk PATCH would be fewer round trips, but this is a handful of
// rows run once, and per-row addressing makes an accidental over-match
// impossible.
let updated = 0;
for (const r of rows) {
  const q =
    `${url}/rest/v1/caller_calls` +
    `?user_id=eq.${encodeURIComponent(r.user_id)}` +
    `&caller_key=eq.${encodeURIComponent(r.caller_key)}` +
    `&address=eq.${encodeURIComponent(r.address)}`;
  const patch = await fetch(q, {
    method: 'PATCH',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify({ fdv_at_call: null }),
  });
  if (!patch.ok) {
    console.error(`  FAILED ${r.caller_key} ${r.address}: ${patch.status} ${await patch.text()}`);
    continue;
  }
  updated++;
}
console.log(`\nNulled ${updated} of ${rows.length} readings.`);
