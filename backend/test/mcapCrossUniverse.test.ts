/**
 * The market-cap-crossing universe's source selection (#386).
 *
 * `parseDiscoverySources` decides WHICH GeckoTerminal rankings feed the
 * universe. The one behaviour that must never regress is the escape hatch:
 * `OCT_MCAP_CROSS_DISCOVERY_SOURCES=busiest` restores the exact pre-#386
 * single-ranking universe, so the broadening is switchable rather than a
 * cutover.
 */

import { describe, expect, it } from 'vitest';

import { parseDiscoverySources } from '../src/mcapCross/universe.js';

describe('parseDiscoverySources', () => {
  it('defaults to trending-then-busiest', () => {
    expect(parseDiscoverySources(undefined)).toEqual(['trending', 'busiest']);
    expect(parseDiscoverySources('')).toEqual(['trending', 'busiest']);
    expect(parseDiscoverySources('   ')).toEqual(['trending', 'busiest']);
  });

  it('preserves priority order as written', () => {
    expect(parseDiscoverySources('busiest,trending,new')).toEqual(['busiest', 'trending', 'new']);
    expect(parseDiscoverySources('new,trending')).toEqual(['new', 'trending']);
  });

  it('reverts to the exact single-ranking universe when set to busiest', () => {
    expect(parseDiscoverySources('busiest')).toEqual(['busiest']);
  });

  it('is case- and whitespace-insensitive and dedupes', () => {
    expect(parseDiscoverySources(' Trending , BUSIEST , trending ')).toEqual(['trending', 'busiest']);
  });

  it('drops unknown entries but keeps the valid ones', () => {
    expect(parseDiscoverySources('trending,garbage,busiest')).toEqual(['trending', 'busiest']);
  });

  it('falls back to the default when every entry is unusable', () => {
    expect(parseDiscoverySources('garbage,,nonsense')).toEqual(['trending', 'busiest']);
  });
});
