"""Attention-state pipeline — turns a swap tape into an :class:`AttentionState` (paper §4.4, §5.4).

This is the seam that assembles the emitted contract from the two pure-numpy backbones:

    swap tape  ──▶  Hawkes fit (λ_buy, λ_sell, branching ratio n)      [hawkes.py]
               ──▶  manipulation channel (suspicion, breadth, concentration) [manipulation.py]
               ──▶  embedding  (numpy feature vector, or a torch encoder's PUBLIC head)
               ──▶  calibrated_score  (authenticity-adjusted, small-sample-shrunk)
               ──▶  AttentionState

Two invariants are enforced here, both structural (paper §9.10):

* **The manipulation channel is mandatory.** The builder computes it unconditionally and *refuses*
  (raises) if a finite suspicion score cannot be produced — the attention state never ships without
  its authenticity companion.
* **Causality.** Only events at or before ``as_of`` are read; a later swap cannot leak into the
  state. (The feature store is the program's formal leakage boundary; the encoder re-enforces it
  defensively at its own input.)

Torch is optional: with no encoder supplied, ``embedding`` is a deterministic numpy feature vector,
so the whole pipeline runs and is fully tested in a lean install. When a co-trained transformer
encoder is supplied it must expose the **stop-gradient / public** embedding (see ``transformer.py``
and paper §6.4) — this consumer reads the public head, never the policy-shaped one.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Protocol

import numpy as np

from oct_trading_agent.core.attention import AttentionState
from oct_trading_agent.core.enums import Side
from oct_trading_agent.core.tape import Mint, SwapEvent

from .hawkes import BUY, SELL, HawkesFit, fit_hawkes
from .manipulation import ManipulationReport, assess_manipulation


class PublicEmbedder(Protocol):
    """A source of the stop-gradient / public attention embedding (paper §6.4).

    Implemented by the torch encoder's public head; kept as a Protocol so the pipeline never
    imports torch. ``public_embedding`` must return the detached representation the convergence
    layer and standalone alert are allowed to read.
    """

    def public_embedding(self, events: list[SwapEvent], as_of: datetime) -> list[float]:
        """Return the detached public embedding for the causal event window ending at ``as_of``."""
        ...


@dataclass(frozen=True)
class PipelineConfig:
    """Weights and reference scales for the calibrated attention score.

    ``breadth_reference`` normalizes the unique-buyer count; ``shrink_k`` sets the small-sample
    shrinkage (paper §8.6 — widest uncertainty at cold-start, so short tapes score conservatively).
    """

    w_buy_share: float = 0.4
    w_breadth: float = 0.35
    w_momentum: float = 0.25
    breadth_reference: float = 30.0
    shrink_k: float = 25.0
    embedding_dim: int = 12
    estimate_beta: bool = False
    beta: float | None = None
    creator_sniper_wallets: frozenset[str] = field(default_factory=frozenset)


def _causal_swaps(events: list[SwapEvent], as_of: datetime) -> list[SwapEvent]:
    return sorted(
        (e for e in events if e.block_time <= as_of),
        key=lambda e: (e.slot, e.block_time),
    )


def _seconds_from_start(swaps: list[SwapEvent]) -> tuple[np.ndarray, np.ndarray]:
    """Return ``(times_seconds_from_first, dims)`` for the swap list (dim 0 = buy, 1 = sell)."""
    start = swaps[0].block_time
    times = np.array([(e.block_time - start).total_seconds() for e in swaps], dtype=float)
    dims = np.array([BUY if e.side is Side.BUY else SELL for e in swaps], dtype=int)
    return times, dims


def _numpy_embedding(
    fit: HawkesFit,
    report: ManipulationReport,
    lambda_buy: float,
    lambda_sell: float,
    n: float,
    dim: int,
) -> list[float]:
    """A deterministic, interpretable fallback embedding (no torch needed).

    Not a learned representation — a compact numeric summary so ``AttentionState.embedding`` is
    always populated and the standalone/convergence consumers have a vector to read even before the
    transformer encoder is trained. The learned embedding replaces this once the encoder exists.
    """
    total = lambda_buy + lambda_sell + 1e-9
    feats = [
        np.log1p(lambda_buy),
        np.log1p(lambda_sell),
        lambda_buy / total,  # buy share
        n,
        float(np.clip(1.0 - abs(n - 1.0), 0.0, 1.0)),  # near-critical factor
        report.unique_buyers / 100.0,
        report.concentration,
        report.suspicion,
        report.benford,
        report.round_number,
        report.breadth_deficit,
        fit.n_events / 100.0,
    ]
    vec = np.asarray(feats, dtype=float)
    if vec.shape[0] < dim:
        vec = np.concatenate([vec, np.zeros(dim - vec.shape[0])])
    return [float(x) for x in vec[:dim]]


def _empty_state(mint: Mint, as_of: datetime, dim: int) -> AttentionState:
    """The cold-start state for a tape with no causal events yet (paper §8.6).

    Everything zeroed, but the mandatory ``manipulation_suspicion`` is still present (0.0 = no
    evidence either way on an empty tape) — the channel never goes missing.
    """
    return AttentionState(
        mint=mint,
        as_of=as_of,
        lambda_buy=0.0,
        lambda_sell=0.0,
        branching_ratio_n=0.0,
        unique_buyer_breadth=0,
        concentration=0.0,
        manipulation_suspicion=0.0,
        embedding=[0.0] * dim,
        calibrated_score=0.0,
    )


def build_attention_state(
    mint: Mint,
    events: list[SwapEvent],
    as_of: datetime,
    *,
    config: PipelineConfig | None = None,
    embedder: PublicEmbedder | None = None,
) -> AttentionState:
    """Assemble the emitted :class:`AttentionState` for one token at ``as_of``.

    Parameters
    ----------
    mint
        The token whose tape is being read.
    events
        The token's swap events (unfiltered; only those at/before ``as_of`` are used).
    as_of
        The causal instant the state is emitted for.
    config
        Scoring/shrinkage configuration and the creator/sniper wallet set.
    embedder
        Optional co-trained transformer encoder exposing the PUBLIC (stop-gradient) embedding
        (paper §6.4). When ``None``, a deterministic numpy feature embedding is used so the
        pipeline runs without torch.

    Raises
    ------
    RuntimeError
        If the mandatory manipulation-suspicion channel cannot be produced as a finite value —
        the attention state is refused rather than emitted without its authenticity companion
        (paper §9.10).
    """
    cfg = config or PipelineConfig()
    swaps = _causal_swaps(events, as_of)
    if not swaps:
        return _empty_state(mint, as_of, cfg.embedding_dim)

    times, dims = _seconds_from_start(swaps)
    horizon = float(times[-1])

    # --- Hawkes backbone: λ_buy(T), λ_sell(T), branching ratio n ---
    fit = fit_hawkes(
        times,
        dims,
        n_dims=2,
        labels=("buy", "sell"),
        beta=cfg.beta,
        estimate_beta=cfg.estimate_beta,
        T=horizon,
    )
    lam = fit.intensity_at_end()
    lambda_buy = float(max(lam[BUY], 0.0))
    lambda_sell = float(max(lam[SELL], 0.0))
    n = float(fit.branching_ratio)

    # --- Manipulation channel (MANDATORY) ---
    buy_swaps = [e for e in swaps if e.side is Side.BUY]
    buy_sizes = np.array([float(e.quote_amount) for e in buy_swaps], dtype=float)
    # integer-code buyer wallets
    buyer_index: dict[str, int] = {}
    buyer_ids = np.array(
        [buyer_index.setdefault(e.signer, len(buyer_index)) for e in buy_swaps], dtype=int
    )
    all_sizes = np.array([float(e.quote_amount) for e in swaps], dtype=float)

    creator_wallets = cfg.creator_sniper_wallets
    if creator_wallets:
        total_vol = float(np.sum(all_sizes)) + 1e-12
        creator_vol = float(
            np.sum([float(e.quote_amount) for e in swaps if e.signer in creator_wallets])
        )
        creator_share = creator_vol / total_vol
    else:
        creator_share = 0.0

    report = assess_manipulation(
        buy_sizes=buy_sizes,
        buyer_ids=buyer_ids,
        all_sizes=all_sizes,
        creator_volume_share=creator_share,
    )
    if not np.isfinite(report.suspicion):
        raise RuntimeError(
            "manipulation-suspicion channel produced a non-finite score; refusing to emit an "
            "AttentionState without its mandatory authenticity companion (paper §9.10)"
        )

    # --- Embedding: public (stop-gradient) learned head if supplied, else numpy features ---
    if embedder is not None:
        embedding = embedder.public_embedding(swaps, as_of)
    else:
        embedding = _numpy_embedding(
            fit, report, lambda_buy, lambda_sell, n, cfg.embedding_dim
        )

    # --- Calibrated score: authenticity-adjusted, small-sample-shrunk ---
    total_intensity = lambda_buy + lambda_sell + 1e-9
    buy_share = lambda_buy / total_intensity
    breadth_norm = float(np.clip(report.unique_buyers / max(cfg.breadth_reference, 1e-9), 0.0, 1.0))
    momentum = float(np.clip(1.0 - abs(n - 1.0), 0.0, 1.0))
    wsum = cfg.w_buy_share + cfg.w_breadth + cfg.w_momentum
    raw = (
        cfg.w_buy_share * buy_share
        + cfg.w_breadth * breadth_norm
        + cfg.w_momentum * momentum
    ) / max(wsum, 1e-9)
    authenticity = 1.0 - report.suspicion
    shrink = fit.n_events / (fit.n_events + cfg.shrink_k)  # →1 as evidence accrues (§8.6)
    calibrated = float(np.clip(raw * authenticity * shrink, 0.0, 1.0))

    return AttentionState(
        mint=mint,
        as_of=as_of,
        lambda_buy=lambda_buy,
        lambda_sell=lambda_sell,
        branching_ratio_n=n,
        unique_buyer_breadth=report.unique_buyers,
        concentration=float(np.clip(report.concentration, 0.0, 1.0)),
        manipulation_suspicion=float(np.clip(report.suspicion, 0.0, 1.0)),
        embedding=embedding,
        calibrated_score=calibrated,
    )
