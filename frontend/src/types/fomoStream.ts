// Types for the 985monitor.xyz live event stream. Mirrors the backend contract
// in backend/src/fomo/streamNormalize.ts and the /api/fomo/stream/* routes.
//
// SCOPE: this is a third party's re-broadcast of fomo.family activity, not
// OCT's own fomo.family feed and not the blocked service account restored. Every
// surface that renders these types has to say so — see FomoStreamTape.

export interface FomoStreamEnvelope {
  source: '985monitor-stream';
  sourceLabel: string;
  sourceUrl: string;
  scope: string;
  available: boolean;
  error?: string;
}

export interface FomoStreamTrade {
  id: string;
  /** Epoch ms. */
  ts: number;
  side: 'buy' | 'sell' | 'thesis' | null;
  handle: string | null;
  displayName: string | null;
  avatar: string | null;
  followers: number | null;
  usd: number | null;
  amount: number | null;
  tokenAddress: string | null;
  symbol: string | null;
  tokenImage: string | null;
  chainId: number | null;
  chainName: string | null;
  marketCap: number | null;
  priceUsd: number | null;
  comment: string | null;
  txUrl: string | null;
}

/** A trade held in client state; `key` keeps React keys stable across dedupe. */
export interface FomoStreamTradeEntry extends FomoStreamTrade {
  receivedAt: number;
  key: string;
}

export interface FomoStreamListenerStatus {
  enabled: boolean;
  connected: boolean;
  connectedAt: string | null;
  lastEventAt: string | null;
  lastTradeAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  reconnects: number;
  tradesSeen: number;
  sourceUrl: string;
}

export interface FomoStreamStatusResponse extends FomoStreamEnvelope {
  listener: FomoStreamListenerStatus;
  bufferedTrades: number;
}

export interface FomoStreamTapeResponse extends FomoStreamEnvelope {
  listenerEnabled: boolean;
  trades: FomoStreamTrade[];
}
