// Rollout — the pump.fun + FOMO feature-rollout cut. ~40s, 1920×1080.
//
// Structure is built around the music (public/audio/track.mp3): a quiet
// build 0–8s, then the drop at exactly 8.0s. The cut is timed so the payoff
// beat's hard cut lands ON that drop (see BEATS below — open+hook sum to
// exactly sec(8)). Everything after is full energy, ending on a calm close.
//
// Directorial rules for this pass (a restructure, not an easing tweak):
//   - Fill the frame. Panels read ~90% width; content is sized to leave no
//     empty panel body. No beat should read as "a small panel floating in
//     a lot of dark".
//   - Vary composition BETWEEN beats (panel → full-screen type moment →
//     panel → panel → close) for rhythm. Within a beat, only one thing moves
//     at a time.
//   - Captions are short and only add information beyond what's on screen —
//     several beats (the payoff, the close) carry no caption at all because
//     the visual already says it.
//   - Everything is frame-driven. No Math.random()/Date.now() anywhere —
//     Remotion renders frames out of order, so anything randomised would
//     flicker between frames.
//
// Styling matches the "sleek premium terminal" redesign: flame is the
// primary accent, gold (color.accent2) is reserved for the one payoff number
// and a couple of section eyebrows, and elevated cards (color.elevated)
// float above the darker Panel body for layered depth. See brand.ts.
//
// All data is fabricated EXCEPT one real public moment: @slingoorio's
// "I will not run this coin" $TOAD call on pump.fun. Everything else —
// handles, wallets, tickers, numbers — is invented to read like real pump.fun
// + FOMO activity without quoting anyone else real. Wallets keep the existing
// prop convention: valid-shaped Solana base58 that visibly spells a fake word.

import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { color, font, glow, sec, SNAP } from '../brand';
import { Caption } from '../components/Shot';
import { SlabIn } from '../components/Kinetic';
import { ChartUp } from '../components/ConsoleUI';

// ---------------------------------------------------------------------------
// Fabricated sample data. Nothing here is real except the HERO call.
// ---------------------------------------------------------------------------

// The one real-person moment in the cut: @slingoorio's public $TOAD call on
// pump.fun ("I will not run this coin"), called near $25.6K, which went on to
// run to roughly $21M — an ~820x. Everything downstream (the caller board,
// the holders, the FOMO feed) references TOAD as fabricated flavor, never
// attributing invented trades to the real handle.
const HERO = {
  handle: 'slingoorio',
  searchQuery: 'slingoor',
  token: 'TOAD',
  name: 'The Toad Pepe',
  thesis: 'I will not run this coin.',
  calledLabel: '$25.6K',
  calledMc: 25_600,
  resultLabel: '$21M',
  resultMc: 21_000_000,
  multLabel: '820×',
};

type Side = 'buy' | 'sell';

type Caller = { handle: string; band: 'elite' | 'solid' | 'mixed'; calls: number; avgX: string; bestX: string };
const CALLERS: Caller[] = [
  { handle: 'ghostcaller', band: 'elite', calls: 61, avgX: '6.8×', bestX: '340×' },
  { handle: 'slingoorio', band: 'elite', calls: 31, avgX: '5.4×', bestX: '820×' },
  { handle: 'duneriderx', band: 'solid', calls: 52, avgX: '3.2×', bestX: '96×' },
  { handle: 'nightowlcalls', band: 'solid', calls: 19, avgX: '2.9×', bestX: '140×' },
  { handle: 'pumpprophet', band: 'mixed', calls: 27, avgX: '1.8×', bestX: '54×' },
];

type FomoHolder = { rank: number; who: string; value: string; pnl: string };
const FOMO_HOLDERS: FomoHolder[] = [
  { rank: 1, who: '@solstice', value: '$18.4K', pnl: '+212%' },
  { rank: 2, who: '@degenjeff', value: '$9.1K', pnl: '+88%' },
  { rank: 3, who: '@moonboy', value: '$4.6K', pnl: '-12%' },
];
const CHAIN_HOLDERS: FomoHolder[] = [
  { rank: 1, who: '7Nw3…d3ad', value: '$54.2K', pnl: '+640%' },
  { rank: 2, who: '9xQe…4kZr', value: '$31.0K', pnl: '+180%' },
  { rank: 3, who: '2mPz…9fLk', value: '$12.7K', pnl: '+40%' },
];

type FomoTrade = { trader: string; side: Side; token: string; sol: string; pnl: string; when: string };
const FOMO: FomoTrade[] = [
  { trader: 'solstice', side: 'buy', token: 'TOAD', sol: '22.0', pnl: '+140%', when: 'now' },
  { trader: 'degenjeff', side: 'buy', token: 'GIGA', sol: '15.5', pnl: '+12%', when: '4s' },
  { trader: 'moonboy', side: 'sell', token: 'SPURDO', sol: '3.20', pnl: '-18%', when: '19s' },
  { trader: 'trenchlord', side: 'buy', token: 'BONGO', sol: '9.80', pnl: '+64%', when: '45s' },
];
const FOMO_THESIS = { trader: 'solstice', text: 'this feels like the next TOAD.' };

// ---------------------------------------------------------------------------
// Motion primitives — snap rather than ease. Beats change decisively; within
// a beat, elements arrive fast (SNAP, the fast out-quint from brand.ts) and
// then hold still — never two things moving at once. The payoff beat's chart
// climb is the one deliberate exception (SlowPush): a continuous build to
// match a continuous number.
// ---------------------------------------------------------------------------

/** Quick cross-fade. The default beat change — short in, short out. */
const Dissolve: React.FC<{ children: React.ReactNode; dur: number; inDur?: number; outDur?: number }> = ({
  children,
  dur,
  inDur = 6,
  outDur = 6,
}) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [0, inDur, dur - outDur, dur], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>;
};

/** Fade + directional slide entrance, near-cut fast fade on exit. One of two
 * "decisive" beat changes used for variety between beats — never inside one. */
const SlideCut: React.FC<{ children: React.ReactNode; dur: number; direction?: 'left' | 'right' }> = ({
  children,
  dur,
  direction = 'right',
}) => {
  const frame = useCurrentFrame();
  const inP = SNAP(
    interpolate(frame, [0, 10], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
  );
  const o = interpolate(frame, [0, 6, dur - 5, dur], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const sign = direction === 'right' ? 1 : -1;
  return (
    <AbsoluteFill style={{ opacity: o, transform: `translateX(${(1 - inP) * 70 * sign}px)` }}>
      {children}
    </AbsoluteFill>
  );
};

/** True hard cut in (zero fade — full opacity from frame 0), soft fade out
 * at the end. Used once: the payoff beat must be fully visible on the exact
 * frame the music drops, so even a 6-frame fade-in would blur the sync. */
const HardCutIn: React.FC<{ children: React.ReactNode; dur: number; outDur?: number }> = ({
  children,
  dur,
  outDur = 6,
}) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [0, dur - outDur, dur], [1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>;
};

/** Fade + scale-punch entrance — reads as a decisive near-cut. The other
 * beat-change variant. */
const PunchCut: React.FC<{ children: React.ReactNode; dur: number }> = ({ children, dur }) => {
  const frame = useCurrentFrame();
  const inP = SNAP(
    interpolate(frame, [0, 9], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
  );
  const o = interpolate(frame, [0, 5, dur - 4, dur], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <AbsoluteFill style={{ opacity: o, transform: `scale(${0.93 + inP * 0.07})`, transformOrigin: 'center center' }}>
      {children}
    </AbsoluteFill>
  );
};

/** One-time push-in that settles fast (SNAP), then holds — panels lock in
 * decisively instead of drifting for the length of the beat. */
const PushIn: React.FC<{ children: React.ReactNode; dur: number; push?: number }> = ({ children, push = 1.05 }) => {
  const frame = useCurrentFrame();
  const p = SNAP(
    interpolate(frame, [0, 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
  );
  return (
    <AbsoluteFill
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        transform: `scale(${1 + (push - 1) * p})`,
        transformOrigin: 'center center',
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

/** Continuous slow push, held for the payoff beat's chart climb only — a
 * deliberate exception to the fast-settle PushIn above. The camera builds at
 * the same steady rate the market cap ticks up, so the two read as one move. */
const SlowPush: React.FC<{ children: React.ReactNode; dur: number; push?: number }> = ({
  children,
  dur,
  push = 1.08,
}) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [0, dur], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        transform: `scale(${1 + (push - 1) * p})`,
        transformOrigin: 'center center',
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

/** A row that fades and rises into place with energy (SNAP), not a soft ease. */
const Appear: React.FC<{ children: React.ReactNode; from: number; rise?: number }> = ({
  children,
  from,
  rise = 16,
}) => {
  const frame = useCurrentFrame();
  const p = SNAP(
    interpolate(frame, [from, from + 8], [0, 1], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    }),
  );
  return <div style={{ opacity: p, transform: `translateY(${(1 - p) * rise}px)` }}>{children}</div>;
};

/** Fade + scale punch — for the one or two moments per cut that should read
 * as a deliberate "arrival" rather than a row sliding into a list. */
const PunchAppear: React.FC<{ children: React.ReactNode; from: number }> = ({ children, from }) => {
  const frame = useCurrentFrame();
  const p = SNAP(
    interpolate(frame, [from, from + 9], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
  );
  return <div style={{ opacity: p, transform: `scale(${0.9 + p * 0.1})` }}>{children}</div>;
};

// ---------------------------------------------------------------------------
// Console chrome — the product floating on a dark neutral stage. Panels run
// wide (PANEL_W ≈ 91% of frame width) and content is sized generously so the
// panel body is never empty.
// ---------------------------------------------------------------------------

const PANEL_W = 1750;

const Stage: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
    {/* Soft neutral stage, not pure black — the panel floats on a lit surface. */}
    <AbsoluteFill
      style={{ background: 'linear-gradient(155deg, #2a2d33 0%, #1b1d22 52%, #101114 100%)' }}
    />
    {/* Centre glow lifts the middle where the panel sits. */}
    <AbsoluteFill
      style={{
        background: 'radial-gradient(ellipse at center, rgba(255,255,255,0.08) 0%, rgba(0,0,0,0) 60%)',
      }}
    />
    {/* Faint warm undertone — the redesign's premium lit look, applied gently. */}
    <AbsoluteFill
      style={{
        background: 'radial-gradient(ellipse at 50% 28%, rgba(240,178,92,0.05) 0%, rgba(0,0,0,0) 55%)',
      }}
    />
    {children}
  </AbsoluteFill>
);

const PANEL_GLOW = {
  flame: '0 40px 130px rgba(0,0,0,0.75), 0 0 50px -14px rgba(255,42,42,0.28)',
  gold: '0 40px 130px rgba(0,0,0,0.75), 0 0 55px -16px rgba(240,178,92,0.26)',
  solana: '0 40px 130px rgba(0,0,0,0.75), 0 0 50px -14px rgba(20,241,149,0.22)',
} as const;

/** The console window: chrome bar with the active brand/tab, then the body. */
const Panel: React.FC<{
  brand: string;
  tab: string;
  children: React.ReactNode;
  brandColor?: string;
  panelGlow?: keyof typeof PANEL_GLOW;
}> = ({ brand, tab, children, brandColor = color.flame, panelGlow = 'flame' }) => (
  <div
    style={{
      width: PANEL_W,
      // A touch lighter than color.surface (#0a0a0a) so the product itself
      // reads bright against the lit stage rather than merging into it.
      background: '#141519',
      border: '1px solid #26272c',
      borderRadius: 20,
      overflow: 'hidden',
      boxShadow: PANEL_GLOW[panelGlow],
    }}
  >
    {/* Chrome bar. */}
    <div
      style={{
        height: 70,
        background: '#0f0f0f',
        borderBottom: '1px solid #1c1c1c',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '0 32px',
      }}
    >
      {[0, 1, 2].map((i) => (
        <div key={i} style={{ width: 14, height: 14, borderRadius: '50%', background: '#2a2a2a' }} />
      ))}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginLeft: 14 }}>
        <span style={{ fontFamily: font.mono, fontSize: 28, color: brandColor, fontWeight: 600 }}>
          {brand}
        </span>
        <span style={{ fontFamily: font.mono, fontSize: 28, color: color.faint }}>/ {tab}</span>
      </div>
      <div style={{ flex: 1 }} />
      {/* Live dot. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 12, height: 12, borderRadius: '50%', background: color.solana }} />
        <span style={{ fontFamily: font.mono, fontSize: 21, color: color.muted, letterSpacing: '0.16em' }}>
          LIVE
        </span>
      </div>
    </div>
    <div style={{ padding: '40px 46px 50px' }}>{children}</div>
  </div>
);

/** Profile header row — avatar, name, @handle, a sub-line, an action chip. */
const ProfileHeader: React.FC<{
  name: string;
  handle: string;
  sub: string;
  action?: string;
  avatarColor?: string;
}> = ({ name, handle, sub, action = 'refresh', avatarColor = color.flame }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 22,
      paddingBottom: 28,
      borderBottom: '2px solid #000',
      marginBottom: 30,
    }}
  >
    <div style={{ width: 76, height: 76, borderRadius: '50%', background: avatarColor, flexShrink: 0 }} />
    <div style={{ minWidth: 0, flex: 1 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
        <span style={{ fontFamily: font.display, fontSize: 46, color: color.text, fontWeight: 700 }}>
          {name}
        </span>
        <span style={{ fontFamily: font.mono, fontSize: 32, color: color.muted }}>@{handle}</span>
      </div>
      <div style={{ fontFamily: font.mono, fontSize: 28, color: color.faint, marginTop: 6 }}>{sub}</div>
    </div>
    <div
      style={{
        fontFamily: font.mono,
        fontSize: 24,
        color: color.muted,
        border: '2px solid #2a2a2a',
        borderRadius: 12,
        padding: '14px 22px',
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
      }}
    >
      {action}
    </div>
  </div>
);

const SectionLabel: React.FC<{ children: React.ReactNode; accent?: string }> = ({
  children,
  accent = color.muted,
}) => (
  <div
    style={{
      fontFamily: font.mono,
      fontSize: 28,
      fontWeight: 700,
      letterSpacing: '0.2em',
      textTransform: 'uppercase',
      color: accent,
      marginBottom: 18,
    }}
  >
    {children}
  </div>
);

const cell = (align: 'left' | 'right' = 'left', c: string = color.text): React.CSSProperties => ({
  fontFamily: font.mono,
  fontSize: 40,
  color: c,
  textAlign: align,
  whiteSpace: 'nowrap',
});

const headCell = (align: 'left' | 'right' = 'left'): React.CSSProperties => ({
  fontFamily: font.mono,
  fontSize: 24,
  fontWeight: 700,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: color.faint,
  textAlign: align,
});

/** Buy / sell pill, matching the console's bordered tinted badge. */
const SideBadge: React.FC<{ side: Side }> = ({ side }) => {
  const c = side === 'buy' ? color.solana : color.flame;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        fontFamily: font.mono,
        fontSize: 26,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.1em',
        color: c,
        border: `2px solid ${c}`,
        background: `${c}22`,
        borderRadius: 10,
        padding: '7px 16px',
      }}
    >
      <span>{side === 'buy' ? '↙' : '↗'}</span>
      {side}
    </span>
  );
};

/** Small caller-quality band pill (unrated/slop/mixed/solid/elite from the real console). */
const BandPill: React.FC<{ band: Caller['band'] }> = ({ band }) => {
  const c = band === 'elite' ? color.accent2 : band === 'solid' ? color.solana : color.evm;
  return (
    <span
      style={{
        fontFamily: font.mono,
        fontSize: 19,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.12em',
        color: c,
        border: `1.5px solid ${c}`,
        borderRadius: 7,
        padding: '4px 10px',
        marginLeft: 14,
      }}
    >
      {band}
    </span>
  );
};

const RowShell: React.FC<{ children: React.ReactNode; grid: string; last?: boolean }> = ({
  children,
  grid,
  last = false,
}) => (
  <div
    style={{
      display: 'grid',
      gridTemplateColumns: grid,
      alignItems: 'center',
      gap: 26,
      padding: '26px 12px',
      borderBottom: last ? 'none' : `1px solid ${color.divider}`,
    }}
  >
    {children}
  </div>
);

const signColor = (v: string): string =>
  v.startsWith('-') ? color.flame : v.startsWith('+') ? color.solana : color.muted;

// ---------------------------------------------------------------------------
// Beat 1 — Cold open, 0–2.5s. "New in OCT." Fast in, no lingering, bigger
// type than a v1 title card.
// ---------------------------------------------------------------------------

const ColdOpenBeat: React.FC = () => (
  <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 26 }}>
    <Appear from={2} rise={12}>
      <div
        style={{
          fontFamily: font.mono,
          fontSize: 34,
          letterSpacing: '0.28em',
          textTransform: 'uppercase',
          color: color.accent2,
          textAlign: 'center',
        }}
      >
        New in OCT
      </div>
    </Appear>
    <Appear from={8} rise={18}>
      <div style={{ fontFamily: font.display, fontSize: 140, fontWeight: 700, color: color.text }}>
        pump.fun <span style={{ color: color.flame }}>+</span> FOMO
      </div>
    </Appear>
  </AbsoluteFill>
);

// ---------------------------------------------------------------------------
// Beat 2 — The hook, 2.5–8s (165 frames). Compressed hard: the search bar
// cuts in already mid-typed, follow flips fast, and the callout ping toast —
// the star of this beat — slides in around the 6.8–7.3s mark (beat-local
// frame ~130) so we're holding on it when the drop lands at exactly 8.0s.
// Deterministic "typing" driven off frame count, no Math.random.
// ---------------------------------------------------------------------------

const TYPE_INITIAL = 3; // already mid-typed when the beat cuts in
const TYPE_END = 15; // finishes typing in 0.5s
const MATCH_AT = TYPE_END + 4;
const FOLLOW_AT = MATCH_AT + 10;
const TOAST_AT = 130; // beat-local; lands the toast at global t≈6.8s

const SearchBar: React.FC = () => {
  const frame = useCurrentFrame();
  const typed = Math.max(
    TYPE_INITIAL,
    Math.min(
      HERO.searchQuery.length,
      Math.floor(
        interpolate(frame, [0, TYPE_END], [TYPE_INITIAL, HERO.searchQuery.length], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        }),
      ),
    ),
  );
  const done = frame >= TYPE_END;
  const blink = Math.floor(frame / 12) % 2 === 0;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        background: '#0c0c0c',
        border: '2px solid #222',
        borderRadius: 14,
        padding: '26px 32px',
        marginBottom: 28,
      }}
    >
      <span style={{ fontFamily: font.mono, fontSize: 32, color: color.faint }}>Search ›</span>
      <span style={{ fontFamily: font.mono, fontSize: 36, color: color.text }}>
        {HERO.searchQuery.slice(0, typed)}
      </span>
      {!done && (
        <span
          style={{
            width: 3,
            height: 42,
            background: color.flame,
            opacity: blink ? 1 : 0,
            display: 'inline-block',
          }}
        />
      )}
    </div>
  );
};

const CalloutPingToast: React.FC<{ from: number }> = ({ from }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - from, fps, config: { damping: 13, mass: 0.45 } });
  return (
    <div
      style={{
        marginTop: 36,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 26,
        transform: `translateX(${(1 - s) * 100}px)`,
        opacity: Math.min(1, s * 1.4),
        background: color.elevated,
        border: '2px solid #000',
        borderLeft: `10px solid ${color.flame}`,
        borderRadius: 20,
        padding: '30px 42px',
        boxShadow: `${glow.flame}, 0 0 60px -10px rgba(255,42,42,0.35)`,
      }}
    >
      <div style={{ width: 64, height: 64, borderRadius: '50%', background: color.flame, flexShrink: 0 }} />
      <div>
        <div style={{ fontFamily: font.mono, fontSize: 40, color: color.text }}>
          <span style={{ color: color.muted }}>@{HERO.handle}</span> called{' '}
          <span style={{ color: color.flame, fontWeight: 700 }}>${HERO.token}</span>
        </div>
        <div style={{ fontFamily: font.mono, fontSize: 26, color: color.faint, marginTop: 6 }}>
          at {HERO.calledLabel} mcap · just now
        </div>
      </div>
    </div>
  );
};

const HookBeat: React.FC = () => {
  const frame = useCurrentFrame();
  const following = frame >= FOLLOW_AT;
  return (
    <Panel brand="pump.fun" tab="Following">
      <SearchBar />
      {frame >= MATCH_AT && (
        <Appear from={MATCH_AT}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 24,
              background: color.elevated,
              borderRadius: 16,
              padding: '24px 32px',
            }}
          >
            <div style={{ width: 70, height: 70, borderRadius: '50%', background: color.flame, flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: font.mono, fontSize: 38, color: color.text }}>@{HERO.handle}</div>
              <div style={{ fontFamily: font.mono, fontSize: 26, color: color.faint, marginTop: 3 }}>
                pump.fun · top caller
              </div>
            </div>
            <div
              style={{
                fontFamily: font.mono,
                fontSize: 26,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                color: following ? color.solana : color.bg,
                background: following ? 'transparent' : color.flame,
                border: following ? `2px solid ${color.solana}` : 'none',
                borderRadius: 12,
                padding: '16px 32px',
                boxShadow: following ? undefined : glow.flame,
              }}
            >
              {following ? '✓ Following' : 'Follow'}
            </div>
          </div>
        </Appear>
      )}
      {frame >= TOAST_AT && <CalloutPingToast from={TOAST_AT} />}
    </Panel>
  );
};

// ---------------------------------------------------------------------------
// Beat 3 — THE PAYOFF, 8–17.5s (285 frames). Cuts in exactly on the music's
// drop. Three phases in one Sequence:
//   0–~204f  the call card (punch-in), then the chart climbing to $21.0M
//            with a slow continuous push (SlowPush) synced to the number.
//   210f+    a HARD CUT — no crossfade — to a full-screen, no-chrome type
//            moment: the 820× multiple in gold. The single biggest visual
//            in the video. No caption anywhere in this beat; the numbers do
//            the talking.
// ---------------------------------------------------------------------------

const PAYOFF_CUT_AT = 210; // beat-local frame — the hard cut to the reveal
const CHART_FROM = 66;
// ChartUp eases with SNAP (a fast out-quint) internally, which finishes
// almost all of its visual motion by ~46% of whatever `dur` it's given —
// pass it a `dur` noticeably longer than the window we actually show, so the
// candles keep drawing and the market cap keeps ticking across nearly the
// whole visible window instead of finishing early and then sitting frozen
// (that dead hold was the exact bug this pass was asked to fix). The chart
// settles at exactly $21.0M around frame ~195, a brief beat before the cut.
const CHART_DUR = 280;

const REVEAL_GLOW = '0 0 70px -8px rgba(240,178,92,0.5), 0 0 160px -30px rgba(240,178,92,0.3)';

const PayoffPanel: React.FC = () => (
  <SlowPush dur={PAYOFF_CUT_AT} push={1.08}>
    <Panel brand="pump.fun" tab="Callout" panelGlow="gold">
      <PunchAppear from={0}>
        <ProfileHeader
          name="Slingoor"
          handle={HERO.handle}
          sub={`"${HERO.thesis}"`}
          action="verified caller"
        />
      </PunchAppear>
      <PunchAppear from={8}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 20, marginBottom: 26 }}>
          <span style={{ fontFamily: font.display, fontSize: 88, fontWeight: 800, color: color.text }}>
            <span style={{ color: color.flame }}>$</span>
            {HERO.token}
          </span>
          <span style={{ fontFamily: font.mono, fontSize: 30, color: color.muted }}>{HERO.name}</span>
          <span style={{ fontFamily: font.mono, fontSize: 30, color: color.muted, marginLeft: 8 }}>
            called at <span style={{ color: color.text }}>{HERO.calledLabel}</span>
          </span>
        </div>
      </PunchAppear>

      <Appear from={CHART_FROM - 12}>
        <ChartUp
          from={CHART_FROM}
          dur={CHART_DUR}
          width={1550}
          height={420}
          mcFrom={HERO.calledMc}
          mcTo={HERO.resultMc}
        />
      </Appear>
    </Panel>
  </SlowPush>
);

const PayoffReveal: React.FC<{ start: number }> = ({ start }) => (
  <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 34 }}>
      <div style={{ display: 'inline-block', boxShadow: REVEAL_GLOW, borderRadius: 32, padding: '14px 56px' }}>
        <SlabIn from={start} size={320} weight={800} colorOverride={color.accent2} tracking={-0.03}>
          {HERO.multLabel}
        </SlabIn>
      </div>
      <Appear from={start + 14} rise={12}>
        <div style={{ fontFamily: font.mono, fontSize: 48, color: color.muted, letterSpacing: '0.04em' }}>
          {HERO.calledLabel} <span style={{ color: color.faint }}>→</span> {HERO.resultLabel}
        </div>
      </Appear>
    </div>
  </AbsoluteFill>
);

const PayoffBeat: React.FC = () => {
  const frame = useCurrentFrame();
  const revealed = frame >= PAYOFF_CUT_AT;
  return <Stage>{revealed ? <PayoffReveal start={PAYOFF_CUT_AT} /> : <PayoffPanel />}</Stage>;
};

// ---------------------------------------------------------------------------
// Beat 4 — Top Callers board, 17.5–22s. Auto-ranked leaderboard.
// ---------------------------------------------------------------------------

const CALLER_GRID = '100px 1fr 230px 230px 230px';

const CallersBeat: React.FC = () => (
  <Panel brand="OCT" tab="Callers · Leaderboard" brandColor={color.accent2} panelGlow="gold">
    <SectionLabel accent={color.accent2}>Top callers · ranked automatically</SectionLabel>
    <RowShell grid={CALLER_GRID}>
      <div style={headCell()}>#</div>
      <div style={headCell()}>Caller</div>
      <div style={headCell('right')}>Calls</div>
      <div style={headCell('right')}>Avg ×</div>
      <div style={headCell('right')}>Best ×</div>
    </RowShell>
    {CALLERS.map((c, i) => (
      <Appear key={c.handle} from={4 + i * 4}>
        <RowShell grid={CALLER_GRID} last={i === CALLERS.length - 1}>
          <div style={cell('left', color.faint)}>{i + 1}</div>
          <div style={cell('left')}>
            @{c.handle}
            <BandPill band={c.band} />
          </div>
          <div style={cell('right', color.muted)}>{c.calls}</div>
          <div style={cell('right', color.solana)}>{c.avgX}</div>
          <div style={cell('right', color.accent2)}>{c.bestX}</div>
        </RowShell>
      </Appear>
    ))}
  </Panel>
);

// ---------------------------------------------------------------------------
// Beat 5 — Holders, side by side: FOMO-tracked vs on-chain pump.fun.
// 22–26.5s.
// ---------------------------------------------------------------------------

const HOLDER_GRID = '50px 1fr 170px 170px';

const HolderColumn: React.FC<{ title: string; rows: FomoHolder[]; from: number; accent: string }> = ({
  title,
  rows,
  from,
  accent,
}) => (
  <div style={{ flex: 1 }}>
    <SectionLabel accent={accent}>{title}</SectionLabel>
    <RowShell grid={HOLDER_GRID}>
      <div style={headCell()}>#</div>
      <div style={headCell()}>Holder</div>
      <div style={headCell('right')}>Value</div>
      <div style={headCell('right')}>PnL</div>
    </RowShell>
    {rows.map((r, i) => (
      <Appear key={r.who} from={from + i * 4}>
        <RowShell grid={HOLDER_GRID} last={i === rows.length - 1}>
          <div style={cell('left', color.faint)}>{r.rank}</div>
          <div style={{ ...cell('left'), fontSize: 32 }}>{r.who}</div>
          <div style={cell('right', color.muted)}>{r.value}</div>
          <div style={cell('right', signColor(r.pnl))}>{r.pnl}</div>
        </RowShell>
      </Appear>
    ))}
  </div>
);

const HoldersBeat: React.FC = () => (
  <Panel brand="pump.fun" tab={`$${HERO.token} · Holders`}>
    <div style={{ display: 'flex', gap: 48 }}>
      <HolderColumn title="FOMO tracked" rows={FOMO_HOLDERS} from={4} accent={color.solana} />
      <div style={{ width: 1, background: color.divider }} />
      <HolderColumn title="On-chain · pump.fun" rows={CHAIN_HOLDERS} from={7} accent={color.flame} />
    </div>
  </Panel>
);

// ---------------------------------------------------------------------------
// Beat 6 — FOMO live trades, plus PnL and a thesis line. 26.5–31.5s.
// ---------------------------------------------------------------------------

const FOMO_GRID = '1fr 170px 200px 200px 150px 130px';

const FomoBeat: React.FC = () => (
  <Panel brand="fomo.family" tab="Live · Trades" brandColor={color.solana} panelGlow="solana">
    <SectionLabel>Live trades · tracked traders</SectionLabel>
    <RowShell grid={FOMO_GRID}>
      <div style={headCell()}>Trader</div>
      <div style={headCell()}>Side</div>
      <div style={headCell()}>Token</div>
      <div style={headCell('right')}>SOL value</div>
      <div style={headCell('right')}>PnL</div>
      <div style={headCell('right')}>When</div>
    </RowShell>
    {FOMO.map((t, i) => (
      <Appear key={t.trader} from={4 + i * 4}>
        <RowShell grid={FOMO_GRID} last={i === FOMO.length - 1}>
          <div style={cell('left')}>
            <span style={{ color: color.muted }}>@</span>
            {t.trader}
          </div>
          <div>
            <SideBadge side={t.side} />
          </div>
          <div style={cell('left')}>{t.token}</div>
          <div style={cell('right')}>{t.sol} SOL</div>
          <div style={cell('right', signColor(t.pnl))}>{t.pnl}</div>
          <div style={cell('right', color.faint)}>{t.when}</div>
        </RowShell>
      </Appear>
    ))}
    <Appear from={4 + FOMO.length * 4 + 6}>
      <div
        style={{
          marginTop: 26,
          background: color.elevated,
          borderLeft: `6px solid ${color.solana}`,
          borderRadius: 12,
          padding: '20px 28px',
          fontFamily: font.mono,
          fontSize: 28,
          color: color.text,
        }}
      >
        <span style={{ color: color.muted }}>@{FOMO_THESIS.trader}</span> — “{FOMO_THESIS.text}”
      </div>
    </Appear>
  </Panel>
);

// ---------------------------------------------------------------------------
// Beat 7 — Workspace: pump.fun + FOMO panels tiled with the rest of the
// board. 31.5–35.5s. The grid fills most of the frame; tiles arrive fast.
// ---------------------------------------------------------------------------

const WorkspaceTile: React.FC<{ title: string; accent: string; from: number; children: React.ReactNode }> = ({
  title,
  accent,
  from,
  children,
}) => (
  <Appear from={from} rise={20}>
    <div
      style={{
        width: 780,
        background: color.elevated,
        border: '1px solid #2a2d35',
        borderRadius: 16,
        overflow: 'hidden',
        boxShadow: '0 26px 70px rgba(0,0,0,0.6)',
      }}
    >
      <div
        style={{
          height: 56,
          background: '#0f0f0f',
          borderBottom: '1px solid #1c1c1c',
          display: 'flex',
          alignItems: 'center',
          padding: '0 26px',
          fontFamily: font.mono,
          fontSize: 25,
          color: accent,
          fontWeight: 600,
          letterSpacing: '0.08em',
        }}
      >
        {title}
      </div>
      <div style={{ padding: 28, height: 340, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        {children}
      </div>
    </div>
  </Appear>
);

const tileLine = (c: string): React.CSSProperties => ({
  fontFamily: font.mono,
  fontSize: 26,
  color: c,
  padding: '14px 0',
  borderBottom: `1px solid ${color.divider}`,
});

const WorkspaceBeat: React.FC = () => (
  <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
    <div style={{ display: 'grid', gridTemplateColumns: '780px 780px', gap: 44 }}>
      <WorkspaceTile title="Feed" accent={color.flame} from={2}>
        <div style={tileLine(color.solana)}>sol_scanner · new pair, LP burned</div>
        <div style={tileLine(color.text)}>alpha_dev · dev doxxed, socials live</div>
        <div style={{ ...tileLine(color.muted), borderBottom: 'none' }}>caller_7 · holders 340 → 1.2k</div>
      </WorkspaceTile>
      <WorkspaceTile title="Callers" accent={color.accent2} from={5}>
        {CALLERS.slice(0, 3).map((c) => (
          <div key={c.handle} style={{ ...tileLine(color.text), display: 'flex', justifyContent: 'space-between' }}>
            <span>@{c.handle}</span>
            <span style={{ color: color.accent2, fontWeight: 700 }}>{c.bestX}</span>
          </div>
        ))}
      </WorkspaceTile>
      <WorkspaceTile title="pump.fun · Callouts" accent={color.flame} from={8}>
        <div style={{ ...tileLine(color.text), display: 'flex', justifyContent: 'space-between' }}>
          <span>@{HERO.handle} · ${HERO.token}</span>
          <span style={{ color: color.accent2, fontWeight: 700 }}>{HERO.multLabel}</span>
        </div>
        <div style={{ ...tileLine(color.muted), borderBottom: 'none' }}>
          {HERO.calledLabel} → {HERO.resultLabel}
        </div>
      </WorkspaceTile>
      <WorkspaceTile title="fomo.family" accent={color.solana} from={11}>
        {FOMO.slice(0, 2).map((t) => (
          <div key={t.trader} style={{ ...tileLine(color.text), display: 'flex', justifyContent: 'space-between' }}>
            <span>@{t.trader} · {t.token}</span>
            <span style={{ color: signColor(t.pnl), fontWeight: 700 }}>{t.pnl}</span>
          </div>
        ))}
      </WorkspaceTile>
    </div>
  </AbsoluteFill>
);

// ---------------------------------------------------------------------------
// Beat timing. Each beat is a Sequence so it retunes cheaply. open + hook
// sum to exactly sec(8) — the payoff beat's hard cut lands ON the music's
// drop at 8.0s. Total runtime lands at 40.0s.
// ---------------------------------------------------------------------------

const BEATS = {
  open: sec(2.5),
  hook: sec(5.5),
  payoff: sec(9.5),
  callers: sec(4.5),
  holders: sec(4.5),
  fomo: sec(5),
  workspace: sec(4),
  close: sec(4.5),
} as const;

let cursor = 0;
const at = (d: number) => {
  const from = cursor;
  cursor += d;
  return from;
};

const OPEN_AT = at(BEATS.open);
const HOOK_AT = at(BEATS.hook);
const PAYOFF_AT = at(BEATS.payoff);
const CALLERS_AT = at(BEATS.callers);
const HOLDERS_AT = at(BEATS.holders);
const FOMO_AT = at(BEATS.fomo);
const WORKSPACE_AT = at(BEATS.workspace);
const CLOSE_AT = at(BEATS.close);

export const ROLLOUT_DURATION = cursor;

// ---------------------------------------------------------------------------
// Music bed. A single <Audio> spanning the whole composition, mounted outside
// any Sequence so its frame is the absolute composition frame. Fades in over
// ~0.4s and out over the last ~1.5s so the 55.3s track (longer than the
// video) trims cleanly instead of cutting off hard.
// ---------------------------------------------------------------------------

const AUDIO_FADE_IN = sec(0.4);
const AUDIO_FADE_OUT = sec(1.5);

const MusicBed: React.FC = () => {
  const frame = useCurrentFrame();
  const volume = interpolate(
    frame,
    [0, AUDIO_FADE_IN, ROLLOUT_DURATION - AUDIO_FADE_OUT, ROLLOUT_DURATION],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );
  return <Audio src={staticFile('audio/track.mp3')} volume={volume} />;
};

export const Rollout: React.FC = () => (
  <AbsoluteFill style={{ background: color.bg }}>
    <MusicBed />

    {/* 1 — Cold open. */}
    <Sequence from={OPEN_AT} durationInFrames={BEATS.open}>
      <Dissolve dur={BEATS.open}>
        <Stage>
          <PushIn dur={BEATS.open} push={1.02}>
            <ColdOpenBeat />
          </PushIn>
        </Stage>
      </Dissolve>
    </Sequence>

    {/* 2 — The hook: follow @slingoorio, a callout ping lands. Punch cut in. */}
    <Sequence from={HOOK_AT} durationInFrames={BEATS.hook}>
      <PunchCut dur={BEATS.hook}>
        <Stage>
          <PushIn dur={BEATS.hook} push={1.03}>
            <HookBeat />
          </PushIn>
        </Stage>
        <Caption>Get pinged the instant they call.</Caption>
      </PunchCut>
    </Sequence>

    {/* 3 — THE PAYOFF: cuts in exactly on the music's drop (8.0s). No
        caption anywhere in this beat — the call card, the chart, and the
        full-screen 820× reveal carry it alone. */}
    <Sequence from={PAYOFF_AT} durationInFrames={BEATS.payoff}>
      <HardCutIn dur={BEATS.payoff}>
        <PayoffBeat />
      </HardCutIn>
    </Sequence>

    {/* 4 — Top Callers board. */}
    <Sequence from={CALLERS_AT} durationInFrames={BEATS.callers}>
      <Dissolve dur={BEATS.callers}>
        <Stage>
          <PushIn dur={BEATS.callers} push={1.025}>
            <CallersBeat />
          </PushIn>
        </Stage>
        <Caption>Ranked automatically.</Caption>
      </Dissolve>
    </Sequence>

    {/* 5 — Holders side by side: FOMO tracked vs on-chain. Slide in, other side. */}
    <Sequence from={HOLDERS_AT} durationInFrames={BEATS.holders}>
      <SlideCut dur={BEATS.holders} direction="left">
        <Stage>
          <PushIn dur={BEATS.holders} push={1.025}>
            <HoldersBeat />
          </PushIn>
        </Stage>
        <Caption>Who's holding — on-chain.</Caption>
      </SlideCut>
    </Sequence>

    {/* 6 — FOMO live trades, PnL, and the thesis. Punch cut in. */}
    <Sequence from={FOMO_AT} durationInFrames={BEATS.fomo}>
      <PunchCut dur={BEATS.fomo}>
        <Stage>
          <PushIn dur={BEATS.fomo} push={1.025}>
            <FomoBeat />
          </PushIn>
        </Stage>
        <Caption>The trade — and why they made it.</Caption>
      </PunchCut>
    </Sequence>

    {/* 7 — Workspace: build your own board. */}
    <Sequence from={WORKSPACE_AT} durationInFrames={BEATS.workspace}>
      <Dissolve dur={BEATS.workspace}>
        <Stage>
          <PushIn dur={BEATS.workspace} push={1.02}>
            <WorkspaceBeat />
          </PushIn>
        </Stage>
        <Caption>Build your own board.</Caption>
      </Dissolve>
    </Sequence>

    {/* 8 — Close: still wordmark, air around it, a gold accent. Calm — the
        one beat that keeps a slightly longer, gentler fade, and breathes. */}
    <Sequence from={CLOSE_AT} durationInFrames={BEATS.close}>
      <Dissolve dur={BEATS.close} inDur={10} outDur={10}>
        <AbsoluteFill
          style={{ background: color.bg, alignItems: 'center', justifyContent: 'center', gap: 24 }}
        >
          <SlabIn from={6} size={170} tracking={-0.04}>
            OCT
          </SlabIn>
          <div
            style={{
              width: 74,
              height: 4,
              background: color.accent2,
              opacity: 0.85,
              boxShadow: glow.gold,
            }}
          />
          <SlabIn
            from={20}
            size={34}
            family={font.mono}
            weight={400}
            colorOverride={color.muted}
            tracking={0.08}
          >
            onchaintools.tech
          </SlabIn>
        </AbsoluteFill>
      </Dissolve>
    </Sequence>
  </AbsoluteFill>
);
