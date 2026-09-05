// The j7 dropped roster, fetched once per surface and refreshed on the
// reconciler's own cadence. Consumers get a case-folded lookup (lib/droppedRoster)
// and ask `isDropped(lookup, 'pump' | 'fomo', key)` per row.
//
// HOSTED-ONLY, by construction rather than by gate: the reconciler's demand
// comes from the Supabase tracking tables, so in local mode nothing is ever
// dropped. Skipping the request there saves a round trip on every Callers tab
// open — the local answer is a known constant, not a fetch.
//
// Failure is silent on purpose. This is an annotation on top of a roster that
// already renders; an error here must not become a red banner on a tab that is
// otherwise fine. An older backend without the route (404) degrades the same
// way: no badge, no notice.

import { useCallback, useEffect, useState } from 'react';
import { getAccessToken, isHostedMode } from '../lib/supabase';
import {
  buildDroppedLookup,
  EMPTY_DROPPED_LOOKUP,
  type DroppedLookup,
  type DroppedRosterPayload,
} from '../lib/droppedRoster';

const API_BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

// The backend reconciles every 5 min (j7/roster.ts INTERVAL_MS); polling faster
// would only re-read the same snapshot.
const REFRESH_MS = 5 * 60_000;

// One in-flight/settled fetch shared by every mounted consumer. The Callers
// page mounts three surfaces (Following, Top Callers, feed) that all want the
// same global snapshot — without this each would fire its own request.
let _cache: { lookup: DroppedLookup; at: number } | null = null;
let _inflight: Promise<DroppedLookup> | null = null;

async function fetchDropped(): Promise<DroppedLookup> {
  try {
    const headers = new Headers();
    const token = await getAccessToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const res = await fetch(`${API_BASE}/pumpfun/roster/dropped`, { headers });
    if (!res.ok) return EMPTY_DROPPED_LOOKUP;
    return buildDroppedLookup((await res.json()) as DroppedRosterPayload);
  } catch {
    return EMPTY_DROPPED_LOOKUP;
  }
}

function load(force = false): Promise<DroppedLookup> {
  if (!force && _cache && Date.now() - _cache.at < REFRESH_MS) return Promise.resolve(_cache.lookup);
  if (_inflight) return _inflight;
  _inflight = fetchDropped()
    .then((lookup) => {
      _cache = { lookup, at: Date.now() };
      return lookup;
    })
    .finally(() => {
      _inflight = null;
    });
  return _inflight;
}

/** Test seam / hot-path reset. */
export function resetDroppedRosterCache(): void {
  _cache = null;
  _inflight = null;
}

export function useDroppedRoster(): { dropped: DroppedLookup; refresh: () => Promise<void> } {
  const [dropped, setDropped] = useState<DroppedLookup>(() => _cache?.lookup ?? EMPTY_DROPPED_LOOKUP);

  const refresh = useCallback(async () => {
    if (!isHostedMode) return;
    setDropped(await load(true));
  }, []);

  useEffect(() => {
    if (!isHostedMode) return;
    let alive = true;
    const tick = () => {
      void load().then((lookup) => {
        if (alive) setDropped(lookup);
      });
    };
    tick();
    const timer = window.setInterval(tick, REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  return { dropped, refresh };
}
