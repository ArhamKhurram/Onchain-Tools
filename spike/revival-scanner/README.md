# Revival scanner de-risking spike (Sprint 1, Workstream C)

**This is a measurement, not a product.** It answers one question: does the
ATR-based revival signal defined in `PROJECT_CONTEXT.md` have alpha on real
Solana swap data? Results live in [`REPORT.md`](REPORT.md).

Not a workspace — deliberately outside the root `package.json` workspaces.
Plain Node (v22+, ESM, zero runtime deps except the substreams client libs
used by the C1 hello-world).

## Credentials

Read at runtime from `backend/.env` (`PINAX_API_KEY`, `PINAX_API_TOKEN`).
Never committed, copied, or printed. Override with env vars of the same name.

## Pipeline

```
universe.js  -> data/universe.json        (~130 SOL-quoted meme pools, sampled
                                           across the window to reduce
                                           survivorship bias)
backfill.js  -> data/swaps/<pool>.jsonl   (normalized SwapEvents, 28 days,
                                           HTTP pages disk-cached; reruns free)
measure.js   -> data/measurement.json     (replay + per-gate-combo metrics)
```

Shared single code path (backtest == would-be-live):

- `candles.js` — incremental 1m candles; close = per-candle VWAP; high/low
  from 15s sub-bucket VWAPs (single sandwich swaps cannot print a wick);
  forward-filled empty minutes.
- `indicators.js` — incremental ATR% (Wilder 14), ATR%-expansion z-score vs
  the token's own trailing 24h baseline, RVOL, rolling unique buyers,
  buy/sell ratio. Floored denominators everywhere.
- `detector.js` — trigger (z-score) + hard AND-gates + dormancy precondition
  + cooldown. `episodes.js` — C0 episode labeling (same DormancyTracker).

## Run

```sh
npm install            # only needed for the C1 gRPC hello-world
node src/universe.js
node src/backfill.js   # ~20-40 min first run, cached afterwards
node src/measure.js
node src/selftest.js   # synthetic-tape sanity checks
node src/grpc-hello.js --module map_events --blocks 3 --auth key   # C1
```

All thresholds live in `src/config.js` and are provisional.
