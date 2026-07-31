// Showcase — ~30s square cut for social.
//
// Arc: the problem → the feed catches it → the CA drops → it runs → the alert
// you would have gotten. The missed-runner beat is the payoff, so it gets the
// most screen time and the chart.
//
// UI is recreated natively rather than screen-captured: the reference edit
// punches hard into content for phone legibility, and native gives real 30fps
// motion with no cursor jitter. All data is fabricated (src/fixtures.ts).

import React from 'react';
import { AbsoluteFill, Sequence } from 'remotion';
import { color, font, sec } from '../brand';
import { SlabIn, BlockWipe, Tag } from '../components/Kinetic';
import { FeedMessage, MissedRunnerToast, GainRow, ChartUp, Stage } from '../components/ConsoleUI';
import { FAKE_SOL_MINT } from '../fixtures';

const Beat: React.FC<{ tag?: string; lines: string[]; sub?: string; bg?: string; fg?: string }> = ({
  tag,
  lines,
  sub,
  bg = color.bg,
  fg = color.text,
}) => (
  <AbsoluteFill style={{ background: bg, padding: 90, justifyContent: 'center', gap: 10 }}>
    {tag ? <Tag from={0}>{tag}</Tag> : null}
    <div style={{ height: tag ? 18 : 0 }} />
    {lines.map((l, i) => (
      <SlabIn key={l} from={3 + i * 3} size={124} colorOverride={fg}>
        {l}
      </SlabIn>
    ))}
    {sub ? (
      <>
        <div style={{ height: 26 }} />
        <SlabIn from={3 + lines.length * 3 + 3} size={30} family={font.mono} weight={400} colorOverride={color.muted} tracking={0}>
          {sub}
        </SlabIn>
      </>
    ) : null}
  </AbsoluteFill>
);

export const Showcase: React.FC = () => (
  <AbsoluteFill style={{ background: color.bg }}>
    {/* 0.0s — cold open */}
    <Sequence durationInFrames={sec(3)}>
      <Beat tag="the trenches" lines={['Your alpha', 'group', 'called it.']} />
    </Sequence>

    {/* 3.0s — the turn */}
    <Sequence from={sec(3)} durationInFrames={sec(2)}>
      <AbsoluteFill style={{ background: color.bg }}>
        <BlockWipe from={0} dur={8} fill={color.flame} />
        <AbsoluteFill style={{ padding: 90, justifyContent: 'center' }}>
          <SlabIn from={6} size={150} colorOverride={color.bg}>
            You
          </SlabIn>
          <SlabIn from={9} size={150} colorOverride={color.bg}>
            missed it.
          </SlabIn>
        </AbsoluteFill>
      </AbsoluteFill>
    </Sequence>

    {/* 5.0s — the feed, punched in */}
    <Sequence from={sec(5)} durationInFrames={sec(5)}>
      <Stage>
        <Tag from={0}>live feed</Tag>
        <FeedMessage from={4} author="sol_scanner" accent={color.solana} ts="02:14" text="new pair deployed · LP burned" />
        <FeedMessage from={12} author="alpha_dev" accent={color.evm} ts="02:14" text="dev doxxed, socials live" />
        <FeedMessage from={22} author="trench_bot" accent={color.flame} ts="02:15" text={`CA: ${FAKE_SOL_MINT}`} contract />
      </Stage>
    </Sequence>

    {/* 10.0s — detection callout */}
    <Sequence from={sec(10)} durationInFrames={sec(3)}>
      <Beat lines={['Contract', 'caught.']} sub="Solana + EVM, the second it drops" />
    </Sequence>

    {/* 13.0s — it runs. Chart + gain row. */}
    <Sequence from={sec(13)} durationInFrames={sec(6)}>
      <Stage>
        <Tag from={0}>3 days later</Tag>
        <ChartUp from={4} dur={48} height={330} />
        <div style={{ height: 10 }} />
        <GainRow from={40} symbol="MARSCOIN" fromMc="14K" toMc="46M" multiple="3301x" />
      </Stage>
    </Sequence>

    {/* 19.0s — THE PAYOFF: the alert you would have gotten. */}
    <Sequence from={sec(19)} durationInFrames={sec(6)}>
      <Stage>
        <SlabIn from={0} size={92}>
          You&apos;d have
        </SlabIn>
        <SlabIn from={3} size={92}>
          been told.
        </SlabIn>
        <div style={{ height: 26 }} />
        <MissedRunnerToast
          from={14}
          symbol="SESTRI"
          multiple="1.7×"
          scannedAgo="8m ago"
          channel="#alpha-no-yap"
          mcFrom="258K"
          mcTo="450.9K"
        />
        <div style={{ height: 14 }} />
        <SlabIn from={34} size={28} family={font.mono} weight={400} colorOverride={color.muted} tracking={0}>
          Missed-runner alerts — every call you scrolled past, tracked.
        </SlabIn>
      </Stage>
    </Sequence>

    {/* 25.0s — claim */}
    <Sequence from={sec(25)} durationInFrames={sec(3)}>
      <Beat lines={['Every call.', 'One console.']} sub="Discord · Telegram · live contract detection" />
    </Sequence>

    {/* 28.0s — CTA */}
    <Sequence from={sec(28)} durationInFrames={sec(4)}>
      <AbsoluteFill style={{ background: color.flame, padding: 90, justifyContent: 'center', gap: 6 }}>
        <SlabIn from={2} size={168} colorOverride={color.bg}>
          Stop
        </SlabIn>
        <SlabIn from={5} size={168} colorOverride={color.bg}>
          scrolling.
        </SlabIn>
        <div style={{ height: 34 }} />
        <SlabIn from={11} size={38} family={font.mono} weight={500} colorOverride={color.bg} tracking={0.02}>
          onchain-tools.app
        </SlabIn>
      </AbsoluteFill>
    </Sequence>
  </AbsoluteFill>
);

export const SHOWCASE_DURATION = sec(32);
