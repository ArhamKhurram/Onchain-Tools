// The landing "WHAT'S NEW" feed is generated from the repo-root CHANGELOG.md — the SINGLE source
// of truth that also drives the Discord announcements. It used to be a second, hand-maintained
// array here, which is exactly why it drifted months behind (a July snapshot while the changelog
// was on August). Parsing the real file means shipping a changelog entry updates the landing for
// free; there is nothing to keep in sync.
//
// The parse happens at BUILD time: vite.config.ts reads CHANGELOG.md, runs
// src/data/parseChangelog.ts, and serves the newest entries as the
// `virtual:oct-updates` module. The old `?raw` import inlined the ENTIRE
// changelog (32.7 kB and growing every release) into the bundle and parsed it
// at runtime, even though the section only renders the newest 8 entries.
import { UPDATES } from 'virtual:oct-updates';

export { UPDATES };

export function formatUpdateDate(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}
