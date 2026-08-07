// Venue credential connect / rotate / disconnect — Supabase-direct.
//
// THE POINT OF THIS FILE: the plaintext venue token goes browser -> Supabase and
// never touches the OCT backend. `sniper_store_venue_credential` is a SECURITY
// DEFINER RPC granted to `authenticated`, so the user's own client writes it
// into Vault directly, mirroring the direct RLS-scoped write pattern
// useTrackedWallets/useHoldingWallets already use for their tables.
//
// The secret is a function ARGUMENT and is stored nowhere: not in this hook's
// state, not in appStore, not in localStorage, not in a URL, not in a log line.
// The connect modal holds it in a local useState and clears it in the finally of
// submit. `getVenueSecret` on the backend reads it only at the moment
// executeFire is about to send.
//
// There is no read-back. `sniper_get_venue_secret` has no `authenticated` grant,
// so the token is unreadable by its own owner by design — the UI therefore has
// no reveal, no copy, and not even a last-4 fingerprint (a fingerprint would
// require someone to read the secret, which is the thing being avoided).
// Rotation is re-running the store RPC; disconnect is the delete RPC.

import { useCallback, useEffect, useState } from 'react';
import { getSupabase, isHostedMode } from '../lib/supabase';
import type { SniperVenueCredential } from '../types/sniper';

export interface VenueConnectMeta {
  walletAddress?: string;
  region?: string;
  label?: string;
}

export function useSniperVenues(userId: string | undefined) {
  const [credentials, setCredentials] = useState<SniperVenueCredential[]>([]);
  const [loading, setLoading] = useState(isHostedMode && !!userId);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    // getSupabase() throws when VITE_SUPABASE_URL/ANON_KEY are unset, so the
    // whole hook is inert in local mode — where the credential is an env var
    // and there is nothing for a browser to read.
    if (!isHostedMode || !userId) {
      setCredentials([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    // No .eq('user_id', …): the select-own RLS policy already scopes this, and
    // there is no secret column on the table to leak.
    const { data, error: fetchError } = await getSupabase()
      .from('sniper_venue_credentials')
      .select('id, venue, wallet_address, region, label, created_at, updated_at')
      .order('created_at', { ascending: false });

    if (fetchError) {
      setError(fetchError.message);
      setCredentials([]);
    } else {
      // getSupabase() is untyped (createClient with no Database generic) and
      // database.types.ts carries neither this table nor these RPCs, so the row
      // is cast locally — exactly as useTrackedWallets does.
      setCredentials((data as SniperVenueCredential[]) ?? []);
    }
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Connect or rotate. `secret` is passed in and never retained.
   *
   * `p_user_id` is deliberately OMITTED: called as an authenticated user the RPC
   * ignores it in favour of auth.uid(), so passing it (the way useHoldingWallets
   * passes user_id on its insert) would be noise at best and misleading at worst.
   */
  const connect = useCallback(
    async (secret: string, meta: VenueConnectMeta = {}) => {
      if (!isHostedMode) return { ok: false as const, error: 'Hosted mode only' };
      const { error: rpcError } = await getSupabase().rpc('sniper_store_venue_credential', {
        p_venue: 'slotshark',
        p_secret: secret,
        p_wallet_address: meta.walletAddress?.trim() || null,
        p_region: meta.region?.trim() || null,
        p_label: meta.label?.trim() || null,
      });
      if (rpcError) return { ok: false as const, error: rpcError.message };
      await refresh();
      return { ok: true as const };
    },
    [refresh],
  );

  /** Drops the metadata row AND the vault secret. Returns false if nothing was connected. */
  const disconnect = useCallback(async () => {
    if (!isHostedMode) return { ok: false as const, error: 'Hosted mode only' };
    const { data, error: rpcError } = await getSupabase().rpc('sniper_delete_venue_credential', {
      p_venue: 'slotshark',
    });
    if (rpcError) return { ok: false as const, error: rpcError.message };
    await refresh();
    return { ok: true as const, removed: (data as boolean | null) ?? false };
  }, [refresh]);

  return { credentials, loading, error, refresh, connect, disconnect };
}
