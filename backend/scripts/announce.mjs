#!/usr/bin/env node
// Post an update announcement to Discord via the bot API. Intended caller: an
// LLM coding agent, right after shipping a change — it writes the title/
// description itself and runs this, no Discord interaction involved.
//
// Usage:
//   node scripts/announce.mjs --title "..." --description "..." [--kind site|bot] [--image URL] [--link URL]
//
// Reads OCT_BOT_API_KEY from backend/.env and posts to the locally-running
// backend (OCT_LOCAL_API_URL to override, e.g. against a deployed instance).

import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '../.env'), override: false });

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

const title = arg('title');
const description = arg('description');
const kind = arg('kind', 'site');
const image = arg('image');
const link = arg('link');

if (!title || !description) {
  console.error(
    'Usage: announce.mjs --title "..." --description "..." [--kind site|bot] [--image URL] [--link URL]',
  );
  process.exit(1);
}
if (kind !== 'site' && kind !== 'bot') {
  console.error('--kind must be "site" or "bot"');
  process.exit(1);
}

const key = process.env.OCT_BOT_API_KEY;
if (!key) {
  console.error('OCT_BOT_API_KEY is not set in backend/.env.');
  process.exit(1);
}

const base = process.env.OCT_LOCAL_API_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;

const res = await fetch(`${base}/api/v1/bot/announce`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
  body: JSON.stringify({ title, description, kind, imageUrl: image ?? null, linkUrl: link ?? null }),
});

const json = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`Announce failed (${res.status}):`, json.error ?? res.statusText);
  process.exit(1);
}
console.log('Posted:', json);
