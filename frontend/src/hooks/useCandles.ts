import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchCandles, REFRESH_MS, type CandleSet, type CandleTimeframe } from '../lib/candlesApi';

// OHLCV for one token at one timeframe, kept fresh on the server's own cadence.
//
// Two rules shape this hook:
//   - Refresh is pinned to the backend TTL (`REFRESH_MS`). The endpoint answers
//     from a cache in front of a provider budget of ~6-8 requests/minute shared
//     with the revival detector; polling faster returns identical bytes.
//   - Ordering guard, same as usePumpToken: flipping timeframe or token quickly can
//     land an older response after a newer one. Only the newest load may write.
//
// A retryable failure (503 backed off / 429) keeps the last good candles on screen
// and lets the timer try again — a chart that blanks itself every time the provider
// hiccups would be worse than a slightly stale one.

export interface CandlesState {
  data: CandleSet | null;
  loading: boolean;
  error: string | null;
  retryable: boolean;
}

export function useCandles(network: string | null, address: string | null, timeframe: CandleTimeframe) {
  const [state, setState] = useState<CandlesState>({ data: null, loading: false, error: null, retryable: false });
  const requestId = useRef(0);

  const load = useCallback(
    async (net: string, addr: string, tf: CandleTimeframe, signal: AbortSignal) => {
      const id = (requestId.current += 1);
      setState((s) => ({ ...s, loading: true }));
      let result;
      try {
        result = await fetchCandles(net, addr, tf, signal);
      } catch {
        return; // aborted — the effect that aborted us owns the next state
      }
      if (id !== requestId.current) return;
      if (result.ok) {
        setState({ data: result.data, loading: false, error: null, retryable: false });
      } else {
        // Keep stale-but-good data through a retryable blip; a hard error clears it.
        setState((s) => ({
          data: result.retryable ? s.data : null,
          loading: false,
          error: result.error,
          retryable: result.retryable,
        }));
      }
    },
    [],
  );

  useEffect(() => {
    if (!network || !address) {
      requestId.current += 1;
      setState({ data: null, loading: false, error: null, retryable: false });
      return;
    }
    const controller = new AbortController();
    // A token/timeframe switch must not show the previous token's candles while
    // the new set loads.
    setState({ data: null, loading: true, error: null, retryable: false });
    void load(network, address, timeframe, controller.signal);
    const timer = window.setInterval(
      () => void load(network, address, timeframe, controller.signal),
      REFRESH_MS[timeframe],
    );
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [network, address, timeframe, load]);

  const refresh = useCallback(() => {
    if (network && address) void load(network, address, timeframe, new AbortController().signal);
  }, [network, address, timeframe, load]);

  return { ...state, refresh };
}
