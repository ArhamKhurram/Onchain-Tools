"""agent/encoders — the trade-flow attention encoder (paper §4.4).

Compresses a token's swap tape into an :class:`~oct_trading_agent.core.attention.AttentionState`
via two complementary backbones (paper §5.3):

* **Hawkes teacher** (``hawkes.py``, pure numpy) — a multivariate self-exciting point process whose
  fitted intensity *is* the attention chart (``λ_buy``/``λ_sell``) and whose branching ratio ``n``
  is the attention-momentum scalar. Interpretable, and the SSL distillation target for the student.
* **Self-attention student** (``transformer.py``, optional torch) — a causal masked self-attention
  encoder producing the learned embedding, pretrained self-supervised (next-event timing/mark +
  Hawkes-intensity distillation).

The **mandatory manipulation-suspicion channel** (``manipulation.py``, pure numpy) is the
authenticity companion the attention state never ships without (paper §9.10); the **standalone
signal** (``standalone.py``) is the shippable "attention is igniting" alert; and ``pipeline.py``
assembles the emitted :class:`AttentionState`.

CODEPENDENT TRAINING (load-bearing, paper §6.4): after SSL pretraining the encoder stays UNFROZEN
and is co-trained with the policy under ``L = L_RL + β · L_SSL``. A **stop-gradient / public** head
(``EncoderOutput.public_embedding``) feeds convergence + the alert; a **task-coupled private** head
(``EncoderOutput.private_embedding``) feeds the RL agent. This module builds the encoder + the SSL
pretraining; Model N wires in ``L_RL`` and the reflexive own-flow correction (the ``own_flow`` input
feature). Torch is optional: the Hawkes teacher, manipulation channel, standalone signal, and
pipeline all run and are fully tested without it.
"""

from __future__ import annotations

from .hawkes import (
    BUY,
    SELL,
    HawkesFit,
    HawkesParams,
    fit_hawkes,
    simulate_hawkes,
)
from .manipulation import (
    ManipulationReport,
    assess_manipulation,
    benford_suspicion,
    breadth_deficit_suspicion,
    buyer_concentration,
    herfindahl,
    round_number_suspicion,
)
from .pipeline import (
    PipelineConfig,
    PublicEmbedder,
    build_attention_state,
)
from .standalone import (
    IgnitionSignal,
    IgnitionThresholds,
    evaluate_ignition,
    is_igniting,
)
from .transformer import (
    FEATURE_NAMES,
    N_FEATURES,
    OWN_FLOW_COL,
    TORCH_AVAILABLE,
    swaps_to_event_features,
)

__all__ = [
    # hawkes teacher
    "BUY",
    "SELL",
    "HawkesFit",
    "HawkesParams",
    "fit_hawkes",
    "simulate_hawkes",
    # manipulation channel (mandatory authenticity companion)
    "ManipulationReport",
    "assess_manipulation",
    "benford_suspicion",
    "round_number_suspicion",
    "breadth_deficit_suspicion",
    "buyer_concentration",
    "herfindahl",
    # standalone signal
    "IgnitionSignal",
    "IgnitionThresholds",
    "evaluate_ignition",
    "is_igniting",
    # pipeline → AttentionState
    "PipelineConfig",
    "PublicEmbedder",
    "build_attention_state",
    # transformer student (torch optional)
    "FEATURE_NAMES",
    "N_FEATURES",
    "OWN_FLOW_COL",
    "TORCH_AVAILABLE",
    "swaps_to_event_features",
]
