"""Agent decision output — the typed decision Model N emits (02 §3; paper §4.2).

``AgentDecision`` is the model→OCT contract. It is deliberately richer than "buy/sell": it
carries a *distributional* value estimate (for CVaR/risk-sensitive sizing, paper §6.3), a
calibrated ``confidence``, a human-legible ``rationale_trace`` (which features/tools drove it),
and a ``signal_contribution`` — the single calibrated score that enters OCT's convergence layer
as one more INDEPENDENT signal (never fused at the detection level; paper §4.3).
"""

from __future__ import annotations

from typing import Literal, Protocol, runtime_checkable

import numpy as np
from pydantic import Field, model_validator

from .base import Frozen
from .enums import FeatureTier, Intent
from .features import FeatureBundle
from .tape import Mint


class ValueDistribution(Frozen):
    """A distributional value estimate (C51 categorical or QR/IQN quantile; paper §6.3).

    Fat-tailed new-pair returns make a scalar value useless for risk-sensitive sizing, so the
    critic emits a distribution and the sizing head reads a risk measure (e.g. CVaR) off it.

    * categorical: ``locations`` are atom values, ``weights`` are probabilities (sum≈1).
    * quantile:    ``locations`` are quantile *levels* implied by uniform spacing, ``weights``
                   are the quantile *values*; we store the realized values in ``locations`` and
                   uniform quantile mass in ``weights`` for a single mean/CVaR code path.

    Both forms reduce to (support, mass) pairs, so :meth:`mean` and :meth:`cvar` are one impl.
    """

    representation: Literal["categorical", "quantile"]
    locations: list[float] = Field(min_length=1, description="Atom values (support).")
    weights: list[float] = Field(min_length=1, description="Non-negative masses over locations.")

    @model_validator(mode="after")
    def _check(self) -> ValueDistribution:
        if len(self.locations) != len(self.weights):
            raise ValueError("locations and weights must have equal length")
        if any(w < 0 for w in self.weights):
            raise ValueError("weights must be non-negative")
        if sum(self.weights) <= 0:
            raise ValueError("weights must sum to a positive value")
        return self

    def mean(self) -> float:
        """Probability-weighted mean of the support."""
        loc = np.asarray(self.locations, dtype=float)
        w = np.asarray(self.weights, dtype=float)
        w = w / w.sum()
        return float(np.dot(loc, w))

    def cvar(self, alpha: float = 0.05) -> float:
        """Conditional Value-at-Risk at level ``alpha`` (mean of the worst ``alpha`` tail).

        Risk-sensitive objective per paper §3.5.2 / §6.3 — sizing maximizes CVaR, not the mean,
        which is what suppresses the martingale/lottery attractor.
        """
        if not 0.0 < alpha <= 1.0:
            raise ValueError("alpha must be in (0, 1]")
        loc = np.asarray(self.locations, dtype=float)
        w = np.asarray(self.weights, dtype=float)
        order = np.argsort(loc)
        loc, w = loc[order], w[order]
        w = w / w.sum()
        cum = np.cumsum(w)
        # Take mass up to alpha from the lower (worst) tail.
        cutoff = np.searchsorted(cum, alpha, side="left")
        cutoff = min(cutoff, len(loc) - 1)
        tail_loc = loc[: cutoff + 1]
        tail_w = w[: cutoff + 1].copy()
        # Trim the last bucket so the tail mass equals exactly alpha.
        overshoot = float(cum[cutoff] - alpha)
        if overshoot > 0:
            tail_w[-1] -= overshoot
        total = tail_w.sum()
        if total <= 0:
            return float(tail_loc[0])
        return float(np.dot(tail_loc, tail_w) / total)


class RationaleItem(Frozen):
    """One line of the rationale trace: a feature or tool and its signed contribution."""

    source: str = Field(description="Feature name or tool id that drove the decision.")
    tier: FeatureTier | None = Field(default=None, description="Tier the source belongs to.")
    contribution: float = Field(description="Signed influence on the decision (impl-defined scale).")
    note: str | None = None


class SignalContribution(Frozen):
    """The calibrated single signal Model N exposes to OCT's convergence layer (paper §4.3).

    ``score`` is a calibrated [0,1] conviction. ``independent`` is a standing assertion that this
    signal is not fused with any other detection — convergence combines SCORES only. ``model_id``
    lets the convergence A/B (with-N vs without-N) attribute lift.
    """

    model_id: str = Field(description="Which trained policy/archetype produced this.")
    score: float = Field(ge=0.0, le=1.0, description="Calibrated conviction in [0,1].")
    independent: Literal[True] = True


class AgentDecision(Frozen):
    """The typed decision Model N emits per candidate token per step (paper §4.2).

    Long-only alpha: ``intent`` never expresses a short. ``size`` is a fraction of the risk
    budget in ``[0, f_max]`` (``1.0`` == f_max), consistent with :class:`.sim.Order`.
    """

    mint: Mint
    intent: Intent
    size: float = Field(default=0.0, ge=0.0, le=1.0, description="Fraction of risk budget.")
    value_distribution: ValueDistribution
    confidence: float = Field(ge=0.0, le=1.0, description="Calibrated confidence in [0,1].")
    rationale_trace: list[RationaleItem] = Field(default_factory=list)
    signal_contribution: SignalContribution


@runtime_checkable
class Policy(Protocol):
    """The policy interface: a feature bundle in, a typed decision out. Impl in ``agent/``."""

    def decide(self, bundle: FeatureBundle) -> AgentDecision:
        """Map a causal feature bundle to a typed decision."""
        ...
