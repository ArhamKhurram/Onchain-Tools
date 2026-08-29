// The landing "WHAT'S NEW" feed is generated from the repo-root CHANGELOG.md — the SINGLE source
// of truth that also drives the Discord announcements. It used to be a second, hand-maintained
// array here, which is exactly why it drifted months behind (a July snapshot while the changelog
// was on August). Parsing the real file means shipping a changelog entry updates the landing for
// free; there is nothing to keep in sync.
//
// `?raw` inlines the markdown at build time (Vite), so no runtime fetch and no extra request.
import changelogRaw from '../../../CHANGELOG.md?raw';

export interface UpdateEntry {
  date: string;
  added?: string[];
  fixed?: string[];
  notes?: string[];
}

/** How many of the most-recent dated sections the landing shows (newest first). */
const MAX_ENTRIES = 8;

type Section = 'added' | 'fixed' | 'notes';

const DATE_HEADING = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/;
const SECTION_HEADING = /^###\s+(Added|Fixed|Notes)\s*$/i;
const TOP_BULLET = /^-\s+(.*)$/; // a new item — top-level only (no leading indent)
const SUB_BULLET = /^\s+-\s+(.*)$/; // an indented sub-bullet — folded into the current item

/**
 * Parse CHANGELOG.md into dated entries. Top-level `- ` lines start an item; wrapped continuation
 * lines and indented sub-bullets fold into the current item, so a multi-line changelog bullet
 * renders as one readable line on the landing. Only Added/Fixed/Notes sections are surfaced.
 */
function parseChangelog(raw: string): UpdateEntry[] {
  const entries: UpdateEntry[] = [];
  let entry: UpdateEntry | null = null;
  let section: Section | null = null;

  const push = (text: string) => {
    if (!entry || !section) return;
    (entry[section] ??= []).push(text.trim());
  };

  for (const line of raw.split('\n')) {
    const date = line.match(DATE_HEADING);
    if (date) {
      entry = { date: date[1] };
      entries.push(entry);
      section = null;
      continue;
    }
    if (!entry) continue; // skip the title + intro before the first dated heading

    const sec = line.match(SECTION_HEADING);
    if (sec) {
      section = sec[1].toLowerCase() as Section;
      continue;
    }

    const top = line.match(TOP_BULLET);
    if (top) {
      push(top[1]);
      continue;
    }

    // Continuation: a wrapped line or an indented sub-bullet extends the last item.
    if (section && entry[section]?.length) {
      const sub = line.match(SUB_BULLET);
      const cont = (sub ? sub[1] : line).trim();
      if (cont) {
        const list = entry[section]!;
        list[list.length - 1] += ` ${cont}`;
      }
    }
  }

  return entries
    .map((e) => ({
      date: e.date,
      added: e.added?.length ? e.added : undefined,
      fixed: e.fixed?.length ? e.fixed : undefined,
      notes: e.notes?.length ? e.notes : undefined,
    }))
    .filter((e) => e.added || e.fixed || e.notes)
    .slice(0, MAX_ENTRIES);
}

/** Public update log — newest first, generated from CHANGELOG.md. */
export const UPDATES: UpdateEntry[] = parseChangelog(changelogRaw);

export function formatUpdateDate(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}
