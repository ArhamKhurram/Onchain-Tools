import { describe, expect, it } from 'vitest';
import {
  isBlankTokenInfo,
  normalizeManipulation,
} from '../src/mcapCross/manipulation.js';

/**
 * GMGN's manufactured-launch flags (bundler / sniper / insider), read from the
 * `stat` sub-object of `/v1/token/info`.
 *
 * WHY THIS ENDPOINT AND NOT THE UI'S. GMGN's token panel is fed by an INTERNAL
 * API (`/defi/quotation/...`, `/api/v1/mutil_window_token_security_launchpad/...`)
 * that returns HTTP 403 + a Cloudflare challenge to a server-side `X-APIKEY`.
 * The OpenAPI `/v1/token/info` — which our key CAN reach — carries the same
 * numbers in `stat`. All fixtures below are recorded from the live API on
 * 2026-09-07, not invented.
 */

/** pump.fun launch "MPGA" — the bundled/sniped shape the operator calls a fake chart. */
const PUMP_STAT = {
  address: 'HcbKRVuLBB3mYHjHDjFueotZeGDCH2fcK9SS6Yrrpump',
  stat: {
    top_bundler_trader_percentage: '0.2273',
    top70_sniper_hold_rate: '0.1269740298',
    top_rat_trader_percentage: '0',
    top_entrapment_trader_percentage: '0.0048',
    top_bot_degen_percentage: '0.571',
  },
};

/** BONK — established, obviously organic. The clean baseline. */
const BONK_STAT = {
  address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  stat: {
    top_bundler_trader_percentage: '0.0017',
    top70_sniper_hold_rate: '0.0000003458',
    top_rat_trader_percentage: '0.0006',
    // Entrapment is 0.7256 for BONK — high for a legit token, which is exactly
    // why it is NOT used as the insider proxy. Present here to prove it is ignored.
    top_entrapment_trader_percentage: '0.7256',
    top_bot_degen_percentage: '0.0001',
  },
};

/** BNB CAKE — every stat field returns 0. GMGN has no launch analytics on BNB. */
const BSC_ZEROS = {
  address: '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82',
  stat: {
    top_bundler_trader_percentage: 0,
    top70_sniper_hold_rate: 0,
    top_rat_trader_percentage: 0,
    top_entrapment_trader_percentage: 0,
    top_bot_degen_percentage: 0,
  },
};

/** The success-with-blanks answer for an address GMGN has never indexed. */
const BLANK = { address: '', symbol: '' };

describe('normalizeManipulation', () => {
  it('reads the pump.fun launch as high bundler / sniper concentration', () => {
    const m = normalizeManipulation(PUMP_STAT);
    expect(m?.bundlerRate).toBeCloseTo(0.2273, 4);
    expect(m?.sniperRate).toBeCloseTo(0.127, 3);
    expect(m?.insiderRate).toBe(0);
  });

  it('reads BONK as near-zero on every axis — and IGNORES the high entrapment', () => {
    const m = normalizeManipulation(BONK_STAT);
    expect(m?.bundlerRate).toBeCloseTo(0.0017, 4);
    expect(m?.sniperRate).toBeGreaterThan(0);
    expect(m?.sniperRate).toBeLessThan(0.001);
    // insider = rat_trader (0.0006), NOT entrapment (0.7256). If the mapping
    // ever regresses to entrapment this assertion fails loudly.
    expect(m?.insiderRate).toBeCloseTo(0.0006, 4);
  });

  it('reads BNB zeros as a real, comparable zero — harmless on a MAX ceiling', () => {
    const m = normalizeManipulation(BSC_ZEROS);
    expect(m).toEqual({ bundlerRate: 0, sniperRate: 0, insiderRate: 0 });
  });

  it('treats a blank (unindexed) payload as no answer at all', () => {
    expect(isBlankTokenInfo(BLANK)).toBe(true);
    expect(normalizeManipulation(BLANK)).toBeNull();
    expect(normalizeManipulation(null)).toBeNull();
    expect(normalizeManipulation({})).toBeNull();
  });

  it('treats a present address with no stat block as all-unknown, not all-zero', () => {
    const m = normalizeManipulation({ address: 'So11111111111111111111111111111111111111112' });
    expect(m).toEqual({ bundlerRate: null, sniperRate: null, insiderRate: null });
  });

  it('rejects an out-of-range rate as UNKNOWN rather than clamping it', () => {
    // A "1.5" or "150" is not a fraction and we do not know what it is. Guessing
    // is how a garbage reading becomes a confident number.
    const m = normalizeManipulation({
      address: 'x',
      stat: { top_bundler_trader_percentage: '1.5', top70_sniper_hold_rate: '150', top_rat_trader_percentage: '-0.1' },
    });
    expect(m).toEqual({ bundlerRate: null, sniperRate: null, insiderRate: null });
  });

  it('reads an empty-string field as unknown, not zero', () => {
    const m = normalizeManipulation({ address: 'x', stat: { top_bundler_trader_percentage: '' } });
    expect(m?.bundlerRate).toBeNull();
  });
});
