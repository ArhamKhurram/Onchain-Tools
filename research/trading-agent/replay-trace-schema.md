# Replay-trace contract

The data layer behind the **trade-replay browser**: pick any actor — an archive champion or a
harvested census wallet — and watch exactly what it did on a token's chart, trade by trade
(trickshot-style). Sibling of [`desk-telemetry-schema.md`](./desk-telemetry-schema.md): that file is
the *population-evolution* viz contract; this one is the *per-actor replay* contract. Producer code
lives in `src/oct_trading_agent/traces/`.

Because "replay" ultimately means **every trade of every actor** (potentially hundreds of thousands
of (actor, token) pairs), the layer is three tiers — a scalable substrate, an on-demand builder,
and a bounded curated showcase — not a pre-rendered file per pair.

Provenance note: price series are derived from the captured Pinax-decoded swap rows
(`MarketSwapDataset` pool parquets). trickshot derives its prices from raw per-pool balance deltas;
Pinax pre-decodes exactly that for us, so this layer starts one level above trickshot's data
acquisition.

## Layout on disk

```
data/replay_traces/                       # gitignored (under /data/), fully regenerable
  trade_log/<segment>.parquet             # tier 1: one row per TRADE; one file per producing run
  actors/<segment>.parquet                # tier 1: the browsing index (one row per actor)
  mint_index.parquet                      # mint -> (amm_pool, n_rows); built once, cached
  curated/<group>/<actor>/<mint>.json     # tier 3: bounded showcase traces
  curated/index.json                      # tier 3: browsing manifest for the showcase
```

## Tier 1 — the trade-log substrate (parquet)

One row per **trade** (never per hold/no-op). Schema (`traces/log.py::TRADE_LOG_SCHEMA`):

| column         | type    | agents                                        | wallets                          |
| -------------- | ------- | --------------------------------------------- | -------------------------------- |
| `actor_id`     | str     | archive agent id (`seed003`, `c0042`)         | wallet address                   |
| `actor_kind`   | str     | `"agent"`                                     | `"wallet"`                       |
| `group_id`     | str     | training `run_id`                             | cohort (`census-winners`, …)     |
| `mint`         | str     | token traded                                  | token traded                     |
| `t`            | i64     | decision instant (epoch s)                    | swap block time (epoch s)        |
| `seq`          | i64     | episode step index                            | trade index within (wallet,mint) |
| `side`         | str     | `"buy"` / `"sell"` (from intent)              | swap direction                   |
| `fill`         | bool    | the sim executed it                           | always `true` (it happened)      |
| `intent`       | str?    | `open_long`/`add`/`trim`/`close`              | null                             |
| `size_frac`    | f64?    | policy size fraction                          | null                             |
| `base`         | f64?    | null (env doesn't report fill amounts)        | token amount (UI units)          |
| `quote`        | f64?    | paper balance moved, cost-inclusive           | swap quote leg (SOL)             |
| `price`        | f64?    | null (never fabricated)                       | `quote / base`                   |
| `bal_after`    | f64?    | paper balance after the step                  | null (unknowable)                |
| `realized_cum` | f64?    | cumulative realized PnL (env ledger)          | cumulative FIFO realized PnL     |

Null means "the source did not carry it" — a number is **never** imputed. Wallet `realized_cum`
follows the census FIFO rules exactly (`data/census/fifo.py`): sells match oldest lots; proceeds
with no cost basis (transfer-ins) are excluded; unit-tested to land on `fifo_pair_pnl().realized_pnl`.
Agent rows record real sim fills (the eval runner's own trade criterion); a truncation-forced
liquidation appears as one final synthetic `close` row whose `realized_cum` is the episode's true
realized total and whose `quote` is null (the env never itemized it).

**Appending from a future run** (no trainer changes — producers opt in):

```python
from oct_trading_agent.traces import TradeRow
from oct_trading_agent.traces.log import TradeLogStore
from oct_trading_agent.traces.record import record_policy_rollout

store = TradeLogStore("data/replay_traces")
ep = record_policy_rollout(env, policy, actor_id="c0042", group_id=run_id)  # during any eval
store.write_segment(f"agents-{run_id}", rows)     # whole-file atomic; idempotent per segment
store.write_actors(f"agents-{run_id}", actor_rows)
```

Each producing run owns ONE segment file; re-running it replaces its segment and never touches
another run's rows; readers lazily scan `trade_log/*.parquet`, so new segments are visible with
zero coordination.

### Actors index (`actors/*.parquet`)

One row per actor: `actor_id, actor_kind, group_id, tokens_touched, n_trades,
realized_pnl_quote`, plus agent-only typed columns (`role`, `style_cell`, `pnl_bps`, `win_rate`
from the archive's held-out profile) and `meta_json` (census stats / replay provenance). This is
the replay browser's actor list.

## Tier 2 — on-demand trace builder

```
uv run python -m oct_trading_agent.traces.build \
    --root data/replay_traces --dataset data/market_dataset_snap800 \
    --actor <actor_id> --mint <mint> [--group <run|cohort>] [--out file.json]
```

`build_trace(actor_id, mint)` (in `traces/build.py`) assembles the trace JSON below at request
time: (actor, mint) rows from the trade log + the token's chart from its **busiest pool** (the
trickshot convention — the actor's trades are overlaid in full even when they span pools), via the
cached `mint_index.parquet` so it reads ONE pool file, never scanning the dataset. Measured on the
busiest real (wallet, token) pair (246 trades, 7,703-print tape): **~0.05 s cold** — far under the
2 s budget, so no request cache is needed. The one slow pass is the first-ever `mint_index` build
(a single scan of `pools/*.parquet`), cached forever after. The CLI prints JSON to stdout (timing
on stderr), so a local replay-browser server needs only a subprocess shim; no HTTP layer is
warranted yet. An ambiguous `actor_id` (two runs reusing `c0042`) is a typed error asking for
`--group`.

## Trace JSON (tiers 2 and 3 emit the identical contract)

```jsonc
{
  "schema": "replay-trace/v1",
  "actor_id": "Bt2MZcEA…",             // wallet address | archive agent id
  "actor_kind": "wallet",              // "agent" | "wallet"
  "group_id": "census-winners",        // run_id | cohort
  "mint": "FxkG9P5P…",
  "meta": { ... },                     // agents: role/style_cell/pnl_bps/win_rate + replay provenance
                                       // wallets: census stats (total_realized, mean_hold_s, …)
  "price": {
    "points": [{"t": 1787516695, "p": 2.1e-7}, ...],   // ≤500 (default), time-ordered
    "n_source": 7703,                  // prints in the source tape before downsampling
    "downsampled": true,
    "method": "bucketed-extremes: …",  // the honest sampling label (only when downsampled)
    "pool": "…",                       // busiest pool charted (trickshot convention)
    "n_pools": 2                       // pools the mint traded on in our tape
  },
  "steps": [                           // trade-log rows minus the identity columns; nulls OMITTED
    {"t": …, "seq": 0, "side": "buy", "fill": true, "base": …, "quote": …, "price": …, "realized_cum": 0.0},
    {"t": …, "seq": 1, "side": "sell", "fill": true, "intent": "close", "size_frac": 1.0, "bal": …, "realized_cum": …}
  ]
}
```

**Downsampling** (`traces/schema.py::downsample_price`): a series over the cap keeps the first and
last points plus each interior time-bucket's min AND max price, so the global extremes (wick highs,
rug lows) always survive — the chart keeps its shape; intermediate ticks are elided. Every price
kept is a real trade print (nothing is averaged or synthesized), which is what the
`method` label discloses to the viewer.

## Tier 3 — curated showcase (`curated/`)

The bounded, self-contained export a viz artifact can embed: per group, the champions' full
(bounded) re-eval, and each cohort's top wallets by census realized PnL capped at
`--curated-max-tokens` (default 24) most-consequential tokens each (largest |realized PnL| pairs —
a hyperactive bot wallet touches 900 tokens; the rest stay reachable through tier 2).
`curated/index.json` lists every group → actor → token with paths, step counts, and file sizes;
exporters merge their group entries, so agents and wallets compose without coordination. A group's
directory is regenerated from scratch on re-export (no stale traces).

## Regeneration (real commands)

```bash
# Wallet cohorts (lean install): full trade log for ALL 200+200 census wallets + curated top-10 winners
uv run python -m oct_trading_agent.traces.wallets \
    --cohorts data/wallet_census/winners.json --dataset data/market_dataset_snap800 \
    --root data/replay_traces --curated-top 10
uv run python -m oct_trading_agent.traces.wallets \
    --cohorts data/wallet_census/losers.json --dataset data/market_dataset_snap800 \
    --root data/replay_traces --curated-top 0

# Archive champions (learn extra / .venv-cuda): deterministic re-eval on 8 held-out tokens each
.venv-cuda/Scripts/python.exe -X utf8 -m oct_trading_agent.traces.agents \
    --checkpoint data/desk_telemetry/mapelites-800.ckpt.pt \
    --dataset data/market_dataset_snap800 --tokens 800 \
    --root data/replay_traces --torch-threads 1 --tokens-per-champion 8 --seed 0
```

The agent re-eval is deterministic: fixed `--seed` drives the sim seed, the policy is the archive
genome evaluated exactly as the trainer evaluates it (argmax intent, Beta-mode size), and the
held-out sample is the walk-forward test split's first N tokens — the same command reproduces
byte-identical rows.
