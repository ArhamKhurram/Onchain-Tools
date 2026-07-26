import { Lock } from 'lucide-react';

/**
 * Shown whenever the *saved* allowlist is empty.
 *
 * Deliberately not an alert. An empty allowlist is the shipped default and the
 * correct resting state: the failure mode of a bug anywhere in pool discovery
 * is then "does nothing", never "entered a pool nobody approved". So this reads
 * as a status, in neutral chrome, saying plainly what the system can and cannot
 * do — no warning colour, no icon that implies something went wrong.
 */
export default function LpIdleNotice({
  surfacedCount,
  pendingAdds,
}: {
  surfacedCount: number;
  pendingAdds: number;
}) {
  return (
    <section className="border-2 border-oct-border-bright bg-oct-surface-raised px-4 py-3.5 flex items-start gap-3">
      <div className="w-8 h-8 shrink-0 border-2 border-oct-border bg-oct-surface flex items-center justify-center">
        <Lock size={15} strokeWidth={2} className="text-oct-muted" />
      </div>
      <div className="min-w-0">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-oct-text font-semibold">
          Idle — no pool is allowlisted
        </p>
        <p className="font-mono text-[11px] text-oct-muted leading-relaxed mt-1.5">
          The automation cannot open, compound, rebalance or switch any position. It has no pool it is
          permitted to touch, so it will do nothing at all.{' '}
          <span className="text-oct-text">
            This is the shipped default and a safe state, not an error.
          </span>
        </p>
        <p className="font-mono text-[11px] text-oct-muted leading-relaxed mt-1.5">
          {surfacedCount > 0
            ? `${surfacedCount} pool${surfacedCount === 1 ? '' : 's'} currently meet the criteria below. Meeting them only puts a pool on screen — ticking it is what admits it.`
            : 'No pool currently meets the criteria below. On a chain this young, sparse results are a signal about the chain rather than a broken filter.'}
          {pendingAdds > 0 && (
            <span className="text-oct-accent">
              {' '}
              {pendingAdds} ticked but not yet saved — nothing changes until you save.
            </span>
          )}
        </p>
      </div>
    </section>
  );
}
