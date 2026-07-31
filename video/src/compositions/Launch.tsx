// Launch — the ~60s product-forward cut, per SCRIPT.md.
//
// Structure follows the Grok reference: real product UI, slow push-ins,
// cross-dissolves, one small line of copy per beat, ending on a still logo.
// Everything you see is the actual console (public/capture/demo.mp4).
//
// Source timecodes, mapped from the recording:
//   0-12s    landing
//   12-24s   console home (module picker)
//   45-70s   contract feed, full screen
//   70-135s  FOMO — holders, leaderboard, trader lookup
//   155-235s workspace — room feed / contract feed / radar / FOMO all live
//   240-270s settings, incl. caller quality

import React from 'react';
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame } from 'remotion';
import { color, font, sec } from '../brand';
import { Shot, Caption, PANEL, FULL } from '../components/Shot';
import { SlabIn } from '../components/Kinetic';

/** Cross-dissolve wrapper — the only transition in this cut. */
const Dissolve: React.FC<{ children: React.ReactNode; dur: number }> = ({ children, dur }) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [0, 14, dur - 14, dur], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>;
};

const BEATS = {
  open: sec(6),
  feed: sec(10),
  detect: sec(10),
  radar: sec(10),
  fomo: sec(8),
  quality: sec(8),
  close: sec(8),
} as const;

let cursor = 0;
const at = (d: number) => {
  const from = cursor;
  cursor += d;
  return from;
};

const OPEN_AT = at(BEATS.open);
const FEED_AT = at(BEATS.feed);
const DETECT_AT = at(BEATS.detect);
const RADAR_AT = at(BEATS.radar);
const FOMO_AT = at(BEATS.fomo);
const QUALITY_AT = at(BEATS.quality);
const CLOSE_AT = at(BEATS.close);

export const LAUNCH_DURATION = cursor;

export const Launch: React.FC = () => (
  <AbsoluteFill style={{ background: color.bg }}>
    {/* Cold open — the console at rest. No claim until something real is on screen. */}
    <Sequence from={OPEN_AT} durationInFrames={BEATS.open}>
      <Dissolve dur={BEATS.open}>
        <Shot startAt={14} crop={FULL} fill={0.92} push={1.05} durationInFrames={BEATS.open} />
        <Caption from={sec(2)}>Every alpha call. One console.</Caption>
      </Dissolve>
    </Sequence>

    {/* The feed — punch into the room-feed panel while messages arrive. */}
    <Sequence from={FEED_AT} durationInFrames={BEATS.feed}>
      <Dissolve dur={BEATS.feed}>
        <Shot startAt={196} crop={PANEL.roomFeed} fill={1} push={1.07} durationInFrames={BEATS.feed} />
        <Caption>Discord + Telegram, one stream</Caption>
      </Dissolve>
    </Sequence>

    {/* Detection — the contract feed, enriched. */}
    <Sequence from={DETECT_AT} durationInFrames={BEATS.detect}>
      <Dissolve dur={BEATS.detect}>
        <Shot startAt={52} crop={FULL} fill={1} push={1.08} durationInFrames={BEATS.detect} />
        <Caption>Detected and enriched, the second it drops</Caption>
      </Dissolve>
    </Sequence>

    {/* Radar — the differentiator. Punch into the radar panel. */}
    <Sequence from={RADAR_AT} durationInFrames={BEATS.radar}>
      <Dissolve dur={BEATS.radar}>
        <Shot startAt={205} crop={PANEL.radar} fill={1} push={1.07} durationInFrames={BEATS.radar} />
        <Caption>Every call, ranked by who made it</Caption>
      </Dissolve>
    </Sequence>

    {/* FOMO — live trades. */}
    <Sequence from={FOMO_AT} durationInFrames={BEATS.fomo}>
      <Dissolve dur={BEATS.fomo}>
        <Shot startAt={214} crop={PANEL.fomo} fill={1} push={1.06} durationInFrames={BEATS.fomo} />
        <Caption>fomo.family, live</Caption>
      </Dissolve>
    </Sequence>

    {/* Caller quality — the settings screen that explains the bands. */}
    <Sequence from={QUALITY_AT} durationInFrames={BEATS.quality}>
      <Dissolve dur={BEATS.quality}>
        <Shot startAt={252} crop={FULL} fill={1} push={1.06} durationInFrames={BEATS.quality} />
        <Caption>Callers earn a rating from their own calls</Caption>
      </Dissolve>
    </Sequence>

    {/* Close — still logo, air around it. */}
    <Sequence from={CLOSE_AT} durationInFrames={BEATS.close}>
      <Dissolve dur={BEATS.close}>
        <AbsoluteFill
          style={{ background: color.bg, alignItems: 'center', justifyContent: 'center', gap: 26 }}
        >
          <SlabIn from={6} size={150} tracking={-0.04}>
            OCT
          </SlabIn>
          <SlabIn from={20} size={30} family={font.mono} weight={400} colorOverride={color.muted} tracking={0.08}>
            onchaintools.tech
          </SlabIn>
        </AbsoluteFill>
      </Dissolve>
    </Sequence>
  </AbsoluteFill>
);
