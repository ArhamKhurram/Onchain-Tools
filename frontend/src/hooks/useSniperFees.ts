import { useCallback, useEffect, useRef, useState } from 'react';
import { sniperJson, sniperPost } from '../lib/sniperApi';
import type { SniperResult } from '../lib/sniperApi';
import { DEFAULT_FEE_SETTINGS } from '../types/sniper';
import type { SniperFeeSettings, SniperFeesResponse } from '../types/sniper';

/**
 * The ACCOUNT-LEVEL tip + priority fee. One setting for the whole account,
 * inherited by every rule that does not explicitly override it, so the operator
 * sets it once instead of on every rule.
 *
 * Owned by SniperPage and passed down, the way the other sniper hooks are: the
 * rule form's trigger-total preview and the fire modal's per-leg fee both have
 * to move the moment this changes, and a second copy of it in a child would
 * show one screen a stale number about money.
 *
 * The value here is a PREVIEW input only. The server reads its own copy at the
 * top of every fire, so a stale hook can misdraw a figure but can never change
 * what is reserved.
 */
export function useSniperFees() {
  const [fees, setFees] = useState<SniperFeeSettings>(DEFAULT_FEE_SETTINGS);
  const [venueFeeRate, setVenueFeeRate] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    const res = await sniperJson<SniperFeesResponse>('/fees');
    if (!mounted.current) return;
    if (res.ok) {
      setFees(res.data.fees);
      setVenueFeeRate(res.data.venueFeeRate ?? {});
      setError(null);
    } else {
      // Keep the last good value rather than falling back to zero on a failed
      // read: a preview that silently drops the tip understates what a fire
      // costs, which is the wrong direction to be wrong in.
      setError(res.reason);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  /**
   * Send only the components being changed — the API leaves an omitted one
   * alone. Invalid values are refused by the server with `invalid_fees` rather
   * than coerced, and that reason is surfaced verbatim.
   */
  const save = useCallback(async (next: Partial<SniperFeeSettings>): Promise<SniperResult<SniperFeesResponse>> => {
    const res = await sniperPost<SniperFeesResponse>('/fees', next);
    if (res.ok) {
      setFees(res.data.fees);
      if (res.data.venueFeeRate) setVenueFeeRate(res.data.venueFeeRate);
      setError(null);
    }
    return res;
  }, []);

  return { fees, venueFeeRate, loading, error, refresh, save };
}
