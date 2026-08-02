import type { CallerBand } from '@oct/shared';

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

export const BAND_TITLE: Record<CallerBand, string> = {
  elite: 'Elite caller — high hit rate on their own calls',
  solid: 'Solid caller',
  mixed: 'Mixed record',
  unrated: 'Not enough call history to rate yet',
  slop: 'Mostly slop — few calls have gone anywhere',
};

/**
 * Background + text pair for the small badge shown next to a name in the feed.
 * Only defined for the bands worth flagging (see `bandIsNotable`) — `mixed`
 * and `unrated` intentionally render no badge.
 */
export const BAND_BADGE_CLASS: Record<CallerBand, string> = {
  elite: 'bg-oct-green/15 text-oct-green',
  solid: 'bg-oct-live/15 text-oct-live',
  mixed: '',
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

export function formatRate(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${Math.round(value * 100)}%`;
}
