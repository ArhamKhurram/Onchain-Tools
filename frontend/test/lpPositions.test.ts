import { describe, it, expect } from 'vitest';
import {
  addToAllowlist,
  buildLineageGrid,
  buildLineages,
  resolveDisplayPnl,
  canAdmitPool,
  coverageRank,
  describeRange,
  formatDriftPercent,
  formatPrice,
  formatTokenId,
  isCoveredNow,
  isUncovered,
  normalizeSafeAddress,
  positionCoverage,
  positionPairLabel,
  presentStatus,
  rangeGeometry,
  safeAddressDirty,
  sortPositions,
  summarizePositions,
  validateSafeAddress,
  type LpPositionView,
} from '../src/components/lp/positions';

const POOL_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const POOL_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const POOL_C = '0xcccccccccccccccccccccccccccccccccccccccc';
const SAFE = '0xdddddddddddddddddddddddddddddddddddddddd';

const upper = (address: string) => address.toUpperCase().replace('0X', '0x');

const position = (over: Partial<LpPositionView> = {}): LpPositionView => ({
  tokenId: '1001',
  poolAddress: POOL_A,
  platform: 'uniswapv3',
  feeTierBps: 3000,
  token0: { symbol: 'WETH', address: POOL_B, decimals: 18 },
  token1: { symbol: 'USDC', address: POOL_C, decimals: 6 },
  status: 'in_range',
  valueUsd: 1_000,
  unclaimedFeesUsd: 12.5,
  minPrice: 1_800,
  maxPrice: 2_200,
  currentPrice: 2_000,
  isAllowlisted: true,
  managedByAutomation: true,
  ...over,
});

// --- Allowlisted is not managed ---------------------------------------------
//
// The distinction this panel exists to make. Each case below is a way the two
// could be confused, and the assertion is that they are not.

describe('allowlisted is not managed', () => {
  it('reports a pool that is not allowlisted as unmanaged, whatever else is true', () => {
    const p = position({ isAllowlisted: false, managedByAutomation: false });
    expect(positionCoverage(p, [])).toBe('unmanaged');
    expect(isCoveredNow('unmanaged')).toBe(false);
    expect(isUncovered('unmanaged')).toBe(true);
  });

  it('fails closed when the server claims managed on a pool that is not allowlisted', () => {
    // A contradiction. Promoting it to "managed" would tell the operator the
    // automation is compounding a position it has no authority to touch.
    const p = position({ isAllowlisted: false, managedByAutomation: true });
    expect(positionCoverage(p, [])).toBe('unmanaged');
  });

  it('keeps allowlisted-but-not-managed distinct from managed', () => {
    const p = position({ isAllowlisted: true, managedByAutomation: false });
    expect(positionCoverage(p, [POOL_A])).toBe('allowlisted_not_managed');
    expect(isCoveredNow('allowlisted_not_managed')).toBe(false);
    expect(isUncovered('allowlisted_not_managed')).toBe(true);
  });

  it('only calls a position managed when the pool is saved and the server agrees', () => {
    expect(positionCoverage(position(), [POOL_A])).toBe('managed');
    expect(isCoveredNow('managed')).toBe(true);
    expect(isUncovered('managed')).toBe(false);
  });

  it('treats an unsaved tick as still unmanaged', () => {
    const p = position({ isAllowlisted: false, managedByAutomation: false });
    expect(positionCoverage(p, [POOL_A])).toBe('pending_allowlist');
    expect(isCoveredNow('pending_allowlist')).toBe(false);
    expect(isUncovered('pending_allowlist')).toBe(true);
  });

  it('treats an unsaved removal as still managed today', () => {
    // The saved allowlist is what the signer reads, so unticking a pool changes
    // nothing until the save lands.
    expect(positionCoverage(position(), [])).toBe('pending_removal');
    expect(isCoveredNow('pending_removal')).toBe(true);
    expect(isUncovered('pending_removal')).toBe(false);
  });

  it('reports a closed position as closed rather than as a coverage gap', () => {
    const p = position({ status: 'closed', isAllowlisted: false, managedByAutomation: false });
    expect(positionCoverage(p, [])).toBe('closed');
    expect(isUncovered('closed')).toBe(false);
  });

  it('matches the draft allowlist case-insensitively', () => {
    const p = position({ isAllowlisted: false, managedByAutomation: false });
    expect(positionCoverage(p, [upper(POOL_A)])).toBe('pending_allowlist');
  });

  it('offers a one-click admit only where an allowlist add is what is missing', () => {
    expect(canAdmitPool('unmanaged')).toBe(true);
    expect(canAdmitPool('allowlisted_not_managed')).toBe(false);
    expect(canAdmitPool('pending_allowlist')).toBe(false);
    expect(canAdmitPool('managed')).toBe(false);
    expect(canAdmitPool('closed')).toBe(false);
  });
});

describe('addToAllowlist', () => {
  it('adds normalized without mutating the input', () => {
    const before = [POOL_A];
    expect(addToAllowlist(before, upper(POOL_B))).toEqual([POOL_A, POOL_B]);
    expect(before).toEqual([POOL_A]);
  });

  it('never removes — a second click is a no-op, not a toggle', () => {
    expect(addToAllowlist([POOL_A], POOL_A)).toEqual([POOL_A]);
    expect(addToAllowlist([POOL_A], upper(POOL_A))).toEqual([POOL_A]);
  });

  it('ignores a blank address', () => {
    expect(addToAllowlist([POOL_A], '   ')).toEqual([POOL_A]);
  });
});

// --- Range and price presentation -------------------------------------------

describe('rangeGeometry', () => {
  it('places a price inside its range as a fraction', () => {
    expect(rangeGeometry(100, 200, 150)).toEqual({
      placement: 'inside',
      fraction: 0.5,
      driftPercent: null,
    });
  });

  it('treats the bounds themselves as inside', () => {
    expect(rangeGeometry(100, 200, 100).placement).toBe('inside');
    expect(rangeGeometry(100, 200, 200).placement).toBe('inside');
    expect(rangeGeometry(100, 200, 100).fraction).toBe(0);
    expect(rangeGeometry(100, 200, 200).fraction).toBe(1);
  });

  it('pins an out-of-range price to the end it left, with the drift past that bound', () => {
    const above = rangeGeometry(100, 200, 220);
    expect(above.placement).toBe('above');
    expect(above.fraction).toBe(1);
    expect(above.driftPercent).toBeCloseTo(10);

    const below = rangeGeometry(100, 200, 90);
    expect(below.placement).toBe('below');
    expect(below.fraction).toBe(0);
    expect(below.driftPercent).toBeCloseTo(10);
  });

  it('refuses to place a price in a degenerate range rather than inventing 0 or 1', () => {
    expect(rangeGeometry(200, 200, 200)).toEqual({
      placement: 'unknown',
      fraction: null,
      driftPercent: null,
    });
    expect(rangeGeometry(300, 200, 250).placement).toBe('unknown');
  });

  it('reports unknown for non-finite inputs instead of rendering NaN', () => {
    expect(rangeGeometry(Number.NaN, 200, 150).placement).toBe('unknown');
    expect(rangeGeometry(100, undefined, 150).placement).toBe('unknown');
    expect(rangeGeometry(100, 200, null).placement).toBe('unknown');
    expect(rangeGeometry(100, Number.POSITIVE_INFINITY, 150).placement).toBe('unknown');
  });
});

describe('describeRange', () => {
  it('says what in-range means, not that it is in range', () => {
    expect(describeRange(rangeGeometry(100, 200, 150), 'in_range')).toContain('earning fees');
  });

  it('names the side, the drift and the consequence when out of range', () => {
    const text = describeRange(rangeGeometry(100, 200, 220), 'out_of_range');
    expect(text).toContain('above the upper bound');
    expect(text).toContain('10.0%');
    expect(text).toContain('earning nothing');
  });

  it('drops the drift rather than printing a dash mid-sentence', () => {
    // A zero lower bound makes a percentage of it meaningless.
    const text = describeRange(rangeGeometry(0, 200, -5), 'out_of_range');
    expect(text).toContain('below the lower bound');
    expect(text).not.toContain('by ');
  });

  it('does not describe a range for a closed position', () => {
    expect(describeRange(rangeGeometry(100, 200, 150), 'closed')).toContain('withdrawn');
  });

  it('says so plainly when the bounds are unusable', () => {
    expect(describeRange(rangeGeometry(Number.NaN, 200, 150), 'in_range')).toBe(
      'Price range unavailable for this position.',
    );
  });
});

describe('presentStatus', () => {
  it('pairs every status with its consequence, not just its name', () => {
    expect(presentStatus('in_range')).toEqual({
      label: 'In range',
      consequence: 'Earning fees',
      tone: 'earning',
    });
    expect(presentStatus('out_of_range')).toEqual({
      label: 'Out of range',
      consequence: 'Earning nothing',
      tone: 'idle',
    });
    expect(presentStatus('closed').tone).toBe('closed');
  });
});

describe('price and drift formatting', () => {
  it('scales decimals to the magnitude of the price', () => {
    expect(formatPrice(3241.5512)).toBe('3,241.55');
    expect(formatPrice(1.5)).toBe('1.5');
    expect(formatPrice(1)).toBe('1');
    expect(formatPrice(0.000023)).toBe('0.000023');
    expect(formatPrice(0)).toBe('0');
  });

  it('falls back to exponential rather than rendering a long-tail price as 0', () => {
    expect(formatPrice(0.00000001)).toBe('1.00e-8');
  });

  it('renders a dash for anything non-finite', () => {
    expect(formatPrice(Number.NaN)).toBe('—');
    expect(formatPrice(undefined)).toBe('—');
    expect(formatPrice('2000')).toBe('—');
  });

  it('keeps drift readable at both ends of the scale', () => {
    expect(formatDriftPercent(10)).toBe('10.0%');
    expect(formatDriftPercent(0.42)).toBe('0.42%');
    expect(formatDriftPercent(240)).toBe('240%');
    expect(formatDriftPercent(Number.NaN)).toBe('—');
  });

  it('labels pairs and token ids', () => {
    expect(positionPairLabel(position())).toBe('WETH / USDC');
    expect(formatTokenId('1001')).toBe('#1001');
    expect(formatTokenId('#1001')).toBe('#1001');
    expect(formatTokenId('')).toBe('—');
    expect(formatTokenId(undefined)).toBe('—');
  });
});

// --- Summary ----------------------------------------------------------------

describe('summarizePositions', () => {
  const positions = [
    position({ tokenId: '1', poolAddress: POOL_A, valueUsd: 1_000, unclaimedFeesUsd: 10 }),
    position({
      tokenId: '2',
      poolAddress: POOL_B,
      valueUsd: 400,
      unclaimedFeesUsd: 4,
      status: 'out_of_range',
      isAllowlisted: false,
      managedByAutomation: false,
    }),
    position({
      tokenId: '3',
      poolAddress: POOL_C,
      valueUsd: 9_999,
      unclaimedFeesUsd: 99,
      status: 'closed',
      isAllowlisted: false,
      managedByAutomation: false,
    }),
  ];

  it('counts and values managed separately from uncovered', () => {
    const summary = summarizePositions(positions, [POOL_A]);
    expect(summary.total).toBe(3);
    expect(summary.open).toBe(2);
    expect(summary.closed).toBe(1);
    expect(summary.managed).toBe(1);
    expect(summary.managedValueUsd).toBe(1_000);
    expect(summary.uncovered).toBe(1);
    expect(summary.uncoveredValueUsd).toBe(400);
  });

  it('excludes closed positions from the money totals', () => {
    const summary = summarizePositions(positions, [POOL_A]);
    expect(summary.valueUsd).toBe(1_400);
    expect(summary.unclaimedFeesUsd).toBe(14);
  });

  it('counts out-of-range money whether or not it is managed', () => {
    const summary = summarizePositions(positions, [POOL_A]);
    expect(summary.outOfRange).toBe(1);
    expect(summary.outOfRangeValueUsd).toBe(400);
  });

  it('lists only the pools a one-click add would fix, deduplicated', () => {
    const summary = summarizePositions(
      [
        position({ tokenId: '1', poolAddress: POOL_B, isAllowlisted: false, managedByAutomation: false }),
        position({ tokenId: '2', poolAddress: upper(POOL_B), isAllowlisted: false, managedByAutomation: false }),
        position({ tokenId: '3', poolAddress: POOL_A }),
      ],
      [POOL_A],
    );
    expect(summary.admittablePools).toEqual([POOL_B]);
  });

  it('keeps an unsaved tick out of the managed count and inside the pending count', () => {
    const summary = summarizePositions(positions, [POOL_A, POOL_B]);
    expect(summary.managed).toBe(1);
    expect(summary.uncovered).toBe(1);
    expect(summary.pending).toBe(1);
    // Nothing to admit — it is already ticked, it just is not saved.
    expect(summary.admittablePools).toEqual([]);
  });

  it('treats a non-finite value as zero rather than poisoning the totals', () => {
    const summary = summarizePositions(
      [position({ valueUsd: Number.NaN, unclaimedFeesUsd: Number.NaN })],
      [POOL_A],
    );
    expect(summary.valueUsd).toBe(0);
    expect(summary.unclaimedFeesUsd).toBe(0);
    expect(summary.open).toBe(1);
  });

  it('reports an empty list without producing NaN', () => {
    const summary = summarizePositions([], []);
    expect(summary).toMatchObject({ total: 0, open: 0, valueUsd: 0, uncovered: 0, managed: 0 });
  });
});

// --- Ordering ---------------------------------------------------------------

describe('sortPositions', () => {
  it('puts the coverage gaps first, ahead of larger managed positions', () => {
    const rows = sortPositions(
      [
        position({ tokenId: 'managed', poolAddress: POOL_A, valueUsd: 50_000 }),
        position({
          tokenId: 'gap',
          poolAddress: POOL_B,
          valueUsd: 40,
          isAllowlisted: false,
          managedByAutomation: false,
        }),
      ],
      [POOL_A],
    );
    expect(rows.map((r) => r.tokenId)).toEqual(['gap', 'managed']);
  });

  it('ranks the six coverage states from worst to moot', () => {
    expect(coverageRank('unmanaged')).toBeLessThan(coverageRank('allowlisted_not_managed'));
    expect(coverageRank('allowlisted_not_managed')).toBeLessThan(coverageRank('pending_allowlist'));
    expect(coverageRank('pending_allowlist')).toBeLessThan(coverageRank('managed'));
    expect(coverageRank('managed')).toBeLessThan(coverageRank('closed'));
  });

  it('surfaces out-of-range money first within a coverage band', () => {
    const rows = sortPositions(
      [
        position({ tokenId: 'inRange', poolAddress: POOL_A, valueUsd: 5_000 }),
        position({ tokenId: 'outRange', poolAddress: POOL_A, valueUsd: 100, status: 'out_of_range' }),
      ],
      [POOL_A],
    );
    expect(rows.map((r) => r.tokenId)).toEqual(['outRange', 'inRange']);
  });

  it('sorts by value and breaks ties on tokenId, without mutating the input', () => {
    const input = [
      position({ tokenId: 'b', valueUsd: 100 }),
      position({ tokenId: 'a', valueUsd: 100 }),
      position({ tokenId: 'c', valueUsd: 900 }),
    ];
    expect(sortPositions(input, [POOL_A]).map((r) => r.tokenId)).toEqual(['c', 'a', 'b']);
    expect(input[0].tokenId).toBe('b');
  });
});

describe('buildLineages', () => {
  it('returns one lineage per pool with the newest open position as head', () => {
    const lineages = buildLineages([
      position({ tokenId: '100', poolAddress: POOL_A, status: 'closed' }),
      position({ tokenId: '200', poolAddress: POOL_A, status: 'in_range' }),
      position({ tokenId: '50', poolAddress: POOL_A, status: 'closed' }),
    ]);
    expect(lineages).toHaveLength(1);
    expect(lineages[0]?.head.tokenId).toBe('200');
    expect(lineages[0]?.ancestors.map((p) => p.tokenId)).toEqual(['100', '50']);
    expect(lineages[0]?.hasOpen).toBe(true);
  });

  it('uses the newest closed position as head when fully exited', () => {
    const lineages = buildLineages([
      position({ tokenId: '10', poolAddress: POOL_A, status: 'closed' }),
      position({ tokenId: '20', poolAddress: POOL_A, status: 'closed' }),
    ]);
    expect(lineages[0]?.head.tokenId).toBe('20');
    expect(lineages[0]?.hasOpen).toBe(false);
    expect(lineages[0]?.ancestors.map((p) => p.tokenId)).toEqual(['10']);
  });

  it('keeps multiple pools as separate lineages', () => {
    const lineages = buildLineages([
      position({ tokenId: '1', poolAddress: POOL_A }),
      position({ tokenId: '2', poolAddress: POOL_B }),
    ]);
    expect(lineages).toHaveLength(2);
    expect(lineages.map((l) => l.poolAddress).sort()).toEqual([POOL_A, POOL_B].sort());
  });

  it('orders ancestors by explicit mint→burn links when provided', () => {
    const lineages = buildLineages(
      [
        position({ tokenId: '100', poolAddress: POOL_A, status: 'closed' }),
        position({ tokenId: '200', poolAddress: POOL_A, status: 'closed' }),
        position({ tokenId: '300', poolAddress: POOL_A, status: 'in_range' }),
      ],
      [
        {
          oldTokenId: '100',
          newTokenId: '200',
          poolAddress: POOL_A,
          withdrawnValueUsd: null,
          remintedValueUsd: null,
          timestamp: 1,
        },
        {
          oldTokenId: '200',
          newTokenId: '300',
          poolAddress: POOL_A,
          withdrawnValueUsd: null,
          remintedValueUsd: null,
          timestamp: 2,
        },
      ],
    );
    expect(lineages).toHaveLength(1);
    expect(lineages[0]?.head.tokenId).toBe('300');
    expect(lineages[0]?.ancestors.map((p) => p.tokenId)).toEqual(['200', '100']);
  });

  it('emits one lineage per concurrent open position in the same pool', () => {
    const lineages = buildLineages([
      position({ tokenId: '419551', poolAddress: POOL_A, status: 'in_range', valueUsd: 60 }),
      position({ tokenId: '420479', poolAddress: POOL_A, status: 'in_range', valueUsd: 19 }),
    ]);
    expect(lineages).toHaveLength(2);
    expect(lineages.map((l) => l.head.tokenId).sort()).toEqual(['419551', '420479']);
    expect(lineages.every((l) => l.ancestors.length === 0)).toBe(true);
  });

  it('does not treat a concurrent open as an ancestor of another open', () => {
    const lineages = buildLineages([
      position({ tokenId: '100', poolAddress: POOL_A, status: 'closed' }),
      position({ tokenId: '200', poolAddress: POOL_A, status: 'in_range' }),
      position({ tokenId: '300', poolAddress: POOL_A, status: 'in_range' }),
    ]);
    const byHead = new Map(lineages.map((l) => [l.head.tokenId, l]));
    expect(byHead.get('200')?.ancestors.map((p) => p.tokenId)).toEqual(['100']);
    expect(byHead.get('300')?.ancestors).toEqual([]);
  });

  it('buildLineageGrid splits live and closed-only farms', () => {
    const grid = buildLineageGrid(
      [
        position({ tokenId: '1', poolAddress: POOL_A, status: 'in_range' }),
        position({ tokenId: '2', poolAddress: POOL_B, status: 'closed' }),
      ],
      [POOL_A, POOL_B],
    );
    expect(grid.live).toHaveLength(1);
    expect(grid.live[0]?.lineage.head.poolAddress).toBe(POOL_A);
    expect(grid.closedOnly).toHaveLength(1);
    expect(grid.closedOnly[0]?.lineage.head.poolAddress).toBe(POOL_B);
  });

  it('buildLineageGrid shows two live rows for two in-range positions in one pool', () => {
    const grid = buildLineageGrid(
      [
        position({ tokenId: '419551', poolAddress: POOL_A, status: 'in_range', valueUsd: 60 }),
        position({ tokenId: '420479', poolAddress: POOL_A, status: 'in_range', valueUsd: 19 }),
      ],
      [POOL_A],
    );
    expect(grid.live).toHaveLength(2);
    expect(grid.live.map((row) => row.tile.position.tokenId).sort()).toEqual(['419551', '420479']);
    expect(grid.live.every((row) => row.ancestorCount === 0)).toBe(true);
  });
});

describe('resolveDisplayPnl', () => {
  it('returns audit net return when available', () => {
    const display = resolveDisplayPnl(
      {
        lineageKey: POOL_A,
        headTokenId: '1',
        memberTokenIds: ['1'],
        costBasisUsd: 50,
        costBasisKnown: true,
        costBasisSince: null,
        currentValueUsd: 59,
        unclaimedFeesUsd: 0.01,
        lifetimeFeesUsd: 0.5,
        gasPaidUsd: 2,
        netPnlUsd: 7.01,
        netPnlPercent: 14.02,
      },
      position({ valueUsd: 59, unclaimedFeesUsd: 0.01 }),
      true,
    );
    expect(display.source).toBe('audit');
    expect(display.valueUsd).toBeCloseTo(7.01);
  });

  it('combines value and fees when audit PnL is unavailable', () => {
    const display = resolveDisplayPnl(null, position({ valueUsd: 59.41, unclaimedFeesUsd: 0.01 }), false);
    expect(display.source).toBe('indicative');
    expect(display.label).toBe('Total equity');
    expect(display.valueUsd).toBeCloseTo(59.42);
  });
});

// --- Safe address / not-configured ------------------------------------------

describe('validateSafeAddress', () => {
  it('asks for the address when the field is blank rather than reporting an error shape', () => {
    expect(validateSafeAddress('')).toMatch(/Enter the Safe address/);
    expect(validateSafeAddress('   ')).toMatch(/Enter the Safe address/);
  });

  it('rejects anything that is not a 0x-prefixed 20-byte address', () => {
    expect(validateSafeAddress('0xnope')).toMatch(/0x-prefixed/);
    expect(validateSafeAddress(SAFE.slice(0, -1))).toMatch(/0x-prefixed/);
    expect(validateSafeAddress(`${SAFE}aa`)).toMatch(/0x-prefixed/);
    expect(validateSafeAddress(SAFE.replace('0x', ''))).toMatch(/0x-prefixed/);
  });

  it('accepts a well-formed address in either case, with surrounding whitespace', () => {
    expect(validateSafeAddress(SAFE)).toBeNull();
    expect(validateSafeAddress(upper(SAFE))).toBeNull();
    expect(validateSafeAddress(`  ${SAFE}  `)).toBeNull();
    expect(normalizeSafeAddress(`  ${SAFE}  `)).toBe(SAFE);
  });
});

describe('safeAddressDirty', () => {
  it('is clean when nothing is saved and nothing is typed', () => {
    expect(safeAddressDirty('', null)).toBe(false);
    expect(safeAddressDirty('   ', null)).toBe(false);
  });

  it('is dirty as soon as an address is typed against an unset field', () => {
    expect(safeAddressDirty(SAFE, null)).toBe(true);
  });

  it('ignores case and whitespace differences against the saved value', () => {
    expect(safeAddressDirty(upper(SAFE), SAFE)).toBe(false);
    expect(safeAddressDirty(` ${SAFE} `, SAFE)).toBe(false);
    expect(safeAddressDirty(POOL_A, SAFE)).toBe(true);
  });
});
