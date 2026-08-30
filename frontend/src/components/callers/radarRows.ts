// Pure radar aggregation — contracts in, one RadarRow per unique address out.
// Extracted from RadarTable.tsx so the hot path is unit-testable without React.
import type { CallerBand } from '@oct/shared';
import type { ContractEntry } from '../../types';
import type { CallerQuality } from '../../hooks/useCallerQuality';

export interface RadarRow {
  address: string;
  chain: 'evm' | 'sol';
  evmChain?: string;
  symbol?: string;
  name?: string;
  mentions: number;
  callers: Set<string>;
  groups: Set<string>;
  firstCaller?: string;
  firstSeenAt: number;
  lastMentionAt: number;
  timestamps: number[];
  mcAtCall?: number;
  mcAtCallDisplay?: string;
  /** Best band among the callers who posted this token. */
  bestBand?: CallerBand;
  /**
   * Band of the first caller specifically — distinct from bestBand, which is the
   * best across everyone who posted it. The First caller column names one person,
   * so it must show that person's own band, not the row's best.
   */
  firstCallerBand?: CallerBand;
  bestRank: number;
  /** Every caller on this token is muted — the row is pure slop by your own rules. */
  allMuted: boolean;
  // Rick's cross-server first-caller footer, earliest reading across this
  // token's rows ("espadabtw @ 49.3K · 86x · 10h" → name, mcap, absolute ms).
  rickFirstCallerName?: string;
  rickFirstCallMcapUsd?: number;
  rickFirstCallAtMs?: number;
}

// An FDV counts as the group's MC@call only if captured within this of the
// first mention — the arrival burst of one call event, not a re-mention hours
// later. Beyond it, the group's MC@call stays blank rather than borrowing a
// later row's live market cap.
export const MC_AT_CALL_MAX_LAG_MS = 900_000; // 15 min

export function buildRadar(
  contracts: ContractEntry[],
  qualityForContract?: (entry: ContractEntry) => CallerQuality,
): RadarRow[] {
  const map = new Map<string, RadarRow>();
  // MC@call candidate per key: the earliest fdv-bearing mention (ties keep the
  // first one encountered, matching the old stable sort + find). Tracked here,
  // during the single pass, instead of re-filtering + sorting every group —
  // that second pass was O(rows × contracts) and dominated large feeds.
  const mcCandidate = new Map<string, { ts: number; entry: ContractEntry }>();
  for (const c of contracts) {
    const key = c.address.toLowerCase();
    const ts = new Date(c.timestamp).getTime();
    let row = map.get(key);
    if (!row) {
      row = {
        address: c.address,
        chain: c.chain,
        evmChain: c.evmChain,
        symbol: c.tokenSymbol,
        name: c.tokenName,
        mentions: 0,
        callers: new Set(),
        groups: new Set(),
        firstCaller: c.authorName,
        firstCallerBand: qualityForContract ? qualityForContract(c).band : undefined,
        firstSeenAt: ts,
        lastMentionAt: ts,
        timestamps: [],
        bestRank: -Infinity,
        allMuted: true,
      };
      map.set(key, row);
    }

    // A token is only as good as its best caller: one trusted name calling it
    // matters more than five muted ones also calling it.
    if (qualityForContract) {
      const q = qualityForContract(c);
      if (q.rank > row.bestRank) {
        row.bestRank = q.rank;
        row.bestBand = q.band;
      }
      if (q.tier !== 'muted') row.allMuted = false;
    } else {
      row.allMuted = false;
    }

    // Rick's global-first footer is token-level; keep the earliest reading.
    // A timestamped reading beats an untimestamped one, an earlier timestamp
    // beats a later one, and the first untimestamped reading otherwise sticks.
    if (c.firstCallerName != null || c.firstCallMcapUsd != null || c.firstCallAt != null) {
      const atMs = c.firstCallAt ? new Date(c.firstCallAt).getTime() : NaN;
      const hasAt = Number.isFinite(atMs);
      const rowHasAt = row.rickFirstCallAtMs != null;
      const rowHasAny =
        row.rickFirstCallerName != null || row.rickFirstCallMcapUsd != null || rowHasAt;
      const wins =
        !rowHasAny || (hasAt && (!rowHasAt || atMs < (row.rickFirstCallAtMs as number)));
      if (wins) {
        row.rickFirstCallerName = c.firstCallerName;
        row.rickFirstCallMcapUsd = c.firstCallMcapUsd;
        row.rickFirstCallAtMs = hasAt ? atMs : undefined;
      }
    }

    // MC@call is the FIRST call's market cap: remember the earliest mention
    // that carried an FDV. Whether it sat close enough to first-seen is only
    // knowable once the whole group has been walked — checked below.
    if (c.fdvAtCall != null && c.fdvAtCall > 0) {
      const cur = mcCandidate.get(key);
      if (!cur || ts < cur.ts) mcCandidate.set(key, { ts, entry: c });
    }

    row.mentions += 1;
    row.timestamps.push(ts);
    row.callers.add(c.authorId);
    if (c.guildId) row.groups.add(c.guildId);
    else if (c.channelId) row.groups.add(c.channelId);
    if (ts < row.firstSeenAt) {
      row.firstSeenAt = ts;
      row.firstCaller = c.authorName;
      row.firstCallerBand = qualityForContract ? qualityForContract(c).band : undefined;
    }
    if (ts > row.lastMentionAt) row.lastMentionAt = ts;
    row.symbol = row.symbol ?? c.tokenSymbol;
    row.name = row.name ?? c.tokenName;
    row.evmChain = row.evmChain ?? c.evmChain;
  }

  // MC@call is the FIRST call's market cap. Use the earliest fdv-bearing
  // mention, but only if it was captured close to first-seen — otherwise a
  // repeat mention hours later (which now gets its own FDV) would have its
  // live MC stamped onto the original call, turning an honest blank into a
  // wrong denominator in the multiple. Missing beats wrong. (Any later
  // fdv-bearing mention is even further from first-seen, so if the earliest
  // one fails the lag check the group's MC@call stays blank.)
  for (const [key, row] of map) {
    const cand = mcCandidate.get(key);
    if (cand && cand.ts - row.firstSeenAt <= MC_AT_CALL_MAX_LAG_MS) {
      row.mcAtCall = cand.entry.fdvAtCall;
      row.mcAtCallDisplay = cand.entry.fdvAtCallDisplay;
    }
  }

  return [...map.values()];
}
