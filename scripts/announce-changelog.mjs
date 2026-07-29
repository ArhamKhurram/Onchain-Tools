#!/usr/bin/env node
/**
 * Post the newest CHANGELOG.md entry to Discord as a branded announcement.
 *
 * Runs from CI on pushes to main (.github/workflows/announce.yml) and can be
 * triggered by hand for a backfill. Delivery goes through the existing
 * POST /api/v1/bot/announce, so this adds no second Discord login and no new
 * secret — it reuses OCT_BOT_API_KEY and the bot's already-connected client.
 *
 * Deliberately does nothing unless the push actually added a new dated section.
 * A changelog typo fix should not re-announce a release to everyone.
 *
 * The parsing/formatting lives in ./lib/changelog.mjs so the unit tests can
 * import it without going through this file's shebang — see the note there.
 *
 * Env:
 *   OCT_BOT_API_KEY   required — same key the rest of the bot API uses
 *   OCT_API_BASE      required — e.g. https://onchain-tools-production.up.railway.app
 *   ANNOUNCE_LINK_URL optional — "Open →" target; defaults to the landing changelog
 *
 * Flags:
 *   --dry-run   print the payload, post nothing
 *   --force     post even if the top entry's date is not new in this push
 *   --dm        also DM users who opted into release notes (default: off)
 *
 * --dm is opt-out by default on purpose. The channel post is public and cheap
 * to get wrong; a DM fan-out is not, so it takes an explicit flag even though
 * the server side already refuses to DM anyone who hasn't opted in.
 */

import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { newestEntry, buildPayload, headingIsNewInDiff } from './lib/changelog.mjs';

// Announcements are user-facing: the fallback must never point at the repo
// (dev-only, and the URL carries a personal username). ANNOUNCE_LINK_URL
// still overrides for a custom domain.
const DEFAULT_LINK = 'https://onchain-tools-mern.vercel.app/#changelog';

function changelogDiff() {
  // CI checks out with fetch-depth 2 so HEAD~1 exists for a push build.
  try {
    return execSync('git diff HEAD~1 HEAD -- CHANGELOG.md', { encoding: 'utf-8' });
  } catch {
    return '';
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');
  const force = args.has('--force');
  const dm = args.has('--dm');

  const entry = newestEntry(readFileSync('CHANGELOG.md', 'utf-8'));
  if (!entry) {
    console.log('[announce] No changelog entries found; nothing to post.');
    return;
  }

  if (!force && !headingIsNewInDiff(changelogDiff(), entry.heading)) {
    console.log(`[announce] "${entry.heading}" is not new in this push; skipping.`);
    return;
  }

  const linkUrl = process.env.ANNOUNCE_LINK_URL?.trim() || DEFAULT_LINK;
  const payload = { ...buildPayload(entry, { linkUrl }), ...(dm ? { dmOptIns: true } : {}) };

  if (dryRun) {
    console.log(`[announce] Dry run — would post${dm ? ' and DM opt-ins' : ''}:\n`);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const base = process.env.OCT_API_BASE?.trim().replace(/\/$/, '');
  const key = process.env.OCT_BOT_API_KEY?.trim();
  if (!base || !key) {
    console.error('[announce] OCT_API_BASE and OCT_BOT_API_KEY are both required.');
    process.exit(1);
  }

  const res = await fetch(`${base}/api/v1/bot/announce`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`[announce] Failed (${res.status}): ${text}`);
    process.exit(1);
  }
  console.log(`[announce] Posted "${payload.title}" — ${text}`);
}

main().catch((err) => {
  console.error('[announce] Unexpected error:', err?.message ?? err);
  process.exit(1);
});
