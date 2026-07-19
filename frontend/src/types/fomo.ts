// Types for the FOMO user-tracking feature. These mirror the backend contract:
// - FomoTrackedUser matches FomoTrackedUserRow (backend/src/fomo/store.ts) as
//   returned by GET/POST /api/fomo/tracked.
// - FomoTradeEvent matches the `data` payload of the poller's `fomo_trade` WS
//   message (backend/src/fomo/poller.ts -> sendToUser).

export interface FomoTrackedUser {
  id: string;
  user_id: string;
  fomo_user_id: string;
  fomo_handle: string | null;
  display_name: string | null;
  notify_pushover: boolean;
  created_at: string;
}

export interface FomoTradeEvent {
  fomoUserId: string | null;
  fomoHandle: string | null;
  displayName: string | null;
  side: string | null;
  tokenAddress: string | null;
  tokenSymbol: string | null;
  networkId: number | null;
  usdValue: number | null;
  tradeId: string | null;
}

// A trade held in client state. The WS payload carries no timestamp, so the
// arrival time is stamped on receipt; `key` gives React a stable list key even
// when tradeId is missing (backend can't dedup those, but we still render them).
export interface FomoTrade extends FomoTradeEvent {
  receivedAt: number;
  key: string;
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
  ensureFollows: boolean;
}

export interface FomoHolderOverlap {
  trackedCount: number;
  trackedHandles: string[];
}
