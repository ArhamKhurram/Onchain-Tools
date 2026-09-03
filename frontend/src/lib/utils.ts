import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// ── cn() ──────────────────────────────────────────────────────────────────────
// The standard shadcn/KokonutUI class helper: conditional classes via clsx, then
// last-wins conflict resolution via tailwind-merge. Copy-paste component kits
// from that ecosystem assume `cn` exists at `@/lib/utils`, so the name, location
// and signature are all fixed by convention rather than by preference.
//
// Why it is not just `clsx`: clsx concatenates, it does not resolve. A component
// that renders `clsx('px-2', props.className)` with `className="px-6"` emits both,
// and the winner is whichever Tailwind happened to emit later in the stylesheet —
// not the caller's override. `twMerge` drops the earlier `px-2`, so a caller can
// actually override a component's defaults.
//
// tailwind-merge is pinned to v2. v3 targets Tailwind v4's theme format; this app
// is on Tailwind 3.4, and v3 silently mis-parses a v3 config rather than failing
// loudly. Do not bump it without moving Tailwind first.

// twMerge only resolves conflicts between classes it recognises. Its defaults
// cover stock Tailwind, so anything added in tailwind.config.js has to be
// declared here too — otherwise `cn('p-cozy', 'p-roomy')` keeps BOTH and the
// override silently fails to take effect.
//
// Not declared, because it already works: the custom `2xs` font size. twMerge
// matches t-shirt sizes with /^(\d+(\.\d+)?)?(xs|sm|md|lg|xl)$/, which `2xs`
// satisfies, so `text-2xs` is recognised as a font size out of the box.
// The type parameter registers 'oct-type' as an additional class-group id;
// without it twMerge's config type only admits its own built-in group names.
const twMerge = extendTailwindMerge<'oct-type'>({
  extend: {
    theme: {
      // The named density scale. twMerge feeds `theme.spacing` into padding,
      // margin, gap, space, inset and translate in one go, so declaring it here
      // covers `p-cozy`, `gap-snug`, `space-y-comfy`, `-mt-hair` and friends.
      spacing: ['hair', 'tight', 'snug', 'cozy', 'comfy', 'roomy', 'section', 'gutter'],
    },
    classGroups: {
      // Merges into twMerge's existing `duration` group, so `duration-fast` and
      // `duration-200` correctly conflict with each other.
      duration: [{ duration: ['instant', 'fast', 'base', 'slow'] }],
      // A new group for the semantic type roles: they conflict with each other
      // (an element has one role) but deliberately NOT with `text-*`, since
      // `type-body text-lg` is the supported way to take a role and override
      // one axis of it.
      'oct-type': [
        {
          type: [
            'display',
            'heading',
            'title',
            'body',
            'label',
            'caption',
            'data',
            'metric',
          ],
        },
      ],
    },
  },
});

/**
 * Merge class names, resolving Tailwind conflicts so the last one wins.
 *
 * @example cn('p-cozy text-oct-muted', isActive && 'text-oct-text', className)
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export type { ClassValue };
