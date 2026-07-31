// Native recreations of the console's key moments, sized for a square social cut.
//
// These are deliberately NOT screen recordings. The reference edit punches hard
// into message content so it stays legible on a phone; recreating that natively
// gives real 30fps motion, no cursor jitter, and exact timing control. Screen
// capture is still the right tool for the Guide, where authenticity matters more
// than punch.
//
// Visual reference: the console's own AlertToast (border-l-[6px], hard black
// border, surface background) and the gain rows in the FOMO board.

import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, spring, useVideoConfig } from 'remotion';
import { color, font, SNAP } from '../brand';

/** A zoomed Discord/Telegram message, styled like the console feed. */
export const FeedMessage: React.FC<{
  author: string;
  accent: string;
  text: string;
  ts: string;
  from?: number;
  contract?: boolean;
}> = ({ author, accent, text, ts, from = 0, contract = false }) => {
  const frame = useCurrentFrame();
  const p = SNAP(
    interpolate(frame, [from, from + 8], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
  );
  return (
    <div
      style={{
        display: 'flex',
        gap: 20,
        alignItems: 'flex-start',
        opacity: p,
        transform: `translateY(${(1 - p) * 24}px)`,
      }}
    >
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: '50%',
          background: accent,
          flexShrink: 0,
        }}
      />
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'baseline' }}>
          <span style={{ fontFamily: font.mono, fontSize: 30, color: accent, fontWeight: 500 }}>
            {author}
          </span>
          <span style={{ fontFamily: font.mono, fontSize: 22, color: color.faint }}>{ts}</span>
        </div>
        <div
          style={{
            fontFamily: font.mono,
            fontSize: 34,
            lineHeight: 1.35,
            color: contract ? color.solana : color.text,
            marginTop: 6,
            wordBreak: 'break-all',
            background: contract ? 'rgba(20,241,149,0.10)' : undefined,
            borderLeft: contract ? `4px solid ${color.solana}` : undefined,
            paddingLeft: contract ? 14 : 0,
            paddingTop: contract ? 8 : 0,
            paddingBottom: contract ? 8 : 0,
          }}
        >
          {text}
        </div>
      </div>
    </div>
  );
};

/**
 * The missed-runner toast. Mirrors the real AlertToast: dark surface, hard black
 * border, 6px coloured left rail, trending icon.
 */
export const MissedRunnerToast: React.FC<{
  symbol: string;
  multiple: string;
  scannedAgo: string;
  channel: string;
  mcFrom: string;
  mcTo: string;
  from?: number;
}> = ({ symbol, multiple, scannedAgo, channel, mcFrom, mcTo, from = 0 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - from, fps, config: { damping: 14, mass: 0.6 } });
  return (
    <div
      style={{
        transform: `translateX(${(1 - s) * 120}%)`,
        opacity: Math.min(1, s * 1.4),
        background: color.surface,
        border: `3px solid #000000`,
        borderLeft: `10px solid ${color.flame}`,
        borderRadius: 14,
        padding: '26px 30px',
        boxShadow: '8px 8px 0 rgba(0,0,0,0.9)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <span style={{ fontSize: 34 }}>📈</span>
        <span style={{ fontFamily: font.mono, fontSize: 34, color: color.text, fontWeight: 600 }}>
          Missed runner: ${symbol}
        </span>
        <span style={{ fontFamily: font.mono, fontSize: 34, color: color.flame, fontWeight: 700 }}>
          ({multiple})
        </span>
      </div>
      <div style={{ fontFamily: font.mono, fontSize: 23, color: color.muted, lineHeight: 1.45 }}>
        Scanned {scannedAgo} in {channel} · MC {mcFrom} → {mcTo} · Not in My Wallets
      </div>
    </div>
  );
};

/** The gain row — trophy, ticker, entry MC, peak MC, multiple. */
export const GainRow: React.FC<{
  symbol: string;
  fromMc: string;
  toMc: string;
  multiple: string;
  from?: number;
}> = ({ symbol, fromMc, toMc, multiple, from = 0 }) => {
  const frame = useCurrentFrame();
  const p = SNAP(interpolate(frame, [from, from + 10], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 18,
        opacity: p,
        transform: `scale(${0.94 + p * 0.06})`,
        fontFamily: font.mono,
        fontSize: 36,
        background: color.surface,
        border: `3px solid #000`,
        borderRadius: 12,
        padding: '20px 26px',
        boxShadow: '6px 6px 0 rgba(0,0,0,0.9)',
      }}
    >
      <span style={{ fontSize: 34 }}>🏆</span>
      <span style={{ color: color.evm, fontWeight: 600 }}>{symbol}</span>
      <span style={{ color: color.faint }}>@ {fromMc}</span>
      <span style={{ color: color.muted }}>→</span>
      <span style={{ color: color.text, fontWeight: 600 }}>{toMc}</span>
      <span style={{ color: color.solana, fontWeight: 700 }}>Δ {multiple}</span>
    </div>
  );
};

/**
 * An upward price curve that draws itself. Pure SVG path interpolation — cheaper
 * and sharper than compositing a chart recording, and it can be timed to the cut.
 */
export const ChartUp: React.FC<{ from?: number; dur?: number; height?: number }> = ({
  from = 0,
  dur = 40,
  height = 340,
}) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [from, from + dur], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const eased = SNAP(p);

  const W = 900;
  const H = height;
  // A rising curve with a couple of pullbacks so it reads as a real chart.
  const pts: [number, number][] = [
    [0, 0.92], [0.12, 0.86], [0.2, 0.9], [0.32, 0.72],
    [0.44, 0.78], [0.56, 0.52], [0.68, 0.58], [0.8, 0.28], [0.9, 0.34], [1, 0.06],
  ];
  const shown = Math.max(2, Math.ceil(pts.length * eased));
  const sub = pts.slice(0, shown);
  const d = sub.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x * W} ${y * H}`).join(' ');
  const last = sub[sub.length - 1];

  return (
    <svg width={W} height={H} style={{ overflow: 'visible' }}>
      <path d={d} fill="none" stroke={color.solana} strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" />
      <path d={`${d} L ${last[0] * W} ${H} L 0 ${H} Z`} fill={color.solana} opacity={0.12} />
      <circle cx={last[0] * W} cy={last[1] * H} r={12} fill={color.solana} />
    </svg>
  );
};

/** Full-bleed dark stage with generous padding, used behind the UI recreations. */
export const Stage: React.FC<{ children: React.ReactNode; pad?: number }> = ({ children, pad = 90 }) => (
  <AbsoluteFill style={{ background: color.bg, padding: pad, justifyContent: 'center', gap: 34 }}>
    {children}
  </AbsoluteFill>
);
