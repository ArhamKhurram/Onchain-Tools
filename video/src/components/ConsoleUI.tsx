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

// A candle series that trends up with real pullbacks. Hardcoded rather than
// generated: Math.random() is non-deterministic across Remotion's parallel frame
// renderers and would make the chart flicker between frames.
//
// Values are normalised 0..1 where 1 is the top of the price range.
type Candle = { o: number; c: number; h: number; l: number };
const CANDLES: Candle[] = [
  { o: 0.06, c: 0.09, h: 0.11, l: 0.05 }, { o: 0.09, c: 0.08, h: 0.12, l: 0.07 },
  { o: 0.08, c: 0.14, h: 0.16, l: 0.07 }, { o: 0.14, c: 0.12, h: 0.17, l: 0.11 },
  { o: 0.12, c: 0.19, h: 0.21, l: 0.11 }, { o: 0.19, c: 0.25, h: 0.28, l: 0.18 },
  { o: 0.25, c: 0.22, h: 0.27, l: 0.20 }, { o: 0.22, c: 0.31, h: 0.34, l: 0.21 },
  { o: 0.31, c: 0.29, h: 0.35, l: 0.27 }, { o: 0.29, c: 0.38, h: 0.41, l: 0.28 },
  { o: 0.38, c: 0.45, h: 0.49, l: 0.36 }, { o: 0.45, c: 0.41, h: 0.48, l: 0.39 },
  { o: 0.41, c: 0.52, h: 0.55, l: 0.40 }, { o: 0.52, c: 0.60, h: 0.64, l: 0.50 },
  { o: 0.60, c: 0.56, h: 0.63, l: 0.54 }, { o: 0.56, c: 0.67, h: 0.70, l: 0.55 },
  { o: 0.67, c: 0.75, h: 0.79, l: 0.65 }, { o: 0.75, c: 0.71, h: 0.78, l: 0.69 },
  { o: 0.71, c: 0.82, h: 0.86, l: 0.70 }, { o: 0.82, c: 0.90, h: 0.94, l: 0.80 },
  { o: 0.90, c: 0.86, h: 0.93, l: 0.84 }, { o: 0.86, c: 0.97, h: 1.00, l: 0.85 },
];

/**
 * Candlestick chart that fills in left-to-right with a market cap ticking up
 * alongside it. Candles rather than a line: a polyline reads as a spreadsheet,
 * candles read instantly as a token chart.
 */
export const ChartUp: React.FC<{
  from?: number;
  dur?: number;
  width?: number;
  height?: number;
  mcFrom?: number;
  mcTo?: number;
}> = ({ from = 0, dur = 46, width = 1180, height = 420, mcFrom = 14_000, mcTo = 46_000_000 }) => {
  const frame = useCurrentFrame();
  const raw = interpolate(frame, [from, from + dur], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const eased = SNAP(raw);

  const W = width;
  const H = height;
  const n = CANDLES.length;
  const slot = W / n;
  const bodyW = slot * 0.58;
  const shown = Math.max(1, Math.ceil(n * eased));

  // Price scale leaves headroom so the final candle is not flush to the top.
  const y = (v: number) => H - v * (H * 0.88) - H * 0.06;

  // Market cap follows the same curve, so the number and the chart agree.
  // Normalised against the FINAL candle's close (not against 1.0) so the
  // ticker lands exactly on mcTo once the chart finishes — the last close is
  // 0.97, not 1.0, so dividing by raw lastClose undershot the target (e.g.
  // landed on $20.0M instead of $21.0M for a 25.6K -> 21M run).
  const lastClose = CANDLES[Math.min(shown, n) - 1].c;
  const finalClose = CANDLES[n - 1].c;
  const mc = mcFrom + (mcTo - mcFrom) * Math.pow(Math.min(1, lastClose / finalClose), 1.6);
  const mcLabel =
    mc >= 1_000_000 ? `${(mc / 1_000_000).toFixed(1)}M` : `${Math.round(mc / 1000)}K`;

  return (
    <div style={{ position: 'relative', width: W }}>
      {/* Ticking market cap — the number doing the work, not the axis. */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 18, marginBottom: 14 }}>
        <span style={{ fontFamily: font.mono, fontSize: 30, color: color.faint, letterSpacing: '0.14em' }}>
          MARKET CAP
        </span>
        <span style={{ fontFamily: font.mono, fontSize: 58, color: color.solana, fontWeight: 600 }}>
          ${mcLabel}
        </span>
      </div>

      <svg width={W} height={H} style={{ overflow: 'visible', display: 'block' }}>
        <defs>
          <linearGradient id="candleFade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color.solana} stopOpacity="0.22" />
            <stop offset="100%" stopColor={color.solana} stopOpacity="0" />
          </linearGradient>
          <filter id="candleGlow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="7" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Faint grid so the space reads as a chart, not a bar chart. */}
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} x1={0} x2={W} y1={H * g} y2={H * g} stroke={color.divider} strokeWidth={1} />
        ))}

        {/* Area under the closes, softened to transparent. */}
        <path
          d={
            CANDLES.slice(0, shown)
              .map((c, i) => `${i === 0 ? 'M' : 'L'} ${i * slot + slot / 2} ${y(c.c)}`)
              .join(' ') + ` L ${(shown - 1) * slot + slot / 2} ${H} L ${slot / 2} ${H} Z`
          }
          fill="url(#candleFade)"
        />

        {CANDLES.slice(0, shown).map((c, i) => {
          const cx = i * slot + slot / 2;
          const up = c.c >= c.o;
          const stroke = up ? color.solana : color.flame;
          const top = y(Math.max(c.o, c.c));
          const h = Math.max(3, Math.abs(y(c.o) - y(c.c)));
          const isLast = i === shown - 1;
          return (
            <g key={i} filter={isLast ? 'url(#candleGlow)' : undefined}>
              <line x1={cx} x2={cx} y1={y(c.h)} y2={y(c.l)} stroke={stroke} strokeWidth={2.5} />
              <rect x={cx - bodyW / 2} y={top} width={bodyW} height={h} fill={stroke} rx={2} />
            </g>
          );
        })}
      </svg>
    </div>
  );
};

/** Full-bleed dark stage with generous padding, used behind the UI recreations. */
export const Stage: React.FC<{ children: React.ReactNode; pad?: number }> = ({ children, pad = 90 }) => (
  <AbsoluteFill style={{ background: color.bg, padding: pad, justifyContent: 'center', gap: 34 }}>
    {children}
  </AbsoluteFill>
);
