// Pure output formatting.
//
// The whole value of `preflight` and `verifySetup` is that a nervous human can
// read the output and believe it. So the rendering is a pure function of a list
// of results — it cannot accidentally report PASS for a check that never ran,
// because a check that never ran has no row.
//
// Addresses are NEVER truncated anywhere in this file. Verifying an allowlist
// entry means reading all 40 hex characters; an abbreviated `0xb4ac...4b36` is
// exactly the format an address-substitution attack survives.

export type Status = 'pass' | 'fail' | 'warn' | 'info' | 'skip';

export interface CheckResult {
  readonly status: Status;
  /** Short label, left column. */
  readonly label: string;
  /** The observed value or the reason. Full addresses, never abbreviated. */
  readonly detail: string;
  /** Optional extra lines printed under the row, indented. */
  readonly notes?: readonly string[];
}

const GLYPH: Record<Status, string> = {
  pass: 'PASS',
  fail: 'FAIL',
  warn: 'WARN',
  info: 'info',
  skip: 'skip',
};

/** ANSI escape, built from a char code so no literal control byte lives in this file. */
const ESC = String.fromCharCode(27);

const COLOR: Record<Status, string> = {
  pass: `${ESC}[32m`,
  fail: `${ESC}[31m${ESC}[1m`,
  warn: `${ESC}[33m`,
  info: `${ESC}[36m`,
  skip: `${ESC}[90m`,
};
const RESET = `${ESC}[0m`;

export interface RenderOptions {
  readonly color?: boolean;
}

/** Render one section of checks as an aligned table. Pure. */
export function renderChecks(results: readonly CheckResult[], options: RenderOptions = {}): string {
  const color = options.color ?? false;
  const width = results.reduce((max, r) => Math.max(max, r.label.length), 0);
  const lines: string[] = [];

  for (const r of results) {
    const tag = color ? `${COLOR[r.status]}${GLYPH[r.status]}${RESET}` : GLYPH[r.status];
    lines.push(`  ${tag}  ${r.label.padEnd(width)}  ${r.detail}`);
    for (const note of r.notes ?? []) {
      lines.push(`        ${' '.repeat(width)}  ${note}`);
    }
  }
  return lines.join('\n');
}

export interface Tally {
  readonly pass: number;
  readonly fail: number;
  readonly warn: number;
  readonly info: number;
  readonly skip: number;
  /** False if ANY check failed. This is what drives the process exit code. */
  readonly ok: boolean;
}

/** Count results by status. Pure — this is what the exit code is derived from. */
export function tally(results: readonly CheckResult[]): Tally {
  const counts = { pass: 0, fail: 0, warn: 0, info: 0, skip: 0 };
  for (const r of results) counts[r.status] += 1;
  return { ...counts, ok: counts.fail === 0 };
}

/**
 * The one-line verdict.
 *
 * A run with warnings is NOT reported as clean. "All checks passed" when three
 * things were skipped because the RPC timed out is the sentence that gets money
 * lost, so skips and warns are always named in the summary.
 */
export function renderVerdict(t: Tally, subject: string): string {
  if (!t.ok) {
    return `RESULT: NOT SAFE TO PROCEED - ${t.fail} check(s) FAILED. ${subject} is not correctly set up.`;
  }
  const caveats: string[] = [];
  if (t.warn > 0) caveats.push(`${t.warn} warning(s)`);
  if (t.skip > 0) caveats.push(`${t.skip} check(s) could not be run`);
  if (caveats.length > 0) {
    return (
      `RESULT: no failures, but ${caveats.join(' and ')}. Read them before you proceed - ` +
      'a skipped check is not a passed check.'
    );
  }
  return `RESULT: all ${t.pass} check(s) passed. ${subject} looks correct.`;
}

export function heading(text: string): string {
  return `\n${text}\n${'-'.repeat(text.length)}`;
}

export function banner(text: string): string {
  const bar = '='.repeat(Math.max(text.length + 4, 60));
  return `\n${bar}\n  ${text}\n${bar}`;
}

/** Format wei with both units, because one of them is always the one you wanted. */
export function formatWeiWithEther(wei: bigint, formatEther: (v: bigint) => string): string {
  return `${wei.toString()} wei  (${formatEther(wei)} ETH)`;
}

/** Wrap a long sentence to a width, for the rationale blocks. Pure. */
export function wrap(text: string, width = 92, indent = ''): string {
  const words = text.split(/\s+/).filter((w) => w !== '');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current === '') current = word;
    else if (`${current} ${word}`.length <= width - indent.length) current = `${current} ${word}`;
    else {
      lines.push(indent + current);
      current = word;
    }
  }
  if (current !== '') lines.push(indent + current);
  return lines.join('\n');
}
