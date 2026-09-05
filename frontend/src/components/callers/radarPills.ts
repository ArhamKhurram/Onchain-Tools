// Shared pill chrome for every toggle in the Radar's toolbar and settings
// popover. A tiny module of its own so RadarToolbar (which renders
// RadarSettings) and RadarSettings (which uses these) don't import each other.
//
// `text-2xs` (12px) rather than the old `text-[11px]`: the floor of the type
// ramp, and the same size the column headers now use.
export const RADAR_PILL_CLASS =
  'px-cozy py-tight rounded-oct-sm font-mono text-2xs font-bold uppercase border transition-all duration-fast';
export const RADAR_PILL_ON_CLASS = 'bg-oct-accent text-white border-oct-accent/50 shadow-oct-glow-accent';
export const RADAR_PILL_OFF_CLASS =
  'text-oct-muted border-transparent hover:text-oct-text hover:border-oct-border-bright';
/** The outlined variant, for pills that need a visible edge when off. */
export const RADAR_PILL_OUTLINE_CLASS =
  'text-oct-muted border-oct-border-bright hover:text-oct-text hover:border-oct-text';
