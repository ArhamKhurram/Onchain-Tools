import { describe, it, expect } from 'vitest';
import {
  isMonitor985Window,
  normalize985Board,
  normalize985Row,
  normalize985Snapshot,
  select985Board,
} from '../src/fomo/monitor985.js';

// 985monitor.xyz publishes a static snapshot of the fomo.family leaderboards.
// It is a third-party file OCT neither controls nor versions, so the parser is
// tested against the documented shape AND against payloads that have gone wrong
// in every way JSON can go wrong.

const SAMPLE_ROW = {
  rank: 1,
  uid: '6d8c0bf3-5d42-506c-a0ea-9e1e75ff38af',
  handle: 'pointfarmcap',
  name: 'point farm capital',
  avatar: 'https://prod-fomo-profile-pics.s3.amazonaws.com/94a0a2f.jpg',
  followers: 37002,
  numTrades: 2144,
  volume: 9886319,
  pnl: 8097260,
};

function sampleFile(overrides: Record<string, unknown> = {}) {
  return {
    updatedAt: 1788719087841,
    boards: {
      '24h': [SAMPLE_ROW],
      '7d': [{ ...SAMPLE_ROW, uid: 'b', handle: 'seven' }],
      '30d': [{ ...SAMPLE_ROW, uid: 'c', handle: 'thirty' }],
      all: [{ ...SAMPLE_ROW, uid: 'd', handle: 'alltime' }],
    },
    commonFollowing: [],
    alliances: [],
    ...overrides,
  };
}

describe('normalize985Row', () => {
  it('maps the documented row shape onto the leaderboard entry contract', () => {
    expect(normalize985Row(SAMPLE_ROW, 99)).toEqual({
      fomoUserId: '6d8c0bf3-5d42-506c-a0ea-9e1e75ff38af',
      fomoHandle: 'pointfarmcap',
      displayName: 'point farm capital',
      avatar: 'https://prod-fomo-profile-pics.s3.amazonaws.com/94a0a2f.jpg',
      followers: 37002,
      numTrades: 2144,
      volume: 9886319,
      pnl: 8097260,
      rank: 1,
    });
  });

  it('rejects a row with no uid — uid is the join key against tracked users', () => {
    expect(normalize985Row({ ...SAMPLE_ROW, uid: undefined }, 1)).toBeNull();
    expect(normalize985Row({ ...SAMPLE_ROW, uid: '   ' }, 1)).toBeNull();
    expect(normalize985Row(null, 1)).toBeNull();
    expect(normalize985Row('nope', 1)).toBeNull();
    expect(normalize985Row([SAMPLE_ROW], 1)).toBeNull();
  });

  it('falls back to positional rank when the upstream rank is missing or unusable', () => {
    expect(normalize985Row({ ...SAMPLE_ROW, rank: undefined }, 7)?.rank).toBe(7);
    expect(normalize985Row({ ...SAMPLE_ROW, rank: 'first' }, 7)?.rank).toBe(7);
  });

  it('nulls non-finite numbers instead of letting NaN reach the UI', () => {
    const row = normalize985Row({ ...SAMPLE_ROW, pnl: 'not-a-number', volume: null }, 1);
    expect(row?.pnl).toBeNull();
    expect(row?.volume).toBeNull();
  });

  it('drops a non-http avatar so a hostile URL never reaches an <img src>', () => {
    expect(normalize985Row({ ...SAMPLE_ROW, avatar: 'javascript:alert(1)' }, 1)?.avatar).toBeNull();
    expect(normalize985Row({ ...SAMPLE_ROW, avatar: 'data:text/html,<script>' }, 1)?.avatar).toBeNull();
    expect(normalize985Row({ ...SAMPLE_ROW, avatar: 'http://example.com/a.jpg' }, 1)?.avatar).toBe(
      'http://example.com/a.jpg',
    );
  });

  it('caps oversized strings rather than propagating them into state and logs', () => {
    const row = normalize985Row({ ...SAMPLE_ROW, name: 'x'.repeat(5000) }, 1);
    expect(row?.displayName?.length).toBe(128);
  });
});

describe('normalize985Board', () => {
  it('drops unusable rows and dedupes by uid', () => {
    const board = normalize985Board([
      SAMPLE_ROW,
      { ...SAMPLE_ROW },
      null,
      { handle: 'no-uid' },
      { ...SAMPLE_ROW, uid: 'other' },
    ]);
    expect(board.map((e) => e.fomoUserId)).toEqual([SAMPLE_ROW.uid, 'other']);
  });

  it('returns an empty board for anything that is not an array', () => {
    expect(normalize985Board(undefined)).toEqual([]);
    expect(normalize985Board({ '0': SAMPLE_ROW })).toEqual([]);
    expect(normalize985Board('[]')).toEqual([]);
  });
});

describe('normalize985Snapshot', () => {
  it('parses the documented file into all four boards', () => {
    const snap = normalize985Snapshot(sampleFile());
    expect(snap.updatedAt).toBe(1788719087841);
    expect(Object.keys(snap.boards).sort()).toEqual(['24h', '30d', '7d', 'all']);
    expect(snap.boards['7d'][0].fomoHandle).toBe('seven');
  });

  it('always returns all four boards, even when the file is garbage', () => {
    for (const bad of [null, undefined, 'nope', 42, [], { boards: 'nope' }]) {
      const snap = normalize985Snapshot(bad);
      expect(snap.boards['24h']).toEqual([]);
      expect(snap.boards.all).toEqual([]);
      expect(snap.updatedAt).toBeNull();
    }
  });

  it('rejects an implausible updatedAt rather than rendering "54 years ago"', () => {
    expect(normalize985Snapshot(sampleFile({ updatedAt: 0 })).updatedAt).toBeNull();
    expect(normalize985Snapshot(sampleFile({ updatedAt: 1788719087 })).updatedAt).toBeNull(); // seconds, not ms
    expect(normalize985Snapshot(sampleFile({ updatedAt: 9e15 })).updatedAt).toBeNull();
  });
});

describe('select985Board', () => {
  const snapshot = normalize985Snapshot({
    updatedAt: 1788719087841,
    boards: {
      '24h': Array.from({ length: 30 }, (_, i) => ({ ...SAMPLE_ROW, uid: `u${i}`, rank: i + 1 })),
    },
  });

  it('caps to the requested limit', () => {
    expect(select985Board(snapshot, '24h', 5)).toHaveLength(5);
  });

  it('clamps a hostile limit into range instead of trusting it', () => {
    expect(select985Board(snapshot, '24h', -1)).toHaveLength(1);
    expect(select985Board(snapshot, '24h', 10_000)).toHaveLength(30);
    expect(select985Board(snapshot, '24h', Number.NaN)).toHaveLength(30);
  });

  it('returns empty for a window the snapshot did not carry', () => {
    expect(select985Board(snapshot, '30d', 10)).toEqual([]);
  });
});

describe('isMonitor985Window', () => {
  it('accepts exactly the four published windows', () => {
    expect(['24h', '7d', '30d', 'all'].every(isMonitor985Window)).toBe(true);
    expect(isMonitor985Window('1h')).toBe(false);
    expect(isMonitor985Window(null)).toBe(false);
    expect(isMonitor985Window(undefined)).toBe(false);
  });
});
