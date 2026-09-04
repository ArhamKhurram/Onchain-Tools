import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

/**
 * The one badge the sniper screen uses, keyed by MEANING rather than by hue.
 *
 * Colour is safety-critical on this screen — it is the difference between "this
 * row moved real money" and "this row moved nothing" — so the tones map to the
 * semantic status colours and never to the brand accent:
 *
 *   good      dry-run, filled, venue connected — nothing to worry about
 *   warn      armed, live-capable, unresolved — money CAN move, or a leg is
 *             pending a human decision; the operator should look
 *   warnSolid the `live` mode pill. Solid so it out-shouts everything else on
 *             the row, and amber (not the accent) so it cannot be mistaken for
 *             a primary button or for an error
 *   critical  kill switch engaged, aborted / failed fire, cap breached
 *   neutral   informational: the mode name, counts, draft / disabled
 *
 * The accent is reserved for ACTIONS (the fire button) — see SniperFireModal.
 */
export type SniperBadgeTone = 'neutral' | 'good' | 'warn' | 'warnSolid' | 'critical';

const TONE: Record<SniperBadgeTone, string> = {
  neutral: 'border-oct-border text-oct-muted',
  good: 'border-oct-good/60 bg-oct-good-dim text-oct-good',
  warn: 'border-oct-warn/60 bg-oct-warn-dim text-oct-warn',
  warnSolid: 'border-oct-warn bg-oct-warn text-oct-bg',
  critical: 'border-oct-critical/60 bg-oct-critical-dim text-oct-critical',
};

/** Class string alone, for the one case (a router `Link`) that cannot be a `<span>`. */
export const sniperBadgeClass = (tone: SniperBadgeTone, extra?: string) =>
  cn(
    'inline-flex items-center type-caption font-mono uppercase tracking-wider px-cozy py-hair rounded-oct-sm border whitespace-nowrap',
    TONE[tone],
    extra,
  );

export default function SniperBadge({
  tone,
  className,
  children,
}: {
  tone: SniperBadgeTone;
  className?: string;
  children: ReactNode;
}) {
  return <span className={sniperBadgeClass(tone, className)}>{children}</span>;
}
