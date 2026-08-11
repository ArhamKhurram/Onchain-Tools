import { describe, expect, it } from 'vitest';
import type { JournalTrade } from '@oct/shared';
import { buildPositions, DUST_RATIO, episodeId } from '../src/journal/positions.js';

const WALLET_ID = 'wallet-1';
const ADDR = 'JournalWa11etAddre55xxxxxxxxxxxxxxxxxxxxxxx';
const TOK = 'TokenMintAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

let idCounter = 0;
function trade(partial: Partial<JournalTrade> & Pick<JournalTrade, 'side' | 'amountToken' | 'ts'>): JournalTrade {
  return {
    id: `t-${++idCounter}`,
    walletId: WALLET_ID,
    walletAddress: ADDR,
    mint: TOK,
    symbol: 'TOK',
    amountSol: null,
    amountUsd: null,
    txSignature: `sig-${idCounter}`,
    dex: null,
    ...partial,
  };
}

describe('buildPositions — FIFO pairing', () => {
  it('pairs a full round trip and closes the episode with realized PnL', () => {
    const { positions, events } = buildPositions([
      trade({ side: 'buy', amountToken: 1000, amountSol: 1, amountUsd: 200, ts: '2026-08-01T10:00:00.000Z' }),
      trade({ side: 'sell', amountToken: 1000, amountSol: 3, amountUsd: 600, ts: '2026-08-01T12:00:00.000Z' }),
    ]);
    expect(positions).toHaveLength(1);
    const p = positions[0];
    expect(p.status).toBe('closed');
    expect(p.closedAt).toBe('2026-08-01T12:00:00.000Z');
    expect(p.realizedPnlSol).toBeCloseTo(2, 9);
    expect(p.realizedPnlUsd).toBeCloseTo(400, 6);
    expect(p.pnlIncomplete).toBe(false);
    expect(p.remainingToken).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0].pnlSol).toBeCloseTo(2, 9);
  });

  it('consumes lots in FIFO order on a partial sell across two buys', () => {
    const { positions } = buildPositions([
      trade({ side: 'buy', amountToken: 100, amountSol: 0.1, ts: '2026-08-01T10:00:00.000Z' }),
      trade({ side: 'buy', amountToken: 100, amountSol: 0.3, ts: '2026-08-01T11:00:00.000Z' }),
      // Sell 150 @ 0.004 SOL/token: 100 from lot1 (0.001) + 50 from lot2 (0.003).
      trade({ side: 'sell', amountToken: 150, amountSol: 0.6, ts: '2026-08-01T12:00:00.000Z' }),
    ]);
    expect(positions).toHaveLength(1);
    const p = positions[0];
    expect(p.status).toBe('open');
    expect(p.remainingToken).toBeCloseTo(50, 9);
    expect(p.realizedPnlSol).toBeCloseTo((0.004 - 0.001) * 100 + (0.004 - 0.003) * 50, 9);
  });

  it('closes on dust (< 2% of acquired remaining) and reopens a NEW episode on the next buy', () => {
    const { positions } = buildPositions([
      trade({ side: 'buy', amountToken: 1000, amountSol: 1, ts: '2026-08-01T10:00:00.000Z' }),
      // 985 out → 15 remaining < 20 (2% of 1000) → episode closed.
      trade({ side: 'sell', amountToken: 985, amountSol: 2, ts: '2026-08-01T11:00:00.000Z' }),
      // Re-entry the next day → fresh episode, not a continuation.
      trade({ side: 'buy', amountToken: 500, amountSol: 0.5, ts: '2026-08-02T09:00:00.000Z' }),
    ]);
    expect(positions).toHaveLength(2);
    const [first, second] = positions;
    expect(first.status).toBe('closed');
    expect(first.remainingToken).toBeCloseTo(15, 9);
    expect(second.status).toBe('open');
    expect(second.openedAt).toBe('2026-08-02T09:00:00.000Z');
    expect(second.id).toBe(episodeId(WALLET_ID, TOK, '2026-08-02T09:00:00.000Z'));
    expect(second.id).not.toBe(first.id);
  });

  it('keeps an episode open at exactly the dust boundary + epsilon', () => {
    const { positions } = buildPositions([
      trade({ side: 'buy', amountToken: 1000, amountSol: 1, ts: '2026-08-01T10:00:00.000Z' }),
      // Remaining 21 > 2% of 1000 → still open.
      trade({ side: 'sell', amountToken: 979, amountSol: 2, ts: '2026-08-01T11:00:00.000Z' }),
    ]);
    expect(DUST_RATIO).toBe(0.02);
    expect(positions[0].status).toBe('open');
  });

  it('realizes nothing for a sell with no open episode (transfer-in-derived)', () => {
    const { positions, events } = buildPositions([
      trade({ side: 'sell', amountToken: 5000, amountSol: 4, ts: '2026-08-01T10:00:00.000Z' }),
    ]);
    expect(positions).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it('marks pnlIncomplete instead of fabricating PnL when a leg has no SOL value', () => {
    const { positions } = buildPositions([
      // Stable-paid buy: USD known, SOL unknown.
      trade({ side: 'buy', amountToken: 1000, amountSol: null, amountUsd: 100, ts: '2026-08-01T10:00:00.000Z' }),
      trade({ side: 'sell', amountToken: 1000, amountSol: 2, amountUsd: 400, ts: '2026-08-01T12:00:00.000Z' }),
    ]);
    expect(positions).toHaveLength(1);
    const p = positions[0];
    expect(p.status).toBe('closed');
    expect(p.pnlIncomplete).toBe(true);
    // SOL PnL cannot be computed for that lot — stays 0 rather than invented.
    expect(p.realizedPnlSol).toBe(0);
    // USD side is fully known on both legs → real number.
    expect(p.realizedPnlUsd).toBeCloseTo(300, 6);
  });

  it('excludes over-sold quantity beyond the episode from PnL and flags it', () => {
    const { positions } = buildPositions([
      trade({ side: 'buy', amountToken: 100, amountSol: 0.1, ts: '2026-08-01T10:00:00.000Z' }),
      // Sells 150 (50 came from an earlier transfer-in) at 0.002 SOL/token.
      trade({ side: 'sell', amountToken: 150, amountSol: 0.3, ts: '2026-08-01T11:00:00.000Z' }),
    ]);
    const p = positions[0];
    expect(p.status).toBe('closed');
    expect(p.pnlIncomplete).toBe(true);
    // Only the 100 matched tokens realize: (0.002 - 0.001) * 100.
    expect(p.realizedPnlSol).toBeCloseTo(0.1, 9);
  });

  it('keeps separate episodes per mint and per wallet', () => {
    const OTHER = 'TokenMintBxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const { positions } = buildPositions([
      trade({ side: 'buy', amountToken: 10, amountSol: 0.1, ts: '2026-08-01T10:00:00.000Z' }),
      trade({ side: 'buy', amountToken: 20, amountSol: 0.2, ts: '2026-08-01T10:05:00.000Z', mint: OTHER }),
      trade({ side: 'buy', amountToken: 30, amountSol: 0.3, ts: '2026-08-01T10:10:00.000Z', walletId: 'wallet-2' }),
    ]);
    expect(positions).toHaveLength(3);
    expect(new Set(positions.map((p) => p.id)).size).toBe(3);
  });
});
