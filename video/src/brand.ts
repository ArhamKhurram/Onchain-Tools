// OCT brand tokens, mirrored from landing/tailwind.config.js so video and site
// cannot drift. If the landing theme changes, change these to match.
//
// Direction: keep OCT's own palette (black / flame red / mono) and borrow the
// STRUCTURE of the reference board — oversized tightly-kerned type, hard colour
// blocking, one idea per frame, motion that snaps rather than eases. Repainting
// OCT electric-blue would read as a different company.

export const color = {
  bg: '#000000',
  surface: '#0a0a0a',
  flame: '#ff1744',
  flameHover: '#ff4569',
  text: '#ffffff',
  muted: '#888888',
  faint: '#555555',
  divider: '#222222',
  // Chain accents used by the console — reuse so footage and captions agree.
  solana: '#14f195',
  evm: '#ffab00',
} as const;

// Resolved from the actually-loaded webfonts (see fonts.ts). Importing here
// means every composition that touches `font` also triggers the font load, so a
// frame can never render in a silent system fallback.
import { fontFamily } from './fonts';

export const font = {
  display: `${fontFamily.display}, Georgia, serif`,
  mono: `${fontFamily.mono}, ui-monospace, monospace`,
} as const;

/** 16:9 for both cuts. */
export const video = {
  width: 1920,
  height: 1080,
  fps: 30,
} as const;

export const guideVideo = video;

/**
 * Snap easing. The reference board's energy comes from motion that arrives
 * decisively — a fast out-quint rather than a soft ease-in-out.
 */
export const SNAP = (t: number): number => 1 - Math.pow(1 - t, 5);

/** Frames helper: seconds -> frames at the project fps. */
export const sec = (s: number): number => Math.round(s * video.fps);
