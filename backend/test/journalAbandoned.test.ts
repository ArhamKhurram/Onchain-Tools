import { describe, expect, it } from 'vitest';
import type { JournalPosition, JournalTrade } from '@oct/shared';
import {
  DEFAULT_ABANDON_CONFIG,
  abandonedMapFromPositions,
  evaluateAbandoned,
  type AbandonMarketInput,
} from '../src/journal/abandoned.js';
import { buildPositions, episodeId } from '../src/journal/positions.js';
import { extractTokenVolumeSnapshot } from '../src/journal/volumeDeath.js';

const NOW = Date.parse('2026-08-14T12:00:00.000Z');
const OLD = '2026-08-01T12:00:00.000Z'; // 13 days before NOW
const RECENT = '2026-08-13T12:00:00.000Z'; // 1 day before NOW

const WALLET_ID = 'wallet-1';
const ADDR = 'JournalWa11etAddre55xxxxxxxxxxxxxxxxxxxxxxx';
const TOK = 'TokenMintAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

function position(partial: Partial<JournalPosition> = {}): JournalPosition {
  return {
    id: 'pos-1',
    walletId: WALLET_ID,
    walletAddress: ADDR,
    mint: TOK,
    symbol: 'BOT',
    status: 'open',
    acquiredToken: 1_000_000,
    remainingToken: 1_000_000,
    costSol: 1.01,
    costUsd: 200,
    realizedPnlSol: 0,
    realizedPnlUsd: 0,
    pnlIncomplete: false,
    openedAt: OLD,
    closedAt: null,
    closeReason: null,
    lastTradeAt: OLD,
    lastPriceUsd: null,
    lastPriceAt: null,
    ...partial,
  };
}

/** A live pair with real LP and a price that makes the bag worth ~$500. */
const HEALTHY: AbandonMarketInput = {
  pairFound: true,
  liquidityUsd: 25_000,
  priceUsd: 0.0005,
};

describe('evaluateAbandoned — the dead-bag gate', () => {
  it('QUALIFIES: old, real cost basis, pair exists but the bag is worth ~$0', () => {
    const v = evaluateAbandoned(
      position(),
      { pairFound: true, liquidityUsd: 5_000, priceUsd: 0.0000001 },
      NOW,
    );
    expect(v.abandoned).toBe(true);
    if (!v.abandoned) throw new Error('unreachable');
    expect(v.reason).toBe('worthless');
    expect(v.positionValueUsd).toBeCloseTo(0.1, 9);
  });

  it('QUALIFIES on NO PAIR at all — the "not a real coin" case', () => {
    const v = evaluateAbandoned(
      position(),
      { pairFound: false, liquidityUsd: null, priceUsd: null },
      NOW,
    );
    expect(v.abandoned).toBe(true);
    if (!v.abandoned) throw new Error('unreachable');
    expect(v.reason).toBe('no_pair');
    expect(v.positionValueUsd).toBeNull();
  });

  it('QUALIFIES on shallow liquidity even when the bag still prices above $1', () => {
    const v = evaluateAbandoned(
      position(),
      // $500 of "value" behind $12 of LP — unexitable.
      { pairFound: true, liquidityUsd: 12, priceUsd: 0.0005 },
      NOW,
    );
    expect(v.abandoned).toBe(true);
    if (!v.abandoned) throw new Error('unreachable');
    expect(v.reason).toBe('no_liquidity');
  });

  it('DECLINES a position traded more recently than minAgeDays', () => {
    const v = evaluateAbandoned(
      position({ lastTradeAt: RECENT }),
      { pairFound: false, liquidityUsd: null, priceUsd: null },
      NOW,
    );
    expect(v).toEqual({ abandoned: false, declined: 'too_recent' });
  });

  it('DECLINES a position that is still worth real money', () => {
    const v = evaluateAbandoned(position(), HEALTHY, NOW);
    expect(v).toEqual({ abandoned: false, declined: 'alive' });
  });

  it('DECLINES when liquidity is healthy and the value clears the floor', () => {
    const v = evaluateAbandoned(
      position({ remainingToken: 10_000 }),
      { pairFound: true, liquidityUsd: 400, priceUsd: 0.001 }, // $10 bag, $400 LP
      NOW,
    );
    expect(v).toEqual({ abandoned: false, declined: 'alive' });
  });

  it('ZERO-COST GUARD: never closes a position with no cost basis', () => {
    const v = evaluateAbandoned(
      position({ costSol: 0, costUsd: 0 }),
      { pairFound: false, liquidityUsd: null, priceUsd: null },
      NOW,
    );
    expect(v).toEqual({ abandoned: false, declined: 'zero_cost' });
  });

  it('ZERO-COST GUARD: a USD-only cost basis still counts as real', () => {
    const v = evaluateAbandoned(
      position({ costSol: 0, costUsd: 42 }),
      { pairFound: false, liquidityUsd: null, priceUsd: null },
      NOW,
    );
    expect(v.abandoned).toBe(true);
  });

  it('ABSTAINS when a pair exists but returned no price this cycle', () => {
    const v = evaluateAbandoned(
      position(),
      { pairFound: true, liquidityUsd: 5_000, priceUsd: null },
      NOW,
    );
    expect(v).toEqual({ abandoned: false, declined: 'unknown_price' });
  });

  it('ABSTAINS when a pair exists with UNKNOWN liquidity and no price', () => {
    const v = evaluateAbandoned(
      position(),
      { pairFound: true, liquidityUsd: null, priceUsd: null },
      NOW,
    );
    expect(v).toEqual({ abandoned: false, declined: 'unknown_price' });
  });

  it('ABSTAINS on an unparseable lastTradeAt', () => {
    const v = evaluateAbandoned(
      position({ lastTradeAt: 'not-a-date' }),
      { pairFound: false, liquidityUsd: null, priceUsd: null },
      NOW,
    );
    expect(v).toEqual({ abandoned: false, declined: 'unknown_age' });
  });

  it('never touches a position that is already closed', () => {
    const v = evaluateAbandoned(
      position({ status: 'closed', closedAt: OLD }),
      { pairFound: false, liquidityUsd: null, priceUsd: null },
      NOW,
    );
    expect(v).toEqual({ abandoned: false, declined: 'not_open' });
  });

  it('is fully disabled by the master switch', () => {
    const v = evaluateAbandoned(
      position(),
      { pairFound: false, liquidityUsd: null, priceUsd: null },
      NOW,
      { ...DEFAULT_ABANDON_CONFIG, enabled: false },
    );
    expect(v).toEqual({ abandoned: false, declined: 'disabled' });
  });

  it('honours tuned thresholds', () => {
    const cfg = { ...DEFAULT_ABANDON_CONFIG, minAgeDays: 30, maxValueUsd: 50 };
    // 13 days old — under a 30-day floor.
    expect(evaluateAbandoned(position(), HEALTHY, NOW, cfg)).toEqual({
      abandoned: false,
      declined: 'too_recent',
    });
    // Same $500 bag is "worthless" under a $50 floor once old enough... but a
    // $500 bag is not, so use a small one to prove the floor moved.
    const small = position({ remainingToken: 10_000 }); // $5 at 0.0005
    expect(evaluateAbandoned(small, HEALTHY, NOW, { ...cfg, minAgeDays: 7 })).toMatchObject({
      abandoned: true,
      reason: 'worthless',
    });
  });
});

describe('abandonedMapFromPositions', () => {
  it('picks up only rows explicitly marked abandoned', () => {
    const map = abandonedMapFromPositions([
      position({ id: 'a', status: 'closed', closedAt: OLD, closeReason: 'abandoned' }),
      position({ id: 'b', status: 'closed', closedAt: OLD, closeReason: 'sold' }),
      position({ id: 'c', status: 'closed', closedAt: OLD, closeReason: null }),
      position({ id: 'd' }),
    ]);
    expect([...map.keys()]).toEqual(['a']);
    expect(map.get('a')).toBe(OLD);
  });

  it('falls back to lastTradeAt when an abandoned row lost its closedAt', () => {
    const map = abandonedMapFromPositions([
      position({ id: 'a', status: 'closed', closedAt: null, closeReason: 'abandoned' }),
    ]);
    expect(map.get('a')).toBe(OLD);
  });
});

// --- The accounting: a 0-proceeds close is a real loss -----------------------

let idCounter = 0;
function trade(
  partial: Partial<JournalTrade> & Pick<JournalTrade, 'side' | 'amountToken' | 'ts'>,
): JournalTrade {
  return {
    id: `t-${++idCounter}`,
    walletId: WALLET_ID,
    walletAddress: ADDR,
    mint: TOK,
    symbol: 'BOT',
    amountSol: null,
    amountUsd: null,
    txSignature: `sig-${idCounter}`,
    dex: null,
    ...partial,
  };
}

describe('buildPositions — abandoned close books the unrecovered cost', () => {
  const BUY_TS = '2026-08-01T10:00:00.000Z';
  const CLOSED_AT = '2026-08-14T12:00:00.000Z';
  const ID = episodeId(WALLET_ID, TOK, BUY_TS);

  it('realizes the FULL cost as a loss when nothing was ever sold', () => {
    const trades = [
      trade({ side: 'buy', amountToken: 1_000_000, amountSol: 1.01, amountUsd: 202, ts: BUY_TS }),
    ];
    const { positions, events } = buildPositions(trades, {
      abandoned: new Map([[ID, CLOSED_AT]]),
    });

    expect(positions).toHaveLength(1);
    const p = positions[0];
    expect(p.status).toBe('closed');
    expect(p.closedAt).toBe(CLOSED_AT);
    expect(p.closeReason).toBe('abandoned');
    expect(p.realizedPnlSol).toBeCloseTo(-1.01, 9);
    expect(p.realizedPnlUsd).toBeCloseTo(-202, 6);
    // Factual: the operator still holds every token.
    expect(p.remainingToken).toBeCloseTo(1_000_000, 6);
    // lastTradeAt stays the real last trade, not the close.
    expect(p.lastTradeAt).toBe(BUY_TS);

    expect(events).toHaveLength(1);
    expect(events[0].ts).toBe(CLOSED_AT);
    expect(events[0].pnlSol).toBeCloseTo(-1.01, 9);
    expect(events[0].pnlUsd).toBeCloseTo(-202, 6);
  });

  it('books only the UNRECOVERED cost when part of the bag was already sold', () => {
    const trades = [
      trade({ side: 'buy', amountToken: 1000, amountSol: 1, amountUsd: 200, ts: BUY_TS }),
      // Sell 400 @ 0.002 SOL/token → +0.4 realized on a 0.001 cost basis.
      trade({
        side: 'sell',
        amountToken: 400,
        amountSol: 0.8,
        amountUsd: 160,
        ts: '2026-08-02T10:00:00.000Z',
      }),
    ];
    const { positions, events } = buildPositions(trades, {
      abandoned: new Map([[ID, CLOSED_AT]]),
    });

    const p = positions[0];
    // +0.4 from the sell, then -0.6 (600 tokens × 0.001 SOL) written off.
    expect(p.realizedPnlSol).toBeCloseTo(0.4 - 0.6, 9);
    expect(p.realizedPnlUsd).toBeCloseTo(80 - 120, 6);
    expect(p.remainingToken).toBeCloseTo(600, 6);
    expect(p.closeReason).toBe('abandoned');

    expect(events).toHaveLength(2);
    expect(events[1].pnlSol).toBeCloseTo(-0.6, 9);
  });

  it('marks the episode incomplete when a remaining lot had no priced leg', () => {
    const trades = [
      trade({ side: 'buy', amountToken: 500, amountSol: 1, amountUsd: 200, ts: BUY_TS }),
      // Token-to-token leg: no SOL/USD value on the buy.
      trade({ side: 'buy', amountToken: 500, ts: '2026-08-02T10:00:00.000Z' }),
    ];
    const { positions, events } = buildPositions(trades, {
      abandoned: new Map([[ID, CLOSED_AT]]),
    });
    const p = positions[0];
    expect(p.pnlIncomplete).toBe(true);
    // Only the priced lot's cost is written off; nothing is fabricated.
    expect(p.realizedPnlSol).toBeCloseTo(-1, 9);
    expect(p.realizedPnlUsd).toBeNull();
    expect(events[0].pnlUsd).toBeNull();
  });

  it('leaves untouched episodes open and tags normal closes as sold', () => {
    const other = 'OtherMintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const trades = [
      trade({ side: 'buy', amountToken: 1000, amountSol: 1, ts: BUY_TS }),
      trade({ side: 'buy', amountToken: 100, amountSol: 0.5, mint: other, ts: BUY_TS }),
      trade({
        side: 'sell',
        amountToken: 100,
        amountSol: 0.9,
        mint: other,
        ts: '2026-08-03T10:00:00.000Z',
      }),
    ];
    const { positions } = buildPositions(trades, { abandoned: new Map() });
    const byMint = new Map(positions.map((p) => [p.mint, p]));
    expect(byMint.get(TOK)!.status).toBe('open');
    expect(byMint.get(TOK)!.closeReason).toBeNull();
    expect(byMint.get(other)!.status).toBe('closed');
    expect(byMint.get(other)!.closeReason).toBe('sold');
  });

  it('is a no-op when the abandoned id does not match any open episode', () => {
    const trades = [trade({ side: 'buy', amountToken: 1000, amountSol: 1, ts: BUY_TS })];
    const { positions, events } = buildPositions(trades, {
      abandoned: new Map([['some|other|id', CLOSED_AT]]),
    });
    expect(positions[0].status).toBe('open');
    expect(events).toHaveLength(0);
  });
});

describe('extractTokenVolumeSnapshot — liquidity for the abandonment gate', () => {
  it('sums liquidity across matching pairs', () => {
    const snap = extractTokenVolumeSnapshot(
      [
        { baseToken: { address: TOK }, liquidity: { usd: 40 }, priceUsd: '0.001', volume: {} },
        { baseToken: { address: TOK }, liquidity: { usd: 25 }, priceUsd: '0.001', volume: {} },
        { baseToken: { address: 'other' }, liquidity: { usd: 9999 }, volume: {} },
      ],
      TOK,
    );
    expect(snap?.liquidityUsd).toBe(65);
  });

  it('reports UNKNOWN liquidity as null, never as zero', () => {
    const snap = extractTokenVolumeSnapshot(
      [{ baseToken: { address: TOK }, priceUsd: '0.001', volume: {} }],
      TOK,
    );
    expect(snap?.liquidityUsd).toBeNull();
    // …and the detector then declines rather than calling it "no LP".
    expect(
      evaluateAbandoned(
        position({ remainingToken: 100_000 }), // $100 at 0.001
        { pairFound: true, liquidityUsd: snap!.liquidityUsd, priceUsd: snap!.priceUsd },
        NOW,
      ),
    ).toEqual({ abandoned: false, declined: 'alive' });
  });
});
