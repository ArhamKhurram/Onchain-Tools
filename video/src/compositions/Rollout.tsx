// Rollout — the pump.fun feature-rollout cut. ~45s, 1920×1080.
//
// Same discipline as Launch (see SCRIPT.md): calm, product-forward, slow
// push-ins, cross-dissolves, one small lower-third line per beat, the product
// does the talking. The difference is the surface: pump.fun trader tracking is a
// NEW feature, so there is no screen recording to punch into yet. So the panels
// here are native recreations in the ConsoleUI idiom — mono type, surface cards,
// hard black header rails, cockpit radius — mirroring the real console
// components (frontend/src/components/pumpfun/*): the profile header, the Recent
// trades table (Side/Token/Amount/SOL value/When), PnL per token
// (Realized/Unrealized), and the Recent callouts table (Mcap @ call / multiple).
//
// All data is fabricated. Handles, wallets, tickers and numbers are invented to
// read like a real pump.fun trader without quoting anyone real.

import React from 'react';
import { AbsoluteFill, Easing, Sequence, interpolate, useCurrentFrame } from 'remotion';
import { color, font, sec, SNAP } from '../brand';
import { Caption } from '../components/Shot';
import { SlabIn } from '../components/Kinetic';

// ---------------------------------------------------------------------------
// Fabricated sample data. Nothing here is real.
// ---------------------------------------------------------------------------

const TRADER = {
  name: 'west',
  handle: 'westtrades',
  // Valid-shaped Solana base58, but literally spells FAKE — a prop, never a wallet.
  wallet: '7Nw3pumpFAKEwa11et9xQeVK4kZrbGscT2moFAKEd3ad',
  walletShort: '7Nw3…d3ad',
};

type Side = 'buy' | 'sell';
type Trade = { side: Side; token: string; amount: string; sol: string; when: string };

const TRADES: Trade[] = [
  { side: 'buy', token: 'TOAD', amount: '1.42M', sol: '18.24', when: '2s' },
  { side: 'buy', token: 'GIGA', amount: '880K', sol: '7.50', when: '38s' },
  { side: 'sell', token: 'WOJAK', amount: '512K', sol: '12.10', when: '3m' },
  { side: 'buy', token: 'GONK', amount: '2.10M', sol: '24.60', when: '6m' },
  { side: 'sell', token: 'NYAN', amount: '145K', sol: '5.30', when: '11m' },
];

type Pnl = { token: string; realized: string; unrealized: string; spend: string };
const PNL: Pnl[] = [
  { token: 'TOAD', realized: '+214.7', unrealized: '+88.2', spend: '$52.4K' },
  { token: 'GIGA', realized: '+42.1', unrealized: '+12.6', spend: '$18.9K' },
  { token: 'GONK', realized: '+5.9', unrealized: '+61.3', spend: '$40.1K' },
  { token: 'WOJAK', realized: '-8.4', unrealized: '0.0', spend: '$22.0K' },
];

type FomoTrade = { trader: string; side: Side; token: string; sol: string; when: string };
const FOMO: FomoTrade[] = [
  { trader: 'solstice', side: 'buy', token: 'GORK', sol: '22.0', when: 'now' },
  { trader: 'degenjeff', side: 'buy', token: 'TOAD', sol: '15.5', when: '4s' },
  { trader: 'moonboy', side: 'sell', token: 'SPURDO', sol: '3.20', when: '19s' },
  { trader: 'trenchlord', side: 'buy', token: 'BONGO', sol: '9.80', when: '45s' },
];

// ---------------------------------------------------------------------------
// Motion primitives — calm, not snappy. Fade + gentle rise on entrance.
// ---------------------------------------------------------------------------

/** Cross-dissolve wrapper — the only transition in this cut (mirrors Launch). */
const Dissolve: React.FC<{ children: React.ReactNode; dur: number }> = ({ children, dur }) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [0, 14, dur - 14, dur], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>;
};

/** Very slow push-in on native content — the calm signature move. */
const PushIn: React.FC<{ children: React.ReactNode; dur: number; push?: number }> = ({
  children,
  dur,
  push = 1.05,
}) => {
  const frame = useCurrentFrame();
  // Settle the push in the first ~1.2s with an ease-out, then HOLD. Scaling
  // across the whole beat kept the panel in constant sub-pixel motion, which
  // made the fine table text shimmer — that was the "shake". A one-time settle
  // into a static hold is the calm the reference cut asks for.
  const p = interpolate(frame, [0, 36], [0, 1], {
    easing: Easing.out(Easing.cubic),
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
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

/** A row that fades and rises into place. Calm, never a snap. */
const Appear: React.FC<{ children: React.ReactNode; from: number; rise?: number }> = ({
  children,
  from,
  rise = 22,
}) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [from, from + 12], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <div style={{ opacity: p, transform: `translateY(${(1 - p) * rise}px)` }}>{children}</div>
  );
};

// ---------------------------------------------------------------------------
// Console chrome — the product floating on a dark neutral stage.
// ---------------------------------------------------------------------------

const PANEL_W = 1560;

const Stage: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
    {/* Soft neutral stage, not pure black — the panel floats on a lit surface
        (the reference cut's look). Was #000, which read as flat and too dark. */}
    <AbsoluteFill
      style={{ background: 'linear-gradient(155deg, #2a2d33 0%, #1b1d22 52%, #101114 100%)' }}
    />
    {/* Centre glow lifts the middle where the panel sits. */}
    <AbsoluteFill
      style={{
        background: 'radial-gradient(ellipse at center, rgba(255,255,255,0.08) 0%, rgba(0,0,0,0) 60%)',
      }}
    />
    {children}
  </AbsoluteFill>
);

/** The console window: chrome bar with the active tab, then the body. */
const Panel: React.FC<{ tab: string; children: React.ReactNode }> = ({ tab, children }) => (
  <div
    style={{
      width: PANEL_W,
      // A touch lighter than color.surface (#0a0a0a) so the product itself
      // reads bright against the lit stage rather than merging into it.
      background: '#141519',
      border: `1px solid #26272c`,
      borderRadius: 18,
      overflow: 'hidden',
      boxShadow: '0 40px 130px rgba(0,0,0,0.75)',
    }}
  >
    {/* Chrome bar. */}
    <div
      style={{
        height: 58,
        background: '#0f0f0f',
        borderBottom: '1px solid #1c1c1c',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '0 26px',
      }}
    >
      {[0, 1, 2].map((i) => (
        <div key={i} style={{ width: 12, height: 12, borderRadius: '50%', background: '#2a2a2a' }} />
      ))}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginLeft: 12 }}>
        <span style={{ fontFamily: font.mono, fontSize: 22, color: color.flame, fontWeight: 600 }}>
          pump.fun
        </span>
        <span style={{ fontFamily: font.mono, fontSize: 22, color: color.faint }}>/ {tab}</span>
      </div>
      <div style={{ flex: 1 }} />
      {/* Live dot. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 10, height: 10, borderRadius: '50%', background: color.solana }} />
        <span style={{ fontFamily: font.mono, fontSize: 18, color: color.muted, letterSpacing: '0.16em' }}>
          LIVE
        </span>
      </div>
    </div>
    <div style={{ padding: '30px 34px 38px' }}>{children}</div>
  </div>
);

/** Profile header row — displayName, @handle, wallet, refresh chip. */
const ProfileHeader: React.FC = () => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 18,
      paddingBottom: 24,
      borderBottom: `2px solid #000`,
      marginBottom: 26,
    }}
  >
    <div style={{ width: 58, height: 58, borderRadius: '50%', background: color.flame, flexShrink: 0 }} />
    <div style={{ minWidth: 0, flex: 1 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <span style={{ fontFamily: font.display, fontSize: 34, color: color.text, fontWeight: 700 }}>
          {TRADER.name}
        </span>
        <span style={{ fontFamily: font.mono, fontSize: 24, color: color.muted }}>@{TRADER.handle}</span>
      </div>
      <div style={{ fontFamily: font.mono, fontSize: 22, color: color.faint, marginTop: 4 }}>
        {TRADER.wallet}
      </div>
    </div>
    <div
      style={{
        fontFamily: font.mono,
        fontSize: 20,
        color: color.muted,
        border: '2px solid #2a2a2a',
        borderRadius: 10,
        padding: '10px 18px',
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
      }}
    >
      refresh
    </div>
  </div>
);

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    style={{
      fontFamily: font.mono,
      fontSize: 20,
      fontWeight: 700,
      letterSpacing: '0.2em',
      textTransform: 'uppercase',
      color: color.muted,
      marginBottom: 16,
    }}
  >
    {children}
  </div>
);

const cell = (align: 'left' | 'right' = 'left', c: string = color.text): React.CSSProperties => ({
  fontFamily: font.mono,
  fontSize: 27,
  color: c,
  textAlign: align,
  whiteSpace: 'nowrap',
});

const headCell = (align: 'left' | 'right' = 'left'): React.CSSProperties => ({
  fontFamily: font.mono,
  fontSize: 18,
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
        gap: 8,
        fontFamily: font.mono,
        fontSize: 20,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.1em',
        color: c,
        border: `2px solid ${c}`,
        background: `${c}22`,
        borderRadius: 8,
        padding: '5px 12px',
      }}
    >
      <span>{side === 'buy' ? '↙' : '↗'}</span>
      {side}
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
      gap: 20,
      padding: '17px 8px',
      borderBottom: last ? 'none' : `1px solid ${color.divider}`,
    }}
  >
    {children}
  </div>
);

const signColor = (v: string): string =>
  v.startsWith('-') ? color.flame : v.startsWith('+') ? color.solana : color.muted;

// ---------------------------------------------------------------------------
// Beat 1 — Track any trader. Paste bar + profile resolving.
// ---------------------------------------------------------------------------

const TrackBeat: React.FC = () => (
  <Panel tab="Traders">
    {/* Paste bar. */}
    <Appear from={4}>
      <div style={{ display: 'flex', gap: 16, marginBottom: 30 }}>
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            background: '#0c0c0c',
            border: '2px solid #222',
            borderRadius: 12,
            padding: '18px 22px',
          }}
        >
          <span style={{ fontFamily: font.mono, fontSize: 24, color: color.faint }}>›</span>
          <span style={{ fontFamily: font.mono, fontSize: 26, color: color.text }}>{TRADER.wallet}</span>
          <span
            style={{
              width: 2,
              height: 30,
              background: color.flame,
              marginLeft: 2,
              display: 'inline-block',
            }}
          />
        </div>
        <div
          style={{
            fontFamily: font.mono,
            fontSize: 24,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.12em',
            color: color.bg,
            background: color.flame,
            borderRadius: 12,
            padding: '18px 34px',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          Track
        </div>
      </div>
    </Appear>
    <Appear from={24}>
      <ProfileHeader />
    </Appear>
    <Appear from={40}>
      <div style={{ fontFamily: font.mono, fontSize: 24, color: color.muted, paddingTop: 4 }}>
        Now watching. Every buy, sell, PnL and callout — live.
      </div>
    </Appear>
  </Panel>
);

// ---------------------------------------------------------------------------
// Beat 2 — Live buys and sells.
// ---------------------------------------------------------------------------

const TRADE_GRID = '150px 1fr 200px 200px 130px';

const TradesBeat: React.FC = () => (
  <Panel tab="Traders">
    <ProfileHeader />
    <SectionLabel>Recent trades · 24 rows</SectionLabel>
    <RowShell grid={TRADE_GRID}>
      <div style={headCell()}>Side</div>
      <div style={headCell()}>Token</div>
      <div style={headCell('right')}>Amount</div>
      <div style={headCell('right')}>SOL value</div>
      <div style={headCell('right')}>When</div>
    </RowShell>
    {TRADES.map((t, i) => (
      <Appear key={t.token} from={10 + i * 9}>
        <RowShell grid={TRADE_GRID} last={i === TRADES.length - 1}>
          <div>
            <SideBadge side={t.side} />
          </div>
          <div style={cell('left')}>{t.token}</div>
          <div style={cell('right', color.muted)}>{t.amount}</div>
          <div style={cell('right')}>{t.sol} SOL</div>
          <div style={cell('right', color.faint)}>{t.when}</div>
        </RowShell>
      </Appear>
    ))}
  </Panel>
);

// ---------------------------------------------------------------------------
// Beat 3 — PnL per token.
// ---------------------------------------------------------------------------

const PNL_GRID = '1fr 220px 220px 180px';

const PnlBeat: React.FC = () => (
  <Panel tab="Traders">
    <ProfileHeader />
    <SectionLabel>PnL per token · reported by pump.fun</SectionLabel>
    <RowShell grid={PNL_GRID}>
      <div style={headCell()}>Token</div>
      <div style={headCell('right')}>Realized</div>
      <div style={headCell('right')}>Unrealized</div>
      <div style={headCell('right')}>Buy spend</div>
    </RowShell>
    {PNL.map((p, i) => (
      <Appear key={p.token} from={10 + i * 10}>
        <RowShell grid={PNL_GRID} last={i === PNL.length - 1}>
          <div style={cell('left')}>{p.token}</div>
          <div style={cell('right', signColor(p.realized))}>{p.realized} SOL</div>
          <div style={cell('right', signColor(p.unrealized))}>{p.unrealized} SOL</div>
          <div style={cell('right', color.muted)}>{p.spend}</div>
        </RowShell>
      </Appear>
    ))}
  </Panel>
);

// ---------------------------------------------------------------------------
// Beat 4 — Callouts. The hero payoff: what they called, at what mcap, and the
// multiple it hit.
// ---------------------------------------------------------------------------

// The hero payoff: slingoor's real public $TOAD call on pump.fun (@slingoorio,
// "I will not run this coin", called near $25.6K), then a time-skip to it hitting
// ~$18M in ~4 hours. The one real-person moment in the cut, played as
// call -> skip -> result; no fabricated trades are attributed to them (the
// track/trades/PnL beats use the demo trader).
const HERO = {
  handle: 'slingoorio',
  token: 'TOAD',
  name: 'The Toad Pepe',
  thesis: 'I will not run this coin.',
  called: '$25.6K',
  result: '$18M',
  elapsed: '4 hours later',
  mult: '≈ 700×',
};

const CalloutsBeat: React.FC = () => {
  const frame = useCurrentFrame();
  // Two phases inside the beat: the CALL, then a time-skip to the RESULT.
  const skip = 78; // frames — the call holds, then we jump forward
  return (
    <Panel tab="Callouts">
      <SectionLabel>The call · pump.fun</SectionLabel>

      {/* Phase 1 — the call. */}
      <Appear from={6}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginBottom: 30 }}>
          <div style={{ width: 52, height: 52, borderRadius: '50%', background: color.flame }} />
          <div>
            <div style={{ fontFamily: font.mono, fontSize: 30, color: color.text }}>@{HERO.handle}</div>
            <div style={{ fontFamily: font.mono, fontSize: 22, color: color.faint, marginTop: 4 }}>
              “{HERO.thesis}”
            </div>
          </div>
        </div>
      </Appear>
      <Appear from={16}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 10 }}>
          <span style={{ fontFamily: font.display, fontSize: 78, fontWeight: 800, color: color.text }}>
            <span style={{ color: color.flame }}>$</span>
            {HERO.token}
          </span>
          <span style={{ fontFamily: font.mono, fontSize: 28, color: color.muted }}>{HERO.name}</span>
        </div>
      </Appear>
      <Appear from={26}>
        <div style={{ fontFamily: font.mono, fontSize: 30, color: color.muted }}>
          called at <span style={{ color: color.text }}>{HERO.called}</span>
        </div>
      </Appear>

      {/* Phase 2 — the time-skip and the result. */}
      {frame >= skip && (
        <div style={{ marginTop: 34 }}>
          <Appear from={skip}>
            <div
              style={{
                fontFamily: font.mono,
                fontSize: 22,
                letterSpacing: '0.24em',
                textTransform: 'uppercase',
                color: color.flame,
                marginBottom: 14,
              }}
            >
              — {HERO.elapsed} —
            </div>
          </Appear>
          <Appear from={skip + 10}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 24 }}>
              <span style={{ fontFamily: font.display, fontSize: 108, fontWeight: 800, color: color.text }}>
                {HERO.result}
              </span>
              <span
                style={{ fontFamily: font.display, fontSize: 64, fontWeight: 800, color: color.solana }}
              >
                {HERO.mult}
              </span>
            </div>
          </Appear>
        </div>
      )}
    </Panel>
  );
};

// ---------------------------------------------------------------------------
// Beat 5 — FOMO live trades (secondary).
// ---------------------------------------------------------------------------

const FOMO_GRID = '1fr 150px 200px 190px 120px';

const FomoBeat: React.FC = () => (
  <Panel tab="fomo.family · Live">
    <SectionLabel>Live trades · tracked traders</SectionLabel>
    <RowShell grid={FOMO_GRID}>
      <div style={headCell()}>Trader</div>
      <div style={headCell()}>Side</div>
      <div style={headCell()}>Token</div>
      <div style={headCell('right')}>SOL value</div>
      <div style={headCell('right')}>When</div>
    </RowShell>
    {FOMO.map((t, i) => (
      <Appear key={t.trader} from={10 + i * 10}>
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
          <div style={cell('right', color.faint)}>{t.when}</div>
        </RowShell>
      </Appear>
    ))}
  </Panel>
);

// ---------------------------------------------------------------------------
// Beat 6 — Console montage: one console for all of it.
// ---------------------------------------------------------------------------

const MiniPanel: React.FC<{ title: string; from: number; children: React.ReactNode }> = ({
  title,
  from,
  children,
}) => (
  <Appear from={from} rise={30}>
    <div
      style={{
        width: 460,
        background: color.surface,
        border: '1px solid #1c1c1c',
        borderRadius: 14,
        overflow: 'hidden',
        boxShadow: '0 26px 70px rgba(0,0,0,0.6)',
      }}
    >
      <div
        style={{
          height: 46,
          background: '#0f0f0f',
          borderBottom: '1px solid #1c1c1c',
          display: 'flex',
          alignItems: 'center',
          padding: '0 20px',
          fontFamily: font.mono,
          fontSize: 20,
          color: color.flame,
          fontWeight: 600,
          letterSpacing: '0.08em',
        }}
      >
        {title}
      </div>
      <div style={{ padding: 22, height: 300 }}>{children}</div>
    </div>
  </Appear>
);

const miniLine = (c: string): React.CSSProperties => ({
  fontFamily: font.mono,
  fontSize: 20,
  color: c,
  padding: '9px 0',
  borderBottom: `1px solid ${color.divider}`,
});

const MontageBeat: React.FC = () => (
  <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
    <div style={{ display: 'flex', gap: 34 }}>
      <MiniPanel title="Feed" from={4}>
        <div style={miniLine(color.solana)}>sol_scanner · new pair, LP burned</div>
        <div style={miniLine(color.text)}>alpha_dev · dev doxxed, socials live</div>
        <div style={{ ...miniLine(color.solana), borderLeft: `4px solid ${color.solana}`, paddingLeft: 12 }}>
          trench_bot · CA: 9xQe…4kZr
        </div>
        <div style={{ ...miniLine(color.muted), borderBottom: 'none' }}>caller_7 · holders 340 → 1.2k</div>
      </MiniPanel>
      <MiniPanel title="Radar" from={10}>
        <div style={{ ...miniLine(color.faint), display: 'flex', justifyContent: 'space-between' }}>
          <span>TOKEN</span>
          <span>×</span>
        </div>
        {[
          ['TOAD', '263x', color.solana],
          ['GIGA', '104x', color.solana],
          ['MOOSE', '54x', color.solana],
          ['RUGME', '0.3x', color.flame],
        ].map(([t, x, c]) => (
          <div key={t} style={{ ...miniLine(color.text), display: 'flex', justifyContent: 'space-between' }}>
            <span>{t}</span>
            <span style={{ color: c as string, fontWeight: 700 }}>{x}</span>
          </div>
        ))}
      </MiniPanel>
      <MiniPanel title="Sniper" from={16}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <div style={{ width: 10, height: 10, borderRadius: '50%', background: color.solana }} />
          <span style={{ fontFamily: font.mono, fontSize: 20, color: color.solana, letterSpacing: '0.14em' }}>
            ARMED
          </span>
        </div>
        <div style={miniLine(color.text)}>fire $TOAD · 2.0 SOL</div>
        <div style={miniLine(color.muted)}>slippage 12% · cap 5.0 SOL</div>
        <div style={{ ...miniLine(color.muted), borderBottom: 'none' }}>kill switch · ready</div>
      </MiniPanel>
    </div>
  </AbsoluteFill>
);

// ---------------------------------------------------------------------------
// Beat timing. Each beat is a Sequence so it retunes cheaply.
// ---------------------------------------------------------------------------

const BEATS = {
  track: sec(5),
  trades: sec(8),
  pnl: sec(7),
  callouts: sec(10),
  fomo: sec(6),
  montage: sec(5),
  close: sec(5),
} as const;

let cursor = 0;
const at = (d: number) => {
  const from = cursor;
  cursor += d;
  return from;
};

const TRACK_AT = at(BEATS.track);
const TRADES_AT = at(BEATS.trades);
const PNL_AT = at(BEATS.pnl);
const CALLOUTS_AT = at(BEATS.callouts);
const FOMO_AT = at(BEATS.fomo);
const MONTAGE_AT = at(BEATS.montage);
const CLOSE_AT = at(BEATS.close);

export const ROLLOUT_DURATION = cursor;

export const Rollout: React.FC = () => (
  <AbsoluteFill style={{ background: color.bg }}>
    {/* 1 — Track any pump.fun trader. */}
    <Sequence from={TRACK_AT} durationInFrames={BEATS.track}>
      <Dissolve dur={BEATS.track}>
        <Stage>
          <PushIn dur={BEATS.track} push={1.02}>
            <TrackBeat />
          </PushIn>
        </Stage>
        <Caption from={sec(2)}>Track any pump.fun trader.</Caption>
      </Dissolve>
    </Sequence>

    {/* 2 — Live buys and sells. */}
    <Sequence from={TRADES_AT} durationInFrames={BEATS.trades}>
      <Dissolve dur={BEATS.trades}>
        <Stage>
          <PushIn dur={BEATS.trades} push={1.025}>
            <TradesBeat />
          </PushIn>
        </Stage>
        <Caption>Their buys and sells, live.</Caption>
      </Dissolve>
    </Sequence>

    {/* 3 — PnL per token. */}
    <Sequence from={PNL_AT} durationInFrames={BEATS.pnl}>
      <Dissolve dur={BEATS.pnl}>
        <Stage>
          <PushIn dur={BEATS.pnl} push={1.025}>
            <PnlBeat />
          </PushIn>
        </Stage>
        <Caption>Realized and unrealized, per coin.</Caption>
      </Dissolve>
    </Sequence>

    {/* 4 — Callouts. The hero payoff. */}
    <Sequence from={CALLOUTS_AT} durationInFrames={BEATS.callouts}>
      <Dissolve dur={BEATS.callouts}>
        <Stage>
          <PushIn dur={BEATS.callouts} push={1.03}>
            <CalloutsBeat />
          </PushIn>
        </Stage>
        <Caption>And what they called — mcap, and the multiple it hit.</Caption>
      </Dissolve>
    </Sequence>

    {/* 5 — FOMO live trades. */}
    <Sequence from={FOMO_AT} durationInFrames={BEATS.fomo}>
      <Dissolve dur={BEATS.fomo}>
        <Stage>
          <PushIn dur={BEATS.fomo} push={1.025}>
            <FomoBeat />
          </PushIn>
        </Stage>
        <Caption>fomo.family traders, live.</Caption>
      </Dissolve>
    </Sequence>

    {/* 6 — Console montage. */}
    <Sequence from={MONTAGE_AT} durationInFrames={BEATS.montage}>
      <Dissolve dur={BEATS.montage}>
        <Stage>
          <PushIn dur={BEATS.montage} push={1.02}>
            <MontageBeat />
          </PushIn>
        </Stage>
        <Caption>One console for all of it.</Caption>
      </Dissolve>
    </Sequence>

    {/* 7 — Close: still logo, air around it. */}
    <Sequence from={CLOSE_AT} durationInFrames={BEATS.close}>
      <Dissolve dur={BEATS.close}>
        <AbsoluteFill
          style={{ background: color.bg, alignItems: 'center', justifyContent: 'center', gap: 26 }}
        >
          <SlabIn from={6} size={150} tracking={-0.04}>
            OCT
          </SlabIn>
          <SlabIn
            from={20}
            size={30}
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
