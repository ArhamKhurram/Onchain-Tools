"""Attention-state pipeline tests (paper §4.4, §5.4, §9.10) — pure numpy, no torch.

Covers the emitted contract: field ranges, the MANDATORY manipulation channel, causality (no
look-ahead), the cold-start empty tape, creator-wallet down-weighting, and the PublicEmbedder
seam that a torch encoder plugs into.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import numpy as np

from oct_trading_agent.agent.encoders.pipeline import (
    PipelineConfig,
    build_attention_state,
)
from oct_trading_agent.core.attention import AttentionState
from oct_trading_agent.core.enums import Side
from oct_trading_agent.core.tape import SwapEvent

T0 = datetime(2026, 8, 22, 12, 0, 0, tzinfo=UTC)


def _swap(i: int, side: Side, signer: str, secs: float, quote: str = "1.0") -> SwapEvent:
    return SwapEvent(
        mint="MintP",
        slot=1000 + i,
        block_time=T0 + timedelta(seconds=secs),
        signer=signer,
        side=side,
        base_amount=Decimal("1000"),
        quote_amount=Decimal(quote),
    )


def _organic_tape(n: int, seed: int = 0) -> list[SwapEvent]:
    rng = np.random.default_rng(seed)
    events: list[SwapEvent] = []
    t = 0.0
    for i in range(n):
        t += float(rng.exponential(2.0))
        side = Side.BUY if rng.uniform() < 0.7 else Side.SELL
        signer = f"buyer{i}" if side is Side.BUY else f"seller{i % 20}"
        events.append(_swap(i, side, signer, t, quote=str(round(float(rng.uniform(0.1, 3.0)), 4))))
    return events


def test_empty_tape_is_cold_start_state() -> None:
    st = build_attention_state("MintP", [], T0)
    assert isinstance(st, AttentionState)
    assert st.lambda_buy == 0.0 and st.lambda_sell == 0.0
    assert st.branching_ratio_n == 0.0
    assert st.unique_buyer_breadth == 0
    assert st.calibrated_score == 0.0
    # the mandatory channel is present even on an empty tape
    assert st.manipulation_suspicion == 0.0
    assert len(st.embedding) == PipelineConfig().embedding_dim


def test_emitted_state_fields_in_range() -> None:
    st = build_attention_state("MintP", _organic_tape(200), T0 + timedelta(hours=1))
    assert st.lambda_buy >= 0.0 and st.lambda_sell >= 0.0
    assert st.branching_ratio_n >= 0.0
    assert 0.0 <= st.concentration <= 1.0
    assert 0.0 <= st.manipulation_suspicion <= 1.0
    assert 0.0 <= st.calibrated_score <= 1.0
    assert st.unique_buyer_breadth > 0
    assert len(st.embedding) == PipelineConfig().embedding_dim
    assert all(np.isfinite(x) for x in st.embedding)


def test_manipulation_channel_always_present() -> None:
    """The authenticity companion is emitted for every non-trivial tape (paper §9.10)."""
    st = build_attention_state("MintP", _organic_tape(120, seed=2), T0 + timedelta(hours=1))
    assert st.manipulation_suspicion is not None
    assert np.isfinite(st.manipulation_suspicion)


def test_pipeline_is_causal_no_lookahead() -> None:
    """A swap after as_of must not influence the state (leakage firewall re-enforced)."""
    early = _organic_tape(60, seed=3)
    as_of = T0 + timedelta(seconds=30)
    # a giant future buy that would spike intensity/breadth if it leaked
    future = _swap(9999, Side.BUY, "future_whale", 100000.0, quote="9999")
    st_without = build_attention_state("MintP", early, as_of)
    st_with = build_attention_state("MintP", [*early, future], as_of)
    assert st_with.lambda_buy == st_without.lambda_buy
    assert st_with.unique_buyer_breadth == st_without.unique_buyer_breadth
    assert st_with.calibrated_score == st_without.calibrated_score


def test_creator_wallets_raise_suspicion() -> None:
    """Tagging dominant wallets as creator/sniper down-weights apparent attention."""
    tape = _organic_tape(150, seed=4)
    as_of = T0 + timedelta(hours=2)
    base = build_attention_state("MintP", tape, as_of)
    # mark the busiest buyers as creator/sniper wallets
    creators = frozenset(e.signer for e in tape[:80] if e.side is Side.BUY)
    cfg = PipelineConfig(creator_sniper_wallets=creators)
    flagged = build_attention_state("MintP", tape, as_of, config=cfg)
    assert flagged.manipulation_suspicion >= base.manipulation_suspicion
    assert flagged.calibrated_score <= base.calibrated_score


def test_wash_tape_scores_below_organic() -> None:
    """A few wallets churning round sizes scores lower calibrated attention than a broad crowd."""
    as_of = T0 + timedelta(hours=1)
    organic = build_attention_state("MintP", _organic_tape(200, seed=6), as_of)

    # wash: 3 wallets, round sizes, tight timing
    wash: list[SwapEvent] = []
    rng = np.random.default_rng(6)
    t = 0.0
    for i in range(200):
        t += float(rng.exponential(1.0))
        wash.append(
            _swap(i, Side.BUY, f"w{i % 3}", t, quote=str(rng.choice([1.0, 2.0, 5.0])))
        )
    washed = build_attention_state("MintP", wash, as_of)

    assert washed.manipulation_suspicion > organic.manipulation_suspicion
    assert washed.calibrated_score < organic.calibrated_score


def test_public_embedder_seam_is_used() -> None:
    """When a PublicEmbedder is supplied, the pipeline reads its embedding (the §6.4 public head)."""

    class StubEmbedder:
        def public_embedding(self, events: list[SwapEvent], as_of: datetime) -> list[float]:
            return [0.123, 0.456, 0.789]

    st = build_attention_state(
        "MintP", _organic_tape(80, seed=8), T0 + timedelta(hours=1), embedder=StubEmbedder()
    )
    assert st.embedding == [0.123, 0.456, 0.789]


def test_small_sample_shrinks_score() -> None:
    """Cold-start (few events) scores below a long, broad tape, all else equal (paper §8.6)."""
    as_of = T0 + timedelta(hours=1)
    short = build_attention_state("MintP", _organic_tape(15, seed=9), as_of)
    long = build_attention_state("MintP", _organic_tape(400, seed=9), as_of)
    assert short.calibrated_score < long.calibrated_score
