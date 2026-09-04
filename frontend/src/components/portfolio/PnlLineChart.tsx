import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { formatUsd } from '../../types/portfolio';
import { cn } from '../../lib/utils';
import {
  monotoneXPath,
  nearestIndex,
  niceScale,
  xLabelStep,
} from '../../utils/lineChartGeometry';

/**
 * Hand-rolled SVG line chart for the Portfolio PnL modal.
 *
 * Replaces the recharts `<LineChart>` (the only chart in the app) with ~zero
 * vendor bytes while keeping the same shape: dashed grid, mono ticks, a
 * monotone curve with r=3 dots, and a tooltip that snaps to the nearest point
 * with a vertical cursor line.
 *
 * Colour and type come from the theme rather than the old hard-coded recharts
 * hexes, so the chart follows the light/dark palette: grid and axes on the
 * border token, ticks on `text-oct-muted`, the series on the brand accent (it
 * is the chart's one line, not a status, so it is not good/critical), and tick
 * text at the 12px `text-2xs` floor. Theme colours are applied as classes —
 * `stroke-oct-*` / `fill-oct-*` — because SVG presentation attributes cannot
 * resolve `var()`. Geometry is untouched.
 */

export interface PnlChartPoint {
  date: string;
  cumulativePnl: number;
}

// Theme classes standing in for the old recharts hexes (#333 grid, #666 axis,
// #888 ticks, #ff3b3b line, #ccc cursor).
const GRID_CLASS = 'stroke-oct-border';
const AXIS_CLASS = 'stroke-oct-muted/60';
const TICK_CLASS = 'fill-oct-muted type-data text-2xs';
const LINE_CLASS = 'stroke-oct-accent';
const DOT_CLASS = 'fill-oct-accent';
const CURSOR_CLASS = 'stroke-oct-muted';

// Layout mirrors the old chart: margin {top:8,right:12,left:0,bottom:0},
// YAxis width 72, recharts' default XAxis height 30.
const MARGIN = { top: 8, right: 12, left: 0, bottom: 0 };
const Y_AXIS_W = 72;
const X_AXIS_H = 30;
const TICK_LINE = 6;

export default function PnlLineChart({ data }: { data: PnlChartPoint[] }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [hover, setHover] = useState<{ index: number; mouseY: number } | null>(null);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setSize({ w: Math.floor(rect.width), h: Math.floor(rect.height) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const geom = useMemo(() => {
    const { w, h } = size;
    if (w <= 0 || h <= 0 || data.length === 0) return null;

    const plotX = MARGIN.left + Y_AXIS_W;
    const plotY = MARGIN.top;
    const plotW = w - plotX - MARGIN.right;
    const plotH = h - plotY - X_AXIS_H - MARGIN.bottom;
    if (plotW <= 0 || plotH <= 0) return null;

    const values = data.map((d) => d.cumulativePnl);
    const scale = niceScale(Math.min(...values), Math.max(...values));
    const yFor = (v: number) =>
      plotY + plotH - ((v - scale.min) / (scale.max - scale.min)) * plotH;

    // Category point-scale: first point on the left edge, last on the right
    // (same as recharts' category XAxis on a LineChart).
    const xs = data.map((_, i) =>
      data.length === 1 ? plotX + plotW / 2 : plotX + (i / (data.length - 1)) * plotW,
    );
    const pts = data.map((d, i) => ({ x: xs[i], y: yFor(d.cumulativePnl) }));

    // ~"MM-DD" at 12px mono ≈ 36px + breathing room.
    const step = xLabelStep(data.length, plotW, 44);

    return { plotX, plotY, plotW, plotH, scale, yFor, xs, pts, step };
  }, [size, data]);

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!geom) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    if (
      px < geom.plotX - 4 ||
      px > geom.plotX + geom.plotW + 4 ||
      py < geom.plotY ||
      py > geom.plotY + geom.plotH + X_AXIS_H
    ) {
      setHover(null);
      return;
    }
    const idx = nearestIndex(geom.xs, px);
    if (idx >= 0) setHover({ index: idx, mouseY: py });
  };

  if (data.length === 0) return null;

  const active = hover && geom ? data[hover.index] : null;

  // Tooltip placement: to the right of the point, flipped when near the edge.
  let tipLeft = 0;
  let tipTop = 0;
  let tipFlip = false;
  if (hover && geom) {
    const px = geom.xs[hover.index];
    tipFlip = px > geom.plotX + geom.plotW * 0.62;
    tipLeft = px + (tipFlip ? -12 : 12);
    tipTop = Math.min(Math.max(hover.mouseY - 20, geom.plotY), geom.plotY + geom.plotH - 44);
  }

  return (
    <div ref={wrapRef} className="relative w-full h-full">
      {geom && (
        <svg
          width={size.w}
          height={size.h}
          className="block"
          role="img"
          aria-label="Cumulative PnL line chart"
          onMouseMove={handleMove}
          onMouseLeave={() => setHover(null)}
        >
          {/* grid */}
          {geom.scale.ticks.map((t) => (
            <line
              key={`gy${t}`}
              x1={geom.plotX}
              x2={geom.plotX + geom.plotW}
              y1={geom.yFor(t)}
              y2={geom.yFor(t)}
              className={GRID_CLASS}
              strokeDasharray="3 3"
            />
          ))}
          {geom.xs.map((x, i) =>
            i % geom.step === 0 ? (
              <line
                key={`gx${i}`}
                x1={x}
                x2={x}
                y1={geom.plotY}
                y2={geom.plotY + geom.plotH}
                className={GRID_CLASS}
                strokeDasharray="3 3"
              />
            ) : null,
          )}

          {/* Y axis */}
          <line
            x1={geom.plotX}
            x2={geom.plotX}
            y1={geom.plotY}
            y2={geom.plotY + geom.plotH}
            className={AXIS_CLASS}
          />
          {geom.scale.ticks.map((t) => (
            <g key={`yt${t}`}>
              <line
                x1={geom.plotX - TICK_LINE}
                x2={geom.plotX}
                y1={geom.yFor(t)}
                y2={geom.yFor(t)}
                className={AXIS_CLASS}
              />
              <text
                x={geom.plotX - TICK_LINE - 3}
                y={geom.yFor(t)}
                textAnchor="end"
                dominantBaseline="central"
                className={TICK_CLASS}
              >
                {formatUsd(t, { signed: true })}
              </text>
            </g>
          ))}

          {/* X axis */}
          <line
            x1={geom.plotX}
            x2={geom.plotX + geom.plotW}
            y1={geom.plotY + geom.plotH}
            y2={geom.plotY + geom.plotH}
            className={AXIS_CLASS}
          />
          {geom.xs.map((x, i) =>
            i % geom.step === 0 ? (
              <g key={`xt${i}`}>
                <line
                  x1={x}
                  x2={x}
                  y1={geom.plotY + geom.plotH}
                  y2={geom.plotY + geom.plotH + TICK_LINE}
                  className={AXIS_CLASS}
                />
                <text
                  x={x}
                  y={geom.plotY + geom.plotH + TICK_LINE + 12}
                  textAnchor="middle"
                  className={TICK_CLASS}
                >
                  {data[i].date}
                </text>
              </g>
            ) : null,
          )}

          {/* cursor */}
          {hover && (
            <line
              x1={geom.xs[hover.index]}
              x2={geom.xs[hover.index]}
              y1={geom.plotY}
              y2={geom.plotY + geom.plotH}
              className={CURSOR_CLASS}
              strokeWidth={1}
              opacity={0.6}
            />
          )}

          {/* line + dots */}
          <path d={monotoneXPath(geom.pts)} fill="none" className={LINE_CLASS} strokeWidth={2} />
          {geom.pts.map((p, i) => (
            <circle key={`d${i}`} cx={p.x} cy={p.y} r={3} className={DOT_CLASS} />
          ))}
          {hover && (
            <circle
              cx={geom.pts[hover.index].x}
              cy={geom.pts[hover.index].y}
              r={4.5}
              className={cn(DOT_CLASS, 'stroke-oct-text')}
              strokeWidth={1}
            />
          )}
        </svg>
      )}

      {/* tooltip — placement stays inline (it is geometry); the chrome is themed */}
      {active && (
        <div
          className="pointer-events-none absolute z-10 whitespace-nowrap rounded-oct-sm border border-oct-border bg-oct-elevated shadow-oct-soft px-cozy py-snug type-data text-2xs"
          style={{
            left: tipLeft,
            top: tipTop,
            transform: tipFlip ? 'translateX(-100%)' : undefined,
          }}
        >
          <div className="text-oct-muted">Date: {active.date}</div>
          <div className="text-oct-accent mt-hair">
            Cumulative : {formatUsd(active.cumulativePnl, { signed: true })}
          </div>
        </div>
      )}
    </div>
  );
}
