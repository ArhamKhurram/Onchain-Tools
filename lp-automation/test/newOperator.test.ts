import { describe, it, expect } from 'vitest';
import { readVar, upsertVar } from '../scripts/newOperator.js';

// `upsertVar` edits the operator's real .env. A bug here silently drops their
// RPC URL or Safe address, so the substitution is tested rather than trusted.

describe('readVar', () => {
  it('reads a value', () => {
    expect(readVar('LP_OPERATOR_ADDRESS=0xabc\n', 'LP_OPERATOR_ADDRESS')).toBe('0xabc');
  });

  it('returns empty for an unset var', () => {
    expect(readVar('OTHER=1\n', 'LP_OPERATOR_ADDRESS')).toBe('');
  });

  it('returns empty for a declared-but-blank var, so it reads as "not set"', () => {
    expect(readVar('LP_OPERATOR_PRIVATE_KEY=\n', 'LP_OPERATOR_PRIVATE_KEY')).toBe('');
  });

  it('trims whitespace rather than reporting a value of spaces', () => {
    expect(readVar('LP_OPERATOR_PRIVATE_KEY=   \n', 'LP_OPERATOR_PRIVATE_KEY')).toBe('');
  });

  it('does not match a commented-out line', () => {
    expect(readVar('# LP_OPERATOR_ADDRESS=0xabc\n', 'LP_OPERATOR_ADDRESS')).toBe('');
  });

  it('does not confuse a var whose name is a suffix of another', () => {
    // LP_OPERATOR_ADDRESS must not be read out of LP_OPERATOR_ADDRESS_BACKUP.
    expect(readVar('LP_OPERATOR_ADDRESS_BACKUP=0xdead\n', 'LP_OPERATOR_ADDRESS')).toBe('');
  });
});

describe('upsertVar', () => {
  it('replaces an existing assignment in place', () => {
    const out = upsertVar('A=1\nLP_OPERATOR_ADDRESS=old\nB=2\n', 'LP_OPERATOR_ADDRESS', 'new');
    expect(out).toBe('A=1\nLP_OPERATOR_ADDRESS=new\nB=2\n');
  });

  it('preserves every other line — the whole point of the in-place edit', () => {
    const body = 'LP_RPC_URL=https://x\nLP_SAFE_ADDRESS=0xsafe\nLP_ARMED=false\n';
    const out = upsertVar(body, 'LP_OPERATOR_ADDRESS', '0xnew');
    expect(out).toContain('LP_RPC_URL=https://x');
    expect(out).toContain('LP_SAFE_ADDRESS=0xsafe');
    expect(out).toContain('LP_ARMED=false');
  });

  it('appends when the var is absent', () => {
    expect(upsertVar('A=1\n', 'B', '2')).toBe('A=1\nB=2\n');
  });

  it('appends a newline first when the file does not end with one', () => {
    expect(upsertVar('A=1', 'B', '2')).toBe('A=1\nB=2\n');
  });

  it('handles an empty file', () => {
    expect(upsertVar('', 'B', '2')).toBe('B=2\n');
  });

  it('replaces a blank assignment rather than appending a duplicate', () => {
    const out = upsertVar('LP_OPERATOR_PRIVATE_KEY=\n', 'LP_OPERATOR_PRIVATE_KEY', '0xkey');
    expect(out).toBe('LP_OPERATOR_PRIVATE_KEY=0xkey\n');
    expect(out.match(/LP_OPERATOR_PRIVATE_KEY/g)).toHaveLength(1);
  });

  it('is idempotent', () => {
    const once = upsertVar('A=1\n', 'B', '2');
    expect(upsertVar(once, 'B', '2')).toBe(once);
  });

  it('leaves a commented line alone and appends a real assignment', () => {
    const out = upsertVar('# LP_OPERATOR_ADDRESS=0xold\n', 'LP_OPERATOR_ADDRESS', '0xnew');
    expect(out).toContain('# LP_OPERATOR_ADDRESS=0xold');
    expect(out).toContain('\nLP_OPERATOR_ADDRESS=0xnew\n');
  });
});
