// The Contract Feed's two empty states, lifted verbatim out of
// ContractDashboard.tsx. The copy is deliberately specific about WHY the feed
// is empty — a filter, a muted caller, the top-callers gate — because "no
// contracts" on a live console reads as "the feed is broken".

export interface ContractFeedEmptyProps {
  topOnly: boolean;
  /** Everything loaded, before any filter. */
  totalCount: number;
  goodOnly: boolean;
  goodHidden: number;
  mutedCount: number;
  topHidden: number;
}

export default function ContractFeedEmpty({
  topOnly,
  totalCount,
  goodOnly,
  goodHidden,
  mutedCount,
  topHidden,
}: ContractFeedEmptyProps) {
  if (topOnly) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-section max-w-md mx-auto">
        <p className="oct-eyebrow mb-cozy">Top Callers</p>
        <p className="type-body text-oct-text/90 mb-snug">
          Only your elite &amp; trusted callers show here — that&rsquo;s the point.
        </p>
        <p className="type-caption font-normal text-oct-muted leading-relaxed">
          {totalCount === 0
            ? 'Nothing detected yet. This feed stays quiet on purpose — a call only lands here once it comes from a caller with an earned Elite band or one you’ve marked Trusted.'
            : topHidden > 0
              ? `${topHidden} recent call${topHidden === 1 ? '' : 's'} came from callers who aren’t elite or trusted, so they’re held out. Mark a caller Trusted, or wait for one to earn an Elite band, to see them here.`
              : 'No calls from your best callers right now.'}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-section">
      <p className="oct-eyebrow mb-cozy">Contracts</p>
      <p className="type-body text-oct-muted">
        {totalCount === 0
          ? 'No contracts detected yet'
          : goodOnly && goodHidden > 0
            ? `Every match is from a mixed, slop or muted caller — ${goodHidden} hidden by the good-callers filter`
            : mutedCount > 0
              ? 'Every match is from a muted caller'
              : 'No contracts match your filters'}
      </p>
    </div>
  );
}
