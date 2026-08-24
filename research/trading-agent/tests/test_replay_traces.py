"""Replay-trace layer tests — schema round-trip, FIFO-correct wallet steps, shape-preserving
downsampling, deterministic agent recording, and the trade-log store + on-demand builder."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import numpy as np
import polars as pl

from oct_trading_agent.agent.envs import (
    EnvAction,
    EnvConfig,
    Observation,
    TradingEnv,
    bonding_curve_sim_config,
    prepare_bonding_curve_tape,
)
from oct_trading_agent.agent.policies import RandomPolicy
from oct_trading_agent.core import Intent, Side, SwapEvent
from oct_trading_agent.data.census.fifo import fifo_pair_pnl
from oct_trading_agent.data.dataset import RAW_ROW_SCHEMA
from oct_trading_agent.data.pinax_client.decode import WSOL
from oct_trading_agent.traces.build import build_trace
from oct_trading_agent.traces.log import TradeLogStore, build_mint_index
from oct_trading_agent.traces.record import record_policy_rollout
from oct_trading_agent.traces.schema import (
    PricePoint,
    PriceSeries,
    ReplayTrace,
    TraceStep,
    TradeRow,
    downsample_price,
    trace_from_json,
    trace_to_json,
)
from oct_trading_agent.traces.wallets import IncrementalFifo, wallet_trade_rows

MINT = "TokenMintPumpFunBonding0000000000000000000000"
T0 = datetime(2026, 8, 22, 12, 0, 0, tzinfo=UTC)


# ---------------------------------------------------------------------------
# Schema round-trip
# ---------------------------------------------------------------------------


def _sample_trace() -> ReplayTrace:
    return ReplayTrace(
        actor_id="wallet123",
        actor_kind="wallet",
        group_id="census-winners",
        mint=MINT,
        price=PriceSeries(
            points=[PricePoint(t=100, p=0.5), PricePoint(t=200, p=0.75)],
            n_source=1234,
            downsampled=True,
            method="bucketed-extremes",
            pool="Pool111",
            n_pools=2,
        ),
        steps=[
            TraceStep(t=100, seq=0, side="buy", fill=True, base=10.0, quote=5.0, price=0.5,
                      realized_cum=0.0),
            TraceStep(t=150, seq=1, side="sell", fill=True, intent="close", size_frac=1.0,
                      bal=1.25, realized_cum=0.25),
        ],
        meta={"total_realized": 12.5, "name": "census-winner-001"},
    )


def test_trace_json_round_trip() -> None:
    trace = _sample_trace()
    doc = json.loads(json.dumps(trace_to_json(trace)))
    assert trace_from_json(doc) == trace


def test_trace_json_omits_unknowns_rather_than_zeroing() -> None:
    doc = trace_to_json(_sample_trace())
    buy = doc["steps"][0]
    assert "intent" not in buy and "bal" not in buy  # wallet buys carry no policy intent/balance
    sell = doc["steps"][1]
    assert "base" not in sell and "price" not in sell


# ---------------------------------------------------------------------------
# Price downsampling
# ---------------------------------------------------------------------------


def test_downsample_short_series_is_untouched() -> None:
    points = [PricePoint(t=i, p=float(i)) for i in range(10)]
    sampled, downsampled = downsample_price(points, max_points=500)
    assert sampled == points
    assert downsampled is False


def test_downsample_preserves_first_last_and_extremes() -> None:
    rng = np.random.default_rng(0)
    prices = np.abs(rng.normal(1.0, 0.2, size=5000)) + 0.01
    prices[1717] = 9.0  # the wick high
    prices[3131] = 0.001  # the rug low
    points = [PricePoint(t=i, p=float(p)) for i, p in enumerate(prices)]
    sampled, downsampled = downsample_price(points, max_points=500)
    assert downsampled is True
    assert len(sampled) <= 500
    assert sampled[0] == points[0] and sampled[-1] == points[-1]
    kept = {(pt.t, pt.p) for pt in sampled}
    assert (1717, 9.0) in kept and (3131, 0.001) in kept  # global extremes always survive
    assert [pt.t for pt in sampled] == sorted(pt.t for pt in sampled)  # time order kept


# ---------------------------------------------------------------------------
# Wallet steps — FIFO equivalence with the census engine
# ---------------------------------------------------------------------------


def _trade_frame(rows: list[tuple[str, str, bool, float, float, int]]) -> pl.DataFrame:
    return pl.DataFrame(
        {
            "wallet": [r[0] for r in rows],
            "mint": [r[1] for r in rows],
            "is_buy": [r[2] for r in rows],
            "base": [r[3] for r in rows],
            "quote": [r[4] for r in rows],
            "ts": [r[5] for r in rows],
            "signature": [f"sig{i}" for i in range(len(rows))],
        }
    )


def test_wallet_rows_match_census_fifo_engine() -> None:
    """The per-trade running realized PnL ends exactly where the census FIFO engine lands."""
    trades = [
        ("w1", "mintA", True, 100.0, 1.0, 10),  # buy 100 @ 0.01
        ("w1", "mintA", True, 100.0, 3.0, 20),  # buy 100 @ 0.03
        ("w1", "mintA", False, 150.0, 6.0, 30),  # sell 150 @ 0.04 (spans both lots)
        ("w1", "mintA", False, 100.0, 1.0, 40),  # sell 100 @ 0.01: 50 costed, 50 UNCOSTED
    ]
    rows = wallet_trade_rows(_trade_frame(trades), group_id="census-test")
    assert [r.side for r in rows] == ["buy", "buy", "sell", "sell"]
    assert [r.seq for r in rows] == [0, 1, 2, 3]
    expected = fifo_pair_pnl(
        np.array([t[2] for t in trades]),
        np.array([t[3] for t in trades]),
        np.array([t[4] for t in trades]),
        np.array([t[5] for t in trades], dtype=float),
    )
    assert rows[-1].realized_cum is not None
    assert abs(rows[-1].realized_cum - expected.realized_pnl) < 1e-12
    # And the uncosted transfer-in proceeds were EXCLUDED, mirroring the census rule.
    fifo = IncrementalFifo()
    for t in trades:
        fifo.trade(is_buy=t[2], base=t[3], quote=t[4])
    assert abs(fifo.uncosted - expected.uncosted_sell_quote) < 1e-12


def test_wallet_rows_reset_fifo_per_pair() -> None:
    trades = [
        ("w1", "mintA", True, 10.0, 1.0, 10),
        ("w1", "mintA", False, 10.0, 2.0, 20),  # +1.0 realized on mintA
        ("w1", "mintB", False, 10.0, 5.0, 30),  # mintB sell with NO lots: uncosted, realized 0
        ("w2", "mintA", True, 10.0, 1.0, 40),  # new wallet: fresh book, fresh seq
    ]
    rows = wallet_trade_rows(_trade_frame(trades), group_id="census-test")
    by_pair = {(r.actor_id, r.mint): r for r in rows}
    assert by_pair[("w1", "mintA")].realized_cum == 1.0
    assert by_pair[("w1", "mintB")].realized_cum == 0.0  # never fabricated profit
    assert by_pair[("w2", "mintA")].seq == 0


# ---------------------------------------------------------------------------
# Agent recording — determinism + forced-close residual honesty
# ---------------------------------------------------------------------------


def _swap(i: int, side: Side = Side.BUY) -> SwapEvent:
    return SwapEvent(
        mint=MINT,
        slot=1000 + i,
        block_time=T0 + timedelta(seconds=i),
        signature=f"s{i}",
        signer=f"w{i}",
        side=side,
        base_amount=Decimal("1900"),
        quote_amount=Decimal("0.00005"),
        price=Decimal("0.00005") / Decimal("1900"),
        protocol="pumpfun",
    )


def _env(n_swaps: int = 12) -> TradingEnv:
    tape = prepare_bonding_curve_tape([_swap(i) for i in range(n_swaps)])
    return TradingEnv(
        tape,
        MINT,
        bonding_curve_sim_config(risk_budget_quote=Decimal("0.01")),
        config=EnvConfig(initial_balance_quote=Decimal(1)),
    )


class _BuyOnceThenHold:
    """Deterministic scripted policy: open full-size on the first step, then hold to truncation."""

    def __init__(self) -> None:
        self._opened = False

    def reset(self) -> None:
        self._opened = False

    def act(self, observation: Observation) -> EnvAction:
        if not self._opened:
            self._opened = True
            return EnvAction(intent=Intent.OPEN_LONG, size=1.0)
        return EnvAction(intent=Intent.HOLD)


def test_record_rollout_is_deterministic_for_a_seeded_policy() -> None:
    first = record_policy_rollout(_env(), RandomPolicy(seed=7), actor_id="a", group_id="g")
    second = record_policy_rollout(_env(), RandomPolicy(seed=7), actor_id="a", group_id="g")
    assert first.rows == second.rows
    assert first.realized_pnl_quote == second.realized_pnl_quote
    other = record_policy_rollout(_env(), RandomPolicy(seed=8), actor_id="a", group_id="g")
    assert other.rows != first.rows or other.realized_pnl_quote != first.realized_pnl_quote


def test_record_rollout_books_forced_close_as_final_row() -> None:
    episode = record_policy_rollout(_env(), _BuyOnceThenHold(), actor_id="a", group_id="g")
    assert episode.rows[0].side == "buy" and episode.rows[0].intent == "open_long"
    last = episode.rows[-1]
    assert last.side == "sell" and last.intent == "close"  # the truncation-forced liquidation
    assert last.realized_cum is not None
    assert abs(last.realized_cum - episode.realized_pnl_quote) < 1e-12
    assert last.quote is None  # the forced close's cash flow was never itemized — not fabricated


# ---------------------------------------------------------------------------
# Trade-log store + on-demand builder (synthetic mini dataset, tmp_path)
# ---------------------------------------------------------------------------


def _mini_dataset(root: Path, *, pool: str, mint: str, n: int = 30) -> None:
    """A one-pool captured dataset in the real RAW_ROW_SCHEMA layout (price ramps upward)."""
    rows = [
        {
            "amm_pool": pool,
            "protocol": "pumpfun_amm",
            "signature": f"sig{i}",
            "signer": f"w{i % 3}",
            "block_num": 1000 + i,
            "timestamp": 100 + i,
            "transaction_index": 0,
            "instruction_index": 0,
            "input_mint": WSOL if i % 2 == 0 else mint,
            "output_mint": mint if i % 2 == 0 else WSOL,
            "input_value": 1.0 + i * 0.01 if i % 2 == 0 else 100.0,
            "output_value": 100.0 if i % 2 == 0 else 1.0 + i * 0.01,
        }
        for i in range(n)
    ]
    frame = pl.DataFrame(rows, schema=RAW_ROW_SCHEMA)
    (root / "pools").mkdir(parents=True)
    frame.write_parquet(root / "pools" / f"{pool}.parquet")


def test_store_round_trip_and_on_demand_build(tmp_path: Path) -> None:
    dataset = tmp_path / "dataset"
    mint = "MintZ"
    _mini_dataset(dataset, pool="PoolZ", mint=mint)
    store = TradeLogStore(tmp_path / "traces")
    rows = [
        TradeRow(actor_id="w0", actor_kind="wallet", group_id="census-test", mint=mint,
                 t=105, seq=0, side="buy", fill=True, base=100.0, quote=1.05, price=0.0105,
                 realized_cum=0.0),
        TradeRow(actor_id="w0", actor_kind="wallet", group_id="census-test", mint=mint,
                 t=120, seq=1, side="sell", fill=True, base=100.0, quote=1.2, price=0.012,
                 realized_cum=0.15),
    ]
    store.write_segment("wallets-census-test", rows)
    store.write_actors(
        "wallets-census-test",
        [{"actor_id": "w0", "actor_kind": "wallet", "group_id": "census-test",
          "tokens_touched": 1, "n_trades": 2, "realized_pnl_quote": 0.15,
          "meta_json": json.dumps({"name": "tester"})}],
    )

    trace = build_trace(store.root, dataset, "w0", mint)
    assert trace.group_id == "census-test" and trace.actor_kind == "wallet"
    assert [s.side for s in trace.steps] == ["buy", "sell"]
    assert trace.steps[1].realized_cum == 0.15
    assert trace.price.n_source == 30 and len(trace.price.points) == 30
    assert trace.price.downsampled is False and trace.price.pool == "PoolZ"
    assert trace.meta.get("name") == "tester"
    # The round-trip contract holds on the built trace too.
    assert trace_from_json(json.loads(json.dumps(trace_to_json(trace)))) == trace


def test_build_trace_rejects_unknown_and_ambiguous_actors(tmp_path: Path) -> None:
    dataset = tmp_path / "dataset"
    _mini_dataset(dataset, pool="PoolZ", mint="MintZ")
    store = TradeLogStore(tmp_path / "traces")
    row = TradeRow(actor_id="c0001", actor_kind="agent", group_id="run-a", mint="MintZ",
                   t=105, seq=0, side="buy", fill=True, intent="open_long", size_frac=1.0)
    store.write_segment("agents-run-a", [row])
    store.write_segment("agents-run-b", [
        TradeRow(actor_id="c0001", actor_kind="agent", group_id="run-b", mint="MintZ",
                 t=110, seq=0, side="buy", fill=True, intent="open_long", size_frac=0.5),
    ])
    try:
        build_trace(store.root, dataset, "c0001", "MintZ")
        raise AssertionError("ambiguous actor should have raised")
    except ValueError as exc:
        assert "ambiguous" in str(exc)
    pinned = build_trace(store.root, dataset, "c0001", "MintZ", group_id="run-a")
    assert pinned.steps[0].size_frac == 1.0
    try:
        build_trace(store.root, dataset, "nobody", "MintZ")
        raise AssertionError("unknown actor should have raised")
    except ValueError as exc:
        assert "no logged trades" in str(exc)


def test_mint_index_ranks_pools_by_activity(tmp_path: Path) -> None:
    dataset = tmp_path / "dataset"
    _mini_dataset(dataset, pool="PoolBig", mint="MintZ", n=40)
    # A second, quieter pool for the same mint (the migration shape): busiest must win the chart.
    quiet = pl.read_parquet(dataset / "pools" / "PoolBig.parquet").head(6).with_columns(
        pl.lit("PoolSmall").alias("amm_pool")
    )
    quiet.write_parquet(dataset / "pools" / "PoolSmall.parquet")
    index = build_mint_index(dataset)
    assert index.filter(pl.col("mint") == "MintZ").height == 2
    store = TradeLogStore(tmp_path / "traces")
    store.write_segment("agents-run-a", [
        TradeRow(actor_id="c1", actor_kind="agent", group_id="run-a", mint="MintZ",
                 t=105, seq=0, side="buy", fill=True, intent="open_long", size_frac=1.0),
    ])
    trace = build_trace(store.root, dataset, "c1", "MintZ")
    assert trace.price.pool == "PoolBig" and trace.price.n_pools == 2
