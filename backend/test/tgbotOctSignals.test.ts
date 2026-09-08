// "OCT Alerts": forwarded algorithm-scan signals, end to end.
//
// The hard requirements this suite pins:
//   • recognise a message ONLY from a configured source channel (by id, per
//     chain), never a non-configured one, and never by title;
//   • the card is MINIMAL — ticker, market cap, chain, contract address, and the
//     referral buttons, nothing else (no ATH/USD/LIQ/VOL/socials/promo/vendor
//     link), built from EXTRACTED fields rather than the forwarded body;
//   • ticker + market cap parse defensively from untrusted text, and each is
//     OMITTED (never faked as NaN/wrong) when it cannot be found;
//   • one call = one alert: two near-simultaneous posts of the same contract
//     collapse (dedupe on chain + primary address, TTL-bounded, first-wins);
//   • the buttons are GMGN + Axiom, chain-correct, with the owner referral from
//     the SHARED REFERRALS constant (never a hardcoded code);
//   • delivery is default-on, uncapped, respects an existing mute, but CANNOT
//     trip the circuit breaker and mute a chat's other subscriptions;
//   • the vendor word appears NOWHERE in the new code or rendered output.

import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { REFERRALS } from '@oct/shared';
import {
  buildOctSignalView,
  octSignalDedupeKey,
  parseEvmChainFromLinks,
  parseSignalMarketCap,
  parseSignalTicker,
  resolveOctSignalChain,
  stripUpstreamSignature,
  hasSignalSources,
  type OctSignalView,
} from '../src/tgbot/octSignals';
import { octSignalQuickBuyKeyboard, renderOctSignalCard } from '../src/tgbot/render';
import { ALERT_CATALOG, DEFAULT_CHAT_SETTINGS, readSettings } from '../src/tgbot/alertPolicy';
import type { TgChatRecord } from '../src/tgbot/chatStore';
import type { TgChatSettings } from '../src/tgbot/alertPolicy';
import type { TgInlineKeyboardMarkup } from '../src/tgbot/types';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A base58 Solana mint and a canonical 0x EVM address.
const SOL_ADDR = 'So11111111111111111111111111111111111111112';
const EVM_ADDR = '0x1234567890123456789012345678901234567890';
// The Robinhood-chain 0x address shape Axiom's verified route uses.
const RH_ADDR = '0xab35d04e1ee39c789c4a65d522417b3c7f2e4723';

// The two source channels, by id, per chain — never by title.
const SOL_CHANNEL = '-1001111111111';
const EVM_CHANNEL = '-1002222222222';

// A view builder for the render/keyboard/delivery tests. Mirrors what
// buildOctSignalView produces, with the extracted fields defaulted.
function view(overrides: Partial<OctSignalView> = {}): OctSignalView {
  return {
    chain: 'sol',
    network: 'solana',
    addresses: [SOL_ADDR],
    text: 'scan',
    ticker: null,
    mcapDisplay: null,
    ...overrides,
  };
}

function configureSources(): void {
  vi.stubEnv('OCT_SIGNAL_SOURCE_CHANNEL_IDS_SOL', SOL_CHANNEL);
  vi.stubEnv('OCT_SIGNAL_SOURCE_CHANNEL_IDS_EVM', EVM_CHANNEL);
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------

describe('source recognition — by id, per chain, never by title', () => {
  it('resolves a configured SOL / EVM channel and nothing else', () => {
    configureSources();
    expect(resolveOctSignalChain(SOL_CHANNEL)).toBe('sol');
    expect(resolveOctSignalChain(EVM_CHANNEL)).toBe('evm');
    expect(resolveOctSignalChain('-1009999999999')).toBeNull();
  });

  it('matches the FULL id, not a shared prefix', () => {
    configureSources();
    // Shares the '-100111111111' prefix with SOL_CHANNEL but is a different
    // channel — the two source channels sharing a prefix is exactly the case
    // title-matching and prefix-matching both get wrong.
    expect(resolveOctSignalChain('-1001111111119')).toBeNull();
  });

  it('tolerates the bare vs -100 id form for a topic-less source, still exact', () => {
    configureSources();
    // A bare-group source matches a bare-group (topic-less) message whichever
    // -100/bare form each side uses...
    expect(resolveOctSignalChain('1111111111')).toBe('sol');
    // ...but a topic-less source does NOT match a message from a topic inside
    // that group — the topic makes it a different channel.
    expect(resolveOctSignalChain(`${SOL_CHANNEL}:42`)).toBeNull();
  });

  it('is inert when nothing is configured', () => {
    expect(hasSignalSources()).toBe(false);
    expect(resolveOctSignalChain(SOL_CHANNEL)).toBeNull();
    expect(buildOctSignalView({ chatId: SOL_CHANNEL, text: `buy ${SOL_ADDR}` })).toBeNull();
  });
});

describe('forum-topic sources — two topics of ONE supergroup, matched by topic', () => {
  // The real deployment shape: SOL and EVM are two forum TOPICS of the same
  // supergroup, so the peer id is identical and only the topic tells them apart.
  const SUPERGROUP = '-1003705845819';
  const SOL_TOPIC = `${SUPERGROUP}:3`;
  const EVM_TOPIC = `${SUPERGROUP}:4`;

  function configureTopicSources(): void {
    vi.stubEnv('OCT_SIGNAL_SOURCE_CHANNEL_IDS_SOL', SOL_TOPIC);
    vi.stubEnv('OCT_SIGNAL_SOURCE_CHANNEL_IDS_EVM', EVM_TOPIC);
  }

  it('topic 3 → sol, topic 4 → evm (the two feeds stay distinct)', () => {
    configureTopicSources();
    expect(resolveOctSignalChain(SOL_TOPIC)).toBe('sol');
    expect(resolveOctSignalChain(EVM_TOPIC)).toBe('evm');
  });

  it('any OTHER topic in the same supergroup → null (not force-forwarded)', () => {
    configureTopicSources();
    expect(resolveOctSignalChain(`${SUPERGROUP}:1`)).toBeNull();
    expect(resolveOctSignalChain(`${SUPERGROUP}:7`)).toBeNull();
  });

  it('the bare group (no topic) → null', () => {
    configureTopicSources();
    expect(resolveOctSignalChain(SUPERGROUP)).toBeNull();
  });

  it('does not mislabel EVM as SOL — the pre-fix collision is gone', () => {
    configureTopicSources();
    // Before the fix both topics canonicalised to the bare supergroup id, so
    // the SOL and EVM sets were identical and every EVM message resolved 'sol'.
    expect(resolveOctSignalChain(EVM_TOPIC)).not.toBe('sol');
    const evm = buildOctSignalView({ chatId: EVM_TOPIC, text: `scan ${EVM_ADDR}`, evmChainHint: 'bsc' });
    expect(evm!.chain).toBe('evm');
    const sol = buildOctSignalView({ chatId: SOL_TOPIC, text: `scan ${SOL_ADDR}` });
    expect(sol!.chain).toBe('sol');
  });

  it('tolerates the -100 / bare peer form while keeping the topic exact', () => {
    configureTopicSources();
    // Bare peer form of the SAME topic still matches (peer prefix is normalised).
    expect(resolveOctSignalChain('3705845819:3')).toBe('sol');
    // A different supergroup on the same topic number does not.
    expect(resolveOctSignalChain('-1009999999999:3')).toBeNull();
  });

  it('normalises a zero-padded topic so :03 equals :3', () => {
    configureTopicSources();
    expect(resolveOctSignalChain(`${SUPERGROUP}:03`)).toBe('sol');
  });
});

// ---------------------------------------------------------------------------
// Field extraction — the minimal card is built from THESE, not the body.

describe('ticker + market cap parsing (untrusted input, defensive)', () => {
  // The real upstream shape the operator wants reduced to $TICKER / MC / CA.
  const MARLIN = [
    '🔍 **[JT MARLIN](https://t.me/tokenscan?start=scan-0xab35...)** ($MARLIN)',
    '📊 **Token Stats**',
    '├ MC:  **$735.02K**',
    '├ ATH: **$863.6K** (-14.89% / 3m)',
    '└ VOL: **$719.4K** (24h)',
    RH_ADDR,
  ].join('\n');

  it('parses the ticker from the $SYMBOL', () => {
    expect(parseSignalTicker(MARLIN)).toBe('MARLIN');
  });

  it('parses the market cap from the MC line — not the ATH or VOL figure', () => {
    expect(parseSignalMarketCap(MARLIN)).toBe('$735.02K');
  });

  it('uses a SINGLE-WORD formatted header name when there is no $SYMBOL', () => {
    expect(parseSignalTicker('🔍 **MARLIN**\nMC: $10K')).toBe('MARLIN');
  });

  it('rejects a MULTI-WORD header name rather than making it a ticker', () => {
    // The link label "JT MARLIN" is two words — prose, not a symbol. With no
    // $SYMBOL and no ($SYM) parenthetical, the ticker is dropped (neutral header).
    expect(parseSignalTicker('🔍 **[JT MARLIN](https://t.me/x)**\nMC: $10K')).toBeNull();
  });

  it('takes the ($SYMBOL) parenthetical over the prose link label', () => {
    // The real header shape: the true ticker is the parenthetical, never the
    // multi-word `[JT MARLIN]` link label.
    expect(parseSignalTicker(MARLIN)).toBe('MARLIN');
  });

  it('parses the ticker from an image-card caption (name before the • bullet)', () => {
    expect(parseSignalTicker('MARLIN • 5.2x')).toBe('MARLIN');
  });

  it('rejects the confirmed prose false-positives (no spaced/sentence ticker)', () => {
    // The exact live failures: header/scan-title prose grabbed as a ticker.
    for (const bad of [
      '🔍 **Getting the lord of the memes ready**\nMC: $10K',
      '🔍 **SOL bullish algorithm just triggered**',
      '$SOL bullish algorithm signal',
      '$GETTING the lord ready now',
    ]) {
      const t = parseSignalTicker(bad);
      // Never a multi-word / sentence ticker.
      if (t !== null) expect(t).not.toMatch(/\s/);
      expect(t).not.toBe('GETTING THE LOR');
      expect(t).not.toBe('SOL BULLISH ALG');
    }
    // The two header-prose cases carry no clean symbol at all → neutral header.
    expect(parseSignalTicker('🔍 **Getting the lord of the memes ready**\nMC: $10K')).toBeNull();
    expect(parseSignalTicker('🔍 **SOL bullish algorithm just triggered**')).toBeNull();
  });

  it('does not turn a line of prose into a ticker', () => {
    expect(parseSignalTicker('market is heating up, watch this one closely today')).toBeNull();
  });

  it('returns null for a ticker when nothing usable is present', () => {
    expect(parseSignalTicker('🔥🔥🔥')).toBeNull();
    expect(parseSignalTicker('https://t.me/x')).toBeNull();
  });

  it('accepts labelled MC / MCAP / Market Cap with $ and K/M/B suffixes', () => {
    expect(parseSignalMarketCap('MC: $17.5K')).toBe('$17.5K');
    expect(parseSignalMarketCap('MCAP $1.2M')).toBe('$1.2M');
    expect(parseSignalMarketCap('Market Cap: 750K')).toBe('$750K');
    expect(parseSignalMarketCap('mc = $2B')).toBe('$2B');
  });

  it('parses the market cap from the "@ <mcap>" image-card caption form', () => {
    // The second upstream message per call is an image card; its caption carries
    // the mcap as "@ 142.32K", never a labelled MC line.
    expect(parseSignalMarketCap('somescan_bot @ 142.32K (6h)')).toBe('$142.32K');
    expect(parseSignalMarketCap('MARLIN @ 142.32K [5.2x]')).toBe('$142.32K');
    expect(parseSignalMarketCap('SOME @ 1.2M')).toBe('$1.2M');
  });

  it('the "@" form REQUIRES a magnitude suffix — a bare @handle/number is not MC', () => {
    expect(parseSignalMarketCap('@somescan_bot posted a call')).toBeNull();
    expect(parseSignalMarketCap('called @ 5 min ago')).toBeNull();
  });

  it('returns null (never NaN) when there is no market cap to parse', () => {
    expect(parseSignalMarketCap('no numbers here')).toBeNull();
    expect(parseSignalMarketCap('ATH: $863.6K')).toBeNull(); // ATH is not MC
    expect(parseSignalMarketCap('MC: soon')).toBeNull(); // labelled but no number
  });

  it('EITHER upstream message alone yields ticker + mcap (dedupe keeps whichever is first)', () => {
    configureSources();
    // Message A — the detailed card: parenthetical ticker + labelled MC.
    const a = buildOctSignalView({ chatId: EVM_CHANNEL, text: MARLIN, evmChainHint: 'robinhood' });
    expect(a!.ticker).toBe('MARLIN');
    expect(a!.mcapDisplay).toBe('$735.02K');
    // Message B — the image caption: name-before-bullet ticker + "@ <mcap>".
    const captionB = ['MARLIN • 5.2x', `somescan_bot @ 142.32K (6h)`, RH_ADDR].join('\n');
    const b = buildOctSignalView({ chatId: EVM_CHANNEL, text: captionB, evmChainHint: 'robinhood' });
    expect(b!.ticker).toBe('MARLIN');
    expect(b!.mcapDisplay).toBe('$142.32K');
  });

  it('buildOctSignalView carries ticker + mcap + chain for the MARLIN shape', () => {
    configureSources();
    const built = buildOctSignalView({ chatId: EVM_CHANNEL, text: MARLIN, evmChainHint: 'robinhood' });
    expect(built!.ticker).toBe('MARLIN');
    expect(built!.mcapDisplay).toBe('$735.02K');
    expect(built!.network).toBe('robinhood');
    expect(built!.addresses).toContain(RH_ADDR);
  });
});

describe('buildOctSignalView', () => {
  it('shapes a SOL-source message: chain sol, network solana, CA extracted', () => {
    configureSources();
    const built = buildOctSignalView({ chatId: SOL_CHANNEL, text: `fresh scan ${SOL_ADDR} sending` });
    expect(built).not.toBeNull();
    expect(built!.chain).toBe('sol');
    expect(built!.network).toBe('solana');
    expect(built!.addresses).toContain(SOL_ADDR);
  });

  it('shapes an EVM-source message: chain evm, evm network from the hint', () => {
    configureSources();
    const built = buildOctSignalView({ chatId: EVM_CHANNEL, text: `scan ${EVM_ADDR}`, evmChainHint: 'bsc' });
    expect(built!.chain).toBe('evm');
    expect(built!.network).toBe('bsc');
    expect(built!.addresses).toContain(EVM_ADDR);
  });

  it('a non-configured channel yields nothing', () => {
    configureSources();
    expect(buildOctSignalView({ chatId: '-1008888888888', text: `buy ${SOL_ADDR}` })).toBeNull();
  });

  it('DROPS a message with no contract address — the CA is the alert', () => {
    // The source topics carry non-scan chatter and status lines with no CA;
    // forwarding those rendered empty "OCT Alerts · <chain>" cards. A scan
    // without a contract address is not actionable, so it is not forwarded.
    configureSources();
    expect(
      buildOctSignalView({ chatId: SOL_CHANNEL, text: 'market is heating up, watch closely' }),
    ).toBeNull();
    expect(buildOctSignalView({ chatId: SOL_CHANNEL, text: 'Scanning…' })).toBeNull();
  });

  it('drops a truly empty message', () => {
    configureSources();
    expect(buildOctSignalView({ chatId: SOL_CHANNEL, text: '   ' })).toBeNull();
  });
});

describe('EVM chain resolution — real chain, never a bare "evm"', () => {
  it('reads the chain from a dexscreener link path segment', () => {
    expect(parseEvmChainFromLinks(`chart: https://dexscreener.com/robinhood/0xpair`)).toBe('robinhood');
    expect(parseEvmChainFromLinks(`https://dexscreener.com/base/0xpair`)).toBe('base');
    expect(parseEvmChainFromLinks(`https://dexscreener.com/bsc/0xpair`)).toBe('bsc');
    expect(parseEvmChainFromLinks('no chart link here')).toBeNull();
  });

  it('a dexscreener robinhood link → network robinhood, Robinhood label, Axiom button', () => {
    configureSources();
    const built = buildOctSignalView({
      chatId: EVM_CHANNEL,
      text: `scan ${RH_ADDR}\nhttps://dexscreener.com/robinhood/0xsomepair`,
    });
    expect(built!.network).toBe('robinhood');
    const card = renderOctSignalCard(built!);
    expect(card).toContain('Chain:');
    expect(card).toContain('Robinhood');
    const kb = octSignalQuickBuyKeyboard({ address: RH_ADDR, network: built!.network });
    expect(kb!.inline_keyboard.flat().map((b) => b.text).sort()).toEqual(['Axiom', 'GMGN']);
  });

  it('a base/bsc link → that chain, and Axiom is OMITTED (no verified route)', () => {
    configureSources();
    const base = buildOctSignalView({
      chatId: EVM_CHANNEL,
      text: `scan ${EVM_ADDR}\nhttps://dexscreener.com/base/0xpair`,
    });
    expect(base!.network).toBe('base');
    expect(renderOctSignalCard(base!)).toContain('Base');
    expect(octSignalQuickBuyKeyboard({ address: EVM_ADDR, network: 'base' })!.inline_keyboard.flat().map((b) => b.text)).toEqual(['GMGN']);

    const bsc = buildOctSignalView({
      chatId: EVM_CHANNEL,
      text: `scan ${EVM_ADDR}\nhttps://dexscreener.com/bsc/0xpair`,
    });
    expect(bsc!.network).toBe('bsc');
    expect(octSignalQuickBuyKeyboard({ address: EVM_ADDR, network: 'bsc' })!.inline_keyboard.flat().map((b) => b.text)).not.toContain('Axiom');
  });

  it('falls back to robinhood (NOT bare evm) when no link and no hint', () => {
    configureSources();
    const built = buildOctSignalView({ chatId: EVM_CHANNEL, text: `scan ${EVM_ADDR}` });
    expect(built!.chain).toBe('evm');
    expect(built!.network).toBe('robinhood');
    expect(built!.network).not.toBe('evm');
    expect(renderOctSignalCard(built!)).toContain('Robinhood');
  });

  it('the fallback network is operator-configurable via env', () => {
    configureSources();
    vi.stubEnv('OCT_SIGNAL_EVM_FALLBACK_NETWORK', 'base');
    const built = buildOctSignalView({ chatId: EVM_CHANNEL, text: `scan ${EVM_ADDR}` });
    expect(built!.network).toBe('base');
  });

  it('a body link overrides the caller hint', () => {
    configureSources();
    const built = buildOctSignalView({
      chatId: EVM_CHANNEL,
      text: `scan ${EVM_ADDR}\nhttps://dexscreener.com/robinhood/0xpair`,
      evmChainHint: 'bsc',
    });
    expect(built!.network).toBe('robinhood');
  });
});

describe('signature stripping — the vendor string lives only in operator env', () => {
  it('removes an operator-configured strip term but keeps the scan body', () => {
    const text = `Signal: strong buy\nEntry good\nPOWERED BY ACMESCAN\n@acmescan_alerts`;
    const stripped = stripUpstreamSignature(text, ['ACMESCAN']);
    expect(stripped).toContain('Signal: strong buy');
    expect(stripped).toContain('Entry good');
    expect(stripped).not.toContain('ACMESCAN');
    expect(stripped).not.toContain('@acmescan_alerts');
  });

  it('strips a bare handle / link footer with no configured term', () => {
    const stripped = stripUpstreamSignature('great entry here\nhttps://t.me/somepromo', []);
    expect(stripped).toBe('great entry here');
  });

  it('applies the env strip term through buildOctSignalView, keeping the CA', () => {
    configureSources();
    vi.stubEnv('OCT_SIGNAL_STRIP_TERMS', 'ACMESCAN');
    const built = buildOctSignalView({
      chatId: SOL_CHANNEL,
      text: `scan hit ${SOL_ADDR}\n— powered by ACMESCAN`,
    });
    expect(built!.text).not.toContain('ACMESCAN');
    // The CA is extracted independently, so stripping text never loses it.
    expect(built!.addresses).toContain(SOL_ADDR);
  });
});

// ---------------------------------------------------------------------------
// The minimal card.

describe('the minimal card — ONLY ticker / MCap / chain / CA', () => {
  const MARLIN_VIEW = view({
    chain: 'evm',
    network: 'robinhood',
    addresses: [RH_ADDR],
    text: 'the whole scan body with ATH $863.6K, VOL $719.4K, socials and t.me/tokenscan promo',
    ticker: 'MARLIN',
    mcapDisplay: '$735.02K',
  });

  it('renders $TICKER, the MCap, the chain, and the tap-to-copy CA', () => {
    const card = renderOctSignalCard(MARLIN_VIEW);
    expect(card).toContain('$MARLIN');
    expect(card).toContain('MCap:');
    expect(card).toContain('$735.02K');
    expect(card).toContain('Chain:');
    expect(card).toContain('Robinhood'); // spelled out on the forwarded card
    expect(card).toContain(`<code>${RH_ADDR}</code>`);
  });

  it('drops EVERYTHING else — no ATH/VOL/socials/vendor-link/promo/token-stats', () => {
    const card = renderOctSignalCard(MARLIN_VIEW);
    for (const forbidden of ['ATH', 'VOL', '863.6', '719.4', 'tokenscan', 'Token Stats', 'socials', 'Chart']) {
      expect(card, `card must not contain "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it('SOL signals read "Chain: Solana"', () => {
    const card = renderOctSignalCard(view({ chain: 'sol', network: 'solana', ticker: 'FOO', mcapDisplay: '$1M' }));
    expect(card).toContain('Chain:');
    expect(card).toContain('Solana');
    expect(card).toContain('$FOO');
  });

  it('OMITS the MCap line when the market cap is unknown (never NaN)', () => {
    const card = renderOctSignalCard(view({ ticker: 'FOO', mcapDisplay: null }));
    expect(card).not.toContain('MCap:');
    expect(card).not.toContain('NaN');
  });

  it('uses a neutral header when there is no ticker (no dangling $)', () => {
    const card = renderOctSignalCard(view({ ticker: null }));
    expect(card).toContain('OCT Alerts');
    expect(card).not.toMatch(/💠 \$\b/);
  });

  it('renders without a CA line when the signal carried no address', () => {
    const card = renderOctSignalCard(view({ addresses: [], ticker: 'FOO' }));
    expect(card).not.toContain('<code>');
    expect(card).toContain('$FOO');
  });

  it('escapes untrusted ticker text — an unescaped < is a 400 and a dropped signal', () => {
    const card = renderOctSignalCard(view({ ticker: '<SCRIPT' }));
    expect(card).toContain('&lt;SCRIPT');
    expect(card).not.toContain('<SCRIPT');
  });
});

// ---------------------------------------------------------------------------
// The referral buttons — GMGN + Axiom, chain-correct, referral from REFERRALS.

describe('quick-buy buttons — GMGN + Axiom, chain-correct, no literal code', () => {
  function texts(kb: TgInlineKeyboardMarkup | undefined): string[] {
    return (kb?.inline_keyboard.flat() ?? []).map((b) => b.text);
  }
  function urlFor(kb: TgInlineKeyboardMarkup | undefined, label: string): string | undefined {
    return kb?.inline_keyboard.flat().find((b) => b.text === label)?.url;
  }

  it('Solana → GMGN + Axiom (Bloom and Padre dropped), referral embedded', () => {
    const kb = octSignalQuickBuyKeyboard({ address: SOL_ADDR, network: 'solana' });
    expect(texts(kb).sort()).toEqual(['Axiom', 'GMGN']);
    expect(urlFor(kb, 'GMGN')).toContain(`${REFERRALS.gmgn}_`);
    expect(urlFor(kb, 'Axiom')).toContain(`@${REFERRALS.axiom}`);
    expect(urlFor(kb, 'Axiom')).toContain('chain=sol');
    // No Bloom, no Padre.
    expect(texts(kb)).not.toContain('Bloom');
    expect(texts(kb)).not.toContain('Padre');
  });

  it('EVM Robinhood → GMGN + Axiom, the Axiom URL is the verified robinhood route', () => {
    const kb = octSignalQuickBuyKeyboard({ address: RH_ADDR, network: 'robinhood' });
    expect(texts(kb).sort()).toEqual(['Axiom', 'GMGN']);
    const axiom = urlFor(kb, 'Axiom')!;
    expect(axiom).toContain('axiom.trade/t/');
    expect(axiom).toContain(`@${REFERRALS.axiom}`);
    expect(axiom).toContain('chain=robinhood');
    expect(axiom).toContain(RH_ADDR);
    expect(axiom).not.toContain('chain=sol');
  });

  it('EVM non-Robinhood (e.g. BSC) → GMGN only, NO wrong-chain Axiom link', () => {
    const kb = octSignalQuickBuyKeyboard({ address: EVM_ADDR, network: 'bsc' });
    expect(texts(kb)).toEqual(['GMGN']);
    expect(urlFor(kb, 'GMGN')).toContain(`${REFERRALS.gmgn}_`);
    expect(texts(kb)).not.toContain('Axiom');
  });

  it('no referral code is hardcoded — every code comes from REFERRALS', () => {
    const src = readFileSync(join(__dirname, '../src/tgbot/render.ts'), 'utf-8');
    for (const code of Object.values(REFERRALS)) {
      expect(src, `render.ts must not hardcode the referral code "${code}"`).not.toContain(code);
    }
  });
});

// ---------------------------------------------------------------------------
// Dedupe — one call = one alert.

describe('octSignalDedupeKey', () => {
  it('keys on chain + address so the SAME address on sol vs evm stays distinct', () => {
    expect(octSignalDedupeKey('sol', SOL_ADDR)).not.toBe(octSignalDedupeKey('evm', SOL_ADDR));
  });

  it('folds EVM address casing (same mint, different casings, one key)', () => {
    const upper = '0xABCDEF1234567890123456789012345678901234';
    const lower = '0xabcdef1234567890123456789012345678901234';
    expect(octSignalDedupeKey('evm', upper)).toBe(octSignalDedupeKey('evm', lower));
  });
});

// --- delivery, with the roster mocked (mirrors tgbotDelivery.test.ts) --------

const roster = vi.hoisted(() => new Map<number, TgChatRecord>());

vi.mock('../src/tgbot/chatStore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tgbot/chatStore')>();
  return {
    ...actual,
    getChatStore: () => ({
      listEnabled: async (): Promise<TgChatRecord[]> => [...roster.values()].filter((r) => r.enabled),
      updateSettings: async (chatId: number, settings: TgChatSettings): Promise<boolean> => {
        const record = roster.get(chatId);
        if (!record) return false;
        roster.set(chatId, { ...record, settings });
        return true;
      },
    }),
  };
});

const { TgAlertRouter } = await import('../src/tgbot/alerts');

const CHAT = -1001234567890;

interface Sent {
  chatId: number;
  text: string;
  replyMarkup?: TgInlineKeyboardMarkup;
}

function fakeSender() {
  const sent: Sent[] = [];
  return {
    sent,
    send: async (chatId: number, text: string, opts?: { replyMarkup?: TgInlineKeyboardMarkup }): Promise<boolean> => {
      sent.push({ chatId, text, replyMarkup: opts?.replyMarkup });
      return true;
    },
  };
}

function seed(settings: TgChatSettings): void {
  roster.set(CHAT, {
    chatId: CHAT,
    chatType: 'supergroup',
    title: 'A group',
    addedByTgUserId: 1,
    enabled: true,
    sourceUserId: null,
    settings,
    plan: 'free',
    entitlements: {},
    createdAt: '2026-09-07T00:00:00.000Z',
  });
}

const solView = (addr = SOL_ADDR) => view({ addresses: [addr], ticker: 'TICK', mcapDisplay: '$1M' });
const runner = (symbol: string) => ({
  type: 'missed_runner',
  reason: `Missed runner: ${symbol}`,
  message: { content: '', hasContractAddress: false, contractAddresses: [] } as never,
});

beforeEach(() => {
  roster.clear();
  vi.unstubAllEnvs();
});

describe('delivery', () => {
  it('a fresh chat receives OCT Alerts by default, with CA and referral buttons', async () => {
    // DEFAULT_CHAT_SETTINGS is exactly what a chat that only ran /start has.
    seed({ ...DEFAULT_CHAT_SETTINGS, alerts: { ...DEFAULT_CHAT_SETTINGS.alerts } });
    const sender = fakeSender();
    const router = new TgAlertRouter(() => sender as never);

    await router.handleOctSignal(solView(), 1000);

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.text).toContain('$TICK');
    expect(sender.sent[0]!.text).toContain(`<code>${SOL_ADDR}</code>`);
    // Referral quick-buy buttons, code from the shared REFERRALS constant.
    const buttons = sender.sent[0]!.replyMarkup!.inline_keyboard.flat();
    expect(buttons.map((b) => b.text).sort()).toEqual(['Axiom', 'GMGN']);
    expect(buttons.find((b) => b.text === 'GMGN')!.url).toContain(`${REFERRALS.gmgn}_`);
    expect(buttons.find((b) => b.text === 'Axiom')!.url).toContain(`@${REFERRALS.axiom}`);
  });

  it('an existing chat keeps its other settings and gains OCT Alerts on (no regression)', () => {
    // A row written before octSignals existed: keyword on, contract off, no
    // octSignals key. readSettings must preserve those and default octSignals on.
    const stored = readSettings({ alerts: { keyword: 'digest', contract: 'off' } });
    expect(stored.alerts.keyword).toBe('digest');
    expect(stored.alerts.contract).toBe('off');
    expect(stored.alerts.octSignals).toBe('instant');
  });

  it('a chat that turned OCT Alerts off receives nothing', async () => {
    seed({ ...DEFAULT_CHAT_SETTINGS, alerts: { ...DEFAULT_CHAT_SETTINGS.alerts, octSignals: 'off' } });
    const sender = fakeSender();
    const router = new TgAlertRouter(() => sender as never);

    await router.handleOctSignal(solView(), 1000);
    expect(sender.sent).toHaveLength(0);
  });

  it('is UNCAPPED — a burst is fully delivered, bypassing the hourly ceiling', async () => {
    // Operator decision: OCT Alerts are the point of the bot for its users, so
    // this class is exempt from the per-chat hourly ceiling that bounds the
    // incident classes. Distinct addresses so the dedupe never collapses them.
    vi.stubEnv('TG_BOT_MAX_MESSAGES_PER_HOUR', '2');
    seed({ ...DEFAULT_CHAT_SETTINGS, alerts: { ...DEFAULT_CHAT_SETTINGS.alerts } });
    const sender = fakeSender();
    const router = new TgAlertRouter(() => sender as never);

    for (let i = 0; i < 6; i += 1) {
      await router.handleOctSignal(
        solView(`So1111111111111111111111111111111111111${String(i).padStart(3, '1')}`),
        1000 + i,
      );
    }
    expect(sender.sent).toHaveLength(6);
  });

  it('still honours an explicit mute even while uncapped', async () => {
    // "No cap" is not "cannot opt out": a chat that muted still gets nothing.
    seed({ ...DEFAULT_CHAT_SETTINGS, alerts: { ...DEFAULT_CHAT_SETTINGS.alerts }, mutedUntil: 10_000 });
    const sender = fakeSender();
    const router = new TgAlertRouter(() => sender as never);

    await router.handleOctSignal(solView(), 1000);
    expect(sender.sent).toHaveLength(0);
  });

  it('respects an existing mute — a muted chat gets no OCT Alerts', async () => {
    seed({
      ...DEFAULT_CHAT_SETTINGS,
      alerts: { ...DEFAULT_CHAT_SETTINGS.alerts },
      mutedUntil: 9_000_000,
      mutedReason: 'flooded',
    });
    const sender = fakeSender();
    const router = new TgAlertRouter(() => sender as never);

    await router.handleOctSignal(solView(), 1000);
    expect(sender.sent).toHaveLength(0);
  });

  it('does NOT trip the circuit breaker — a burst never mutes the chat or its other classes', async () => {
    vi.stubEnv('TG_BOT_BREAKER_MAX_EVENTS', '3');
    vi.stubEnv('TG_BOT_MAX_MESSAGES_PER_HOUR', '1000');
    // OCT Alerts on (default) AND missed runners on instant.
    seed({
      ...DEFAULT_CHAT_SETTINGS,
      alerts: { ...DEFAULT_CHAT_SETTINGS.alerts, missedRunner: 'instant' },
    });
    const sender = fakeSender();
    const router = new TgAlertRouter(() => sender as never);

    // A burst well past the breaker threshold (distinct addresses → not deduped).
    for (let i = 0; i < 20; i += 1) {
      await router.handleOctSignal(
        solView(`So111111111111111111111111111111111111${String(i).padStart(4, '1')}`),
        1000 + i,
      );
    }

    // The chat is NOT muted — the breaker never counted the signals.
    expect(roster.get(CHAT)!.settings.mutedUntil).toBe(0);

    // And a missed-runner instant still lands: OCT Alerts did not kill it.
    const before = sender.sent.length;
    await router.handle(runner('TOK'), undefined, 1100);
    expect(sender.sent.length).toBe(before + 1);
    expect(sender.sent.at(-1)!.text).toContain('TOK');
  });
});

describe('dedupe — one call = one alert (chain + primary address, TTL-bounded)', () => {
  it('collapses the same contract posted twice within the TTL to ONE alert', async () => {
    seed({ ...DEFAULT_CHAT_SETTINGS, alerts: { ...DEFAULT_CHAT_SETTINGS.alerts } });
    const sender = fakeSender();
    const router = new TgAlertRouter(() => sender as never);

    // The text card and the image card of the same call, seconds apart.
    await router.handleOctSignal(solView(), 1_000);
    await router.handleOctSignal(solView(), 3_000);
    expect(sender.sent).toHaveLength(1);
  });

  it('re-alerts the same contract after the TTL has elapsed', async () => {
    vi.stubEnv('OCT_SIGNAL_DEDUPE_TTL_MS', '600000');
    seed({ ...DEFAULT_CHAT_SETTINGS, alerts: { ...DEFAULT_CHAT_SETTINGS.alerts } });
    const sender = fakeSender();
    const router = new TgAlertRouter(() => sender as never);

    await router.handleOctSignal(solView(), 1_000);
    await router.handleOctSignal(solView(), 1_000 + 600_001);
    expect(sender.sent).toHaveLength(2);
  });

  it('the SAME address on sol vs evm both alert (distinct tokens)', async () => {
    // Use one bare 0x string reachable as an EVM address and a distinct SOL mint;
    // the key includes the chain, so even a shared string would not collide.
    seed({ ...DEFAULT_CHAT_SETTINGS, alerts: { ...DEFAULT_CHAT_SETTINGS.alerts } });
    const sender = fakeSender();
    const router = new TgAlertRouter(() => sender as never);

    await router.handleOctSignal(view({ chain: 'sol', network: 'solana', addresses: [SOL_ADDR] }), 1_000);
    await router.handleOctSignal(view({ chain: 'evm', network: 'bsc', addresses: [EVM_ADDR] }), 1_000);
    expect(sender.sent).toHaveLength(2);
  });

  it('a no-address signal is NEVER address-deduped — every one forwards', async () => {
    seed({ ...DEFAULT_CHAT_SETTINGS, alerts: { ...DEFAULT_CHAT_SETTINGS.alerts } });
    const sender = fakeSender();
    const router = new TgAlertRouter(() => sender as never);

    const noAddr = view({ addresses: [], text: 'watch the tape', ticker: null });
    await router.handleOctSignal(noAddr, 1_000);
    await router.handleOctSignal(noAddr, 1_001);
    expect(sender.sent).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------

describe('the vendor word appears NOWHERE in the new code or output', () => {
  const VENDOR = /cipher/i;

  it('is absent from the new source modules', () => {
    for (const rel of ['octSignals.ts', 'render.ts', 'alertPolicy.ts', 'alerts.ts']) {
      const src = readFileSync(join(__dirname, '../src/tgbot', rel), 'utf-8');
      expect(VENDOR.test(src), `${rel} must not name the vendor`).toBe(false);
    }
  });

  it('is absent from a fully rendered card', () => {
    const card = renderOctSignalCard(view({ chain: 'evm', network: 'bsc', addresses: [EVM_ADDR], ticker: null, mcapDisplay: '$2M' }));
    expect(VENDOR.test(card)).toBe(false);
    expect(card).toContain('OCT Alerts'); // neutral fallback branding path
  });
});
