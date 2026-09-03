import { describe, it, expect } from 'vitest';
import {
  INSTANT,
  resolveStagger,
  resolveTransition,
  staggerContainer,
  transitions,
  type TransitionName,
} from '../src/lib/motionTokens';

const NAMES: TransitionName[] = ['snappy', 'fade', 'drawer'];

// The reduced-motion contract is an accessibility guarantee, so it is a pure
// function rather than something buried in a hook — which is what makes it
// testable in the frontend's node-environment Vitest setup, with no DOM and no
// matchMedia stub.

describe('resolveTransition', () => {
  it('returns the named preset when motion is not reduced', () => {
    for (const name of NAMES) {
      expect(resolveTransition(name, false)).toBe(transitions[name]);
    }
  });

  it('collapses every preset to an instant transition when motion is reduced', () => {
    for (const name of NAMES) {
      expect(resolveTransition(name, true)).toBe(INSTANT);
    }
  });

  // Motion's useReducedMotion can report null before it has measured the media
  // query. Degrading on "unknown" would drop the animation for every user on
  // first render, so only an explicit true suppresses motion.
  it('animates normally when the preference is not yet known', () => {
    expect(resolveTransition('snappy', null)).toBe(transitions.snappy);
    expect(resolveTransition('snappy', undefined)).toBe(transitions.snappy);
  });

  it('makes reduced motion instant rather than absent, so callbacks still fire', () => {
    expect(INSTANT).toEqual({ duration: 0 });
  });
});

describe('transition presets', () => {
  it('exposes exactly the three documented presets', () => {
    expect(Object.keys(transitions).sort()).toEqual(['drawer', 'fade', 'snappy']);
  });

  it('keeps the drawer spring softer than the UI spring', () => {
    // A full-height panel travelling at button speed reads as a glitch.
    expect(transitions.drawer.stiffness).toBeLessThan(transitions.snappy.stiffness);
    expect(transitions.drawer.mass).toBeGreaterThan(transitions.snappy.mass);
  });

  it('keeps the quick fade on the --oct-duration-fast clock (150ms)', () => {
    expect(transitions.fade.duration).toBe(0.15);
  });
});

describe('resolveStagger', () => {
  it('walks children in when motion is allowed', () => {
    expect(resolveStagger(false)).toBe(staggerContainer);
    expect(resolveStagger(null)).toBe(staggerContainer);
  });

  // A zero-duration transition still honours staggerChildren, so the delays have
  // to be removed rather than shortened — otherwise a reduced-motion user still
  // watches the sequence play out, just with instant steps.
  it('removes the delays entirely when motion is reduced', () => {
    const reduced = resolveStagger(true);
    expect(reduced.visible).toEqual({ transition: { staggerChildren: 0, delayChildren: 0 } });
  });

  it('keeps the allowed stagger short enough to read as one movement', () => {
    const visible = staggerContainer.visible as { transition: { staggerChildren: number } };
    expect(visible.transition.staggerChildren).toBeLessThanOrEqual(0.05);
    expect(visible.transition.staggerChildren).toBeGreaterThan(0);
  });
});
