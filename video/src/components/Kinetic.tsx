// Shared motion primitives. Everything here snaps rather than eases — that is
// the single biggest contributor to the reference board's energy.

import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import { color, font, SNAP } from '../brand';

/** Frames since `from`, normalised 0..1 over `dur`, snap-eased. */
function progress(frame: number, from: number, dur: number): number {
  const t = interpolate(frame, [from, from + dur], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return SNAP(t);
}

/** A slab of type that arrives from below behind a hard mask. */
export const SlabIn: React.FC<{
  children: React.ReactNode;
  from?: number;
  dur?: number;
  size?: number;
  weight?: number;
  colorOverride?: string;
  family?: string;
  tracking?: number;
}> = ({
  children,
  from = 0,
  dur = 12,
  size = 120,
  weight = 700,
  colorOverride,
  family = font.display,
  tracking = -0.03,
}) => {
  const frame = useCurrentFrame();
  const p = progress(frame, from, dur);
  // The reveal mask must not clip descenders (g, y, p). Pad the mask below the
  // baseline and pull it back with a negative margin, so the mask covers the
  // ascender edge during the slide but the descender is never cut once settled.
  const descender = Math.ceil(size * 0.3);
  return (
    <div
      style={{
        overflow: 'hidden',
        display: 'block',
        paddingBottom: descender,
        marginBottom: -descender,
      }}
    >
      <div
        style={{
          transform: `translateY(${(1 - p) * 100}%)`,
          fontFamily: family,
          fontSize: size,
          fontWeight: weight,
          letterSpacing: `${tracking}em`,
          lineHeight: 1.02,
          color: colorOverride ?? color.text,
        }}
      >
        {children}
      </div>
    </div>
  );
};

/** A hard colour block that wipes across, used to punctuate cuts. */
export const BlockWipe: React.FC<{
  from?: number;
  dur?: number;
  fill?: string;
  direction?: 'left' | 'right';
}> = ({ from = 0, dur = 10, fill = color.flame, direction = 'left' }) => {
  const frame = useCurrentFrame();
  const p = progress(frame, from, dur);
  const x = direction === 'left' ? `${-100 + p * 100}%` : `${100 - p * 100}%`;
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: fill,
        transform: `translateX(${x})`,
      }}
    />
  );
};

/** Mono label — the small all-caps tag used above headlines. */
export const Tag: React.FC<{ children: React.ReactNode; from?: number }> = ({
  children,
  from = 0,
}) => {
  const frame = useCurrentFrame();
  const p = progress(frame, from, 8);
  return (
    <div
      style={{
        fontFamily: font.mono,
        fontSize: 24,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        color: color.flame,
        opacity: p,
      }}
    >
      {children}
    </div>
  );
};
