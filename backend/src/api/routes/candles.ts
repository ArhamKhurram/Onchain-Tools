import { Router } from 'express';
import type { RouterContext } from '../context.js';
import { safeError } from '../shared.js';
import {
  chartCandleService,
  isChartAddress,
  parseChartLimit,
  parseChartNetwork,
  parseChartTimeframe,
  type ChartCandleService,
} from '../../charts/chartCandles.js';

// OHLCV for the console candlestick chart. Read-only, keyless from the client's
// point of view, and deliberately thin: validation, then the cached service
// (see backend/src/charts/chartCandles.ts for why the cache is the point).
//
// Not user-scoped — candles are public market data and the same for everyone,
// so the cache is shared across users on purpose. `RouterContext` is accepted
// for signature parity with the other sub-routers; nothing in it is needed.
export function createCandlesRoutes(_ctx: RouterContext, service: ChartCandleService = chartCandleService): Router {
  const router = Router();

  router.get('/tokens/:network/:address/candles', async (req, res) => {
    try {
      const network = parseChartNetwork(req.params.network);
      if (!network) {
        return res.status(400).json({ error: 'Unsupported network. Use solana, bsc or robinhood.' });
      }
      const { address } = req.params;
      if (!isChartAddress(address)) {
        return res.status(400).json({ error: 'Invalid token address.' });
      }
      const timeframe = parseChartTimeframe(req.query.tf ?? '1m');
      if (!timeframe) {
        return res.status(400).json({ error: 'Unsupported timeframe. Use 1m or 1h.' });
      }
      const limit = parseChartLimit(req.query.limit, timeframe);

      const result = await service.get(network, address, timeframe, limit);
      if (result.status === 'no_pool') {
        return res.status(404).json({ error: 'No pool indexed for this token on that chain.' });
      }
      if (result.status === 'unavailable') {
        // The source is rate-limit backed off or the provider blipped. Tell the
        // client to try again in a TTL rather than painting an empty chart as fact.
        res.setHeader('Retry-After', '60');
        return res.status(503).json({ error: 'Candles temporarily unavailable. Retrying shortly.', retryable: true });
      }
      const { source, pool, candles } = result.data;
      res.json({
        network,
        address,
        timeframe,
        source,
        pool,
        // Compact wire shape — a 1000-candle set at full key names is ~2x the bytes
        // for no benefit, and this endpoint is polled.
        candles: candles.map((c) => ({ t: c.ts, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume })),
      });
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to load candles') });
    }
  });

  return router;
}
