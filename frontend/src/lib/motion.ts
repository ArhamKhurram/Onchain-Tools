import { createElement, type ReactNode } from 'react';
import { domAnimation, LazyMotion, useReducedMotion } from 'motion/react';
import {
  resolveStagger,
  resolveTransition,
  type TransitionName,
} from './motionTokens';
import type { Transition, Variants } from 'motion/react';

// ── Motion ────────────────────────────────────────────────────────────────────
// The app's single entry point for animation. Import from here, not from
// `motion/react` directly, so that reduced-motion handling and the shared
// presets cannot be bypassed by accident.
//
// THE RULE THAT MATTERS: animate the chrome, never the stream.
//
// OCT is a real-time console. The feed takes WebSocket frames continuously and
// its lists are virtualised with @tanstack/react-virtual, so rows mount and
// unmount constantly while scrolling. Animating one buys nothing — the row is
// often destroyed mid-flight — and costs a composited layer plus a rAF
// subscription per row, on the hot path, at exactly the moment the user is
// trying to read prices.
//
//   Animate:  modals, drawers, side panels, toasts, route and tab transitions,
//             empty states, buttons, settings surfaces.
//   Never:    feed message rows, contract rows, radar table rows, or anything
//             else rendered inside a virtualised list.
//
// ── Bundle policy — the part that is easy to get wrong ───────────────────────
//
// Two rules keep the animation runtime from becoming everyone's problem.
//
// 1. IMPORT `m`, NEVER `motion`. `motion.div` is a proxy that has to reach every
//    feature Motion ships, so one `motion.div` pulls the entire library into
//    whatever chunk touches it — measured here at ~151 kB raw / ~50 kB gzip for
//    a single animated login form. `m` is the same component with the features
//    supplied by a `LazyMotion` provider instead, which lets us ship only the
//    `domAnimation` set (animations, variants, exit, hover/tap/focus). Same
//    result on screen, roughly a third of the bytes.
//
//    `MotionFeatures` runs LazyMotion in STRICT mode, so a stray `motion.div`
//    throws at render with a pointed message rather than quietly adding 50 kB.
//    Pasted components (KokonutUI and friends) usually need exactly one edit:
//    `motion.` → `m.`. If one genuinely needs layout animation or drag, swap
//    `domAnimation` for `domMax` here rather than reaching for `motion`.
//
// 2. MOUNT `MotionFeatures` PER SURFACE, not at the app root. Every consumer so
//    far lives behind a lazily-loaded route, so the runtime stays off the boot
//    path entirely — verified: adding all of this left the `index` chunk
//    byte-identical. Mounting the provider in AppProviders would move it into
//    the initial chunk for every user, including the ones who never open an
//    animated surface. It is also why the reduced-motion contract below is a
//    hook rather than a `<MotionConfig>` at the root.
//
// If a surface above the fold ever needs Motion, give it a `manualChunks` entry
// in vite.config.ts rather than hoisting this import up the tree.

export * as m from 'motion/react-m';
export { AnimatePresence, useReducedMotion } from 'motion/react';
export type { Transition, Variants } from 'motion/react';

/**
 * Supplies the animation feature set to every `m.*` component beneath it.
 * Wrap the animated surface, not the app — see the bundle policy above.
 *
 * @example
 * <MotionFeatures>
 *   <m.div variants={fadeInUp} initial="hidden" animate="visible" />
 * </MotionFeatures>
 */
export function MotionFeatures({ children }: { children: ReactNode }) {
  // createElement rather than JSX so this stays a .ts module alongside the rest
  // of lib/, which is all plain TypeScript.
  return createElement(LazyMotion, { features: domAnimation, strict: true }, children);
}

export {
  fadeIn,
  fadeInUp,
  slideInRight,
  staggerContainer,
  transitions,
  INSTANT,
  resolveTransition,
  resolveStagger,
  type TransitionName,
} from './motionTokens';

/**
 * The transition for a named preset, already reduced-motion aware.
 *
 * Every animated surface should get its transition from here rather than
 * writing one inline — that is what makes "respects prefers-reduced-motion"
 * a property of the system instead of a checklist item per component.
 *
 * @example
 * const transition = useTransition('snappy');
 * <motion.div initial="hidden" animate="visible" variants={fadeInUp} transition={transition} />
 */
export function useTransition(name: TransitionName): Transition {
  return resolveTransition(name, useReducedMotion());
}

/**
 * Parent variants for a staggered sequence, already reduced-motion aware.
 * Pair with {@link fadeInUp} (or any child variants) on the children.
 */
export function useStagger(): Variants {
  return resolveStagger(useReducedMotion());
}
