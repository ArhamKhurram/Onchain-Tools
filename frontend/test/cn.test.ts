import { describe, it, expect } from 'vitest';
import { cn } from '../src/lib/utils';

// `cn` is only as good as twMerge's knowledge of our Tailwind config. Anything
// added to tailwind.config.js that twMerge does not recognise silently stops
// conflicting — both classes survive and the caller's override quietly loses to
// stylesheet order. These tests pin the custom scales declared in
// src/lib/utils.ts so that failure shows up here rather than as one component
// that "won't take a className".

describe('cn — stock Tailwind', () => {
  it('resolves a conflict in favour of the last class', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
  });

  it('keeps classes from different property groups', () => {
    expect(cn('px-2', 'py-1')).toBe('px-2 py-1');
  });

  it('applies clsx semantics to conditionals and falsy values', () => {
    expect(cn('base', false && 'off', undefined, null, 'on')).toBe('base on');
    expect(cn(['a', 'b'], { c: true, d: false })).toBe('a b c');
  });

  it('lets a caller override a component default — the reason cn exists', () => {
    const componentDefault = 'rounded-oct px-3 py-2 text-oct-muted';
    expect(cn(componentDefault, 'text-oct-text')).toBe('rounded-oct px-3 py-2 text-oct-text');
  });
});

describe('cn — OCT density scale', () => {
  it('conflicts two named density values', () => {
    expect(cn('p-cozy', 'p-roomy')).toBe('p-roomy');
  });

  // The load-bearing case: the density names live alongside Tailwind's numeric
  // ramp rather than replacing it, so the two must resolve against each other.
  it('conflicts a named density value with a numeric one, in both directions', () => {
    expect(cn('p-4', 'p-cozy')).toBe('p-cozy');
    expect(cn('p-cozy', 'p-4')).toBe('p-4');
  });

  it('covers the other spacing utilities twMerge derives from theme.spacing', () => {
    expect(cn('gap-2', 'gap-snug')).toBe('gap-snug');
    expect(cn('mt-4', 'mt-section')).toBe('mt-section');
    expect(cn('space-y-2', 'space-y-comfy')).toBe('space-y-comfy');
  });

  it('still distinguishes axes, so px-gutter and py-tight coexist', () => {
    expect(cn('px-gutter', 'py-tight')).toBe('px-gutter py-tight');
  });
});

describe('cn — OCT type roles', () => {
  it('treats the semantic roles as mutually exclusive', () => {
    expect(cn('type-body', 'type-title')).toBe('type-title');
    expect(cn('type-data', 'type-metric')).toBe('type-metric');
  });

  // Deliberate: `type-*` sets a role, `text-*` overrides one axis of it. Making
  // these conflict would break the documented way to tweak a role.
  it('does not conflict a type role with a font-size utility', () => {
    expect(cn('type-body', 'text-lg')).toBe('type-body text-lg');
  });
});

describe('cn — OCT colour and duration tokens', () => {
  it('conflicts the semantic status colours with each other and with the accent', () => {
    expect(cn('text-oct-good', 'text-oct-critical')).toBe('text-oct-critical');
    expect(cn('text-oct-accent', 'text-oct-warn')).toBe('text-oct-warn');
  });

  it('conflicts named durations with numeric ones', () => {
    expect(cn('duration-200', 'duration-fast')).toBe('duration-fast');
    expect(cn('duration-fast', 'duration-slow')).toBe('duration-slow');
  });

  // `2xs` needs no twMerge extension — it already matches its t-shirt-size
  // pattern — but that is an assumption about a dependency, so it gets a test.
  it('recognises the custom 2xs font size', () => {
    expect(cn('text-sm', 'text-2xs')).toBe('text-2xs');
  });
});
