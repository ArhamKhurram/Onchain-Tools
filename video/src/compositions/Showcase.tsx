// Showcase — the ~35s cut that goes under the tweet.
//
// Structure is deliberately one-idea-per-frame: a problem statement, three
// capability beats, then a single CTA. Screen footage is composited in later
// from public/capture (see scripts/capture.ts); the ScreenSlot component marks
// where each clip lands so the timing can be locked before footage exists.

import React from 'react';
import { AbsoluteFill, Sequence, useCurrentFrame, interpolate } from 'remotion';
import { color, font, sec, SNAP } from '../brand';
import { SlabIn, BlockWipe, Tag } from '../components/Kinetic';

/**
 * Placeholder for a real screen recording. Renders a labelled frame so the edit
 * can be timed before capture exists, and is swapped for <OffthreadVideo/> once
 * public/capture/<src> is populated.
 */
const ScreenSlot: React.FC<{ label: string; src: string }> = ({ label, src }) => {
  const frame = useCurrentFrame();
  const p = SNAP(interpolate(frame, [0, 10], [0, 1], { extrapolateRight: 'clamp' }));
  return (
    <AbsoluteFill
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        transform: `scale(${0.96 + p * 0.04})`,
        opacity: p,
      }}
    >
      <div
        style={{
          width: '78%',
          aspectRatio: '16 / 9',
          border: `2px solid ${color.divider}`,
          borderRadius: 12,
          background: color.surface,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
        }}
      >
        <div style={{ fontFamily: font.mono, fontSize: 28, color: color.muted }}>{label}</div>
        <div style={{ fontFamily: font.mono, fontSize: 18, color: color.faint }}>
          public/capture/{src}
        </div>
      </div>
    </AbsoluteFill>
  );
};

const Beat: React.FC<{ tag: string; line: string; sub?: string }> = ({ tag, line, sub }) => (
  <AbsoluteFill
    style={{
      background: color.bg,
      padding: 120,
      justifyContent: 'center',
      gap: 28,
    }}
  >
    <Tag from={0}>{tag}</Tag>
    <SlabIn from={3} size={132}>
      {line}
    </SlabIn>
    {sub ? (
      <SlabIn from={9} size={34} family={font.mono} weight={400} colorOverride={color.muted} tracking={0}>
        {sub}
      </SlabIn>
    ) : null}
  </AbsoluteFill>
);

export const Showcase: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: color.bg }}>
      {/* 0.0s — cold open: the problem, stated flat. */}
      <Sequence durationInFrames={sec(3.5)}>
        <Beat tag="the trenches" line={'Your alpha group\ncalled it.'} />
      </Sequence>

      {/* 3.5s — the turn. */}
      <Sequence from={sec(3.5)} durationInFrames={sec(2.5)}>
        <AbsoluteFill style={{ background: color.bg }}>
          <BlockWipe from={0} dur={8} fill={color.flame} />
          <AbsoluteFill style={{ padding: 120, justifyContent: 'center' }}>
            <SlabIn from={6} size={150} colorOverride={color.bg}>
              You missed it.
            </SlabIn>
          </AbsoluteFill>
        </AbsoluteFill>
      </Sequence>

      {/* 6.0s — capability 1: the feed. */}
      <Sequence from={sec(6)} durationInFrames={sec(5)}>
        <AbsoluteFill style={{ background: color.bg }}>
          <ScreenSlot label="Live feed — Discord + Telegram in one console" src="feed.mp4" />
        </AbsoluteFill>
      </Sequence>

      {/* 11.0s — capability 2: contract detection. */}
      <Sequence from={sec(11)} durationInFrames={sec(5)}>
        <AbsoluteFill style={{ background: color.bg }}>
          <ScreenSlot label="Contract detected the second it drops" src="contract.mp4" />
        </AbsoluteFill>
      </Sequence>

      {/* 16.0s — capability 3: the payoff. */}
      <Sequence from={sec(16)} durationInFrames={sec(5)}>
        <AbsoluteFill style={{ background: color.bg }}>
          <ScreenSlot label="Missed-runner alert — the one you scrolled past" src="missed-runner.mp4" />
        </AbsoluteFill>
      </Sequence>

      {/* 21.0s — the claim. */}
      <Sequence from={sec(21)} durationInFrames={sec(4)}>
        <Beat
          tag="onchain tools"
          line={'Every call.\nOne console.'}
          sub="Discord · Telegram · live contract detection"
        />
      </Sequence>

      {/* 25.0s — CTA. Type is sized to fill the frame: the reference board's
          confidence comes from leaving almost no dead space. */}
      <Sequence from={sec(25)} durationInFrames={sec(5)}>
        <AbsoluteFill style={{ background: color.flame, padding: 100, justifyContent: 'center', gap: 8 }}>
          <SlabIn from={2} size={230} colorOverride={color.bg}>
            Stop
          </SlabIn>
          <SlabIn from={5} size={230} colorOverride={color.bg}>
            scrolling.
          </SlabIn>
          <div style={{ height: 40 }} />
          <SlabIn
            from={11}
            size={44}
            family={font.mono}
            weight={500}
            colorOverride={color.bg}
            tracking={0.02}
          >
            {'onchain-tools.app'}
          </SlabIn>
        </AbsoluteFill>
      </Sequence>
    </AbsoluteFill>
  );
};

export const SHOWCASE_DURATION = sec(30);
