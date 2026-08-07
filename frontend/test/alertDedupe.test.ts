import { describe, it, expect } from 'vitest';
import {
  contractAlertKey,
  dedupeContractAlert,
  CONTRACT_ALERT_DEDUPE_MS,
  type ContractAlertSeen,
} from '../src/utils/alertDedupe';
import type { Alert } from '../src/types';

const T0 = new Date('2026-01-01T00:00:00.000Z').getTime();

// The real incident: one four.meme call on BSC. The caller posted the address
// lowercase; Rick replied moments later with an embed carrying it EIP-55
// checksummed. Two "Contract scan" toasts for one token.
const LOWER = '0x2ec39b165e22944d2fee389219ee64e4924cffff';
const CHECKSUMMED = '0x2Ec39B165e22944d2FEE389219ee64E4924cfffF';
const SOL_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const alert = (address: string, over: { type?: Alert['type']; channelId?: string; id?: string } = {}): Alert =>
  ({
    id: over.id ?? `alert-${address}`,
    type: over.type ?? 'contract_address',
    reason: `Contract scan: ${address.slice(0, 6)}…${address.slice(-4)} · alpha`,
    timestamp: T0,
    message: {
      id: 'm1',
      channelId: over.channelId ?? 'chan-1',
      channelName: 'alpha',
      content: address,
      hasContractAddress: true,
      contractAddresses: [address],
    },
  } as unknown as Alert);

describe('contractAlertKey', () => {
  it('gives a checksummed and a lowercase EVM address the same key', () => {
    expect(contractAlertKey(alert(CHECKSUMMED))).toBe(contractAlertKey(alert(LOWER)));
  });

  it('keys per channel, so the same call in two rooms still both toast', () => {
    expect(contractAlertKey(alert(LOWER, { channelId: 'chan-2' })))
      .not.toBe(contractAlertKey(alert(LOWER)));
  });

  it('opts out of dedupe for non-contract alerts and addressless ones', () => {
    expect(contractAlertKey(alert(LOWER, { type: 'highlighted_user' }))).toBeNull();
    const bare = alert(LOWER);
    (bare.message as { contractAddresses: string[] }).contractAddresses = [];
    expect(contractAlertKey(bare)).toBeNull();
  });
});

describe('dedupeContractAlert', () => {
  it('collapses the raw-detection and Rick-enrichment toasts for one call', () => {
    const first = dedupeContractAlert(alert(LOWER), {}, T0);
    expect(first.duplicate).toBe(false);

    // Rick's embed reply lands two seconds later, checksummed.
    const second = dedupeContractAlert(alert(CHECKSUMMED), first.seen, T0 + 2_000);
    expect(second.duplicate).toBe(true);
  });

  it('is order-independent (checksummed arrives first)', () => {
    const first = dedupeContractAlert(alert(CHECKSUMMED), {}, T0);
    const second = dedupeContractAlert(alert(LOWER), first.seen, T0 + 500);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
  });

  it('lets the same token toast again once the window has passed', () => {
    const first = dedupeContractAlert(alert(LOWER), {}, T0);
    const later = dedupeContractAlert(alert(LOWER), first.seen, T0 + CONTRACT_ALERT_DEDUPE_MS + 1);
    expect(later.duplicate).toBe(false);
  });

  it('does not let a suppressed toast extend the window', () => {
    const first = dedupeContractAlert(alert(LOWER), {}, T0);
    const suppressed = dedupeContractAlert(alert(LOWER), first.seen, T0 + 20_000);
    expect(suppressed.duplicate).toBe(true);

    // Measured from the toast that actually showed, not from the one dropped.
    const after = dedupeContractAlert(alert(LOWER), suppressed.seen, T0 + CONTRACT_ALERT_DEDUPE_MS + 1);
    expect(after.duplicate).toBe(false);
  });

  it('keeps the same token in a different channel', () => {
    const first = dedupeContractAlert(alert(LOWER), {}, T0);
    const other = dedupeContractAlert(alert(LOWER, { channelId: 'chan-2' }), first.seen, T0 + 1_000);
    expect(other.duplicate).toBe(false);
  });

  // Base58 is case-sensitive: two Solana mints differing only in case are two
  // different tokens and must never be folded together.
  it('does not fold Solana mints that differ in case', () => {
    const first = dedupeContractAlert(alert(SOL_MINT), {}, T0);
    const lowered = dedupeContractAlert(alert(SOL_MINT.toLowerCase()), first.seen, T0 + 1_000);
    expect(lowered.duplicate).toBe(false);

    const same = dedupeContractAlert(alert(SOL_MINT), lowered.seen, T0 + 2_000);
    expect(same.duplicate).toBe(true);
  });

  it('never suppresses other alert types', () => {
    let seen: ContractAlertSeen = {};
    for (const type of ['highlighted_user', 'keyword_match', 'missed_runner'] as Alert['type'][]) {
      const a = dedupeContractAlert(alert(LOWER, { type }), seen, T0);
      const b = dedupeContractAlert(alert(LOWER, { type }), a.seen, T0 + 100);
      expect(a.duplicate).toBe(false);
      expect(b.duplicate).toBe(false);
      seen = b.seen;
    }
  });

  it('prunes expired keys instead of growing forever', () => {
    const first = dedupeContractAlert(alert(LOWER), {}, T0);
    expect(Object.keys(first.seen)).toHaveLength(1);

    const later = dedupeContractAlert(
      alert(LOWER, { channelId: 'chan-9' }),
      first.seen,
      T0 + CONTRACT_ALERT_DEDUPE_MS + 1,
    );
    expect(Object.keys(later.seen)).toEqual([contractAlertKey(alert(LOWER, { channelId: 'chan-9' }))]);
  });
});
