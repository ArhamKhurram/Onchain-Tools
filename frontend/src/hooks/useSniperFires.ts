import { useCallback, useEffect, useState } from 'react';
import { sniperJson, sniperPost } from '../lib/sniperApi';
import type { SniperFire } from '../types/sniper';

const POLL_MS = 20_000;

/**
 * The fire log.
 *
 * It polls rather than subscribing: there is deliberately no `sniper_fire`
 * WebSocket frame. Adding one would force `createSniperRouter` to take the
 * WsServer, which would force it to mount AFTER the app-wide cors() it must
 * precede (backend/src/api/sniper/router.ts header). A 20s poll is the price of
 * that ordering constraint, and it is a cheap one — every fire in the alpha is a
 * human pressing a button, and the button refetches on completion anyway.
 */
export function useSniperFires() {
  const [fires, setFires] = useState<SniperFire[]>([]);
  const [unresolvedUnknown, setUnresolvedUnknown] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await sniperJson<{ fires: SniperFire[]; unresolvedUnknown: number }>('/fires?limit=200');
    if (res.ok) {
      setFires(res.data.fires);
      setUnresolvedUnknown(res.data.unresolvedUnknown);
      setError(null);
    } else {
      setError(res.reason);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  /**
   * The human stand-in for `reconcile(wallet, mint, since)`, which cannot be
   * built: no Slotshark fill-history endpoint is known to this repo. An
   * `unknown` leg holds its reservation until a person checks the venue and
   * says which way it went — `not_filled` releases it, `filled` leaves the
   * budget debited and records the signature.
   */
  const resolveFire = useCallback(
    async (id: string, resolution: 'filled' | 'not_filled', note?: string) => {
      const res = await sniperPost<{ fire: SniperFire }>(`/fires/${id}/resolve`, { resolution, note });
      if (res.ok) await refresh();
      return res;
    },
    [refresh],
  );

  return { fires, unresolvedUnknown, loading, error, refresh, resolveFire };
}
