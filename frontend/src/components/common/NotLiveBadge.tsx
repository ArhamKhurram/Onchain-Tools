import { cn } from '../../lib/utils';

/**
 * "not live" — this pick is on the user's roster but j7 has no slot for it, so
 * OCT is not actually watching it upstream. Rendered inline next to the row's
 * name on the Following list, the Top Callers board and the FOMO tracked list.
 *
 * `oct-warn`, not the accent and not `oct-critical`: the pick is intact and
 * will go live when a slot frees, so it is a caution about coverage rather than
 * a failure — and the accent is brand, never status.
 */
export default function NotLiveBadge({
  tracker,
  className,
}: {
  /** Names the cap in the tooltip so the user knows which roster is full. */
  tracker: 'pump' | 'fomo';
  className?: string;
}) {
  const what = tracker === 'pump' ? 'caller' : 'trader';
  return (
    <span
      className={cn(
        'inline-flex items-center shrink-0 rounded-oct-sm border border-oct-warn/50 bg-oct-warn-dim px-snug py-hair',
        'type-label text-2xs uppercase tracking-wide text-oct-warn whitespace-nowrap',
        className,
      )}
      title={`Not live: every j7 ${what} slot is taken, so this ${what} is not being watched upstream. Their calls will not arrive until a slot frees.`}
      aria-label="Not live — j7 slot cap reached"
    >
      not live
    </span>
  );
}
