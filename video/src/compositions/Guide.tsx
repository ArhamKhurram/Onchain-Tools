// Guide — the ~110s onboarding walkthrough.
//
// Steps mirror landing/src/components/Tutorial.tsx exactly (Requirements →
// Getting Started → Discord Token → Telegram → Running). That component is the
// source of truth: if the flow changes there, change it here, not the reverse.
//
// The Discord-token step is the one users actually get stuck on, so it gets the
// most screen time and the zoom-ins.
//
// SECURITY: the token step shows a credential field. Capture must use a throwaway
// token, and RedactBox marks the region to blur if any real value is on screen.

import React from 'react';
import { AbsoluteFill, Sequence, useCurrentFrame, interpolate } from 'remotion';
import { color, font, sec, SNAP } from '../brand';
import { SlabIn, Tag } from '../components/Kinetic';

/**
 * A screen clip with a Ken-Burns-style push and an optional focus rect that
 * zooms toward a region of the frame — the "zoom in on the thing" move.
 * `focus` is in 0..1 units of the clip, so it survives a resolution change.
 */
const ScreenStep: React.FC<{
  label: string;
  src: string;
  focus?: { x: number; y: number; scale: number };
  redact?: { x: number; y: number; w: number; h: number };
}> = ({ label, src, focus, redact }) => {
  const frame = useCurrentFrame();
  const p = SNAP(interpolate(frame, [0, 24], [0, 1], { extrapolateRight: 'clamp' }));

  const scale = focus ? 1 + (focus.scale - 1) * p : 1;
  const originX = focus ? focus.x * 100 : 50;
  const originY = focus ? focus.y * 100 : 50;

  return (
    <AbsoluteFill style={{ background: color.bg, alignItems: 'center', justifyContent: 'center' }}>
      <div
        style={{
          position: 'relative',
          width: '82%',
          aspectRatio: '16 / 9',
          border: `2px solid ${color.divider}`,
          borderRadius: 12,
          background: color.surface,
          overflow: 'hidden',
          transform: `scale(${scale})`,
          transformOrigin: `${originX}% ${originY}%`,
        }}
      >
        {/* Placeholder until public/capture/<src> exists; swapped for OffthreadVideo. */}
        <AbsoluteFill
          style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12 }}
        >
          <div style={{ fontFamily: font.mono, fontSize: 26, color: color.muted }}>{label}</div>
          <div style={{ fontFamily: font.mono, fontSize: 16, color: color.faint }}>
            public/capture/{src}
          </div>
        </AbsoluteFill>

        {redact ? (
          <div
            style={{
              position: 'absolute',
              left: `${redact.x * 100}%`,
              top: `${redact.y * 100}%`,
              width: `${redact.w * 100}%`,
              height: `${redact.h * 100}%`,
              background: color.flame,
              opacity: 0.9,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: font.mono,
              fontSize: 14,
              color: color.bg,
              letterSpacing: '0.1em',
            }}
          >
            REDACTED
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};

/** Full-bleed step card between screen sections. */
const StepCard: React.FC<{ n: string; title: string; body: string }> = ({ n, title, body }) => (
  <AbsoluteFill style={{ background: color.bg, padding: 130, justifyContent: 'center', gap: 24 }}>
    <Tag from={0}>step {n}</Tag>
    <SlabIn from={3} size={104}>
      {title}
    </SlabIn>
    <SlabIn from={9} size={32} family={font.mono} weight={400} colorOverride={color.muted} tracking={0}>
      {body}
    </SlabIn>
  </AbsoluteFill>
);

export const Guide: React.FC = () => (
  <AbsoluteFill style={{ background: color.bg }}>
    {/* 0s — title */}
    <Sequence durationInFrames={sec(3)}>
      <AbsoluteFill style={{ background: color.bg, padding: 130, justifyContent: 'center', gap: 20 }}>
        <Tag from={0}>onchain tools</Tag>
        <SlabIn from={3} size={128}>
          {'Getting started\nin 5 steps.'}
        </SlabIn>
      </AbsoluteFill>
    </Sequence>

    {/* 3s — step 1: requirements */}
    <Sequence from={sec(3)} durationInFrames={sec(5)}>
      <StepCard n="1" title="Requirements" body="Node.js v18+ · npm · Git" />
    </Sequence>

    {/* 8s — step 2: sign in */}
    <Sequence from={sec(8)} durationInFrames={sec(5)}>
      <StepCard n="2" title="Sign in" body="Create your OCT account, then open the console" />
    </Sequence>
    <Sequence from={sec(13)} durationInFrames={sec(8)}>
      <ScreenStep label="Console — first load" src="01-signin.mp4" />
    </Sequence>

    {/* 21s — step 3: the Discord token. The step people get stuck on. */}
    <Sequence from={sec(21)} durationInFrames={sec(5)}>
      <StepCard
        n="3"
        title="Your Discord token"
        body="F12 → Network → refresh → find `authorization` in request headers"
      />
    </Sequence>
    <Sequence from={sec(26)} durationInFrames={sec(10)}>
      <ScreenStep
        label="DevTools — locating the authorization header"
        src="02-token-devtools.mp4"
        focus={{ x: 0.42, y: 0.62, scale: 2.1 }}
        redact={{ x: 0.34, y: 0.56, w: 0.34, h: 0.07 }}
      />
    </Sequence>
    <Sequence from={sec(36)} durationInFrames={sec(8)}>
      <ScreenStep
        label="Settings → Tokens — paste it here"
        src="03-token-paste.mp4"
        focus={{ x: 0.5, y: 0.4, scale: 1.7 }}
      />
    </Sequence>

    {/* 44s — the warning. Non-negotiable, it is in the Tutorial too. */}
    <Sequence from={sec(44)} durationInFrames={sec(5)}>
      <AbsoluteFill style={{ background: color.flame, padding: 130, justifyContent: 'center', gap: 20 }}>
        <SlabIn from={2} size={96} colorOverride={color.bg}>
          Never share your token.
        </SlabIn>
        <SlabIn from={8} size={30} family={font.mono} weight={400} colorOverride={color.bg} tracking={0}>
          It is full account access. Self-bots are against Discord&apos;s ToS — use at your own risk.
        </SlabIn>
      </AbsoluteFill>
    </Sequence>

    {/* 49s — step 4: rooms */}
    <Sequence from={sec(49)} durationInFrames={sec(5)}>
      <StepCard n="4" title="Build a room" body="Pick the channels you actually want to watch" />
    </Sequence>
    <Sequence from={sec(54)} durationInFrames={sec(10)}>
      <ScreenStep
        label="Room config — selecting channels"
        src="04-rooms.mp4"
        focus={{ x: 0.3, y: 0.5, scale: 1.6 }}
      />
    </Sequence>

    {/* 64s — step 5: telegram (optional) */}
    <Sequence from={sec(64)} durationInFrames={sec(5)}>
      <StepCard n="5" title="Add Telegram" body="Optional — same feed, second source" />
    </Sequence>
    <Sequence from={sec(69)} durationInFrames={sec(8)}>
      <ScreenStep label="Telegram setup" src="05-telegram.mp4" />
    </Sequence>

    {/* 77s — running: the payoff */}
    <Sequence from={sec(77)} durationInFrames={sec(5)}>
      <StepCard n="✓" title="You're live" body="Contracts detected and enriched as they drop" />
    </Sequence>
    <Sequence from={sec(82)} durationInFrames={sec(12)}>
      <ScreenStep
        label="Live feed — contract detected and enriched"
        src="06-running.mp4"
        focus={{ x: 0.55, y: 0.45, scale: 1.8 }}
      />
    </Sequence>

    {/* 94s — CTA */}
    <Sequence from={sec(94)} durationInFrames={sec(6)}>
      <AbsoluteFill style={{ background: color.bg, padding: 130, justifyContent: 'center', gap: 22 }}>
        <SlabIn from={2} size={112}>
          That&apos;s it.
        </SlabIn>
        <SlabIn from={8} size={34} family={font.mono} weight={500} colorOverride={color.flame} tracking={0.02}>
          onchaintools.tech
        </SlabIn>
      </AbsoluteFill>
    </Sequence>
  </AbsoluteFill>
);

export const GUIDE_DURATION = sec(100);
