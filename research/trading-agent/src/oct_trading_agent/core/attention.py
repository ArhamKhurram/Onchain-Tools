"""Attention-state contract — the trade-flow attention model's output (paper §4.4).

A new-pair memecoin has no fundamentals; its price is very nearly the derivative of the crowd's
*attention*, which we measure ENDOGENOUSLY from the swap tape (not exogenous search/mentions).
This type is the attention state both backbones (a multivariate Hawkes process and a causal
self-attention transformer) produce.

Two things are structural, not stylistic:

* **The authenticity channel is mandatory.** ``manipulation_suspicion`` never ships as None:
  wash trading manufactures the exact self-exciting tape the model reads as attention, so a high
  reading cannot be taken at face value (paper §4.4 "mandatory authenticity channel", §9.10).
* **The encoder is co-trained with the policy, not frozen.** After SSL pretraining the encoder
  stays unfrozen; RL gradients flow into it alongside a standing self-supervised loss. A
  **stop-gradient copy** of this representation is what feeds OCT's convergence layer and the
  standalone alert — so the shared signal stays flow-derived and mechanically independent of the
  agent's objective even as the agent's private view specializes (paper §4.4 "Codependent
  training"). Consumers of the convergence signal must read the stop-gradient copy, never the
  policy-shaped one.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import Field

from .base import Frozen
from .tape import Mint


class AttentionState(Frozen):
    """Endogenous attention inferred from a token's swap tape at an instant (paper §4.4).

    ``branching_ratio_n`` is the attention-momentum scalar: n→0 = discovery-only (not
    compounding), n→1 = near-critical (a spark can sustain a cascade — a run is dynamically
    possible), n≥1 = explosive/unstable (Filimonov & Sornette endogeneity, repurposed).
    """

    mint: Mint
    as_of: datetime

    lambda_buy: float = Field(ge=0.0, description="Hawkes buy-intensity λ_buy(t) — the attention chart.")
    lambda_sell: float = Field(ge=0.0, description="Hawkes sell-intensity λ_sell(t).")
    branching_ratio_n: float = Field(ge=0.0, description="Attention-momentum scalar (near-critical at ~1).")

    unique_buyer_breadth: int = Field(
        ge=0, description="Distinct buyers so far — the least-fakeable attention breadth signal."
    )
    concentration: float = Field(
        ge=0.0, le=1.0, description="Top-holder share / Gini-style concentration in [0,1]."
    )

    # MANDATORY authenticity channel — never None (paper §4.4/§9.10).
    manipulation_suspicion: float = Field(
        ge=0.0, le=1.0, description="Wash/fake-flow suspicion in [0,1]; a high λ is discounted by this."
    )

    embedding: list[float] = Field(
        default_factory=list, description="Learned attention-state embedding the RL agent consumes."
    )
    calibrated_score: float = Field(
        ge=0.0, le=1.0, description="Single calibrated attention score (authenticity-adjusted)."
    )
