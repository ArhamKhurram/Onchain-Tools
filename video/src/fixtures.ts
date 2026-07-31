// Fabricated data for capture and compositions. NOTHING here is real.
//
// The Discord token below is invented. It follows the shape of a real token
// (base64 user id · base64 timestamp · hmac) so it looks right on screen at a
// glance, but the middle segment literally spells EXAMPLE and the id decodes to
// zeros — so anyone who pauses the video and inspects it can tell immediately
// that it is a prop, and it can never authenticate anything.
//
// Rule: never replace this with a real token to "make the demo look better".
// A real token visible for one frame is a leaked credential, and video frames
// are trivially extractable.

export const FAKE_DISCORD_TOKEN =
  'MDAwMDAwMDAwMDAwMDAwMDAw.RVhBTVBMRQ.EXAMPLE_not_a_real_token_0000000000';

/** Fake wallet addresses — valid-shaped, deliberately not real holdings. */
export const FAKE_SOL_MINT = 'EXMPLEfakeMint1111111111111111111111111111';
export const FAKE_EVM_ADDR = '0xEXAMPLE0000000000000000000000000000dEaD';

/**
 * Feed messages for the showcase. Written to read like a real alpha channel
 * without quoting anyone real — handles are invented.
 */
export const FAKE_FEED = [
  { author: 'sol_scanner', avatar: '#14f195', text: 'new pair just deployed, LP burned', ts: '02:14' },
  { author: 'trench_bot', avatar: '#ff1744', text: `CA: ${FAKE_SOL_MINT}`, ts: '02:14', hasContract: true },
  { author: 'alpha_dev', avatar: '#ffab00', text: 'dev doxxed, socials live', ts: '02:15' },
  { author: 'sol_scanner', avatar: '#14f195', text: 'holders 340 → 1.2k in 4 min', ts: '02:17' },
] as const;

/** Missed-runner alert payload for the payoff beat. */
export const FAKE_MISSED_RUNNER = {
  symbol: 'EXMPL',
  multiple: '42x',
  calledAt: '3 days ago',
  channel: '#alpha-calls',
} as const;
