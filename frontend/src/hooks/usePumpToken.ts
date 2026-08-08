import { useCallback, useEffect, useState } from 'react';
import { pumpGet } from '../lib/pumpfunApi';
import type { PumpCallout, PumpCommunity } from '../types/pumpfun';

// A token view: callouts + community summary for one mint. BOTH endpoints are
// KEYED (coin-communities.xyz), so an unset PUMPFUN_API_KEY turns the whole tab
// into a clean "not configured" state rather than an error — `disabled` carries
// that. The two fetches keep separate error state anyway, so a vendor 502 on one
// does not blank the other.

interface TokenState<T> {
  data: T;
  error: string | null;
  disabled: boolean;
  retryable: boolean;
}

export function usePumpToken(mint: string | null) {
  const [callouts, setCallouts] = useState<TokenState<PumpCallout[]>>({
    data: [],
    error: null,
    disabled: false,
    retryable: false,
  });
  const [community, setCommunity] = useState<TokenState<PumpCommunity | null>>({
    data: null,
    error: null,
    disabled: false,
    retryable: false,
  });
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (m: string) => {
    setLoading(true);
    const [calloutRes, communityRes] = await Promise.all([
      pumpGet<PumpCallout[]>(`/token/${m}/callouts`),
      pumpGet<PumpCommunity>(`/token/${m}/community`),
    ]);

    setCallouts(
      calloutRes.ok
        ? { data: calloutRes.data, error: null, disabled: false, retryable: false }
        : { data: [], error: calloutRes.disabled ? null : calloutRes.error, disabled: calloutRes.disabled, retryable: calloutRes.retryable },
    );
    setCommunity(
      communityRes.ok
        ? { data: communityRes.data, error: null, disabled: false, retryable: false }
        : { data: null, error: communityRes.disabled ? null : communityRes.error, disabled: communityRes.disabled, retryable: communityRes.retryable },
    );
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!mint) {
      setCallouts({ data: [], error: null, disabled: false, retryable: false });
      setCommunity({ data: null, error: null, disabled: false, retryable: false });
      return;
    }
    void load(mint);
  }, [mint, load]);

  const refresh = useCallback(() => {
    if (mint) void load(mint);
  }, [mint, load]);

  return { callouts, community, loading, refresh };
}
