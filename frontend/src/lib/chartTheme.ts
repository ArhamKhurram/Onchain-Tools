// Bridges the `--oct-*` design tokens into a canvas chart. lightweight-charts
// paints on a <canvas>, so it cannot read a CSS variable the way a Tailwind class
// can — every colour has to be resolved to a concrete string at runtime, and
// re-resolved when the theme flips. That resolution is the only thing this module
// does; the palette shape is what the chart component consumes.
//
// Colour is semantic here, not brand: an up candle is `oct-good`, a down candle is
// `oct-critical`. In the dark theme the accent is itself a red, so painting candles
// with the accent would make every red bar read as "brand" — exactly the collision
// the semantic ramp exists to avoid.

export interface ChartPalette {
  up: string;
  down: string;
  text: string;
  muted: string;
  grid: string;
  border: string;
  crosshair: string;
  background: string;
  fontFamily: string;
}

/**
 * The tokens are stored as bare space-separated channels (`45 210 122`, or
 * `45 210 122 / 0.14`) so Tailwind can append its own alpha. A canvas wants a
 * complete colour, so wrap the triplet back into `rgb(...)`; a token that is
 * unset or malformed returns null rather than a string the canvas would choke on.
 */
export function rgbFromTriplet(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!/^\d{1,3}\s+\d{1,3}\s+\d{1,3}(\s*\/\s*(0|1|0?\.\d+))?$/.test(value)) return null;
  return `rgb(${value})`;
}

/** Add an alpha to a bare triplet — used for grid lines that must not compete with candles. */
export function rgbWithAlpha(raw: string | null | undefined, alpha: number): string | null {
  if (!raw) return null;
  const channels = raw.trim().split('/')[0].trim();
  if (!/^\d{1,3}\s+\d{1,3}\s+\d{1,3}$/.test(channels)) return null;
  return `rgb(${channels} / ${alpha})`;
}

/**
 * Fallbacks matching the dark theme, so a detached or pre-paint read still draws
 * something sane instead of transparent-on-transparent.
 */
const FALLBACK: ChartPalette = {
  up: 'rgb(45 210 122)',
  down: 'rgb(255 92 61)',
  text: 'rgb(245 246 248)',
  muted: 'rgb(150 156 168)',
  grid: 'rgb(44 47 56 / 0.6)',
  border: 'rgb(44 47 56)',
  crosshair: 'rgb(150 156 168 / 0.6)',
  background: 'rgb(14 15 19)',
  fontFamily: '"JetBrains Mono", ui-monospace, monospace',
};

/** Resolve the palette from the tokens currently applied to `el` (or the root). */
export function readChartPalette(el: Element = document.documentElement): ChartPalette {
  const styles = getComputedStyle(el);
  const token = (name: string) => styles.getPropertyValue(name);
  return {
    up: rgbFromTriplet(token('--oct-good')) ?? FALLBACK.up,
    down: rgbFromTriplet(token('--oct-critical')) ?? FALLBACK.down,
    text: rgbFromTriplet(token('--oct-text')) ?? FALLBACK.text,
    muted: rgbFromTriplet(token('--oct-muted')) ?? FALLBACK.muted,
    grid: rgbWithAlpha(token('--oct-border'), 0.6) ?? FALLBACK.grid,
    border: rgbFromTriplet(token('--oct-border')) ?? FALLBACK.border,
    crosshair: rgbWithAlpha(token('--oct-muted'), 0.6) ?? FALLBACK.crosshair,
    background: rgbFromTriplet(token('--oct-panel')) ?? FALLBACK.background,
    fontFamily: FALLBACK.fontFamily,
  };
}
