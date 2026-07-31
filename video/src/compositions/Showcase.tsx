// Showcase — ~32s 16:9 cut for social.
//
// Arc: the problem → the feed catches it → the CA drops → it runs → the alert
// you would have gotten. The missed-runner beat is the payoff, so it gets the
// most screen time and the chart.
//
// UI is recreated natively rather than screen-captured: native gives real 30fps
// motion with no cursor jitter and exact timing control. Screen capture is still
// the right tool for the Guide, where authenticity matters more than punch.
//
// All data is fabricated (src/fixtures.ts).

import React from 'react';
import { AbsoluteFill, Sequence } from 'remotion';
import { color, font, sec } from '../brand';
import { SlabIn, BlockWipe, Tag } from '../components/Kinetic';
import { FeedMessage, MissedRunnerToast, GainRow, ChartUp } from '../components/ConsoleUI';
import { FAKE_SOL_MINT } from '../fixtures';

const PAD = 140;

const Beat: React.FC<{ tag?: string; lines: string[]; sub?: string; bg?: string; fg?: string }> = ({
  tag,
  lines,
  sub,
  bg = color.bg,
  fg = color.text,
}) => (
  <AbsoluteFill style={{ background: bg, padding: PAD, justifyContent: 'center', gap: 8 }}>
    {tag ? <Tag from={0}>{tag}</Tag> : null}
    <div style={{ height: tag ? 22 : 0 }} />
    {lines.map((l, i) => (
      <SlabIn key={l} from={3 + i * 3} size={150} colorOverride={fg}>
        {l}
      </SlabIn>
    ))}
    {sub ? (
      <>
        <div style={{ height: 30 }} />
        <SlabIn
          from={3 + lines.length * 3 + 3}
          size={34}
          family={font.mono}
          weight={400}
          colorOverride={color.muted}
          tracking={0}
        >
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
      <Beat tag="the trenches" lines={['Your alpha group', 'called it.']} />
    </Sequence>

    {/* 3.0s — the turn */}
    <Sequence from={sec(3)} durationInFrames={sec(2)}>
      <AbsoluteFill style={{ background: color.bg }}>
        <BlockWipe from={0} dur={8} fill={color.flame} />
        <AbsoluteFill style={{ padding: PAD, justifyContent: 'center' }}>
          <SlabIn from={6} size={190} colorOverride={color.bg}>
            You missed it.
          </SlabIn>
        </AbsoluteFill>
      </AbsoluteFill>
    </Sequence>

    {/* 5.0s — the feed, punched in */}
    <Sequence from={sec(5)} durationInFrames={sec(5)}>
      <AbsoluteFill style={{ background: color.bg, padding: PAD, justifyContent: 'center', gap: 40 }}>
        <Tag from={0}>live feed</Tag>
        <FeedMessage from={4} author="sol_scanner" accent={color.solana} ts="02:14" text="new pair deployed · LP burned" />
        <FeedMessage from={12} author="alpha_dev" accent={color.evm} ts="02:14" text="dev doxxed, socials live" />
        <FeedMessage from={22} author="trench_bot" accent={color.flame} ts="02:15" text={`CA: ${FAKE_SOL_MINT}`} contract />
      </AbsoluteFill>
    </Sequence>

    {/* 10.0s — detection callout */}
    <Sequence from={sec(10)} durationInFrames={sec(3)}>
      <Beat lines={['Contract caught.']} sub="Solana + EVM, the second it drops" />
    </Sequence>

    {/* 13.0s — it runs. Chart carries this beat; gain row lands on top. */}
    <Sequence from={sec(13)} durationInFrames={sec(6)}>
      <AbsoluteFill style={{ background: color.bg, padding: PAD, justifyContent: 'center', gap: 26 }}>
        <Tag from={0}>3 days later</Tag>
        <ChartUp from={4} dur={52} width={1640} height={470} mcFrom={14_000} mcTo={46_000_000} />
        <div style={{ height: 6 }} />
        <div style={{ display: 'flex' }}>
          <GainRow from={46} symbol="MARSCOIN" fromMc="14K" toMc="46M" multiple="3301x" />
        </div>
      </AbsoluteFill>
    </Sequence>

    {/* 19.0s — THE PAYOFF: the alert you would have gotten. */}
    <Sequence from={sec(19)} durationInFrames={sec(6)}>
      <AbsoluteFill style={{ background: color.bg, padding: PAD, justifyContent: 'center', gap: 20 }}>
        <SlabIn from={0} size={112}>
          You&apos;d have been told.
        </SlabIn>
        <div style={{ height: 30 }} />
        <div style={{ display: 'flex' }}>
          <MissedRunnerToast
            from={12}
            symbol="SESTRI"
            multiple="1.7×"
            scannedAgo="8m ago"
            channel="#alpha-no-yap"
            mcFrom="258K"
            mcTo="450.9K"
          />
        </div>
        <div style={{ height: 18 }} />
        <SlabIn from={34} size={30} family={font.mono} weight={400} colorOverride={color.muted} tracking={0}>
          Missed-runner alerts — every call you scrolled past, tracked.
        </SlabIn>
      </AbsoluteFill>
    </Sequence>

    {/* 25.0s — claim */}
    <Sequence from={sec(25)} durationInFrames={sec(3)}>
      <Beat lines={['Every call.', 'One console.']} sub="Discord · Telegram · live contract detection" />
    </Sequence>

    {/* 28.0s — CTA */}
    <Sequence from={sec(28)} durationInFrames={sec(4)}>
      <AbsoluteFill style={{ background: color.flame, padding: PAD, justifyContent: 'center', gap: 10 }}>
        <SlabIn from={2} size={210} colorOverride={color.bg}>
          Stop scrolling.
        </SlabIn>
        <div style={{ height: 40 }} />
        <SlabIn from={9} size={44} family={font.mono} weight={500} colorOverride={color.bg} tracking={0.02}>
          onchaintools.tech
        </SlabIn>
      </AbsoluteFill>
    </Sequence>
  </AbsoluteFill>
);

export const SHOWCASE_DURATION = sec(32);
