import { describe, it, expect } from 'vitest';
import {
  ACTION_META,
  actionAvailability,
  describeFeeAccrual,
  didCommandExecute,
  feeAccrual,
  hasCommandInFlight,
  inFlightActionFor,
  isCommandInFlight,
  isCommandSettled,
  isSkipReport,
  withNothingQueued,
  latestCommandFor,
  mergeCommands,
  parseCommand,
  parseCommands,
  presentCommand,
  shortTxHash,
  type LpCommand,
  type LpCommandAction,
  type LpCommandStatus,
} from '../src/components/lp/commands';
import {
  buildPositionGrid,
  findTile,
  isPoolInDraft,
  positionKey,
  removeFromAllowlist,
  addToAllowlist,
  type LpPositionView,
  type PositionCoverage,
} from '../src/components/lp/positions';

const POOL_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const POOL_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TOKEN_0 = '0x1111111111111111111111111111111111111111';
const TOKEN_1 = '0x2222222222222222222222222222222222222222';

const position = (over: Partial<LpPositionView> = {}): LpPositionView => ({
  tokenId: '1001',
  poolAddress: POOL_A,
  platform: 'uniswapv3',
  feeTierBps: 3000,
  token0: { symbol: 'WETH', address: TOKEN_0, decimals: 18 },
  token1: { symbol: 'USDC', address: TOKEN_1, decimals: 6 },
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

const command = (over: Partial<LpCommand> = {}): LpCommand => ({
  id: 'cmd-1',
  tokenId: '1001',
  action: 'compound',
  status: 'pending',
  requestedAt: '2026-07-26T10:00:00.000Z',
  completedAt: null,
  txHash: null,
  error: null,
  ...over,
});

// --- Grid derivation --------------------------------------------------------

describe('buildPositionGrid', () => {
  it('gives every tile a key that survives a reorder', () => {
    const a = position({ tokenId: '1', poolAddress: POOL_A });
    const b = position({ tokenId: '2', poolAddress: POOL_B, isAllowlisted: false, managedByAutomation: false });
    const first = buildPositionGrid([a, b], [POOL_A]);
    const second = buildPositionGrid([b, a], [POOL_A]);
    expect(first.map((t) => t.key).sort()).toEqual(second.map((t) => t.key).sort());
  });

  it('keys on pool AND tokenId, so the same NFT id in two pools is two tiles', () => {
    // tokenId alone is the id from one position manager. Two platforms on one
    // chain can both mint #1, and a collision would open the wrong detail view.
    const a = position({ tokenId: '1', poolAddress: POOL_A });
    const b = position({ tokenId: '1', poolAddress: POOL_B });
    expect(positionKey(a)).not.toBe(positionKey(b));
    expect(new Set(buildPositionGrid([a, b], []).map((t) => t.key)).size).toBe(2);
  });

  it('normalizes case in the key so a checksummed address matches a lowercase one', () => {
    expect(positionKey(position({ poolAddress: POOL_A.toUpperCase().replace('0X', '0x') }))).toBe(
      positionKey(position()),
    );
  });

  it('puts the uncovered position first, whatever it is worth', () => {
    const managed = position({ tokenId: 'big', valueUsd: 400_000 });
    const uncovered = position({
      tokenId: 'small',
      poolAddress: POOL_B,
      valueUsd: 40,
      isAllowlisted: false,
      managedByAutomation: false,
    });
    const tiles = buildPositionGrid([managed, uncovered], [POOL_A]);
    expect(tiles[0]?.position.tokenId).toBe('small');
    expect(tiles[0]?.coverage).toBe('unmanaged');
  });

  it('resolves range geometry once per tile', () => {
    const [tile] = buildPositionGrid([position()], [POOL_A]);
    expect(tile?.geometry.placement).toBe('inside');
    expect(tile?.geometry.fraction).toBeCloseTo(0.5, 5);
  });

  it('reports unknown coverage without touching the market status', () => {
    const tiles = buildPositionGrid([position({ status: 'out_of_range', currentPrice: 3_000 })], [], true);
    expect(tiles[0]?.coverage).toBe('unknown');
    expect(tiles[0]?.status.tone).toBe('idle');
  });
});

describe('findTile', () => {
  it('returns null for a key that no longer exists, so the drawer closes itself', () => {
    const tiles = buildPositionGrid([position()], [POOL_A]);
    expect(findTile(tiles, 'gone')).toBeNull();
    expect(findTile(tiles, null)).toBeNull();
    expect(findTile(tiles, tiles[0]!.key)?.position.tokenId).toBe('1001');
  });
});

// --- Coverage and status are independent channels ---------------------------
//
// They fail in opposite directions: an out-of-range MANAGED position gets
// rebalanced, and an in-range UNMANAGED one looks perfectly healthy while
// nothing tends it. If either were derived from the other, exactly one of those
// would be misread — so the grid must prove they move independently.

describe('coverage and status stay independently derived', () => {
  it('holds coverage constant across every market status', () => {
    const statuses = ['in_range', 'out_of_range'] as const;
    for (const status of statuses) {
      const tiles = buildPositionGrid([position({ status })], [POOL_A]);
      expect(tiles[0]?.coverage).toBe('managed');
    }
  });

  it('holds market status constant across every coverage state', () => {
    const cases: Array<[Partial<LpPositionView>, string[], boolean, PositionCoverage]> = [
      [{ isAllowlisted: true, managedByAutomation: true }, [POOL_A], false, 'managed'],
      [{ isAllowlisted: true, managedByAutomation: false }, [POOL_A], false, 'allowlisted_not_managed'],
      [{ isAllowlisted: false, managedByAutomation: false }, [POOL_A], false, 'pending_allowlist'],
      [{ isAllowlisted: true, managedByAutomation: true }, [], false, 'pending_removal'],
      [{ isAllowlisted: false, managedByAutomation: false }, [], false, 'unmanaged'],
      [{ isAllowlisted: true, managedByAutomation: true }, [POOL_A], true, 'unknown'],
    ];

    for (const [over, allowlist, readFailed, expected] of cases) {
      const tiles = buildPositionGrid(
        [position({ ...over, status: 'out_of_range', currentPrice: 3_000 })],
        allowlist,
        readFailed,
      );
      expect(tiles[0]?.coverage).toBe(expected);
      // The market fact does not budge for any of them.
      expect(tiles[0]?.status.label).toBe('Out of range');
      expect(tiles[0]?.status.tone).toBe('idle');
      expect(tiles[0]?.geometry.placement).toBe('above');
    }
  });
});

// --- The coverage switch writes to the one draft ----------------------------

describe('coverage switch', () => {
  it('adds and removes against the same draft array', () => {
    const added = addToAllowlist([], POOL_A);
    expect(isPoolInDraft(added, POOL_A)).toBe(true);
    const removed = removeFromAllowlist(added, POOL_A);
    expect(isPoolInDraft(removed, POOL_A)).toBe(false);
  });

  it('removes case-insensitively and leaves other pools alone', () => {
    const list = [POOL_A, POOL_B];
    const removed = removeFromAllowlist(list, POOL_A.toUpperCase().replace('0X', '0x'));
    expect(removed).toEqual([POOL_B]);
  });

  it('does not mutate the draft it was given', () => {
    const list = [POOL_A, POOL_B];
    removeFromAllowlist(list, POOL_A);
    expect(list).toEqual([POOL_A, POOL_B]);
  });

  it('is a no-op for a blank address rather than clearing the list', () => {
    expect(removeFromAllowlist([POOL_A], '   ')).toEqual([POOL_A]);
  });
});

// --- Command parsing --------------------------------------------------------

describe('parseCommand', () => {
  it('drops a row whose action cannot be named', () => {
    // A command we cannot describe is one we cannot honestly render, and a
    // mislabelled `exit` is the worst possible rendering.
    expect(parseCommand({ id: 'x', tokenId: '1', action: 'liquidate', status: 'pending' })).toBeNull();
    expect(parseCommand({ id: 'x', tokenId: '1', status: 'pending' })).toBeNull();
    expect(parseCommand(null)).toBeNull();
    expect(parseCommand('compound')).toBeNull();
  });

  it('drops a row with no id — there would be nothing to de-duplicate on', () => {
    expect(parseCommand({ tokenId: '1', action: 'compound', status: 'done' })).toBeNull();
  });

  it('accepts a numeric tokenId, since JSON ids arrive both ways', () => {
    expect(parseCommand({ id: 'a', tokenId: 1001, action: 'exit', status: 'done' })?.tokenId).toBe('1001');
  });

  it('maps an unrecognised status to unknown rather than guessing', () => {
    const parsed = parseCommand({ id: 'a', tokenId: '1', action: 'compound', status: 'reticulating' });
    expect(parsed?.status).toBe('unknown');
  });

  it('sorts newest first and accepts both the bare array and the envelope', () => {
    const older = command({ id: 'old', requestedAt: '2026-07-26T09:00:00.000Z' });
    const newer = command({ id: 'new', requestedAt: '2026-07-26T11:00:00.000Z' });
    expect(parseCommands([older, newer]).map((c) => c.id)).toEqual(['new', 'old']);
    expect(parseCommands({ commands: [older, newer] }).map((c) => c.id)).toEqual(['new', 'old']);
    expect(parseCommands(null)).toEqual([]);
  });
});

describe('mergeCommands', () => {
  it('lets a poll result replace the optimistic row it corresponds to', () => {
    const queued = command({ id: 'cmd-1', status: 'pending' });
    const settled = command({ id: 'cmd-1', status: 'done', txHash: '0xabc' });
    const merged = mergeCommands([queued], [settled]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.status).toBe('done');
  });
});

// --- Lifecycle: queued is not done ------------------------------------------

describe('command lifecycle', () => {
  it('treats only pending and claimed as unfinished', () => {
    expect(isCommandInFlight('pending')).toBe(true);
    expect(isCommandInFlight('claimed')).toBe(true);
    for (const status of ['done', 'failed', 'skipped', 'unknown'] as LpCommandStatus[]) {
      expect(isCommandInFlight(status)).toBe(false);
      expect(isCommandSettled(status)).toBe(true);
    }
  });

  it('stops polling on an unrecognised status instead of looping forever', () => {
    expect(hasCommandInFlight([command({ status: 'unknown' })])).toBe(false);
    expect(hasCommandInFlight([command({ status: 'claimed' })])).toBe(true);
  });

  it('counts only done as actually executed', () => {
    expect(didCommandExecute(command({ status: 'done' }))).toBe(true);
    for (const status of ['pending', 'claimed', 'failed', 'skipped', 'unknown'] as LpCommandStatus[]) {
      expect(didCommandExecute(command({ status }))).toBe(false);
    }
  });

  it('finds the newest command and the in-flight action for a position', () => {
    const list = parseCommands([
      command({ id: 'a', requestedAt: '2026-07-26T09:00:00.000Z', status: 'done' }),
      command({ id: 'b', requestedAt: '2026-07-26T11:00:00.000Z', action: 'rebalance', status: 'claimed' }),
      command({ id: 'c', tokenId: '2002', status: 'pending' }),
    ]);
    expect(latestCommandFor(list, '1001')?.id).toBe('b');
    expect(inFlightActionFor(list, '1001')).toBe('rebalance');
    expect(inFlightActionFor(list, '9999')).toBeNull();
  });

  it('reports no in-flight action once everything for that position settled', () => {
    const list = [command({ status: 'done' }), command({ id: 'z', status: 'failed' })];
    expect(inFlightActionFor(list, '1001')).toBeNull();
  });
});

// --- Presentation: a queued command must never read as an executed one -------

describe('presentCommand', () => {
  it('never states an outcome while the command is queued or running', () => {
    for (const status of ['pending', 'claimed'] as LpCommandStatus[]) {
      const shown = presentCommand(command({ status }));
      expect(shown.inFlight).toBe(true);
      // The headline names the action AND the state, never the action alone.
      expect(shown.headline).not.toBe('Compound');
      expect(shown.headline.toLowerCase()).not.toContain('compounded');
      expect(shown.label).not.toBe('Done');
    }
  });

  it('says plainly that nothing has been sent while queued', () => {
    const shown = presentCommand(command({ status: 'pending' }));
    expect(shown.tone).toBe('queued');
    expect(shown.label).toBe('Queued');
    expect(shown.detail).toContain('nothing has been sent on-chain');
  });

  it('distinguishes running from queued', () => {
    const shown = presentCommand(command({ status: 'claimed' }));
    expect(shown.tone).toBe('running');
    expect(shown.label).toBe('Running');
    expect(shown.detail).toContain('not confirmed yet');
  });

  it('surfaces the tx hash on success and flags a success with none', () => {
    const withHash = presentCommand(command({ status: 'done', txHash: '0xdeadbeef' }));
    expect(withHash.tone).toBe('done');
    expect(withHash.txHash).toBe('0xdeadbeef');

    const without = presentCommand(command({ status: 'done' }));
    expect(without.detail).toContain('no transaction hash');
  });

  it('surfaces the reason on failure, and admits when there is none', () => {
    expect(presentCommand(command({ status: 'failed', error: 'gas estimation reverted' })).detail).toBe(
      'gas estimation reverted',
    );
    expect(presentCommand(command({ status: 'failed' })).detail).toContain('gave no reason');
  });

  it('reads a disarmed run back out of the failed status the worker stores', () => {
    // `commandSource.ts` records anything with an error as `failed`, and a
    // disarmed signer carries "skipped: …". Nothing was broadcast, so rendering
    // it in flame would send the operator hunting a transaction that does not
    // exist.
    const shown = presentCommand(
      command({ status: 'failed', error: 'skipped: the signer is disarmed (LP_ARMED is not set)' }),
    );
    expect(shown.tone).toBe('skipped');
    expect(shown.label).toBe('Skipped');
    expect(shown.detail).toContain('the signer is disarmed');
    expect(shown.detail).toContain('Nothing was broadcast');
  });

  it('leaves an ordinary failure alone, and falls back to failed if the wording changes', () => {
    expect(presentCommand(command({ status: 'failed', error: 'dry run reverted' })).tone).toBe('failed');
    expect(presentCommand(command({ status: 'failed', error: 'the run was skipped' })).tone).toBe('failed');
    expect(isSkipReport(null)).toBe(false);
    expect(isSkipReport('  Skipped: disarmed')).toBe(true);
  });

  it('reports a skipped command as not executed, not as done', () => {
    // A queued action reaching a disarmed automation did nothing. Rounding that
    // to "done" would be the worst possible summary of it.
    const shown = presentCommand(command({ status: 'skipped' }));
    expect(shown.tone).toBe('skipped');
    expect(shown.inFlight).toBe(false);
    expect(shown.detail).toContain('disarmed');
    expect(shown.detail).toContain('Nothing changed on-chain');
  });

  it('treats an unrecognised state as unresolved rather than as success', () => {
    const shown = presentCommand(command({ status: 'unknown' }));
    expect(shown.tone).toBe('unknown');
    expect(shown.detail).toContain('unresolved');
  });

  it('names the right action in every headline', () => {
    for (const action of ['compound', 'rebalance', 'compound_rebalance', 'exit'] as LpCommandAction[]) {
      expect(presentCommand(command({ action, status: 'pending' })).headline).toBe(
        `${ACTION_META[action].label} queued`,
      );
    }
  });
});

describe('withNothingQueued', () => {
  it('adds the reassurance when the server did not give it', () => {
    expect(withNothingQueued('Rate limited.')).toBe('Rate limited. Nothing was queued.');
  });

  it('does not repeat it when the server already said so', () => {
    // The route's own 409 and 503 bodies end this way. Saying it twice reads
    // like a bug in the page, while refusing a money action.
    expect(withNothingQueued('The worker would refuse this action, so it was not queued.')).toBe(
      'The worker would refuse this action, so it was not queued.',
    );
    expect(withNothingQueued('Could not read the policy. Nothing was queued.')).toBe(
      'Could not read the policy. Nothing was queued.',
    );
  });
});

describe('shortTxHash', () => {
  it('keeps enough of a 32-byte hash to check against an explorer', () => {
    const hash = `0x${'a'.repeat(60)}bcdef123`;
    expect(shortTxHash(hash)).toBe('0xaaaaaaaa…bcdef123');
    expect(shortTxHash(null)).toBeNull();
    expect(shortTxHash('0xabc')).toBe('0xabc');
  });
});

// --- Availability: disabled with the reason, never enabled-then-409 ---------

describe('actionAvailability', () => {
  const forAll = (
    coverage: PositionCoverage,
    over: Partial<Parameters<typeof actionAvailability>[0]> = {},
  ) =>
    (['compound', 'rebalance', 'compound_rebalance', 'exit'] as LpCommandAction[]).map((action) =>
      actionAvailability({ action, coverage, inFlight: null, ...over }),
    );

  it('disables every action on a pool that is not allowlisted, with the reason', () => {
    for (const availability of forAll('unmanaged')) {
      expect(availability.enabled).toBe(false);
      expect(availability.reason).toBeTruthy();
      expect(availability.reason).toContain('allowlist');
    }
  });

  it('disables a pool that is ticked but not saved', () => {
    // The worker reads the SAVED policy. Enabling here would produce a 409
    // reading "pool is not allowlisted" against a tick visible on screen.
    for (const availability of forAll('pending_allowlist')) {
      expect(availability.enabled).toBe(false);
      expect(availability.reason).toContain('save');
    }
  });

  it('allows an unsaved REMOVAL, because the pool is still allowlisted today', () => {
    for (const availability of forAll('pending_removal')) {
      expect(availability.enabled).toBe(true);
      expect(availability.reason).toBeNull();
    }
  });

  it('allows an allowlisted pool the automation is not acting on', () => {
    // The 409 condition is the POOL not being allowlisted. It is.
    for (const availability of forAll('allowlisted_not_managed')) {
      expect(availability.enabled).toBe(true);
    }
  });

  it('allows every action on a managed position', () => {
    for (const availability of forAll('managed')) {
      expect(availability.enabled).toBe(true);
      expect(availability.reason).toBeNull();
    }
  });

  it('disables on unknown coverage rather than firing a request that may 409', () => {
    for (const availability of forAll('unknown')) {
      expect(availability.enabled).toBe(false);
      expect(availability.reason).toContain('unknown');
    }
  });

  it('disables everything on a closed position', () => {
    for (const availability of forAll('closed')) {
      expect(availability.enabled).toBe(false);
      expect(availability.reason).toContain('closed');
    }
  });

  it('disables while a command is already in flight for the position', () => {
    const same = actionAvailability({ action: 'compound', coverage: 'managed', inFlight: 'compound' });
    expect(same.enabled).toBe(false);
    expect(same.reason).toContain('already queued');

    const other = actionAvailability({ action: 'exit', coverage: 'managed', inFlight: 'compound' });
    expect(other.enabled).toBe(false);
    expect(other.reason).toContain('compound');
    expect(other.reason).toContain('one action');
  });

  it('reports the closed position ahead of a missing API', () => {
    const availability = actionAvailability({
      action: 'exit',
      coverage: 'closed',
      inFlight: null,
      apiUnavailable: true,
    });
    expect(availability.reason).toContain('closed');
  });

  it('disables everything when the backend has no actions route', () => {
    for (const availability of forAll('managed', { apiUnavailable: true })) {
      expect(availability.enabled).toBe(false);
      expect(availability.reason).toContain('manual-actions API');
    }
  });

  it('reports the coverage gap ahead of the in-flight guard', () => {
    // You cannot have queued anything on a pool that was never allowlisted, so
    // the allowlist is the reason worth showing.
    const availability = actionAvailability({
      action: 'compound',
      coverage: 'unmanaged',
      inFlight: 'compound',
    });
    expect(availability.reason).toContain('allowlist');
  });

  it('marks exit, and only exit, as destructive', () => {
    expect(ACTION_META.exit.destructive).toBe(true);
    expect(ACTION_META.compound.destructive).toBe(false);
    expect(ACTION_META.rebalance.destructive).toBe(false);
    expect(ACTION_META.compound_rebalance.destructive).toBe(false);
  });

  it('describes compound_rebalance as a two-step queue entry', () => {
    expect(ACTION_META.compound_rebalance.label).toBe('Compound + rebalance');
    expect(ACTION_META.compound_rebalance.description).toContain('Two on-chain steps');
  });
});

// --- Fee accrual: a ratio, deliberately not a rate --------------------------

describe('feeAccrual', () => {
  it('reports fees as a share of position value', () => {
    const accrual = feeAccrual({ valueUsd: 1_000, unclaimedFeesUsd: 25 });
    expect(accrual.percentOfValue).toBeCloseTo(2.5, 6);
  });

  it('refuses to divide by a zero or missing value', () => {
    expect(feeAccrual({ valueUsd: 0, unclaimedFeesUsd: 25 }).percentOfValue).toBeNull();
    expect(feeAccrual({ valueUsd: undefined, unclaimedFeesUsd: 25 }).percentOfValue).toBeNull();
    expect(feeAccrual({ valueUsd: Number.NaN, unclaimedFeesUsd: 25 }).percentOfValue).toBeNull();
  });

  it('says nothing is compounding when the position is uncovered', () => {
    const accrual = feeAccrual({ valueUsd: 1_000, unclaimedFeesUsd: 25 });
    expect(describeFeeAccrual(accrual, 'unmanaged')).toContain('Nothing is compounding');
    expect(describeFeeAccrual(accrual, 'managed')).toContain('compounds');
  });

  it('admits when the quote carried no fee figure at all', () => {
    const accrual = feeAccrual({ valueUsd: 1_000, unclaimedFeesUsd: null });
    expect(accrual.feesUsd).toBeNull();
    expect(describeFeeAccrual(accrual, 'managed')).toContain('no fee figure');
  });
});
