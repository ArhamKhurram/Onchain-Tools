/**
 * Framer-motion animation features, split out of the critical chunk.
 *
 * `LazyMotion` in App.tsx loads this file via a dynamic `import()` so the
 * domAnimation feature bundle (~25 kB min) downloads after first paint
 * instead of blocking it. Safe because the gate screen renders at
 * `initial={{ opacity: 1 }}` — nothing on screen waits for features; the
 * first feature-gated behavior is the gate's exit fade, which requires a
 * user interaction that lands long after this chunk has arrived.
 */
export { domAnimation as default } from 'framer-motion';
