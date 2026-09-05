/**
 * The mono section kicker, rebuilt on the type ramp.
 *
 * `.oct-eyebrow` in index.css renders at 11px, one step under the 12px floor
 * the `text-2xs` token establishes — and because it sits in the utilities
 * layer it cannot be overridden with `text-*`. It stays untouched (other
 * screens depend on it); console surfaces migrating to the ramp use this
 * composition instead, which is the same kicker at `type-caption` (12px).
 */
export const EYEBROW_CLASS =
  'type-caption font-mono uppercase tracking-[0.14em] text-oct-muted';
