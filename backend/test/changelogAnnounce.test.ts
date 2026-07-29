import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs module, no type declarations by design.
import {
  parseChangelog,
  newestEntry,
  formatDescription,
  buildPayload,
  headingIsNewInDiff,
} from '../../scripts/lib/changelog.mjs';

const SAMPLE = `# Changelog

All notable changes are documented here.

## 2026-07-30

### Fixed
- **Thing one** — it broke, now it doesn't
- **Thing two** — also fixed

## 2026-07-29

### Added
- **Older thing** — shipped earlier
`;

describe('parseChangelog', () => {
  it('splits on ## headings, newest first, dropping the title', () => {
    const sections = parseChangelog(SAMPLE);
    expect(sections.map((s: any) => s.heading)).toEqual(['2026-07-30', '2026-07-29']);
  });

  it('keeps the body with its heading and not the next one', () => {
    const [first] = parseChangelog(SAMPLE);
    expect(first.body).toContain('Thing one');
    expect(first.body).not.toContain('Older thing');
  });

  it('returns nothing for a changelog with no entries', () => {
    expect(newestEntry('# Changelog\n\nnothing yet\n')).toBeNull();
  });
});

describe('formatDescription', () => {
  it('bolds ### sections and normalises bullets', () => {
    const out = formatDescription(newestEntry(SAMPLE)!.body);
    expect(out).toContain('**Fixed**');
    expect(out).toContain('• **Thing one**');
    expect(out).not.toMatch(/^- /m);
  });

  it('leaves short entries untouched by truncation', () => {
    const out = formatDescription('- short', { maxLength: 500 });
    expect(out).not.toContain('Truncated');
  });

  // A description cut mid-sentence reads like a bug, so truncation snaps to a
  // line boundary and says it truncated.
  it('truncates long entries on a line boundary with a pointer to the full log', () => {
    const body = Array.from({ length: 200 }, (_, i) => `- entry number ${i} with some padding text`).join('\n');
    const out = formatDescription(body, { maxLength: 400, linkUrl: 'https://example.com/log' });
    expect(out.length).toBeLessThanOrEqual(400);
    expect(out).toContain('Truncated');
    expect(out).toContain('https://example.com/log');
  });

  it('still truncates without a link', () => {
    const body = Array.from({ length: 200 }, (_, i) => `- entry ${i}`).join('\n');
    const out = formatDescription(body, { maxLength: 200 });
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).toContain('Truncated');
  });
});

describe('buildPayload', () => {
  it('titles from the heading and marks it a site update', () => {
    const payload = buildPayload(newestEntry(SAMPLE)!, { linkUrl: 'https://example.com' });
    expect(payload.title).toBe('Update — 2026-07-30');
    expect(payload.kind).toBe('site');
    expect(payload.linkUrl).toBe('https://example.com');
    expect(payload.description).toContain('Thing one');
  });
});

describe('headingIsNewInDiff', () => {
  const added = `--- a/CHANGELOG.md\n+++ b/CHANGELOG.md\n@@\n+## 2026-07-30\n+\n+### Fixed\n+- thing\n`;

  it('is true when the push added that heading', () => {
    expect(headingIsNewInDiff(added, '2026-07-30')).toBe(true);
  });

  // The accident this guards: rewording an entry that already shipped and
  // re-announcing the whole release to everyone.
  it('is false when only the body of an existing entry changed', () => {
    const edit = `--- a/CHANGELOG.md\n+++ b/CHANGELOG.md\n@@\n-- old wording\n+- new wording\n`;
    expect(headingIsNewInDiff(edit, '2026-07-30')).toBe(false);
  });

  it('is false for a different heading', () => {
    expect(headingIsNewInDiff(added, '2026-07-29')).toBe(false);
  });

  it('does not treat the +++ file marker as an addition', () => {
    expect(headingIsNewInDiff('+++ b/CHANGELOG.md\n', 'CHANGELOG.md')).toBe(false);
  });

  it('is false on an empty diff', () => {
    expect(headingIsNewInDiff('', '2026-07-30')).toBe(false);
  });
});
