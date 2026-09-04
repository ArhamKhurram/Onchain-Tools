---
title: 'ADR-013: Candlestick charts use lightweight-charts'
description: Why the console's OHLC chart is TradingView's lightweight-charts and not bklit, and how it stays off the boot path.
sidebar:
  order: 13
  label: '013 — Candlestick library'
---

**Status:** Accepted (2026-09)

## Context

The console had no candlestick view. The revamp asked for one on the token
surface, and for an evaluation of [bklit](https://bklit.com) against the
incumbent choice for financial charts, TradingView's
[lightweight-charts](https://github.com/tradingview/lightweight-charts).

The frontend constraints that decide this are already fixed elsewhere:

- The boot path is `index` + `vendor-react` + CSS. Anything heavy must be lazy.
- Colours come from the `--oct-*` tokens; up/down must be `oct-good` /
  `oct-critical` (not the brand accent, which is red in the dark theme) and
  must follow the light/dark toggle.
- Motion runs `LazyMotion` in strict mode: a stray `motion.div` throws. The
  project is on `motion@13`.
- The PnL line chart is hand-rolled SVG; no charting framework is a dependency.

### The two candidates, on the same axes

| | **bklit** (`@bklitui/ui`) | **lightweight-charts** |
| --- | --- | --- |
| What it is | shadcn-style registry: `npx shadcn add @bklit/candlestick-chart` copies component **source** into your repo | A versioned npm library |
| Version / publish | `0.0.0` in the monorepo; no npm release; last push 2026-07-28 | 5.2.1, published 2026-08-12 |
| License | MIT (components); Studio editor is proprietary | Apache-2.0 |
| Renderer | SVG via **visx** (`@visx/*` pinned at `4.0.1-alpha.0`) + `d3-*` | HTML5 canvas, one dependency (`fancy-canvas`) |
| Runtime deps you inherit | 13 `@visx/*` packages, 4 `d3-*`, `@base-ui/react` **alpha**, `motion@^12`, `@number-flow/react`, `react-use-measure` | none beyond `fancy-canvas` |
| Bundle | Not measurable as a unit (copy-in + visx tree); visx candlestick path alone is well north of the whole of lightweight-charts | **194 kB raw / 61.6 kB gzip** (bundlephobia); chunked here as `vendor-candles` **168.8 kB raw / 54.3 kB gzip** (Vite 6, minified) |
| React 19 | Peer `^18 \|\| ^19` | Framework-agnostic; mounts on a `ref`. Works with React 19 by construction |
| Candlestick OHLC | Yes, `positiveFill` / `negativeFill` props | Yes, first-class `CandlestickSeries` |
| Zoom / pan / crosshair | Not offered on the candlestick | Built in (wheel zoom, drag pan, crosshair, time axis) |
| Dark theme / CSS vars | Reads `--chart-1` / `--chart-5` **shadcn** variables, i.e. assumes the shadcn token set | Canvas — colours are strings. A 30-line bridge (`lib/chartTheme.ts`) resolves `--oct-*` at runtime and re-applies on theme flip |
| Fit with this repo | Needs `shadcn init` + Tailwind token conventions the repo does not use; ships `motion.*` components that would throw under strict `LazyMotion`; pins alpha packages | Drop-in |

## Decision

**lightweight-charts.** It is the only one of the two that is an actual
library with a version to pin, a license for the whole thing, a one-package
dependency tree and a bundle size that can be measured and budgeted.

bklit is a good shadcn registry, and that is the problem: it is designed for a
project that has adopted shadcn's tokens and conventions, and it brings visx,
d3, an alpha `@base-ui/react` and a second copy of `motion` with it. Adopting it
here means either adopting shadcn or forking the copied source on day one.

Three rules follow from the decision and are enforced in code:

1. **One import site.** `components/charts/CandleChart.tsx` is the only module
   that imports `lightweight-charts`. It is reached only through `React.lazy`
   from `CandleChartPanel`, which itself renders only after a user presses
   *Chart*. `vite.config.ts` pins the library (and `fancy-canvas`) to a
   `vendor-candles` chunk so its weight is visible and its hash stable.
2. **Colours are tokens, resolved late.** `lib/chartTheme.ts` reads
   `--oct-good`, `--oct-critical`, `--oct-text`, `--oct-muted`, `--oct-border`,
   `--oct-panel` from computed style and re-applies them when `data-theme`
   changes. Nothing in the chart hard-codes a hue.
3. **Candles do not animate.** The panel container fades in (chrome); the
   canvas draws whatever the library draws. No OCT motion touches the data.

## Consequences

- One new production dependency (`lightweight-charts@^5.2.1`), Apache-2.0,
  loaded on demand. `index` / `vendor-react` / `index.css` are unchanged.
- The data side is a read-only proxy, `GET /api/tokens/:network/:address/candles`,
  over the revival subsystem's existing Pinax / GeckoTerminal sources — no new
  provider, no new key. It sits behind a 60 s (1m) / 5 min (1h) server cache with
  in-flight coalescing because GeckoTerminal's keyless tier really does grant
  only ~6-8 requests/minute across the whole backend (see
  [Revival detection](/architecture/revival/)).
- Only the chains those sources index chart: Solana, BNB Chain, Robinhood Chain.
  A token on any other chain gets a 400, not a blank canvas.
- If bklit later ships as a versioned npm package with a stable visx and no
  shadcn token assumption, revisit — but the bundle argument would still have
  to be won against 54 kB gzip.
