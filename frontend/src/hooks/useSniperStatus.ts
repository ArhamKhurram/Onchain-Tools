import { useCallback, useEffect, useRef, useState } from 'react';
import { sniperJson, sniperPost } from '../lib/sniperApi';
import type { KillState, SniperStatus } from '../types/sniper';

const POLL_MS = 20_000;

/**
 * The one call the sniper status bar polls. Also owns the kill switch, because
 * the switch and the state it reports must never come from two sources that can
 * disagree — an operator looking at a stale "OFF" badge while the switch is on
 * is exactly the wrong direction to be wrong in.
 */
export function useSniperStatus() {
  const [status, setStatus] = useState<SniperStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Held in a ref so the poll callback never closes over a stale value and the
  // interval does not need to be torn down on every response.
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    const res = await sniperJson<SniperStatus>('/status');
    if (!mounted.current) return;
    if (res.ok) {
      setStatus(res.data);
      setError(null);
    } else {
      // The status bar is chrome; a failed poll must never blank the kill switch
      // the operator is reaching for. Keep the last good status and only report.
      setError(res.reason);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  /**
   * Turning the switch ON needs no confirmation — stopping is always safe.
   * Turning it OFF carries `confirm:'RESUME'`, which the API requires.
   */
  const setKill = useCallback(async (on: boolean, reason?: string) => {
    const res = await sniperPost<KillState>('/kill', on ? { on: true, reason } : { on: false, confirm: 'RESUME' });
    if (res.ok) setStatus((prev) => (prev ? { ...prev, kill: res.data } : prev));
    return res;
  }, []);

  return { status, loading, error, refresh, setKill };
}
