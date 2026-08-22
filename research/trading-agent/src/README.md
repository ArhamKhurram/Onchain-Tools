# `oct_trading_agent` — Phase-0 package conventions

This is the Python package for OCT's autonomous trading-agent research program (**Model N**, the
new-pair agent). It is **research code on the `research/trading-agent` branch** — it never ships to
`main`, and it never touches the production workspaces (`backend/`, `frontend/`, …). The design
source of truth is [`../02-technical-design.md`](../02-technical-design.md) (module layout in §6)
and [`../00-paper.md`](../00-paper.md).

Phase 0 is **contracts + scaffolding only**. The simulator, feature store, data client, and model
are stubbed — Wave-1 builder agents fill them in against the contracts in
[`oct_trading_agent/core/`](./oct_trading_agent/core/).

## Layout

The module tree mirrors 02 §6. Everything is namespaced under one importable package
`oct_trading_agent` (a deliberate deviation from a bare top-level `data/`, `sim/`, `eval/` — those
names are too generic to own the global module namespace; the §6 tree is preserved exactly as
`oct_trading_agent.<module>`).

```
oct_trading_agent/
├── core/          # THE SHARED CONTRACTS — everything imports types from here
├── config.py      # runtime Pinax creds (from backend/.env) + proven Pinax facts
├── data/          # ingest → append-only tape log (pinax_client, labeling, connectors)
├── featurestore/  # point-in-time features (pointintime, tiers, leakage_audit)
├── sim/           # replay simulator (amm, execution, rug, replay)
├── agent/         # RL core (encoders, policies, critics, offline, imitation, online, population, continual)
├── eval/          # metrics, walkforward, ablations, gate
├── ledger/        # paper-trading ledger
├── bridge/        # actuator bridge → /sniper/v1 (propose-only)
└── convergence/   # calibrated single-signal adapter for OCT
```

## The dependency / leakage order (hard rule)

```
data → featurestore → sim → agent → eval
```

**Features are NEVER computed in the `data` or `sim` layers.** The data layer produces raw,
timestamped, append-only tape events (`core.tape`); the feature store is the single place that turns
tape into features, point-in-time, with explicit missingness. This is the *leakage firewall*:
causality is auditable at exactly one boundary (02 §6). A feature computed anywhere else defeats the
standing leakage audit and is a bug.

Corollaries:
- **Missingness is explicit, never imputed.** `core.features.Feature` carries a `FeatureStatus`;
  a "missing" value is `None` with a reason, not a silent zero (04-data-spec.md hygiene rules).
- **Realized only.** No reward path may read unrealized/peak PnL (paper §3.5.4). `PositionState`
  keeps `mark_price` for reporting, walled off from realized figures.
- **Walk-forward only** in `eval` — never random splits.

## `bridge/` is the only door to money

`bridge/` is the **ONLY** module allowed to reference `/sniper/v1`. Keeping that reference at a
single seam makes "propose-only, never spend" enforceable by code review. The agent proposes; the
backend's `executeFire` is the only thing that spends and independently enforces the kill switch,
caps, and auth. The agent never holds the venue token and cannot alter a cap (root `CLAUDE.md`
sniper section; paper §10.4). Signal-first: live execution defaults OFF; paper mode writes to the
ledger, not the sniper.

## Python-first, native-kernel-ready

Build **correct in Python first** — numpy/polars vectorization, clear code over cleverness (the
simulator's correctness is the whole program's credibility, 03 §Phase 0). Keep the simulator hot
loop behind the `core.sim.Simulator` protocol so it can later be swapped to a **Rust** kernel (via
PyO3/maturin — Rust preferred over C++ for Python bindings + Solana-ecosystem fit) **only where
profiling proves it necessary.** No premature native code.

## Dependencies

Runtime deps are lean: `numpy`, `polars`, `pydantic` (v2). Heavy ML/RL deps are **optional groups**
(`torch`, `offline`=d3rlpy, `population`=ray+ribs, `firehose`=grpcio) — Phase 0 is engineering-heavy,
not compute-heavy, so nothing heavy is a required install. Pull the group your wave needs.

## Tasks

Managed with [uv](https://docs.astral.sh/uv/) (also works with plain pip: `pip install -e '.[dev]'`).

```bash
make sync        # uv sync --extra dev
make lint        # ruff check
make typecheck   # mypy (strict)
make test        # pytest
make check       # all three — run before opening a PR
```

`mypy` runs in `strict` mode with the pydantic plugin; `ruff` enforces imports/style. Both must be
clean before a PR.
