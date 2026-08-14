import { useCallback, useState } from 'react';
import { sniperJson } from '../lib/sniperApi';

/**
 * A wallet as it exists at the venue, for the import affordance on the wallet
 * form. Distinct from `SniperWallet` on purpose — that is a wallet OCT governs,
 * with caps; this is one Slotshark holds, with none. Importing turns the second
 * into the first, and the caps are supplied then.
 */
export interface VenueWallet {
  pubkey: string;
  label: string;
  /**
   * Durable nonce accounts, shown in Slotshark's UI as "task accounts". A pool
   * of concurrent in-flight transactions — one per transaction, buy OR sell,
   * released on confirmation. `-1` means their API did not report it —
   * unknown, not zero.
   */
  nonceCount: number;
  enabled: boolean;
  /** null when the per-wallet balance call failed; the row is still importable. */
  balanceSol: number | null;
  /** Already governed by OCT, so importing again would collide. */
  imported: boolean;
}

export function useVenueWallets() {
  const [wallets, setWallets] = useState<VenueWallet[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (venue = 'slotshark') => {
    setLoading(true);
    setError(null);
    const res = await sniperJson<{ wallets: VenueWallet[] }>(`/venues/${venue}/wallets`);
    if (res.ok) {
      setWallets(res.data.wallets);
    } else {
      // These reasons are vendor-shaped, so they get vendor-shaped copy: the
      // operator's next action differs a lot between "your token is bad" and
      // "Slotshark changed their API", and a generic failure hides that.
      setError(
        res.reason === 'no_credential'
          ? 'Connect your Slotshark account first.'
          : res.reason === 'venue_rejected_credential'
            ? 'Slotshark rejected the stored token. Reconnect the venue.'
            : res.reason === 'venue_contract_changed'
              ? 'Slotshark changed their API shape — importing needs a code update.'
              : res.reason === 'venue_unreachable'
                ? 'Could not reach Slotshark. Try again shortly.'
                : 'Could not load wallets from Slotshark.',
      );
      setWallets([]);
    }
    setLoading(false);
  }, []);

  return { wallets, loading, error, load };
}
