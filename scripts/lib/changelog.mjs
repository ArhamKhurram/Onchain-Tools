/**
 * Changelog parsing + Discord formatting. Pure — no I/O, no network.
 *
 * Deliberately kept in its own module with **no shebang**. The runner that
 * imports this has one, and a shebang line is what broke this under vitest on
 * Windows: git checks the file out with CRLF, the transform strips `#!...` up to
 * `\n`, and the stray `\r` becomes an invalid token. CI never caught it because
 * CI is Linux. Keeping the importable half shebang-free means the test never
 * touches that path. `.gitattributes` pins these files to LF as a second guard.
 */

/** Discord text components cap out around 4k; leave room for the chrome. */
export const MAX_DESCRIPTION = 3500;

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

  const suffix = linkUrl
    ? `\n\n-# Truncated — [read the full changelog](${linkUrl})`
    : '\n\n-# Truncated.';
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
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\+##\\s+${escaped}\\s*$`);
  return diff
    .split(/\r?\n/)
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .some((line) => pattern.test(line.replace(/\r$/, '')));
}
