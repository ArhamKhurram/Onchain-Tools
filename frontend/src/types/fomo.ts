// Types for the FOMO user-tracking feature. These mirror the backend contract:
// - FomoTrackedUser matches FomoTrackedUserRow (backend/src/fomo/store.ts) as
//   returned by GET/POST /api/fomo/tracked.
// - FomoTradeEvent matches the `data` payload of the poller's `fomo_trade` WS
//   message (backend/src/fomo/poller.ts -> sendToUser).

// FomoTrackedUser is now canonical in @oct/shared (matches backend
// FomoTrackedUserRow). isolatedModules → re-export as a type.
export type { FomoTrackedUser } from '@oct/shared';

export interface FomoTradeEvent {
  fomoUserId: string | null;
  fomoHandle: string | null;
  displayName: string | null;
  side: string | null;
  tokenAddress: string | null;
  tokenSymbol: string | null;
  tokenName: string | null;
  marketCap: number | null;
  marketCapDisplay: string | null;
  networkId: number | null;
  usdValue: number | null;
  tradeId: string | null;
}

// A trade held in client state.
//
// `occurredAt` is when the trade actually happened and is what the feed renders.
// Live WS frames carry no timestamp, so for those it is stamped on arrival —
// effectively the trade time, since the poller pushes within seconds. Replayed
// history carries the stored event's real time, which matters: without it a
// day's backfill would all render at the moment you reloaded the page.
//
// `key` gives React a stable list key even when tradeId is missing (the backend
// can't dedup those, but we still render them).
export interface FomoTrade extends FomoTradeEvent {
  occurredAt: number;
  receivedAt: number;
  key: string;
}

/** A trade replayed from GET /api/fomo/trades. */
export interface FomoTradeHistoryEntry extends FomoTradeEvent {
  occurredAt: number;
}

export interface FomoLeaderboardEntry {
  fomoUserId: string;
  fomoHandle: string | null;
  displayName: string | null;
  pnl?: number | null;
  volume?: number | null;
  rank?: number | null;
}

export interface FomoServiceStatus {
  configured: boolean;
  pollerActive: boolean;
  pollerReason: string | null;
}

export interface FomoHolderOverlap {
  trackedCount: number;
  trackedHandles: string[];
}
