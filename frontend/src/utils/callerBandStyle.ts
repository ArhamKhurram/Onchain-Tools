import { MIN_RATED_CALLS, type CallerBand, type CallerScore } from '@oct/shared';

/**
 * One place for how a caller band reads across the console, so the chat feed,
 * contract feed, and Radar can't drift into three different colour languages.
 *
 * `unrated` is deliberately the plain text colour rather than a warning tone —
 * most callers will sit there until they have history, and painting them all as
 * suspect would make the whole feed look flagged.
 */
export const BAND_TEXT_CLASS: Record<CallerBand, string> = {
  elite: 'text-oct-green',
  solid: 'text-oct-live',
  mixed: 'text-oct-yellow',
  unrated: 'text-oct-text',
  slop: 'text-oct-muted',
};

export const BAND_DOT_CLASS: Record<CallerBand, string> = {
  elite: 'bg-oct-green',
  solid: 'bg-oct-live',
  mixed: 'bg-oct-yellow',
  unrated: 'bg-oct-border-bright',
  slop: 'bg-oct-muted',
};

/**
 * Tooltips for a band.
 *
 * These are **reach** bands, and the wording has to keep saying so. A band
 * comes from hit rate and slop rate over `peak ÷ MC at call`, where the peak is
 * the highest market cap we have *observed* since the call and multiples are
 * floored at 1x. So "Elite" means "a lot of their calls touched 2x at some
 * point", never "you would have made 2x following them" — nobody exits at the
 * peak, and the peak itself is sampled every few minutes, so a spike between
 * samples is missed. Same framing as the Caller Quality settings panel.
 */
export const BAND_TITLE: Record<CallerBand, string> = {
  elite:
    'Elite reach — 40%+ of their scored calls touched 2x at some point after the call, and few went nowhere. Reach, not realized profit: peaks are sampled, so multiples are floors.',
  solid:
    'Solid reach — 20%+ of their scored calls touched 2x at some point after the call. Reach, not realized profit: peaks are sampled, so multiples are floors.',
  mixed: 'Mixed reach — some of their calls ran, plenty went nowhere.',
  unrated: `Not enough call history to rate yet — under ${MIN_RATED_CALLS} scored calls.`,
  slop: 'Mostly slop — nearly none of their calls got meaningfully above the market cap they called at.',
};

/**
 * One line the feed can print next to the bands, so the reach framing is
 * visible without having to hover a badge.
 */
export const BAND_REACH_NOTE =
  'Bands are reach, not profit: the share of a caller’s calls that touched 2x at some point, from sampled peaks.';

/**
 * Background + text pair for the small badge shown next to a name in the feed.
 *
 * The chat feed and Radar only render badges for the bands worth flagging
 * (see `bandIsNotable`), so `mixed` is inert there — it exists for the
 * contract feed, which labels every row so a CA is never of unknown
 * provenance. `unrated` stays empty: its badge is the dashed outline style,
 * not a filled pill (see the contract feed's CallerBandBadge).
 */
export const BAND_BADGE_CLASS: Record<CallerBand, string> = {
  elite: 'bg-oct-green/15 text-oct-green',
  solid: 'bg-oct-live/15 text-oct-live',
  mixed: 'bg-oct-yellow/15 text-oct-yellow',
  unrated: '',
  slop: 'bg-oct-muted/15 text-oct-muted',
};

/** Only bands worth drawing attention to get a marker; the rest stay quiet. */
export function bandIsNotable(band: CallerBand): boolean {
  return band === 'elite' || band === 'solid' || band === 'slop';
}

/**
 * Username colour in the chat feed, as a CSS var so it follows the theme.
 *
 * `null` means "leave the name alone". Only the notable bands get painted —
 * colouring every caller would turn the feed into a highlighter and drown out
 * the manual highlights that are supposed to stand out.
 */
export const BAND_NAME_COLOR: Record<CallerBand, string | null> = {
  elite: 'rgb(var(--oct-green))',
  solid: 'rgb(var(--oct-live))',
  mixed: null,
  unrated: null,
  slop: 'rgb(var(--oct-muted))',
};

export function formatMultiple(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}×`;
}

/**
 * A multiple that is an observed floor, not an exact figure. Peaks are sampled
 * (every ~3 min, plus opportunistic observations), so a spike between samples
 * is missed — the honest claim is "at least this", never "exactly this".
 */
export function formatMultipleFloor(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `≥${formatMultiple(value)}`;
}

export function formatRate(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${Math.round(value * 100)}%`;
}

/** One inline analytic on a feed row — a short label plus a hover explanation. */
export interface CallerStatChip {
  label: string;
  title: string;
}

/**
 * The compact per-row analytics readout for the Top Callers Feed, e.g.
 * `42% 2x · 15% 5x · 18 calls · ≥2.5× med`.
 *
 * Every figure is honest about being **reach**, not realized return — the same
 * framing as the band tooltips and the Caller Quality settings panel. Hit rates
 * are the share of a caller's *scored* calls that touched a multiple at some
 * point; the median and best are observed floors (`≥`) because peaks are
 * sampled. Returns an empty list when there's no scored history to show (a
 * freshly trusted caller with no calls yet), so the caller renders the manual
 * trust instead of a row of dashes.
 */
export function callerStatChips(score: CallerScore | undefined): CallerStatChip[] {
  if (!score || score.rated <= 0) return [];
  const chips: CallerStatChip[] = [];

  if (score.hitRate2x != null) {
    chips.push({
      label: `${formatRate(score.hitRate2x)} 2x`,
      title: `${formatRate(score.hitRate2x)} of ${score.rated} scored calls touched 2x at some point after the call — reach, not realized profit.`,
    });
  }
  if (score.hitRate5x != null && score.hitRate5x > 0) {
    chips.push({
      label: `${formatRate(score.hitRate5x)} 5x`,
      title: `${formatRate(score.hitRate5x)} of ${score.rated} scored calls touched 5x at some point after the call.`,
    });
  }
  chips.push({
    label: `${score.rated} call${score.rated === 1 ? '' : 's'}`,
    title: `${score.rated} scored call${score.rated === 1 ? '' : 's'} (of ${score.calls} logged) — the sample the band is built from.`,
  });
  if (score.medianMultiple != null) {
    chips.push({
      label: `${formatMultipleFloor(score.medianMultiple)} med`,
      title: 'Median reach multiple across scored calls — an observed floor, since peaks are sampled.',
    });
  }
  return chips;
}
