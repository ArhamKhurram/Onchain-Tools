import { describe, it, expect } from 'vitest';
import {
  describePumpConnection,
  formatPnlUsd,
  leaderboardLabel,
  leaderboardTrackState,
  normalizePumpLeaderboard,
  pumpDaysLeft,
  PUMP_LEADERBOARD_WINDOWS,
  type PumpConnectionStatus,
  type PumpLeaderboardEntry,
} from '../src/types/pumpfun';
import { DEFAULT_PUMP_VIEW, PUMP_TABS, parsePumpView } from '../src/lib/pumpViews';

// The pump.fun leaderboard is a per-user surface fetched with the operator's own
// pump login, so its correctness rides on pure helpers that never touch the
// network: which rows are trackable, whether a session reads as connected /
// expiring / needs-reconnect, and that the sub-tab is actually registered. Each
// `it` guards one concrete bug, the way pumpfun.test.ts and sniperRules.test.ts do.

const WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const WALLET_2 = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

// ---------------------------------------------------------------------------
// Sub-tab registration
// ---------------------------------------------------------------------------

describe('pump.fun sub-tab registration', () => {
  it('registers the Leaderboard tab', () => {
    // The bug this guards: a tab added to PUMP_TABS but not to parsePumpView (or
    // vice versa) highlights while the page falls through to the default panel.
    expect(PUMP_TABS.some((t) => t.id === 'leaderboard')).toBe(true);
  });

  it('parses ?view=leaderboard back to itself', () => {
    expect(parsePumpView('leaderboard')).toBe('leaderboard');
  });

  it('every registered tab id round-trips through the parser', () => {
    for (const tab of PUMP_TABS) {
      // The default tab parses from its own id too — the fall-through only applies
      // to unknown values.
      expect(parsePumpView(tab.id)).toBe(tab.id);
    }
  });

  it('defaults unknown / missing view to Traders', () => {
    expect(parsePumpView(null)).toBe(DEFAULT_PUMP_VIEW);
    expect(parsePumpView('garbage')).toBe(DEFAULT_PUMP_VIEW);
    expect(DEFAULT_PUMP_VIEW).toBe('traders');
  });
});

// ---------------------------------------------------------------------------
// normalizePumpLeaderboard — defensive narrowing of an unverified wire shape
// ---------------------------------------------------------------------------

describe('normalizePumpLeaderboard', () => {
  it('reads a bare array and keeps a valid wallet trackable', () => {
    const rows = normalizePumpLeaderboard([
      { rank: 1, walletAddress: WALLET, handle: 'alpha', pnl: 1234 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      rank: 1,
      walletAddress: WALLET,
      handle: 'alpha',
      displayName: null,
      pnl: 1234,
    });
  });

  it('also reads an { entries: [...] } envelope', () => {
    // The wire shape is unverified, so both a bare array and an envelope must work
    // without the board silently blanking.
    const rows = normalizePumpLeaderboard({ entries: [{ walletAddress: WALLET }] });
    expect(rows).toHaveLength(1);
    expect(rows[0].walletAddress).toBe(WALLET);
  });

  it('keeps a row with a bad wallet but nulls the address, never smuggling junk into tracking', () => {
    // The bug this guards: an invalid wallet passed to the tracked list would
    // track-but-never-load. The row still ranks; its wallet is simply null.
    const rows = normalizePumpLeaderboard([{ rank: 3, wallet: 'not-a-wallet', handle: 'x' }]);
    expect(rows).toHaveLength(1);
    expect(rows[0].walletAddress).toBeNull();
    expect(rows[0].handle).toBe('x');
  });

  it('accepts alternate field spellings for wallet and pnl', () => {
    const rows = normalizePumpLeaderboard([{ address: WALLET, username: 'beta', pnlUsd: -50 }]);
    expect(rows[0]).toMatchObject({ walletAddress: WALLET, handle: 'beta', pnl: -50 });
  });

  it('drops non-object rows and non-array input rather than throwing', () => {
    expect(normalizePumpLeaderboard('nope')).toEqual([]);
    expect(normalizePumpLeaderboard([42, null, { walletAddress: WALLET }])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// leaderboardTrackState — the tracked/disabled toggle
// ---------------------------------------------------------------------------

describe('leaderboardTrackState', () => {
  const entry = (walletAddress: string | null): PumpLeaderboardEntry => ({
    rank: 1,
    walletAddress,
    handle: 'h',
    displayName: null,
    pnl: 0,
  });

  it('is trackable when the wallet is not yet tracked', () => {
    expect(leaderboardTrackState(entry(WALLET), new Set())).toBe('trackable');
  });

  it('is tracked (disabled) when the wallet is already on the list', () => {
    // Mirrors FOMO's "Tracked" disabled state so a second click cannot add a
    // duplicate row.
    expect(leaderboardTrackState(entry(WALLET), new Set([WALLET]))).toBe('tracked');
  });

  it('is no-wallet (disabled) when the row has no trackable address', () => {
    expect(leaderboardTrackState(entry(null), new Set([WALLET_2]))).toBe('no-wallet');
  });
});

// ---------------------------------------------------------------------------
// describePumpConnection / pumpDaysLeft — the connect-state machine
// ---------------------------------------------------------------------------

describe('describePumpConnection', () => {
  const NOW = Date.parse('2026-08-08T00:00:00Z');
  const inDays = (d: number) => new Date(NOW + d * 86_400_000).toISOString();

  it('is unknown (spinner, not a false connect prompt) when status is null', () => {
    expect(describePumpConnection(null, NOW)).toEqual({ state: 'unknown', daysLeft: null });
  });

  it('is disconnected when there is no session', () => {
    const s: PumpConnectionStatus = { connected: false, expiresAt: null, needsReconnect: false };
    expect(describePumpConnection(s, NOW).state).toBe('disconnected');
  });

  it('reconnects when the backend flags needsReconnect, whatever the expiry says', () => {
    const s: PumpConnectionStatus = { connected: true, expiresAt: inDays(20), needsReconnect: true };
    expect(describePumpConnection(s, NOW).state).toBe('reconnect');
  });

  it('is connected with days-left when the session is live', () => {
    const s: PumpConnectionStatus = { connected: true, expiresAt: inDays(12), needsReconnect: false };
    expect(describePumpConnection(s, NOW)).toEqual({ state: 'connected', daysLeft: 12 });
  });

  it('reconnects when connected but the expiry is already in the past', () => {
    // The bug this guards: a lagging `connected:true` with a stale token would
    // otherwise render as connected and every fetch would 401.
    const s: PumpConnectionStatus = { connected: true, expiresAt: inDays(-1), needsReconnect: false };
    expect(describePumpConnection(s, NOW).state).toBe('reconnect');
  });
});

describe('pumpDaysLeft', () => {
  it('returns null for a missing or unparseable timestamp', () => {
    expect(pumpDaysLeft(null)).toBeNull();
    expect(pumpDaysLeft('not-a-date')).toBeNull();
  });

  it('rounds up partial days remaining', () => {
    const now = Date.parse('2026-08-08T00:00:00Z');
    expect(pumpDaysLeft('2026-08-10T12:00:00Z', now)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

describe('leaderboardLabel', () => {
  const base: PumpLeaderboardEntry = { rank: 1, walletAddress: WALLET, handle: null, displayName: null, pnl: 0 };

  it('prefers @handle, then display name, then a truncated wallet', () => {
    expect(leaderboardLabel({ ...base, handle: 'alpha' })).toBe('@alpha');
    expect(leaderboardLabel({ ...base, displayName: 'Alpha' })).toBe('Alpha');
    expect(leaderboardLabel(base)).toBe('9WzDXw…AWWM');
  });
});

describe('formatPnlUsd', () => {
  it('signs and compacts thousands and millions', () => {
    expect(formatPnlUsd(1234)).toBe('+$1.2K');
    expect(formatPnlUsd(-2_000_000)).toBe('-$2.0M');
    expect(formatPnlUsd(150)).toBe('+$150');
  });

  it('renders null as an em dash', () => {
    expect(formatPnlUsd(null)).toBe('—');
  });
});

describe('PUMP_LEADERBOARD_WINDOWS', () => {
  it('offers exactly 7d / 30d / all in order', () => {
    expect([...PUMP_LEADERBOARD_WINDOWS]).toEqual(['7d', '30d', 'all']);
  });
});
