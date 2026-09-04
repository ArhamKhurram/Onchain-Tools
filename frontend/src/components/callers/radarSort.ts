// Radar ordering: the sort-key vocabulary and the comparator, lifted out of
// RadarTable.tsx as a pure function so the table's `rows` memo is a one-liner
// and the ordering rules can be read (and tested) without React around them.
import { compareNumeric, compareText, type SortDir } from '../../lib/sort';
import type { FomoHolderOverlap } from '../../types/fomo';
import type { NetworkFirstScan } from '../../hooks/useNetworkFirstScans';
import type { MentionWindow } from './RadarSettings';
import {
  countWithin,
  pickGlobalFirst,
  MENTION_WINDOW_MS,
  type LiveMc,
  type RadarRow,
} from './radarRows';

export type RadarSortKey =
  | 'token'
  | 'mentions'
  | 'callers'
  | 'fomo'
  | 'groups'
  | 'windowMentions'
  | 'firstCaller'
  | 'globalFirst'
  | 'mcAtCall'
  | 'mcNow'
  | 'mult'
  | 'quality'
  | 'recent';

// Text columns read better opened A→Z; every numeric column opens descending
// (biggest on top). Module-level so useSort's memoised handler stays stable.
export const RADAR_ASC_FIRST: readonly RadarSortKey[] = ['token', 'firstCaller'];

export type RadarWindowFilter = '1h' | '4h' | '24h' | 'all';

const WINDOW_FILTER_MS: Record<Exclude<RadarWindowFilter, 'all'>, number> = {
  '1h': 3_600_000,
  '4h': 14_400_000,
  '24h': 86_400_000,
};

/** Everything the comparator needs beyond the rows themselves. */
export interface RadarSortContext {
  sortKey: RadarSortKey;
  sortDir: SortDir;
  mentionWindow: MentionWindow;
  liveMc: Record<string, LiveMc>;
  overlaps: Record<string, FomoHolderOverlap | undefined>;
  networkScans: Record<string, NetworkFirstScan | undefined>;
}

/** Drop rows whose last mention falls outside the toolbar window. */
export function filterRadarWindow(rows: RadarRow[], windowFilter: RadarWindowFilter): RadarRow[] {
  if (windowFilter === 'all') return rows;
  const cutoff = Date.now() - WINDOW_FILTER_MS[windowFilter];
  return rows.filter((r) => r.lastMentionAt >= cutoff);
}

/** A new, sorted array; the input is never mutated. Ties fall back to newest-first. */
export function sortRadarRows(rows: RadarRow[], ctx: RadarSortContext): RadarRow[] {
  const { sortKey, sortDir, mentionWindow, liveMc, overlaps, networkScans } = ctx;
  const cmpNum = (a: number | undefined | null, b: number | undefined | null) =>
    compareNumeric(a, b, sortDir);
  const cmpStr = (a: string | undefined, b: string | undefined) =>
    compareText(a, b, sortDir);

  return [...rows].sort((a, b) => {
    const fomoA = overlaps[a.address.toLowerCase()]?.trackedCount ?? 0;
    const fomoB = overlaps[b.address.toLowerCase()]?.trackedCount ?? 0;
    const liveA = liveMc[a.address.toLowerCase()];
    const liveB = liveMc[b.address.toLowerCase()];
    const mcNowA = liveA?.mc;
    const mcNowB = liveB?.mc;
    const multA = a.mcAtCall && mcNowA && a.mcAtCall > 0 ? mcNowA / a.mcAtCall : undefined;
    const multB = b.mcAtCall && mcNowB && b.mcAtCall > 0 ? mcNowB / b.mcAtCall : undefined;

    let result = 0;
    switch (sortKey) {
      case 'recent':
        result = cmpNum(a.lastMentionAt, b.lastMentionAt);
        break;
      case 'token':
        result = cmpStr(a.symbol ?? a.address, b.symbol ?? b.address);
        break;
      case 'mentions':
        result = cmpNum(a.mentions, b.mentions);
        break;
      case 'callers':
        result = cmpNum(a.callers.size, b.callers.size);
        break;
      case 'fomo':
        result = cmpNum(fomoA, fomoB);
        break;
      case 'groups':
        result = cmpNum(a.groups.size, b.groups.size);
        break;
      case 'windowMentions':
        result = cmpNum(
          countWithin(a.timestamps, MENTION_WINDOW_MS[mentionWindow]),
          countWithin(b.timestamps, MENTION_WINDOW_MS[mentionWindow]),
        );
        break;
      case 'firstCaller':
        result = cmpStr(a.firstCaller, b.firstCaller);
        break;
      case 'globalFirst':
        result = cmpNum(
          pickGlobalFirst(a, networkScans[a.address])?.atMs,
          pickGlobalFirst(b, networkScans[b.address])?.atMs,
        );
        break;
      case 'mcAtCall':
        result = cmpNum(a.mcAtCall, b.mcAtCall);
        break;
      case 'mcNow':
        result = cmpNum(mcNowA, mcNowB);
        break;
      case 'mult':
        result = cmpNum(multA, multB);
        break;
      case 'quality':
        result = cmpNum(a.bestRank, b.bestRank);
        break;
      default:
        result = 0;
    }
    if (result !== 0) return result;
    return b.lastMentionAt - a.lastMentionAt;
  });
}
