"""Earliness — how early into a token's life a wallet actually bought.

The census already answers "did this wallet make money". It could not answer the question every
manual wallet-hunt is really asking: **did they get there before the move, or after it?** A wallet
that bought REALCOIN at $27k and one that bought at $191k can post the same realized PnL; only one
of them found it.

That question is normally answered by hand — walk the chart minute by minute, note who loaded up
before the run, check them on a scanner, repeat. This module computes the same thing over every
(wallet, token) pair at once, from data the crawler already has: each trade carries ``quote`` and
``base``, so the entry price is ``quote / base`` of the wallet's first BUY, and the token's own
trade tape supplies both the peak and the queue position.

Three numbers per pair, each answering a different form of "early":

``entry_price_pct_of_peak``
    Entry price ÷ the token's exitable peak. **Lower is earlier.** The direct analogue of
    "Early @$27k" when the peak was $191k.
``max_multiple_available``
    Peak ÷ entry price — how much was still on the table when they arrived. The reciprocal of the
    above, kept separately because it is the number a human actually reasons in ("a 7x was still
    available").
``entry_trade_rank_pct``
    Fraction of the token's trades that had already happened when they first bought. **Lower is
    earlier.** This is the crowding measure, and it is deliberately NOT redundant with price: on a
    token that chopped sideways for a day before running, a late-in-queue wallet can still get a
    cheap price. Being early in *time* and early in *price* are different edges.

**The peak is a high quantile, not the max.** A single fat-fingered print sets an all-time high no
one could have sold into, and dividing by it would flatter every wallet on the token equally. The
p99 of traded prices is an exitable peak — there was real volume there. ``token_peak_price_max`` is
kept alongside for reference, never as the denominator.
"""

from __future__ import annotations

from dataclasses import dataclass

import polars as pl

__all__ = ["EarlinessConfig", "token_price_stats", "add_earliness"]


@dataclass(frozen=True)
class EarlinessConfig:
    """Knobs for the earliness pass."""

    #: Quantile of traded price used as the token's *exitable* peak. See the module docstring for
    #: why this is not ``max``.
    peak_quantile: float = 0.99
    #: A token needs at least this many trades before its peak/queue statistics mean anything.
    min_trades_per_token: int = 8


def token_price_stats(trades: pl.DataFrame, config: EarlinessConfig | None = None) -> pl.DataFrame:
    """Per-token price + queue reference: exitable peak, max, first/last price, trade count.

    ``trades`` is the crawler's sorted trade frame (``wallet, mint, is_buy, base, quote, ts``).
    Rows with non-positive ``base`` carry no price and are dropped rather than divided by.
    """
    cfg = config or EarlinessConfig()
    priced = trades.filter(pl.col("base") > 0).with_columns(
        (pl.col("quote") / pl.col("base")).alias("price")
    )
    return priced.group_by("mint").agg(
        pl.col("price").quantile(cfg.peak_quantile).alias("token_peak_price"),
        pl.col("price").max().alias("token_peak_price_max"),
        pl.col("price").sort_by("ts").first().alias("token_first_price"),
        pl.col("ts").min().alias("token_first_ts"),
        pl.col("ts").max().alias("token_last_ts"),
        pl.len().alias("token_trades"),
    )


def add_earliness(
    pairs: pl.DataFrame,
    trades: pl.DataFrame,
    config: EarlinessConfig | None = None,
) -> pl.DataFrame:
    """Annotate ``pairs`` with the three earliness measures. Null where they cannot be honest.

    Null — never a filled-in default — when the wallet never bought (airdrop/transfer-in), when the
    token is too thin for its peak to mean anything, or when the peak is non-positive. A zero here
    would read as "maximally early" and quietly promote exactly the wallets we know least about.
    """
    cfg = config or EarlinessConfig()
    stats = token_price_stats(trades, cfg)

    # Queue position: how many trades on this token preceded the wallet's first buy. Computed by
    # asof-joining the first-buy instant into the token's own cumulative trade count.
    priced = trades.filter(pl.col("base") > 0).select("mint", "ts").sort(["mint", "ts"])
    ranked = priced.with_columns(
        pl.int_range(pl.len()).over("mint").alias("trades_before")
    )

    out = pairs.join(stats, on="mint", how="left")

    enough = pl.col("token_trades") >= cfg.min_trades_per_token
    valid_peak = pl.col("token_peak_price").is_not_null() & (pl.col("token_peak_price") > 0)
    valid_entry = pl.col("first_buy_price").is_not_null() & (pl.col("first_buy_price") > 0)
    usable = enough & valid_peak & valid_entry

    out = out.sort(["mint", "first_buy_ts"]).join_asof(
        ranked.sort(["mint", "ts"]),
        left_on="first_buy_ts",
        right_on="ts",
        by="mint",
        strategy="backward",
    )

    return out.with_columns(
        pl.when(usable)
        .then(pl.col("first_buy_price") / pl.col("token_peak_price"))
        .otherwise(None)
        .alias("entry_price_pct_of_peak"),
        pl.when(usable)
        .then(pl.col("token_peak_price") / pl.col("first_buy_price"))
        .otherwise(None)
        .alias("max_multiple_available"),
        pl.when(usable & pl.col("trades_before").is_not_null() & (pl.col("token_trades") > 0))
        .then(pl.col("trades_before") / pl.col("token_trades"))
        .otherwise(None)
        .alias("entry_trade_rank_pct"),
    ).drop("trades_before", strict=False)
