import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  contractCallerKey,
  resolveCallerTier,
  effectiveBand,
  callerRank,
  type CallerBand,
  type CallerScore,
  type CallerTier,
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
}

interface ScoresResponse {
  windowDays: number;
  contracts: number;
  pricedTokens: number;
  scores: CallerScore[];
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

  const byKey = useMemo(() => {
    const map = new Map<string, CallerScore>();
    for (const s of scores?.scores ?? []) map.set(s.key, s);
    return map;
  }, [scores]);

  const qualityFor = useCallback(
    (key: string, roomIds: string[] = []): CallerQuality => {
      const tier = resolveCallerTier(callerTiers, key, roomIds);
      const score = byKey.get(key);
      return {
        key,
        tier,
        band: effectiveBand(tier, score?.band),
        rank: callerRank(tier, score?.band),
        score,
      };
    },
    [callerTiers, byKey],
  );

  const qualityForContract = useCallback(
    (entry: ContractEntry): CallerQuality => qualityFor(contractCallerKey(entry), entry.roomIds ?? []),
    [qualityFor],
  );

  return {
    qualityFor,
    qualityForContract,
    rankingEnabled,
    showMuted,
    /** Null until the first fetch lands — used to keep "unrated" from flashing. */
    loaded: scores != null,
    windowDays: scores?.windowDays,
    pricedTokens: scores?.pricedTokens,
    scores: scores?.scores ?? [],
  };
}
