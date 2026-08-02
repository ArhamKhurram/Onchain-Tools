// Font loading. Without this the renderer silently falls back to a system serif
// and mono — the video still renders, it just is not OCT's brand, which is the
// kind of bug you only catch by looking at a frame.
//
// Fraunces + IBM Plex Mono match landing/tailwind.config.js.

import { loadFont as loadFraunces } from '@remotion/google-fonts/Fraunces';
import { loadFont as loadPlexMono } from '@remotion/google-fonts/IBMPlexMono';

const fraunces = loadFraunces('normal', { weights: ['700', '900'], subsets: ['latin'] });
const plexMono = loadPlexMono('normal', { weights: ['400', '500'], subsets: ['latin'] });

/** Resolved family names — use these rather than hardcoded strings. */
export const fontFamily = {
  display: fraunces.fontFamily,
  mono: plexMono.fontFamily,
} as const;

/** Await in delayRender if a composition needs guaranteed-loaded metrics. */
export const fontsReady = Promise.all([fraunces.waitUntilDone(), plexMono.waitUntilDone()]);
