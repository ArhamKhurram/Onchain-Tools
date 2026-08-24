"""The unified replay-trace contract — trade-log rows, trace JSON, price downsampling. PURE.

One schema fits BOTH actor kinds (see ``replay-trace-schema.md`` for the documented contract):

* **Agents** — every step's fill recorded live while a champion policy is re-run through the replay
  env. ``intent``/``size_frac``/``bal`` come from the env step ``info``; ``quote`` is the paper
  balance moved by the fill (cost-inclusive); ``price``/``base`` are ``None`` — the env does not
  report per-fill execution amounts and this layer NEVER fabricates a number it was not given.
* **Wallets** — the census cohorts' real captured swaps ARE the steps. ``base``/``quote``/``price``
  are the swap's own amounts; ``intent``/``size_frac``/``bal`` are ``None`` (a real wallet has no
  policy intent and its true balance is unknowable from one token's tape); ``realized_cum`` is the
  FIFO cumulative realized PnL, matching the census engine's rules exactly
  (:mod:`oct_trading_agent.data.census.fifo` — uncosted transfer-in sells excluded).

``None`` fields are OMITTED from JSON, never emitted as fabricated zeros.

The price series carries an honest sampling label (trickshot's discipline): when downsampled,
``downsampled: true`` plus the method string travel with the points so the viz can disclose that
the shape is bucketed extremes of real trade prints, not every tick.

Torch-free and polars-free — this module is the pure contract; parquet I/O lives in :mod:`.log`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

TRACE_SCHEMA_VERSION = "replay-trace/v1"

#: The honest sampling label a downsampled price series carries (rendered by the viz).
DOWNSAMPLE_METHOD = (
    "bucketed-extremes: first + last + each time-bucket's min/max close; "
    "prices are real trade prints, intermediate ticks elided"
)

#: Default cap on price points per trace — the viz needs the chart's shape, not every tick.
MAX_PRICE_POINTS = 500

#: Agent intents that move quote INTO the token (buy side) / OUT of it (sell side).
BUY_INTENTS = frozenset({"open_long", "add"})
SELL_INTENTS = frozenset({"trim", "close"})


# ---------------------------------------------------------------------------
# Trade-log row — the substrate's unit (one parquet row per trade)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TradeRow:
    """One TRADE by one actor on one token — the trade-log parquet row (and a trace step's source).

    ``seq`` orders trades within an (actor, mint) pair (step index for agents, trade index for
    wallets) so equal-second trades replay in their true order. Optional fields are ``None`` when
    the source did not carry them — never imputed (see the module docstring for which kind carries
    what).
    """

    actor_id: str
    actor_kind: str  # "agent" | "wallet"
    group_id: str  # run_id (agents) | cohort name (wallets)
    mint: str
    t: int  # epoch seconds
    seq: int
    side: str  # "buy" | "sell"
    fill: bool
    intent: str | None = None  # agents: open_long/add/trim/close
    size_frac: float | None = None  # agents: the policy's size fraction on the fill
    base: float | None = None  # wallets: token amount moved (UI units)
    quote: float | None = None  # quote moved (wallets: swap leg; agents: |Δbalance|, cost-incl.)
    price: float | None = None  # wallets: quote/base of the swap
    bal_after: float | None = None  # agents: paper balance after the step
    realized_cum: float | None = None  # cumulative realized PnL on this (actor, mint), quote units

    def to_record(self) -> dict[str, Any]:
        """The flat dict a columnar writer stores (``None`` stays ``None`` → parquet null)."""
        return {
            "actor_id": self.actor_id,
            "actor_kind": self.actor_kind,
            "group_id": self.group_id,
            "mint": self.mint,
            "t": self.t,
            "seq": self.seq,
            "side": self.side,
            "fill": self.fill,
            "intent": self.intent,
            "size_frac": self.size_frac,
            "base": self.base,
            "quote": self.quote,
            "price": self.price,
            "bal_after": self.bal_after,
            "realized_cum": self.realized_cum,
        }


# ---------------------------------------------------------------------------
# Trace JSON — what the replay viz consumes (tier 2 on demand, tier 3 curated)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PricePoint:
    """One point of the token's chart: epoch seconds + price (quote per base)."""

    t: int
    p: float


@dataclass(frozen=True)
class PriceSeries:
    """The token's (possibly downsampled) chart plus the honest provenance of its sampling.

    ``pool`` is the busiest pool the series was derived from when the mint printed on several
    (trickshot's convention: chart the busiest pool, overlay ALL the actor's trades); ``n_pools``
    says how many pools the tape held so the viz can disclose a multi-pool token.
    """

    points: list[PricePoint]
    n_source: int  # prints in the source tape before downsampling
    downsampled: bool
    method: str | None = None  # sampling label (DOWNSAMPLE_METHOD) when downsampled
    pool: str | None = None
    n_pools: int = 1


@dataclass(frozen=True)
class TraceStep:
    """One replay step — a :class:`TradeRow` minus the identity columns the trace header carries."""

    t: int
    seq: int
    side: str
    fill: bool
    intent: str | None = None
    size_frac: float | None = None
    base: float | None = None
    quote: float | None = None
    price: float | None = None
    bal: float | None = None
    realized_cum: float | None = None

    @classmethod
    def from_row(cls, row: TradeRow) -> TraceStep:
        return cls(
            t=row.t, seq=row.seq, side=row.side, fill=row.fill, intent=row.intent,
            size_frac=row.size_frac, base=row.base, quote=row.quote, price=row.price,
            bal=row.bal_after, realized_cum=row.realized_cum,
        )


@dataclass(frozen=True)
class ReplayTrace:
    """One (actor, token) replay: the actor's identity + metadata, the chart, and the trade steps."""

    actor_id: str
    actor_kind: str
    group_id: str
    mint: str
    price: PriceSeries
    steps: list[TraceStep]
    meta: dict[str, Any] = field(default_factory=dict)
    schema: str = TRACE_SCHEMA_VERSION


def _drop_none(d: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}


def trace_to_json(trace: ReplayTrace) -> dict[str, Any]:
    """Serialize a :class:`ReplayTrace` to its JSON dict (``None`` fields omitted, never zeroed)."""
    price: dict[str, Any] = {
        "points": [{"t": pt.t, "p": pt.p} for pt in trace.price.points],
        "n_source": trace.price.n_source,
        "downsampled": trace.price.downsampled,
        "n_pools": trace.price.n_pools,
    }
    if trace.price.method is not None:
        price["method"] = trace.price.method
    if trace.price.pool is not None:
        price["pool"] = trace.price.pool
    return {
        "schema": trace.schema,
        "actor_id": trace.actor_id,
        "actor_kind": trace.actor_kind,
        "group_id": trace.group_id,
        "mint": trace.mint,
        "meta": trace.meta,
        "price": price,
        "steps": [
            _drop_none(
                {
                    "t": s.t, "seq": s.seq, "side": s.side, "fill": s.fill, "intent": s.intent,
                    "size_frac": s.size_frac, "base": s.base, "quote": s.quote, "price": s.price,
                    "bal": s.bal, "realized_cum": s.realized_cum,
                }
            )
            for s in trace.steps
        ],
    }


def trace_from_json(data: dict[str, Any]) -> ReplayTrace:
    """Parse a trace JSON dict back into a :class:`ReplayTrace` (the round-trip inverse)."""
    price_d = data["price"]
    price = PriceSeries(
        points=[PricePoint(t=int(pt["t"]), p=float(pt["p"])) for pt in price_d["points"]],
        n_source=int(price_d["n_source"]),
        downsampled=bool(price_d["downsampled"]),
        method=price_d.get("method"),
        pool=price_d.get("pool"),
        n_pools=int(price_d.get("n_pools", 1)),
    )
    steps = [
        TraceStep(
            t=int(s["t"]), seq=int(s["seq"]), side=str(s["side"]), fill=bool(s["fill"]),
            intent=s.get("intent"),
            size_frac=None if s.get("size_frac") is None else float(s["size_frac"]),
            base=None if s.get("base") is None else float(s["base"]),
            quote=None if s.get("quote") is None else float(s["quote"]),
            price=None if s.get("price") is None else float(s["price"]),
            bal=None if s.get("bal") is None else float(s["bal"]),
            realized_cum=None if s.get("realized_cum") is None else float(s["realized_cum"]),
        )
        for s in data["steps"]
    ]
    return ReplayTrace(
        actor_id=str(data["actor_id"]),
        actor_kind=str(data["actor_kind"]),
        group_id=str(data["group_id"]),
        mint=str(data["mint"]),
        price=price,
        steps=steps,
        meta=dict(data.get("meta", {})),
        schema=str(data.get("schema", TRACE_SCHEMA_VERSION)),
    )


# ---------------------------------------------------------------------------
# Price downsampling — shape-preserving, honestly labeled
# ---------------------------------------------------------------------------


def downsample_price(
    points: list[PricePoint], *, max_points: int = MAX_PRICE_POINTS
) -> tuple[list[PricePoint], bool]:
    """Downsample a time-ordered price series to at most ``max_points``, preserving its SHAPE.

    Guarantees, by construction: the FIRST and LAST points always survive, and every interior
    time-bucket contributes its min AND max price — so the series' global extremes (the wick highs
    and rug lows a replay chart must show) are never smoothed away. Points stay in time order and
    are deduplicated by index. Returns ``(points, downsampled)``; a series already within the cap
    is returned unchanged with ``downsampled=False``.
    """
    if max_points < 4:
        raise ValueError("max_points must be >= 4 (first + last + at least one min/max bucket)")
    n = len(points)
    if n <= max_points:
        return list(points), False

    interior = range(1, n - 1)
    n_buckets = (max_points - 2) // 2
    keep: set[int] = {0, n - 1}
    total = len(interior)
    for b in range(n_buckets):
        lo = 1 + (total * b) // n_buckets
        hi = 1 + (total * (b + 1)) // n_buckets
        if hi <= lo:
            continue
        lo_idx = min(range(lo, hi), key=lambda i: points[i].p)
        hi_idx = max(range(lo, hi), key=lambda i: points[i].p)
        keep.add(lo_idx)
        keep.add(hi_idx)
    return [points[i] for i in sorted(keep)], True


__all__ = [
    "TRACE_SCHEMA_VERSION",
    "DOWNSAMPLE_METHOD",
    "MAX_PRICE_POINTS",
    "BUY_INTENTS",
    "SELL_INTENTS",
    "TradeRow",
    "PricePoint",
    "PriceSeries",
    "TraceStep",
    "ReplayTrace",
    "trace_to_json",
    "trace_from_json",
    "downsample_price",
]
