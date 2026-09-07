// The referral quick-buy keyboard on the 750K market-cap-crossing card.
//
// Two things these tests must not do: hardcode a referral code, or assume a
// chain. The owner's codes live in one place — REFERRALS in @oct/shared — and
// every URL assertion is made against THAT imported constant, so a code change
// there flows through without a test edit and a code TYPO here cannot pass.
//
// Chain correctness is the other hard requirement: Axiom and Padre are
// Solana-only, so a BNB or Robinhood token must never be handed an Axiom
// `?chain=sol` link. Each chain is exercised explicitly.

import { describe, expect, it } from 'vitest';
import { REFERRALS } from '@oct/shared';
import {
  mcapCrossQuickBuyKeyboard,
  renderMcapCrossCard,
  type McapCrossView,
} from '../src/tgbot/render.js';
import type { TgInlineKeyboardButton } from '../src/tgbot/types.js';

// A base58 Solana mint (no leading 0x) and a canonical 0x EVM address.
const SOL_ADDR = 'So11111111111111111111111111111111111111112';
const EVM_ADDR = '0x1234567890123456789012345678901234567890';

function buttons(view: { address: string; network: string }): TgInlineKeyboardButton[] {
  const keyboard = mcapCrossQuickBuyKeyboard(view);
  expect(keyboard).toBeDefined();
  // Two-per-row layout, never more than two rows for four venues.
  expect(keyboard!.inline_keyboard.length).toBeLessThanOrEqual(2);
  return keyboard!.inline_keyboard.flat();
}

function byLabel(row: TgInlineKeyboardButton[], label: string): TgInlineKeyboardButton | undefined {
  return row.find((b) => b.text === label);
}

describe('mcapCrossQuickBuyKeyboard — chain-correct venue set', () => {
  it('a Solana token gets GMGN, Axiom, Padre and Bloom', () => {
    const bs = buttons({ address: SOL_ADDR, network: 'solana' });
    expect(bs.map((b) => b.text)).toEqual(['GMGN', 'Axiom', 'Padre', 'Bloom']);
  });

  it('a BNB (bsc) token gets only the venues that support EVM — GMGN and Bloom', () => {
    const bs = buttons({ address: EVM_ADDR, network: 'bsc' });
    expect(bs.map((b) => b.text)).toEqual(['GMGN', 'Bloom']);
    // Solana-only venues are omitted, not silently pointed at the wrong chain.
    expect(byLabel(bs, 'Axiom')).toBeUndefined();
    expect(byLabel(bs, 'Padre')).toBeUndefined();
  });

  it('a Robinhood token gets only GMGN and Bloom', () => {
    const bs = buttons({ address: EVM_ADDR, network: 'robinhood' });
    expect(bs.map((b) => b.text)).toEqual(['GMGN', 'Bloom']);
  });

  it('emits real URL buttons — a url, never a callback', () => {
    for (const b of buttons({ address: SOL_ADDR, network: 'solana' })) {
      expect(b.url).toMatch(/^https?:\/\//);
      expect(b.callback_data).toBeUndefined();
    }
  });
});

describe('mcapCrossQuickBuyKeyboard — every URL carries the owner referral', () => {
  it('embeds the owner code from REFERRALS on each Solana venue', () => {
    const bs = buttons({ address: SOL_ADDR, network: 'solana' });
    // GMGN: gmgn.ai/sol/token/<ref>_<addr>
    expect(byLabel(bs, 'GMGN')!.url).toContain(`${REFERRALS.gmgn}_`);
    // Axiom: axiom.trade/t/<addr>/@<ref>?chain=sol
    expect(byLabel(bs, 'Axiom')!.url).toContain(`@${REFERRALS.axiom}`);
    // Padre: trade.padre.gg/...?rk=<ref>
    expect(byLabel(bs, 'Padre')!.url).toContain(`rk=${REFERRALS.padre}`);
    // Bloom: t.me/BloomSolana_bot?start=ref_<ref>_ca_<addr>
    expect(byLabel(bs, 'Bloom')!.url).toContain(`ref_${REFERRALS.bloom}_`);
    // And the address itself is present in each.
    for (const b of bs) expect(b.url).toContain(SOL_ADDR);
  });

  it('embeds the owner code on each EVM venue', () => {
    const bs = buttons({ address: EVM_ADDR, network: 'bsc' });
    expect(byLabel(bs, 'GMGN')!.url).toContain(`${REFERRALS.gmgn}_`);
    expect(byLabel(bs, 'Bloom')!.url).toContain(`ref_${REFERRALS.bloom}_`);
    for (const b of bs) expect(b.url).toContain(EVM_ADDR);
  });
});

describe('mcapCrossQuickBuyKeyboard — chain routing of the URL', () => {
  it('GMGN opens the token on ITS chain, not the Base default', () => {
    const bsc = byLabel(buttons({ address: EVM_ADDR, network: 'bsc' }), 'GMGN')!.url;
    expect(bsc).toContain('/bsc/');
    expect(bsc).not.toContain('/base/');

    const hood = byLabel(buttons({ address: EVM_ADDR, network: 'robinhood' }), 'GMGN')!.url;
    expect(hood).toContain('/robinhood/');
    expect(hood).not.toContain('/base/');

    const sol = byLabel(buttons({ address: SOL_ADDR, network: 'solana' }), 'GMGN')!.url;
    expect(sol).toContain('gmgn.ai/sol/');
  });

  it('never emits an Axiom ?chain=sol link for an EVM token', () => {
    for (const network of ['bsc', 'robinhood']) {
      const bs = buttons({ address: EVM_ADDR, network });
      expect(bs.some((b) => b.url.includes('axiom.trade'))).toBe(false);
      expect(bs.some((b) => b.url.includes('chain=sol'))).toBe(false);
    }
  });
});

describe('renderMcapCrossCard — safety and layout', () => {
  const base: McapCrossView = {
    address: SOL_ADDR,
    network: 'solana',
    symbol: 'PEPE',
    mcapUsd: 800_000,
    targetUsd: 750_000,
    liquidityUsd: 90_000,
    liquidityRatio: 0.11,
  };

  it('keeps the address as tap-to-copy code and moves links to the keyboard', () => {
    const card = renderMcapCrossCard(base);
    expect(card).toContain(`<code>${SOL_ADDR}</code>`);
    // The chart/buy links are a reply_markup keyboard now, not an inline <a>.
    expect(card).not.toContain('<a href');
  });

  it('escapes an address before rendering it — an address is untrusted input', () => {
    // A real mint cannot contain markup, but the render path must still escape:
    // nothing in this file is allowed to interpolate an address raw.
    const hostile = '<script>alert(1)</script>';
    const card = renderMcapCrossCard({ ...base, address: hostile });
    expect(card).toContain('&lt;script&gt;');
    expect(card).not.toContain('<script>');
  });
});
