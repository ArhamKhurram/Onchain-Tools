// Types for the robinhoodtrenches source. Mirrors the backend contract in
// backend/src/robinhood/normalize.ts and routes.ts.
//
// SCOPE: robinhoodtrenches indexes Robinhood Chain (chain 4663) only. It is not
// a fomo.family proxy and has no Solana or BSC data. Every surface that renders
// these types has to say so — see ROBINHOOD_SCOPE in components/robinhood.

/** The scope envelope every /api/robinhood response carries. */
export interface RobinhoodEnvelope {
  source: 'robinhoodtrenches';
  sourceLabel: string;
  sourceUrl: string;
  scope: string;
  chainId: number;
  available: boolean;
  /** True when the payload came from cache because the upstream was unreachable. */
  stale?: boolean;
  error?: string;
}

export interface RobinhoodFill {
  id: number;
  /** Seconds since epoch, as published upstream. */
  ts: number;
  tx: string | null;
  side: 'buy' | 'sell' | null;
  usd: number | null;
  amount: number | null;
  price: number | null;
  handle: string | null;
  displayName: string | null;
  followers: number | null;
  wallet: string | null;
  token: string | null;
  symbol: string | null;
  name: string | null;
  mark: number | null;
  liquidity: number | null;
  pairUrl: string | null;
  isStock: boolean | null;
  newPosition: boolean | null;
}

/** A fill held in client state; `receivedAt` is only used for ordering ties. */
export interface RobinhoodFillEntry extends RobinhoodFill {
  receivedAt: number;
  key: string;
}

export interface RobinhoodUpstreamStatus {
  ok: boolean;
  chainId: number | null;
  wallets: number | null;
  trades: number | null;
  lastTs: number | null;
  lagSeconds: number | null;
  lastBlock: number | null;
  source: string | null;
}

export interface RobinhoodStatusResponse extends RobinhoodEnvelope {
  upstream: RobinhoodUpstreamStatus | null;
  pollerEnabled: boolean;
  bufferedFills: number;
}

export interface RobinhoodRadarRow {
  token: string;
  symbol: string | null;
  name: string | null;
  buyers: number | null;
  usdIn: number | null;
  mark: number | null;
  liquidity: number | null;
  pairCreatedAt: number | null;
  pairUrl: string | null;
  change24: number | null;
  firstTs: number | null;
  fresh: boolean | null;
  isStock: boolean | null;
  firstBuyer: { handle: string | null; followers: number | null; ts: number | null } | null;
}

export interface RobinhoodTapeResponse extends RobinhoodEnvelope {
  fills: RobinhoodFill[];
}

export interface RobinhoodRadarResponse extends RobinhoodEnvelope {
  rows: RobinhoodRadarRow[];
}
