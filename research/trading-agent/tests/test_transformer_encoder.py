"""Transformer student encoder tests (paper §5, §6.4).

The pure-numpy feature adapter is tested unconditionally (it is the encoder's input and runs
without torch). The torch encoder tests ``pytest.importorskip("torch")`` so the suite stays green
in a lean install — the encoder's gate is that everything *except* the transformer is fully tested
without torch, and the transformer's own tests are skipped rather than failing when torch is absent.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import numpy as np
import pytest

from oct_trading_agent.agent.encoders.transformer import (
    FEATURE_NAMES,
    N_FEATURES,
    OWN_FLOW_COL,
    swaps_to_event_features,
)
from oct_trading_agent.core.enums import Side
from oct_trading_agent.core.tape import SwapEvent

T0 = datetime(2026, 8, 22, 12, 0, 0, tzinfo=UTC)


def _swap(i: int, side: Side, signer: str, secs: float, quote: str = "1.0") -> SwapEvent:
    return SwapEvent(
        mint="MintT",
        slot=2000 + i,
        block_time=T0 + timedelta(seconds=secs),
        signer=signer,
        side=side,
        base_amount=Decimal("1000"),
        quote_amount=Decimal(quote),
    )


def _tape() -> list[SwapEvent]:
    return [
        _swap(0, Side.BUY, "a", 0.0, "1.0"),
        _swap(1, Side.BUY, "b", 2.0, "2.5"),
        _swap(2, Side.SELL, "a", 3.0, "0.7"),
        _swap(3, Side.BUY, "c", 6.0, "4.0"),
    ]


# --- pure-numpy adapter: runs without torch ---


def test_feature_matrix_shape_and_causality() -> None:
    feats = swaps_to_event_features(_tape(), T0 + timedelta(seconds=100))
    assert feats.shape == (4, N_FEATURES)
    # side_sign column: buy=+1, sell=-1
    assert list(feats[:, 1]) == [1.0, 1.0, -1.0, 1.0]
    # running unique buyers is non-decreasing (breadth column, /100)
    breadth = feats[:, 3] * 100
    assert list(breadth) == [1.0, 2.0, 2.0, 3.0]


def test_feature_matrix_respects_as_of() -> None:
    feats = swaps_to_event_features(_tape(), T0 + timedelta(seconds=4))
    assert feats.shape[0] == 3  # the swap at 6s is after as_of


def test_own_flow_tag() -> None:
    feats = swaps_to_event_features(
        _tape(), T0 + timedelta(seconds=100), own_flow_wallets=frozenset({"b"})
    )
    assert feats[1, OWN_FLOW_COL] == 1.0  # wallet 'b' tagged as own flow
    assert feats[0, OWN_FLOW_COL] == 0.0
    assert FEATURE_NAMES[OWN_FLOW_COL] == "own_flow"


def test_empty_feature_matrix() -> None:
    feats = swaps_to_event_features([], T0)
    assert feats.shape == (0, N_FEATURES)


# --- torch encoder: skipped when torch is absent ---


def test_encoder_two_head_detach_boundary() -> None:
    torch = pytest.importorskip("torch")
    from oct_trading_agent.agent.encoders.transformer import SwapSequenceEncoder

    torch.manual_seed(0)
    enc = SwapSequenceEncoder(d_model=16, n_heads=2, n_layers=1, embedding_dim=8)
    feats = torch.from_numpy(swaps_to_event_features(_tape(), T0 + timedelta(seconds=100))).float()
    out = enc.forward(feats.unsqueeze(0))

    assert out.private_embedding.shape == (1, 8)
    assert out.public_embedding.shape == (1, 8)
    assert out.ssl_prediction.shape == (1, 4)

    # PUBLIC head reads a detached representation → no grad path into the backbone.
    enc.zero_grad()
    out.public_embedding.sum().backward()  # type: ignore[no-untyped-call, unused-ignore]
    backbone_grads_public = [
        p.grad for n, p in enc.named_parameters() if n.startswith("encoder.") and p.grad is not None
    ]
    assert backbone_grads_public == []  # stop-gradient boundary holds

    # PRIVATE head DOES flow gradients into the backbone (task-coupled).
    enc.zero_grad()
    out2 = enc.forward(feats.unsqueeze(0))
    out2.private_embedding.sum().backward()  # type: ignore[no-untyped-call, unused-ignore]
    backbone_grads_private = [
        p.grad for n, p in enc.named_parameters() if n.startswith("encoder.") and p.grad is not None
    ]
    assert len(backbone_grads_private) > 0


def test_ssl_pretrain_step_trains_backbone() -> None:
    torch = pytest.importorskip("torch")
    from oct_trading_agent.agent.encoders.transformer import (
        SwapSequenceEncoder,
        ssl_pretrain_step,
    )

    torch.manual_seed(1)
    enc = SwapSequenceEncoder(d_model=16, n_heads=2, n_layers=1, embedding_dim=8)
    feats = torch.from_numpy(swaps_to_event_features(_tape(), T0 + timedelta(seconds=100))).float()
    batch = feats.unsqueeze(0)
    opt = torch.optim.Adam(enc.parameters(), lr=1e-2)

    # SSL loss should decrease over a few tiny steps (backbone is being trained).
    first = ssl_pretrain_step(enc, batch, lambda_buy=2.0, lambda_sell=1.0, optimizer=opt)
    for _ in range(30):
        last = ssl_pretrain_step(enc, batch, lambda_buy=2.0, lambda_sell=1.0, optimizer=opt)
    assert last < first


def test_encoder_public_embedding_implements_protocol() -> None:
    torch = pytest.importorskip("torch")
    from oct_trading_agent.agent.encoders.pipeline import build_attention_state
    from oct_trading_agent.agent.encoders.transformer import SwapSequenceEncoder

    torch.manual_seed(2)
    enc = SwapSequenceEncoder(d_model=16, n_heads=2, n_layers=1, embedding_dim=8)
    # duck-types PublicEmbedder → the pipeline can consume the learned public head
    st = build_attention_state("MintT", _tape(), T0 + timedelta(seconds=100), embedder=enc)
    assert len(st.embedding) == 8
    assert all(np.isfinite(x) for x in st.embedding)
    # empty window → zero vector of the embedding dim
    assert enc.public_embedding([], T0) == [0.0] * 8
