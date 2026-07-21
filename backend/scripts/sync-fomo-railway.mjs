#!/usr/bin/env node
/** Push FOMO_* secrets from backend/.env to linked Railway service. */
import { config } from 'dotenv';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dir, '../.env') });

const KEYS = [
  'FOMO_REFRESH_TOKEN',
  'FOMO_PRIVY_APP_ID',
  'FOMO_PRIVY_CLIENT',
  'FOMO_PRIVY_CLIENT_ID',
  'FOMO_PRIVY_CA_ID',
  'FOMO_PRIVY_TOKEN',
  'FOMO_PRIVY_SESSION',
  'FOMO_CF_CLEARANCE',
  'FOMO_CF_BM',
  'FOMO_CF_UVID',
];

let set = 0;
for (const key of KEYS) {
  const value = process.env[key];
  if (!value?.trim()) {
    console.log(`skip ${key} (empty)`);
    continue;
  }
  execFileSync('railway', ['variables', '--set', `${key}=${value}`], {
    stdio: 'inherit',
    cwd: path.resolve(__dir, '../..'),
  });
  set += 1;
  console.log(`set ${key} (${value.length} chars)`);
}

console.log(`Done — updated ${set} Railway variable(s).`);
