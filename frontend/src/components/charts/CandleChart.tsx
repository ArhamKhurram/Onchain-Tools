import { useEffect, useRef } from 'react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { ChartCandle, CandleTimeframe } from '../../lib/candlesApi';
import { minMoveFor, pricePrecisionFor, toCandlePoints, toVolumePoints } from '../../lib/candleSeries';
import { readChartPalette, type ChartPalette } from '../../lib/chartTheme';

// The one file that imports `lightweight-charts`. It is reached ONLY through
// `React.lazy` from CandleChartPanel, and the library is pinned to its own
// `vendor-candles` chunk in vite.config.ts — so the ~60 kB gzip of canvas
// charting is paid once, on the first click of a "Chart" button, and never on
// the boot path. Keep it that way: nothing outside components/charts/ should
// import this module or the library.
//
// Everything visual here is the library's own drawing. There is no OCT motion
// on candles — the data is the stream, and the stream does not animate (see the
// rule at the top of lib/motion.ts). The container fades in, and that fade lives
// in the panel, not here.

interface CandleChartProps {
  candles: readonly ChartCandle[];
  timeframe: CandleTimeframe;
  className?: string;
}

/** Push the current palette into an existing chart — used on mount and on theme flips. */
function applyPalette(
  chart: IChartApi,
  candleSeries: ISeriesApi<'Candlestick'>,
  volumeSeries: ISeriesApi<'Histogram'>,
  p: ChartPalette,
): void {
  chart.applyOptions({
    layout: {
      background: { type: ColorType.Solid, color: p.background },
      textColor: p.muted,
      fontFamily: p.fontFamily,
      // 12px is the console's type floor (`text-2xs`); the library defaults to 11.
      fontSize: 12,
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: p.grid, style: LineStyle.Solid },
      horzLines: { color: p.grid, style: LineStyle.Solid },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: p.crosshair, labelBackgroundColor: p.border },
      horzLine: { color: p.crosshair, labelBackgroundColor: p.border },
    },
    rightPriceScale: { borderColor: p.border },
    timeScale: { borderColor: p.border },
  });
  candleSeries.applyOptions({
    upColor: p.up,
    downColor: p.down,
    borderUpColor: p.up,
    borderDownColor: p.down,
    wickUpColor: p.up,
    wickDownColor: p.down,
  });
  volumeSeries.applyOptions({ color: p.muted });
}

export default function CandleChart({ candles, timeframe, className }: CandleChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const paletteRef = useRef<ChartPalette>(readChartPalette());
  // First data set fits the whole window; later refreshes must not yank the
  // viewport back while the user is zoomed into a region.
  const fittedRef = useRef(false);
  // Latest candles, readable from the theme observer without re-subscribing it.
  const candlesRef = useRef(candles);
  candlesRef.current = candles;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      handleScale: { axisPressedMouseMove: true },
      timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 4 },
      rightPriceScale: { scaleMargins: { top: 0.08, bottom: 0.22 } },
      localization: { locale: 'en-US' },
    });
    const candleSeries = chart.addSeries(CandlestickSeries, {});
    // Volume rides the same pane on an overlay scale squeezed into the bottom
    // fifth, so it reads as context for the candles rather than a second chart.
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    applyPalette(chart, candleSeries, volumeSeries, paletteRef.current);
    chartRef.current = chart;
    candleRef.current = candleSeries;
    volumeRef.current = volumeSeries;
    fittedRef.current = false;

    // The theme toggle flips `data-theme` on <html>; the canvas has no other way
    // to hear about it.
    const observer = new MutationObserver(() => {
      paletteRef.current = readChartPalette();
      applyPalette(chart, candleSeries, volumeSeries, paletteRef.current);
      // Volume bar colours are baked into the data points, so re-tint them too.
      volumeSeries.setData(
        toVolumePoints(candlesRef.current, paletteRef.current.up, paletteRef.current.down).map((v) => ({
          ...v,
          time: v.time as UTCTimestamp,
        })),
      );
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = candleRef.current;
    const volumeSeries = volumeRef.current;
    if (!chart || !candleSeries || !volumeSeries) return;

    const points = toCandlePoints(candles);
    const p = paletteRef.current;
    const last = points.length > 0 ? points[points.length - 1].close : 0;
    const precision = pricePrecisionFor(last);
    candleSeries.applyOptions({ priceFormat: { type: 'price', precision, minMove: minMoveFor(precision) } });
    candleSeries.setData(points.map((c) => ({ ...c, time: c.time as UTCTimestamp })));
    volumeSeries.setData(toVolumePoints(candles, p.up, p.down).map((v) => ({ ...v, time: v.time as UTCTimestamp })));

    if (!fittedRef.current && points.length > 0) {
      chart.timeScale().fitContent();
      fittedRef.current = true;
    }
  }, [candles]);

  // A timeframe change is a new window; let the next data set refit.
  useEffect(() => {
    fittedRef.current = false;
  }, [timeframe]);

  return <div ref={containerRef} className={className} />;
}
