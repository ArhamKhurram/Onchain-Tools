// Fetch layer for GET /api/tokens/:network/:address/candles — the read-only OHLCV
// proxy behind the console candlestick chart. Public market data, nothing spends,
// so it uses `apiFetch` + `API_BASE` like the pump.fun client (and NOT sniperApi).
//
// The backend answers from a short TTL cache (60s for 1m candles, 5m for 1h) in
// front of a provider budget of ~6-8 requests/minute shared with the revival
// detector. `useCandles` pins its refresh interval to those TTLs — asking faster
// only returns the same cached bytes.

import { apiFetch, API_BASE } from '../stores/appStore.helpers';

export type CandleTimeframe = '1m' | '1h';

/** Compact wire shape: bucket-start ms, open/high/low/close USD, volume USD. */
export interface ChartCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface CandleSet {
  network: string;
  address: string;
  timeframe: CandleTimeframe;
  source: 'pinax' | 'geckoterminal';
  pool: { address: string; symbol: string | null };
  candles: ChartCandle[];
}

export type CandlesResult =
  | { ok: true; data: CandleSet }
  | {
      ok: false;
      status: number;
      error: string;
      /** 503: the source is backed off; the hook keeps its refresh timer and tries again. */
      retryable: boolean;
    };

/** Bucket width in ms, for detecting a stale last candle and for the refresh cadence. */
export const TIMEFRAME_MS: Record<CandleTimeframe, number> = { '1m': 60_000, '1h': 3_600_000 };

/** Mirrors the server TTLs — the refresh cadence that actually yields new data. */
export const REFRESH_MS: Record<CandleTimeframe, number> = { '1m': 60_000, '1h': 5 * 60_000 };

export async function fetchCandles(
  network: string,
  address: string,
  timeframe: CandleTimeframe,
  signal?: AbortSignal,
): Promise<CandlesResult> {
  const url = `${API_BASE}/tokens/${encodeURIComponent(network)}/${encodeURIComponent(address)}/candles?tf=${timeframe}`;
  let res: Response;
  try {
    res = await apiFetch(url, { signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    return { ok: false, status: 0, error: 'Network error.', retryable: true };
  }
  if (!res.ok) {
    let error = `Request failed (${res.status}).`;
    try {
      const body = (await res.json()) as unknown;
      if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
        error = (body as { error: string }).error;
      }
    } catch {
      // non-JSON error body — keep the status fallback
    }
    return { ok: false, status: res.status, error, retryable: res.status === 503 || res.status === 429 };
  }
  return { ok: true, data: (await res.json()) as CandleSet };
}
