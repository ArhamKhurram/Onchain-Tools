// Shared chrome for the LP automation page.
//
// Everything here is expressed in `oct-*` tokens so the page themes with the
// rest of the console (dark: black/red, light: cream/blue) instead of pinning
// dark-mode colours the way some older panels do.
//
// The one deliberate visual rule: MONEY reads differently from CONFIGURATION.
// A number that can move funds is set in the display face with a hairline
// accent rail; a number that only shapes behaviour is set in mono. That
// distinction is load-bearing on a page whose whole job is to make the
// consequences of a setting obvious.

export const LP_PANEL = 'border-2 border-oct-border bg-oct-surface';
export const LP_PANEL_HEADER =
  'px-4 py-3 border-b-2 border-oct-border bg-oct-surface-raised flex items-center justify-between gap-3 flex-wrap';
export const LP_PANEL_TITLE =
  'font-mono text-[11px] uppercase tracking-[0.16em] text-oct-text font-semibold';
export const LP_EYEBROW = 'font-mono text-[10px] uppercase tracking-[0.2em] text-oct-muted';
export const LP_HELP = 'font-mono text-[11px] leading-relaxed text-oct-muted';

/** Live plain-English readout of what a group of settings does. */
export const LP_READOUT =
  'font-mono text-[11px] leading-relaxed text-oct-text border-l-2 border-oct-accent pl-3 py-1';

export const LP_INPUT =
  'w-full bg-oct-bg border-2 px-2.5 py-1.5 font-mono text-sm text-oct-text tabular-nums outline-none transition-colors placeholder:text-oct-muted focus:border-oct-accent';

export const LP_BTN =
  'inline-flex items-center justify-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.12em] border-2 px-3 py-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

export const LP_BTN_GHOST = `${LP_BTN} border-oct-border-bright text-oct-muted hover:text-oct-text hover:border-oct-text`;
export const LP_BTN_PRIMARY = `${LP_BTN} border-oct-accent bg-oct-accent text-white hover:bg-oct-accent-hover hover:border-oct-accent-hover`;

/** A number that can move money. */
export const LP_MONEY_VALUE = 'font-display text-2xl tracking-tight tabular-nums text-oct-text';
/** A number that only shapes behaviour. */
export const LP_CONFIG_VALUE = 'font-mono text-xl tabular-nums text-oct-text';
