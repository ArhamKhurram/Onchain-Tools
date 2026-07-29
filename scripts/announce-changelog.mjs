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
 * Env:
 *   OCT_BOT_API_KEY   required — same key the rest of the bot API uses
 *   OCT_API_BASE      required — e.g. https://onchain-tools-production.up.railway.app
 *   ANNOUNCE_LINK_URL optional — "Open →" target; defaults to the repo changelog
 *
 * Flags:
 *   --dry-run   print the payload, post nothing
 *   --force     post even if the top entry's date is not new in this push
 */

import { readFileSync } from 'fs';
import { execSync } from 'child_process';

const DEFAULT_LINK = 'https://github.com/ArhamKhurram/Onchain-Tools/blob/main/CHANGELOG.md';
/** Discord text components cap out around 4k; leave room for the chrome. */
const MAX_DESCRIPTION = 3500;

// --- pure helpers (unit-tested in backend/test/changelogAnnounce.test.ts) ---

/** Split the changelog into `## <heading>` sections, newest first. */
export function parseChangelog(markdown) {
  const sections = [];
  const lines = markdown.split(/\r?\n/);
  let current = null;

  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (current) sections.push(current);
      current = { heading: heading[1], body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) sections.push(current);

  return sections.map((s) => ({ heading: s.heading, body: s.body.join('\n').trim() }));
}

export function newestEntry(markdown) {
  return parseChangelog(markdown)[0] ?? null;
}

/**
 * Turn a changelog body into Discord-friendly text.
 *
 * Keeps `### Added` / `### Fixed` as bold run-ins and normalises bullets. Long
 * entries are truncated on a line boundary rather than mid-sentence, with a
 * pointer to the full log — a half-cut sentence reads like a bug.
 */
export function formatDescription(body, { maxLength = MAX_DESCRIPTION, linkUrl } = {}) {
  const normalized = body
    .split(/\r?\n/)
    .map((line) => {
      const h3 = /^###\s+(.+?)\s*$/.exec(line);
      if (h3) return `\n**${h3[1]}**`;
      return line.replace(/^-\s+/, '• ').replace(/^\s{2,}-\s+/, '  ◦ ');
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (normalized.length <= maxLength) return normalized;

  const suffix = linkUrl ? `\n\n-# Truncated — [read the full changelog](${linkUrl})` : '\n\n-# Truncated.';
  const budget = maxLength - suffix.length;
  const cut = normalized.slice(0, budget);
  const lastBreak = cut.lastIndexOf('\n');
  return (lastBreak > budget * 0.5 ? cut.slice(0, lastBreak) : cut).trimEnd() + suffix;
}

export function buildPayload(entry, { linkUrl } = {}) {
  return {
    title: `Update — ${entry.heading}`,
    description: formatDescription(entry.body, { linkUrl }),
    kind: 'site',
    linkUrl: linkUrl ?? null,
  };
}

/**
 * Did this push introduce the heading we're about to announce?
 *
 * Guards the common accident: editing wording inside an already-shipped entry
 * and re-announcing it. Only an added `## <heading>` line counts.
 */
export function headingIsNewInDiff(diff, heading) {
  return diff
    .split(/\r?\n/)
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .some((line) => new RegExp(`^\\+##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`).test(line));
}

// --- runner -----------------------------------------------------------------

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

  const entry = newestEntry(readFileSync('CHANGELOG.md', 'utf-8'));
  if (!entry) {
    console.log('[announce] No changelog entries found; nothing to post.');
    return;
  }

  if (!force) {
    if (!headingIsNewInDiff(changelogDiff(), entry.heading)) {
      console.log(`[announce] "${entry.heading}" is not new in this push; skipping.`);
      return;
    }
  }

  const linkUrl = process.env.ANNOUNCE_LINK_URL?.trim() || DEFAULT_LINK;
  const payload = buildPayload(entry, { linkUrl });

  if (dryRun) {
    console.log('[announce] Dry run — would post:\n');
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

// Only run when invoked directly, so the pure helpers above stay importable.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('announce-changelog.mjs')) {
  main().catch((err) => {
    console.error('[announce] Unexpected error:', err?.message ?? err);
    process.exit(1);
  });
}
