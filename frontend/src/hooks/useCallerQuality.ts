import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  contractCallerKey,
  resolveCallerTier,
  effectiveBand,
  callerRank,
  pickRoomScore,
  type CallerBand,
  type CallerScore,
  type CallerTier,
  type RoomCallerScores,
} from '@oct/shared';
import type { ContractEntry } from '../types';
import { useAppStore } from '../stores/appStore';
import { apiFetch, API_BASE } from '../stores/appStore.helpers';

/** Scores only move on the backend sampler's cadence, so refetch rarely. */
const REFRESH_MS = 300_000;

export interface CallerQuality {
  key: string;
  tier: CallerTier;
  /** What to display, after the manual tier has overridden the earned band. */
  band: CallerBand;
  /** Sort weight — higher floats up. */
  rank: number;
  score?: CallerScore;
  /** Where `score` came from — a rated in-room record, or the global one. */
  scoreScope?: 'room' | 'global';
}

interface ScoresResponse {
  windowDays: number;
  contracts: number;
  pricedTokens: number;
  /** The window held more rows than the backend would read — scores cover less than the window. */
  truncated?: boolean;
  /** Timestamp of the oldest row the scores were actually built from. */
  coversFrom?: string;
  scores: CallerScore[];
  /** Absent from older backends; room preference degrades to global. */
  roomScores?: RoomCallerScores;
  /**
   * How the board was built. `persistent` reads a durable per-caller record —
   * a caller stays ranked once they have scanned, regardless of how far the
   * contract log still reaches. `derived` is the original fold over the log,
   * which is what local mode does. Absent from older backends.
   */
  mode?: 'persistent' | 'derived';
  /** True when the board covers the caller's whole recorded history. */
  allTime?: boolean;
  /** Distinct callers on the persistent record. */
  callersTracked?: number;
}

let cached: ScoresResponse | null = null;
let cachedAt = 0;
let inFlight: Promise<ScoresResponse | null> | null = null;

async function loadScores(force = false): Promise<ScoresResponse | null> {
  if (!force && cached && Date.now() - cachedAt < REFRESH_MS) return cached;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const res = await apiFetch(`${API_BASE}/callers/scores`);
      if (!res.ok) return cached;
      const data = (await res.json()) as ScoresResponse;
      cached = data;
      cachedAt = Date.now();
      return data;
    } catch {
      // Scoring is a nice-to-have overlay; a failure must never blank the feed.
      return cached;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * Caller quality lookup — manual tiers from config, earned bands from the API.
 *
 * Returns a resolver rather than a map so callers can pass the room context that
 * a room-scoped mute needs ("slop in #prosp, fine elsewhere").
 */
export function useCallerQuality() {
  const callerTiers = useAppStore((s) => s.config?.callerTiers);
  const rankingEnabled = useAppStore((s) => s.config?.callerQualityRanking ?? false);
  const showMuted = useAppStore((s) => s.config?.callerTierShowMuted ?? true);
  const [scores, setScores] = useState<ScoresResponse | null>(cached);

  useEffect(() => {
    let active = true;
    void loadScores().then((data) => {
      if (active && data) setScores(data);
    });
    const timer = setInterval(() => {
      void loadScores(true).then((data) => {
        if (active && data) setScores(data);
      });
    }, REFRESH_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  // Scoring exclusions change who is on the board, so don't make the user wait
  // out the refresh interval to see their own edit land.
  const exclusionSig = JSON.stringify(
    useAppStore((s) => s.config?.callerScoreExclusions) ?? [],
  );
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    void loadScores(true).then((data) => {
      if (data) setScores(data);
    });
  }, [exclusionSig]);

  const byKey = useMemo(() => {
    const map = new Map<string, CallerScore>();
    for (const s of scores?.scores ?? []) map.set(s.key, s);
    return map;
  }, [scores]);

  /** roomId -> (caller key -> that caller's score inside that room). */
  const byRoom = useMemo(() => {
    const map = new Map<string, Map<string, CallerScore>>();
    for (const [roomId, roomScores] of Object.entries(scores?.roomScores ?? {})) {
      const inner = new Map<string, CallerScore>();
      for (const s of roomScores) inner.set(s.key, s);
      map.set(roomId, inner);
    }
    return map;
  }, [scores]);

  const qualityFor = useCallback(
    (key: string, roomIds: string[] = [], scope: 'room' | 'global' = 'room'): CallerQuality => {
      // Manual tiers stay room-aware in BOTH scopes — a room-scoped mute is a
      // deliberate statement and applies wherever that room context appears.
      // The scope only chooses which *earned* record backs the band.
      const tier = resolveCallerTier(callerTiers, key, roomIds);
      const picked =
        scope === 'room'
          ? pickRoomScore(roomIds, (roomId) => byRoom.get(roomId)?.get(key), byKey.get(key))
          : { score: byKey.get(key), scope: 'global' as const };
      return {
        key,
        tier,
        band: effectiveBand(tier, picked.score?.band),
        rank: callerRank(tier, picked.score?.band),
        score: picked.score,
        scoreScope: picked.score ? picked.scope : undefined,
      };
    },
    [callerTiers, byKey, byRoom],
  );

  /** Room-scoped surfaces (chat feed, contract feed): in-room record first. */
  const qualityForContract = useCallback(
    (entry: ContractEntry): CallerQuality => qualityFor(contractCallerKey(entry), entry.roomIds ?? []),
    [qualityFor],
  );

  /**
   * Global-band variant for surfaces that aggregate across rooms — the Radar
   * merges every room's calls into one table, so painting a row with one
   * room's band would misattribute it. Room-scoped manual mutes still apply.
   */
  const qualityForContractGlobal = useCallback(
    (entry: ContractEntry): CallerQuality =>
      qualityFor(contractCallerKey(entry), entry.roomIds ?? [], 'global'),
    [qualityFor],
  );

  return {
    qualityFor,
    qualityForContract,
    qualityForContractGlobal,
    rankingEnabled,
    showMuted,
    /** Null until the first fetch lands — used to keep "unrated" from flashing. */
    loaded: scores != null,
    windowDays: scores?.windowDays,
    pricedTokens: scores?.pricedTokens,
    contractsScanned: scores?.contracts,
    truncated: scores?.truncated ?? false,
    coversFrom: scores?.coversFrom,
    /** Older backends only ever derived, so that's the honest default. */
    mode: scores?.mode ?? 'derived',
    allTime: scores?.allTime ?? false,
    callersTracked: scores?.callersTracked ?? 0,
    scores: scores?.scores ?? [],
    /** Force a refetch — e.g. after refreshing a token's peak. */
    reload: () => loadScores(true),
  };
}

/**
 * Re-observe one token's market cap and fold it into its peak.
 *
 * Peaks are joined when scores are read, so raising one re-derives every caller
 * who called that token — there is nothing else to invalidate. The value folded
 * in is today's MC, not a historical ATH: peaks are a high-water mark of
 * observations, so this raises the floor and can never lower it.
 */
export async function refreshTokenPeak(
  address: string,
  opts: { chain?: 'evm' | 'sol'; evmChain?: string } = {},
): Promise<{ mcNow?: number; peakMc?: number; raised: boolean } | null> {
  try {
    const res = await apiFetch(`${API_BASE}/callers/peaks/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, ...opts }),
    });
    if (!res.ok) return null;
    return (await res.json()) as { mcNow?: number; peakMc?: number; raised: boolean };
  } catch {
    return null;
  }
}
