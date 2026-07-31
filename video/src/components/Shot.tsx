// A framed slice of the screen recording.
//
// Rule that matters: a shot ALWAYS fills the output frame. Crops are 16:9
// regions of the 1920x1080 recording, scaled up to cover 1920x1080 exactly.
//
// The previous version contained arbitrary-aspect panel crops inside a safe
// area, which for a tall panel (616x940) resolved to ~520px wide in a 1920 frame
// — the product ended up marooned in a black void. Emphasis comes from WHERE the
// region is and how far it pushes, never from shrinking the product.

import React from 'react';
import { AbsoluteFill, OffthreadVideo, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { color, font, video } from '../brand';

export interface Crop {
  /** Top-left of a 16:9 region in the 1920x1080 recording. */
  x: number;
  y: number;
  /** Width of the region; height is derived as w * 9/16. */
  w: number;
}

/** The whole screen. */
export const FULL: Crop = { x: 0, y: 0, w: 1920 };

/**
 * 16:9 regions of the Workspace layout (~155s-235s), each framed so the panel of
 * interest dominates while neighbouring panels stay in shot as context — which is
 * what the reference does: the product looks like a real application, not a
 * cropped-out widget.
 */
export const REGION = {
  /** Room feed dominant, contract feed bleeding in at the right. */
  feed: { x: 0, y: 150, w: 1180 },
  /** Contract feed centred. */
  contracts: { x: 470, y: 96, w: 1180 },
  /** Radar centred, feed at left edge for context. */
  radar: { x: 400, y: 470, w: 1250 },
  /** FOMO column with the radar shoulder. */
  fomo: { x: 900, y: 120, w: 1020 },
  /** Whole workspace, slight inset. */
  workspace: { x: 20, y: 40, w: 1880 },
} as const;

export const Shot: React.FC<{
  startAt: number;
  crop?: Crop;
  /** Total push over the beat: 1.06 ends 6% tighter. */
  push?: number;
  durationInFrames: number;
}> = ({ startAt, crop = FULL, push = 1.06, durationInFrames }) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [0, durationInFrames], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const scale = 1 + (push - 1) * p;

  // Scale so the crop region exactly covers the output frame.
  const factor = video.width / crop.w;

  return (
    <AbsoluteFill style={{ overflow: 'hidden', background: color.bg }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          transform: `scale(${scale})`,
          transformOrigin: 'center center',
        }}
      >
        <div
          style={{
            position: 'absolute',
            width: 1920 * factor,
            height: 1080 * factor,
            left: -crop.x * factor,
            top: -crop.y * factor,
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

/**
 * Caption over a full-bleed shot. Needs a scrim now that the UI runs to the
 * frame edge, or mono grey text lands on top of message rows.
 */
export const Caption: React.FC<{ children: React.ReactNode; from?: number }> = ({
  children,
  from = 14,
}) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [from, from + 14], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center' }}>
      <div
        style={{
          width: '100%',
          paddingTop: 130,
          paddingBottom: 58,
          display: 'flex',
          justifyContent: 'center',
          background: 'linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,0.93) 58%)',
          opacity: o,
        }}
      >
        <span
          style={{
            fontFamily: font.mono,
            fontSize: 30,
            letterSpacing: '0.05em',
            color: '#e8e8e8',
          }}
        >
          {children}
        </span>
      </div>
    </AbsoluteFill>
  );
};
