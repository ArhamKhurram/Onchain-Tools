// A framed slice of the screen recording.
//
// Every product beat is a crop of public/capture/demo.mp4 rather than a separate
// clip: the Workspace section runs all four panels live at once, so punching into
// individual panels gives real motion in every beat from one continuous take —
// and the data across beats stays consistent because it *is* the same moment.
//
// Crops are expressed in source pixels against the 1920x1080 recording, which
// makes them readable against a screenshot and independent of the output size.

import React from 'react';
import { AbsoluteFill, OffthreadVideo, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { color, font, video } from '../brand';

export interface Crop {
  /** Source rect in the 1920x1080 recording. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Full frame — used for the wide establishing shots. */
export const FULL: Crop = { x: 0, y: 0, w: 1920, h: 1080 };

/**
 * Panel rects inside the Workspace layout (~155s-235s of the recording).
 * Nudge these rather than re-deriving them; they were measured off a still.
 */
export const PANEL = {
  // Splitter between the room feed and the middle column sits at ~x=634.
  roomFeed: { x: 14, y: 96, w: 616, h: 940 },
  contractFeed: { x: 648, y: 96, w: 800, h: 495 },
  radar: { x: 648, y: 600, w: 800, h: 440 },
  fomo: { x: 1458, y: 96, w: 448, h: 940 },
} as const;

/**
 * Renders a crop of the recording, letterboxed into the output frame with a
 * slow push. `startAt` is the source timecode in seconds.
 */
export const Shot: React.FC<{
  startAt: number;
  crop?: Crop;
  /** Total push over the beat: 1.06 means it ends 6% larger. */
  push?: number;
  /** Fraction of the SAFE AREA the framed product occupies. */
  fill?: number;
  durationInFrames: number;
}> = ({ startAt, crop = FULL, push = 1.06, fill = 1, durationInFrames }) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [0, durationInFrames], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const scale = 1 + (push - 1) * p;

  // Fit-CONTAIN inside a safe area, rather than fitting to width. Tall panels
  // (the room feed, the FOMO column) are far taller than they are wide, so
  // width-fitting magnified them ~2x and clipped the bottom. The safe area also
  // leaves a band at the foot of the frame so a caption never sits on the UI.
  const safeW = video.width * 0.88 * fill;
  const safeH = video.height * 0.74 * fill;
  const factor = Math.min(safeW / crop.w, safeH / crop.h);
  const targetW = crop.w * factor;
  const targetH = crop.h * factor;

  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div
        style={{
          width: targetW,
          height: targetH,
          overflow: 'hidden',
          borderRadius: 10,
          border: `1px solid ${color.divider}`,
          boxShadow: '0 40px 120px rgba(0,0,0,0.8)',
          transform: `scale(${scale})`,
        }}
      >
        {/* The video is scaled so the requested crop fills the frame, then
            offset so the crop's top-left sits at the frame's origin. */}
        <div
          style={{
            width: 1920 * factor,
            height: 1080 * factor,
            marginLeft: -crop.x * factor,
            marginTop: -crop.y * factor,
          }}
        >
          <OffthreadVideo
            src={staticFile('capture/demo.mp4')}
            startFrom={Math.round(startAt * video.fps)}
            muted
            style={{ width: '100%', height: '100%', display: 'block' }}
          />
        </div>
      </div>
    </AbsoluteFill>
  );
};

/** Lower-third caption. Fades in after the shot has settled. */
export const Caption: React.FC<{ children: React.ReactNode; from?: number }> = ({
  children,
  from = 12,
}) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [from, from + 12], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 68 }}>
      <div
        style={{
          fontFamily: font.mono,
          fontSize: 28,
          letterSpacing: '0.04em',
          color: color.muted,
          opacity: o,
        }}
      >
        {children}
      </div>
    </AbsoluteFill>
  );
};
