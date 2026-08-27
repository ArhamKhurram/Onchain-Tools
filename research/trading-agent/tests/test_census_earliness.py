"""Earliness: did the wallet arrive before the move, or after it?

The census could already say whether a wallet made money. These tests pin the thing it could not
say — how early it got in — including the cases where the honest answer is "we don't know".
"""

from __future__ import annotations

import polars as pl

from oct_trading_agent.data.census.crawler import build_pair_stats
from oct_trading_agent.data.census.earliness import (
    EarlinessConfig,
    add_earliness,
    token_price_stats,
)

TRADE_SCHEMA = {
    "wallet": pl.String,
    "mint": pl.String,
    "is_buy": pl.Boolean,
    "base": pl.Float64,
    "quote": pl.Float64,
    "ts": pl.Int64,
    "signature": pl.String,
}


def _trades(rows: list[tuple]) -> pl.DataFrame:
    cols = list(TRADE_SCHEMA)
    return pl.DataFrame(
        {c: [r[i] for r in rows] for i, c in enumerate(cols)}, schema=TRADE_SCHEMA
    )


def _ramp(mint: str, n: int = 20, start_price: float = 1.0, step: float = 1.0) -> list[tuple]:
    """A token whose price climbs every trade — trade i is priced at start + i*step."""
    out = []
    for i in range(n):
        price = start_price + i * step
        out.append((f"noise{i}", mint, True, 1.0, price, 1000 + i, f"s{mint}{i}"))
    return out


def _pairs_with_earliness(rows: list[tuple], cfg: EarlinessConfig | None = None) -> pl.DataFrame:
    trades = _trades(rows)
    return add_earliness(build_pair_stats(trades), trades, cfg)


# -- entry price ---------------------------------------------------------------------------------


def test_entry_price_is_the_first_buy_not_the_first_trade() -> None:
    """A wallet whose first row is a SELL never paid that price — it was airdropped or transferred."""
    rows = [
        *_ramp("M"),
        ("seller", "M", False, 1.0, 99.0, 900, "sell-first"),
        ("seller", "M", True, 1.0, 5.0, 1100, "buy-second"),
    ]
    pairs = _pairs_with_earliness(rows)
    row = pairs.filter(pl.col("wallet") == "seller").row(0, named=True)
    assert row["first_buy_price"] == 5.0
    assert row["first_buy_ts"] == 1100


def test_never_bought_has_no_entry_price() -> None:
    rows = [*_ramp("M"), ("airdropped", "M", False, 1.0, 50.0, 1100, "only-sell")]
    pairs = _pairs_with_earliness(rows)
    row = pairs.filter(pl.col("wallet") == "airdropped").row(0, named=True)
    assert row["first_buy_price"] is None
    assert row["entry_price_pct_of_peak"] is None
    assert row["max_multiple_available"] is None


# -- the three measures --------------------------------------------------------------------------


def test_early_buyer_scores_lower_than_late_buyer_on_both_axes() -> None:
    """The headline property: earlier entry → smaller price fraction AND smaller queue position."""
    rows = [
        *_ramp("M", n=20),
        ("early", "M", True, 1.0, 2.0, 1001, "early-buy"),
        ("late", "M", True, 1.0, 18.0, 1018, "late-buy"),
    ]
    pairs = _pairs_with_earliness(rows)
    e = pairs.filter(pl.col("wallet") == "early").row(0, named=True)
    lt = pairs.filter(pl.col("wallet") == "late").row(0, named=True)

    assert e["entry_price_pct_of_peak"] < lt["entry_price_pct_of_peak"]
    assert e["max_multiple_available"] > lt["max_multiple_available"]
    assert e["entry_trade_rank_pct"] < lt["entry_trade_rank_pct"]


def test_multiple_available_is_the_reciprocal_of_the_price_fraction() -> None:
    rows = [*_ramp("M"), ("w", "M", True, 1.0, 4.0, 1005, "b")]
    row = _pairs_with_earliness(rows).filter(pl.col("wallet") == "w").row(0, named=True)
    assert abs(row["entry_price_pct_of_peak"] * row["max_multiple_available"] - 1.0) < 1e-9


def test_price_and_queue_earliness_are_independent_signals() -> None:
    """A wallet late in the QUEUE can still be early in PRICE — a token that chopped, then ran.

    If these two ever collapse into one number, the module has lost the distinction it exists for.
    """
    flat = [(f"n{i}", "C", True, 1.0, 1.0, 1000 + i, f"f{i}") for i in range(30)]
    run = [(f"r{i}", "C", True, 1.0, 10.0 + i, 1100 + i, f"r{i}") for i in range(10)]
    rows = [*flat, *run, ("cheap_but_late", "C", True, 1.0, 1.0, 1099, "cbl")]
    row = _pairs_with_earliness(rows).filter(pl.col("wallet") == "cheap_but_late").row(0, named=True)
    assert row["entry_trade_rank_pct"] > 0.5  # arrived after most of the queue
    assert row["entry_price_pct_of_peak"] < 0.2  # yet still paid a pre-run price


# -- the peak ------------------------------------------------------------------------------------


def test_peak_ignores_a_single_unexitable_print() -> None:
    """One fat-fingered trade must not become the denominator for every wallet on the token."""
    rows = _ramp("M", n=100, start_price=1.0, step=0.0)  # 100 trades all at 1.0
    rows.append(("spike", "M", True, 1.0, 10_000.0, 2000, "spike"))
    stats = token_price_stats(_trades(rows))
    row = stats.row(0, named=True)
    assert row["token_peak_price_max"] == 10_000.0
    assert row["token_peak_price"] < 100.0  # p99 stays down at the traded level


def test_thin_token_yields_null_rather_than_a_flattering_zero() -> None:
    """Below the trade floor we don't know the peak — and a 0.0 would read as 'maximally early'."""
    rows = [("w", "T", True, 1.0, 1.0, 1000, "a"), ("x", "T", True, 1.0, 2.0, 1001, "b")]
    pairs = _pairs_with_earliness(rows, EarlinessConfig(min_trades_per_token=8))
    for row in pairs.iter_rows(named=True):
        assert row["entry_price_pct_of_peak"] is None
        assert row["entry_trade_rank_pct"] is None


def test_earliness_does_not_disturb_existing_pair_columns() -> None:
    rows = [
        *_ramp("M"),
        ("w", "M", True, 1.0, 3.0, 1002, "b1"),
        ("w", "M", False, 1.0, 9.0, 1600, "s1"),
    ]
    trades = _trades(rows)
    base = build_pair_stats(trades)
    after = add_earliness(base, trades)
    for col in base.columns:
        assert col in after.columns
    b = base.filter(pl.col("wallet") == "w").row(0, named=True)
    a = after.filter(pl.col("wallet") == "w").row(0, named=True)
    assert a["realized_pnl"] == b["realized_pnl"]
    assert a["n_trades"] == b["n_trades"]
