import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { formatUsd } from '../../types/portfolio';
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
 * vendor bytes while keeping the exact look: dashed #333 grid, #888 10px mono
 * ticks, #ff3b3b monotone curve with r=3 dots, and the black-bordered #111
 * tooltip that snaps to the nearest point with a vertical cursor line.
 */

export interface PnlChartPoint {
  date: string;
  cumulativePnl: number;
}

// Colors lifted verbatim from the old recharts props (plus recharts' own
// defaults for axis lines #666 and the tooltip cursor #ccc).
const GRID_STROKE = '#333';
const AXIS_STROKE = '#666';
const TICK_FILL = '#888';
const LINE_STROKE = '#ff3b3b';
const CURSOR_STROKE = '#ccc';

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

    // ~"MM-DD" at 10px mono ≈ 30px + breathing room.
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
              stroke={GRID_STROKE}
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
                stroke={GRID_STROKE}
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
            stroke={AXIS_STROKE}
          />
          {geom.scale.ticks.map((t) => (
            <g key={`yt${t}`}>
              <line
                x1={geom.plotX - TICK_LINE}
                x2={geom.plotX}
                y1={geom.yFor(t)}
                y2={geom.yFor(t)}
                stroke={AXIS_STROKE}
              />
              <text
                x={geom.plotX - TICK_LINE - 3}
                y={geom.yFor(t)}
                textAnchor="end"
                dominantBaseline="central"
                fontSize={10}
                fill={TICK_FILL}
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
            stroke={AXIS_STROKE}
          />
          {geom.xs.map((x, i) =>
            i % geom.step === 0 ? (
              <g key={`xt${i}`}>
                <line
                  x1={x}
                  x2={x}
                  y1={geom.plotY + geom.plotH}
                  y2={geom.plotY + geom.plotH + TICK_LINE}
                  stroke={AXIS_STROKE}
                />
                <text
                  x={x}
                  y={geom.plotY + geom.plotH + TICK_LINE + 12}
                  textAnchor="middle"
                  fontSize={10}
                  fill={TICK_FILL}
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
              stroke={CURSOR_STROKE}
              strokeWidth={1}
              opacity={0.6}
            />
          )}

          {/* line + dots */}
          <path d={monotoneXPath(geom.pts)} fill="none" stroke={LINE_STROKE} strokeWidth={2} />
          {geom.pts.map((p, i) => (
            <circle key={`d${i}`} cx={p.x} cy={p.y} r={3} fill={LINE_STROKE} />
          ))}
          {hover && (
            <circle
              cx={geom.pts[hover.index].x}
              cy={geom.pts[hover.index].y}
              r={4.5}
              fill={LINE_STROKE}
              stroke="#fff"
              strokeWidth={1}
            />
          )}
        </svg>
      )}

      {/* tooltip — same contentStyle the recharts Tooltip carried */}
      {active && (
        <div
          className="pointer-events-none absolute z-10 whitespace-nowrap"
          style={{
            left: tipLeft,
            top: tipTop,
            transform: tipFlip ? 'translateX(-100%)' : undefined,
            background: '#111',
            border: '2px solid #000',
            fontFamily: 'monospace',
            fontSize: 11,
            padding: '8px 10px',
          }}
        >
          <div style={{ color: '#ccc' }}>Date: {active.date}</div>
          <div style={{ color: LINE_STROKE, marginTop: 2 }}>
            Cumulative : {formatUsd(active.cumulativePnl, { signed: true })}
          </div>
        </div>
      )}
    </div>
  );
}
