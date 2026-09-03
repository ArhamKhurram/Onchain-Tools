import type { Transition, Variants } from 'motion/react';

// ── Motion tokens ─────────────────────────────────────────────────────────────
// The data half of the motion system: presets and the reduced-motion resolver,
// with no React and no runtime import of `motion` (the type import above is
// erased at compile time). `lib/motion.ts` re-exports all of this alongside the
// React bindings and is the module components should import from.
//
// Splitting it out buys two things: the presets stay unit-testable in the
// frontend's node-environment Vitest setup, and a module that only needs to
// reason about durations does not drag ~30 kB of animation runtime with it.

/**
 * Named transitions. Three, deliberately — a shared vocabulary only works if it
 * is small enough to hold in your head, and "which spring was that" is exactly
 * the question a token system exists to stop people asking.
 *
 * Durations mirror the `--oct-duration-*` variables in index.css so a Motion
 * entrance and the CSS hover transition on the same button run on one clock.
 */
export const transitions = {
  /**
   * Snappy spring for UI chrome that should feel physical: buttons, popovers,
   * toggles, anything the user just clicked. Settles in ~200ms.
   */
  snappy: { type: 'spring', stiffness: 420, damping: 34, mass: 0.7 },
  /**
   * Quick fade for content swaps — tab panels, view switches, empty states.
   * 150ms, matching `--oct-duration-fast`.
   */
  fade: { duration: 0.15, ease: [0.4, 0, 0.2, 1] },
  /**
   * Softer, heavier spring for large surfaces that travel a real distance:
   * drawers, side panels, sheets. Slower on purpose — a full-height panel
   * snapping in at button speed reads as a glitch.
   */
  drawer: { type: 'spring', stiffness: 320, damping: 38, mass: 0.9 },
} satisfies Record<string, Transition>;

export type TransitionName = keyof typeof transitions;

/**
 * The reduced-motion transition: everything lands on its final value on the
 * next frame. Note it is *instant*, not *absent* — the animation still runs, so
 * `AnimatePresence` exit callbacks, layout measurement and completion handlers
 * all still fire and components need no reduced-motion branch of their own.
 */
export const INSTANT: Transition = { duration: 0 };

/**
 * Resolve a preset against the user's motion preference.
 *
 * Pure, so the accessibility contract is testable without a DOM. `null` is the
 * "not yet measured" value Motion's `useReducedMotion` can return on the first
 * render; only an explicit `true` suppresses motion, so an unknown preference
 * animates normally rather than degrading for everyone.
 */
export function resolveTransition(
  name: TransitionName,
  prefersReducedMotion: boolean | null | undefined,
): Transition {
  return prefersReducedMotion === true ? INSTANT : transitions[name];
}

// ── Variants ──────────────────────────────────────────────────────────────────
// Shared entrance shapes. Travel distances are small by design: this is a
// trading console, and an 8px rise reads as polish where a 40px one reads as a
// marketing page. Under reduced motion the transition collapses to zero
// duration, so the transform lands immediately and nothing visibly moves.

/** Fade + short rise. The default entrance for a panel, card or section. */
export const fadeInUp: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0 },
};

/** Plain fade, for anything already in position. */
export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
};

/** Drawer / side panel entering from the right. */
export const slideInRight: Variants = {
  hidden: { opacity: 0, x: 24 },
  visible: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: 24 },
};

/**
 * Parent variants that walk children in one after another.
 *
 * The stagger is small: 40ms reads as one considered movement, while anything
 * near 100ms turns a four-item form into a visible queue the user has to wait
 * out on every single visit.
 */
export const staggerContainer: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.04, delayChildren: 0.02 } },
};

/**
 * The reduced-motion counterpart to {@link staggerContainer}. A zero-duration
 * transition still honours `staggerChildren`, so the delays have to be removed
 * rather than shortened or the sequence still plays out as a visible cascade.
 */
export const staggerContainerInstant: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0, delayChildren: 0 } },
};

/** Pick the right stagger parent for the user's motion preference. */
export function resolveStagger(prefersReducedMotion: boolean | null | undefined): Variants {
  return prefersReducedMotion === true ? staggerContainerInstant : staggerContainer;
}
