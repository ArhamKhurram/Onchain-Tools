import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

// ── Chip ──────────────────────────────────────────────────────────────────────
// The token-native counterpart to the legacy `.oct-chip` helper in index.css.
// That helper is pinned at 11px, one step under the 12px floor the type scale
// sets, and it lives in the utilities layer where it beats any `text-*` placed
// beside it — so a call site cannot lift it without editing index.css, which
// would restyle every other screen at once. This renders the same pill at
// `type-caption` (12px) and, being a plain component, takes overrides through
// `className` like anything else.
//
// `type-data` rather than `font-mono` for the count variant: chips almost
// always hold a number, and tabular digits stop "12" and "99" from jiggling the
// pill's width as a live count ticks.

interface ChipProps {
  children: ReactNode;
  className?: string;
  /** Render the contents as data (mono, tabular) — the default, since chips mostly hold counts. */
  data?: boolean;
}

export default function Chip({ children, className, data = true }: ChipProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-tight rounded-full border border-oct-border bg-oct-surface-raised/70 px-cozy py-hair text-oct-muted',
        data ? 'type-data text-2xs' : 'type-caption uppercase tracking-wide',
        className,
      )}
    >
      {children}
    </span>
  );
}
