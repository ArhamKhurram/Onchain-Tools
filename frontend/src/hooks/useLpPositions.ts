import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE, apiFetch } from '../stores/appStore.helpers';
import type { LpPositionSkip, LpPositionView } from '../components/lp/positions';

/**
 * `GET /api/lp/positions`
 *
 * Read-only, and display-grade by design: this feed is Krystal's cached view of
 * the Safe's positions. The automation does not act on it — it reads the chain
 * directly (LP_AUTOMATION_PLAN.md §3) — so nothing here can be used to decide
 * anything, only to show what is open.
 *
 * `configured: false` is an ordinary state, not a failure: it means no Safe
 * address has been saved yet. It is kept distinct from `error` so the panel can
 * render a setup step rather than a fault.
 */

export interface UseLpPositionsResult {
  positions: LpPositionView[];
  /** The Safe the server read, echoed back so the panel can show what it is showing. */
  safeAddress: string | null;
  /** False until a Safe address is saved. */
  configured: boolean;
  /** Positions the server received but could not read — surfaced, never swallowed. */
  skipped: LpPositionSkip[];
  /**
   * True when the server could not read the policy, so every coverage flag is
   * UNKNOWN rather than false. Without it the panel would assert that nothing
   * is protected on a transient database error.
   */
  policyReadFailed: boolean;
  fetchedAt: string | null;
  loading: boolean;
  error: string | null;
  /** The backend has no `/api/lp/positions` route yet. */
  unavailable: boolean;
  refresh: () => Promise<void>;
}

function isPosition(entry: unknown): entry is LpPositionView {
  return !!entry && typeof entry === 'object';
}

function parseSkipped(value: unknown): LpPositionSkip[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry): LpPositionSkip | null => {
      if (!entry || typeof entry !== 'object') return null;
      const record = entry as Record<string, unknown>;
      return {
        index: typeof record.index === 'number' ? record.index : -1,
        identifier: typeof record.identifier === 'string' ? record.identifier : 'unknown',
        reason: typeof record.reason === 'string' ? record.reason : 'unreadable',
      };
    })
    .filter((entry): entry is LpPositionSkip => entry !== null);
}

export function useLpPositions(enabled = true): UseLpPositionsResult {
  const [positions, setPositions] = useState<LpPositionView[]>([]);
  const [safeAddress, setSafeAddress] = useState<string | null>(null);
  const [configured, setConfigured] = useState(false);
  const [skipped, setSkipped] = useState<LpPositionSkip[]>([]);
  const [policyReadFailed, setPolicyReadFailed] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const id = ++requestId.current;
    setLoading(true);
    setError(null);

    try {
      const res = await apiFetch(`${API_BASE}/lp/positions`);
      if (id !== requestId.current) return;

      if (res.status === 404 || res.status === 501) {
        setUnavailable(true);
        setPositions([]);
        setLoading(false);
        return;
      }

      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? (JSON.parse(text) as unknown) : null;
      } catch {
        body = null;
      }
      if (id !== requestId.current) return;

      if (!res.ok) {
        const record = (body ?? {}) as Record<string, unknown>;
        throw new Error(
          typeof record.error === 'string' ? record.error : `Failed to load positions (${res.status})`,
        );
      }

      // Accept a bare array or the documented envelope — the API is being built
      // alongside this page, and losing every position to an envelope mismatch
      // would be worse than accepting both shapes.
      const record = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
      const list = Array.isArray(body)
        ? body
        : Array.isArray(record.positions)
          ? (record.positions as unknown[])
          : [];

      setUnavailable(false);
      setPositions(list.filter(isPosition));
      setSafeAddress(typeof record.safeAddress === 'string' ? record.safeAddress : null);
      // A bare array carries no `configured` flag; having positions at all means
      // the server had an address to read them from.
      setConfigured(
        typeof record.configured === 'boolean' ? record.configured : list.length > 0,
      );
      setSkipped(parseSkipped(record.skipped));
      // Absent (older backend) reads as false — the normal, non-alarming default.
      setPolicyReadFailed(record.policyReadFailed === true);
      setFetchedAt(typeof record.fetchedAt === 'string' ? record.fetchedAt : null);
    } catch (err) {
      if (id !== requestId.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load positions');
      setPositions([]);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    positions,
    safeAddress,
    configured,
    skipped,
    policyReadFailed,
    fetchedAt,
    loading,
    error,
    unavailable,
    refresh,
  };
}
