// Pure CHANGELOG.md parser for the landing "WHAT'S NEW" feed.
//
// This runs at BUILD time only (imported by vite.config.ts, which turns the
// parsed entries into the `virtual:oct-updates` module). Keeping it out of the
// runtime graph means the bundle carries the ~8 rendered entries as JSON
// instead of the entire raw changelog plus the parser.

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
export function parseChangelog(raw: string): UpdateEntry[] {
  const entries: UpdateEntry[] = [];
  let entry: UpdateEntry | null = null;
  let section: Section | null = null;

  const push = (text: string) => {
    if (!entry || !section) return;
    (entry[section] ??= []).push(text.trim());
  };

  // CRLF-safe: on a Windows checkout every line carries a trailing \r, which
  // `.` (a JS regex line terminator) refuses to match — TOP_BULLET's `(.*)$`
  // then fails on every bullet and the whole parse comes back empty.
  for (const line of raw.split(/\r?\n/)) {
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
