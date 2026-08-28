/**
 * Candle-source routing and the Pinax scale calibration.
 *
 * The property worth defending here is not "does it pick Pinax" — it is that a source can only be
 * used when its units are KNOWN. Pinax OHLC is not USD-denominated, and the factor is not
 * derivable from token decimals (a Solana pool needed x10^6, a BSC pool x10^0, same day). So the
 * factor is measured per pool, and anything that does not land on a clean power of ten is refused
 * rather than guessed at. These tests pin the refusal, because the failure it prevents is silent:
 * gates evaluating against numbers orders of magnitude wrong read exactly like a quiet market.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parsePinaxNetworks, plannedSourceFor } from '../src/revival/candleSource.js';
import { pinaxSupports, snapToPowerOfTen } from '../src/revival/pinaxCandles.js';

const ENV_KEYS = ['PINAX_API_KEY', 'OCT_REVIVAL_PINAX_NETWORKS', 'TRENCHCORD_REVIVAL_PINAX_NETWORKS'];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('scale calibration', () => {
  it('accepts the two factors actually observed in the wild', () => {
    // Solana USDC(d6)/WSOL(d9): close 0.00010727 vs SOL at $107.34.
    expect(snapToPowerOfTen(107.34 / 0.00010727)).toBe(1e6);
    // BSC USDT(d18)/WBNB(d18): close 713.51 vs BNB at $712.84 — already USD.
    expect(snapToPowerOfTen(712.84 / 713.51)).toBe(1);
  });

  it('tolerates the drift between two price sources sampled seconds apart', () => {
    // A few percent of disagreement is normal and must not disqualify a real 10^6 mismatch.
    expect(snapToPowerOfTen(1.03e6)).toBe(1e6);
    expect(snapToPowerOfTen(0.97e6)).toBe(1e6);
  });

  it('REFUSES a ratio that is not a power of ten', () => {
    // 86.9x was a real intermediate result while deriving this; it is not a unit mismatch, it
    // means the two sources are pricing different things. Guessing here would rescale everything.
    expect(snapToPowerOfTen(86.9)).toBeNull();
    expect(snapToPowerOfTen(3.2)).toBeNull();
  });

  it('refuses degenerate ratios instead of returning a plausible-looking number', () => {
    expect(snapToPowerOfTen(0)).toBeNull();
    expect(snapToPowerOfTen(-1e6)).toBeNull();
    expect(snapToPowerOfTen(Number.NaN)).toBeNull();
    expect(snapToPowerOfTen(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('which chains Pinax can serve', () => {
  it('indexes solana and bsc but not robinhood', () => {
    // Verified against /v1/networks on 2026-08-27. Robinhood Chain is an Arbitrum Orbit L3 and is
    // absent from Pinax's list; if this ever flips, the routing default should be revisited.
    expect(pinaxSupports('solana')).toBe(true);
    expect(pinaxSupports('bsc')).toBe(true);
    expect(pinaxSupports('robinhood')).toBe(false);
  });

  it('drops an unsupported chain from the override rather than routing it to Pinax', () => {
    expect(parsePinaxNetworks('solana,robinhood')).toEqual(['solana']);
  });

  it('ignores unknown ids and de-duplicates', () => {
    expect(parsePinaxNetworks('solana,nonsense,solana,bsc')).toEqual(['solana', 'bsc']);
  });

  it('treats an empty override as "everything on GeckoTerminal"', () => {
    // The kill switch: it must mean OFF, not "fall back to the default set".
    expect(parsePinaxNetworks('')).toEqual([]);
    expect(parsePinaxNetworks('   ')).toEqual([]);
  });

  it('defaults to solana + bsc when unset', () => {
    expect(parsePinaxNetworks(undefined)).toEqual(['solana', 'bsc']);
  });
});

describe('routing', () => {
  it('sends everything to GeckoTerminal when no API key is configured', () => {
    // This is the SHIPPED state until the key reaches the deploy environment, so it has to be the
    // safe path rather than an error path.
    for (const network of ['solana', 'bsc', 'robinhood'] as const) {
      expect(plannedSourceFor(network)).toBe('geckoterminal');
    }
  });

  it('routes solana and bsc to Pinax once a key exists, and robinhood never', () => {
    process.env.PINAX_API_KEY = 'test-key';
    expect(plannedSourceFor('solana')).toBe('pinax');
    expect(plannedSourceFor('bsc')).toBe('pinax');
    expect(plannedSourceFor('robinhood')).toBe('geckoterminal');
  });

  it('honours the env kill switch even with a key present', () => {
    process.env.PINAX_API_KEY = 'test-key';
    process.env.OCT_REVIVAL_PINAX_NETWORKS = '';
    expect(plannedSourceFor('solana')).toBe('geckoterminal');
    expect(plannedSourceFor('bsc')).toBe('geckoterminal');
  });

  it('supports routing one chain without the other', () => {
    process.env.PINAX_API_KEY = 'test-key';
    process.env.OCT_REVIVAL_PINAX_NETWORKS = 'bsc';
    expect(plannedSourceFor('bsc')).toBe('pinax');
    expect(plannedSourceFor('solana')).toBe('geckoterminal');
  });

  it('accepts the TRENCHCORD_ fallback the rest of the codebase uses', () => {
    process.env.PINAX_API_KEY = 'test-key';
    process.env.TRENCHCORD_REVIVAL_PINAX_NETWORKS = 'solana';
    expect(plannedSourceFor('solana')).toBe('pinax');
    expect(plannedSourceFor('bsc')).toBe('geckoterminal');
  });
});
