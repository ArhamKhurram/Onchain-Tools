// The Flap new-stock card and its quick-buy keyboard. The card must name the
// RWA ticker, the chain, and the first token's CA (tap-to-copy); the keyboard
// must carry chain-correct referral links whose code comes from REFERRALS —
// never hardcoded, never a wrong-chain link.

import { describe, it, expect } from 'vitest';
import { REFERRALS } from '@oct/shared';
import {
  renderFlapStockCard,
  flapStockQuickBuyKeyboard,
  flapStockDigestLine,
  type FlapStockView,
} from '../src/tgbot/render';

const TOKEN = '0x1234567890abcdef1234567890abcdef12345678';

describe('renderFlapStockCard', () => {
  it('shows the RWA ticker, the chain (BNB) and the CA as tap-to-copy code', () => {
    const view: FlapStockView = { symbols: ['FXIon'], network: 'bsc', firstTokenAddress: TOKEN };
    const card = renderFlapStockCard(view);
    expect(card).toContain('🆕 New Flap stock: $FXION');
    expect(card).toContain('BNB');
    expect(card).toContain(`<code>${TOKEN}</code>`);
  });

  it('spells Robinhood on the chain line', () => {
    const card = renderFlapStockCard({ symbols: ['TSLAB'], network: 'robinhood', firstTokenAddress: TOKEN });
    expect(card).toContain('Robinhood');
    expect(card).toContain('$TSLAB');
  });

  it('joins multiple basket symbols with a slash', () => {
    const card = renderFlapStockCard({ symbols: ['FXIon', 'NVDAB'], network: 'bsc', firstTokenAddress: TOKEN });
    expect(card).toContain('$FXION / $NVDAB');
  });

  it('escapes a hostile on-chain symbol rather than emitting raw markup', () => {
    const card = renderFlapStockCard({ symbols: ['<b>x'], network: 'bsc', firstTokenAddress: TOKEN });
    expect(card).not.toContain('<b>x');
    expect(card).toContain('&lt;');
  });

  it('digest line keeps the ticker and chain', () => {
    const line = flapStockDigestLine({ symbols: ['FXIon'], network: 'bsc', firstTokenAddress: TOKEN });
    expect(line).toContain('Flap stock listings');
    expect(line).toContain('$FXION');
    expect(line).toContain('BNB');
  });
});

describe('flapStockQuickBuyKeyboard', () => {
  it('on BNB: GMGN only, with the owner referral from REFERRALS, on the bsc chain', () => {
    const kb = flapStockQuickBuyKeyboard({ address: TOKEN, network: 'bsc' })!;
    const buttons = kb.inline_keyboard.flat();
    expect(buttons.map((b) => b.text)).toEqual(['GMGN']);
    const gmgn = buttons[0]!;
    expect(gmgn.url).toContain('gmgn.ai/bsc/token/');
    expect(gmgn.url).toContain(`${REFERRALS.gmgn}_${TOKEN}`);
    // Axiom has no verified BNB route → no wrong-chain button.
    expect(buttons.some((b) => b.text === 'Axiom')).toBe(false);
  });

  it('on Robinhood: GMGN + Axiom, both chain-correct and referral-bearing', () => {
    const kb = flapStockQuickBuyKeyboard({ address: TOKEN, network: 'robinhood' })!;
    const buttons = kb.inline_keyboard.flat();
    const byText = Object.fromEntries(buttons.map((b) => [b.text, b.url]));
    expect(byText.GMGN).toContain('gmgn.ai/robinhood/token/');
    expect(byText.GMGN).toContain(`${REFERRALS.gmgn}_${TOKEN}`);
    expect(byText.Axiom).toContain('axiom.trade/t/');
    expect(byText.Axiom).toContain('chain=robinhood');
    expect(byText.Axiom).toContain(REFERRALS.axiom);
  });
});
