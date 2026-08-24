"""Causal, stride-refit attention-feature tracker — per-decision-instant §4.4 features.

The pipeline (:mod:`.pipeline`) emits a full :class:`~oct_trading_agent.core.attention.AttentionState`
but refits the Hawkes model from scratch on every call — fine for an alert, wasteful for an RL env
that asks for features at EVERY decision instant of EVERY episode over thousands of training
iterations. This module is the env-facing wrapper: it fits the two-dimensional (buy/sell)
exponential-kernel Hawkes model (:mod:`.hawkes`, EM, pure numpy) **on a stride** — refit points sit
on a fixed event-count grid ``min_events, min_events + refit_stride, …`` — and caches each fit, so a
token's whole training run pays for each refit exactly once. Between grid points the *cached
parameters* are re-evaluated causally over the events observed so far, which keeps λ_buy(t)
event-fresh while the (slower-moving) parameter estimate updates on the stride.

Per decision instant the tracker exposes exactly the three tier-A+ observation features:

* ``lambda_buy_ratio`` — λ_buy(t) / μ_buy: current buy intensity relative to the fitted exogenous
  base rate. 1 ≈ "arrivals are pure discovery"; ≫1 = "the tape is running hot vs its own baseline".
  This IS the attention chart (paper §4.4), normalized so it is comparable across tokens.
* ``branching_ratio_n`` — the attention-momentum scalar (Filimonov & Sornette endogeneity,
  paper §4.2): n→0 discovery-only, n→1 near-critical, **n ≥ 1 explosive — reported honestly, never
  silently clipped** (the :attr:`AttentionFeatures.explosive` property flags it).
* ``suspicion`` — the MANDATORY manipulation-suspicion companion (:mod:`.manipulation`,
  paper §4.4/§9.10). The env never emits the two attention features without it: all three slots
  share one mask bit, so a consumer cannot see λ/n with the authenticity channel missing.

**What the suspicion heuristic can and cannot catch** (honest, per §9.10): it is a pure-flow blend —
Benford/first-digit shape, round-number gluts, breadth deficit (repeat trading by few signers),
buyer concentration — computed from the SAME tape as the attention signal. It catches lazy wash
signatures (metronomic scripted sizes, few-wallet churn). It CANNOT resolve wallets at this tier:
a sybil operator splitting one entity across many fresh signers with organic-looking sizes defeats
it (Lillo & Farmer's order-splitting result — one actor splitting is genuinely hard to distinguish
from many independent buyers), and self-excitation is not identifiable from a hidden common driver
using flow alone. The score *down-weights* apparent attention; it never proves authenticity.

Causality: ``features_at(as_of)`` is a deterministic pure function of the events with
``block_time <= as_of`` — the fit grid is defined by event COUNT and each grid fit reads only its
prefix of the tape, so a future trade can never change the features reported at ``t`` (unit-tested).
Before ``min_events`` causal events exist the features are MISSING (``observed=False``) and the env
masks them — honest missingness, never an imputed value (paper §8.6 cold-start).
"""

from __future__ import annotations

from bisect import bisect_right
from dataclasses import dataclass
from datetime import datetime

import numpy as np

from oct_trading_agent.core.enums import Side
from oct_trading_agent.core.tape import SwapEvent

from .hawkes import BUY, SELL, HawkesParams, fit_hawkes
from .manipulation import assess_manipulation

_EPS = 1e-9

#: Cap on the reported λ_buy/μ_buy ratio. A near-zero fitted base rate can make the raw ratio
#: astronomically large; the cap keeps the (log1p-transformed) observation slot bounded without
#: distorting any realistic reading. This is a numeric guard, not a clip on the branching ratio.
MAX_LAMBDA_RATIO = 1e6


@dataclass(frozen=True)
class AttentionTrackerConfig:
    """Stride/window knobs for the per-token tracker.

    ``min_events`` is the honest cold-start bar: below it the Hawkes MLE is too unstable to report
    (paper §4.5 "tiny samples") and the features are masked-missing instead. ``refit_stride`` trades
    fit freshness for compute — parameters (and the suspicion score) refresh every N new events,
    while the intensity itself is re-evaluated on every event.
    """

    min_events: int = 20
    refit_stride: int = 10
    max_iter: int = 100
    beta: float | None = None  # None = data-driven default per refit (inverse median gap)


@dataclass(frozen=True)
class AttentionFeatures:
    """The three tier-A+ observation features at one decision instant (plus honesty metadata).

    ``observed=False`` means the tape had fewer than ``min_events`` causal events at ``as_of`` and
    every value is a placeholder the env must mask — never a measured zero.
    """

    lambda_buy_ratio: float
    branching_ratio_n: float
    suspicion: float
    observed: bool
    n_events: int

    @property
    def explosive(self) -> bool:
        """``n >= 1`` — the explosive/unstable regime, flagged rather than silently clipped."""
        return self.branching_ratio_n >= 1.0


#: The masked-missing placeholder emitted before the first fit window (paper §8.6).
MISSING_ATTENTION = AttentionFeatures(
    lambda_buy_ratio=0.0,
    branching_ratio_n=0.0,
    suspicion=0.0,
    observed=False,
    n_events=0,
)


@dataclass(frozen=True)
class _FitCache:
    """One grid point's cached fit: the Hawkes parameters and the window's suspicion score."""

    params: HawkesParams
    suspicion: float


class HawkesAttentionTracker:
    """Causal per-token attention features from the swap tape, Hawkes-fit on an event-count stride.

    Construct once per token with its (full) swap list; the tracker only ever READS the prefix at or
    before the queried instant, so handing it the whole tape is safe (and lets one tracker serve
    every episode/reset over the same token). All state is a cache of prefix fits — the tracker has
    no notion of "current time", which is what makes ``features_at`` a pure function of ``as_of``.
    """

    def __init__(
        self,
        swaps: list[SwapEvent],
        *,
        config: AttentionTrackerConfig | None = None,
    ) -> None:
        self.config = config or AttentionTrackerConfig()
        if self.config.min_events < 2:
            raise ValueError("min_events must be >= 2 (a Hawkes fit needs inter-event gaps)")
        if self.config.refit_stride < 1:
            raise ValueError("refit_stride must be >= 1")
        ordered = sorted(swaps, key=lambda e: (e.block_time, e.slot))
        self._swaps = ordered
        self._block_times = [e.block_time for e in ordered]
        if ordered:
            start = ordered[0].block_time
            self._start: datetime | None = start
            self._times = np.array(
                [(e.block_time - start).total_seconds() for e in ordered], dtype=float
            )
            self._dims = np.array(
                [BUY if e.side is Side.BUY else SELL for e in ordered], dtype=int
            )
        else:
            self._start = None
            self._times = np.empty(0, dtype=float)
            self._dims = np.empty(0, dtype=int)
        self._fits: dict[int, _FitCache] = {}

    @property
    def n_swaps(self) -> int:
        return len(self._swaps)

    def _grid_point(self, m: int) -> int:
        """Largest refit grid point ``<= m`` (grid: min_events, min_events + stride, …)."""
        cfg = self.config
        return cfg.min_events + ((m - cfg.min_events) // cfg.refit_stride) * cfg.refit_stride

    def _fit_prefix(self, m_fit: int) -> _FitCache:
        """Fit (or fetch the cached fit of) the first ``m_fit`` events — parameters + suspicion."""
        cached = self._fits.get(m_fit)
        if cached is not None:
            return cached

        times = self._times[:m_fit]
        dims = self._dims[:m_fit]
        fit = fit_hawkes(
            times,
            dims,
            n_dims=2,
            labels=("buy", "sell"),
            beta=self.config.beta,
            T=float(times[-1]),
            max_iter=self.config.max_iter,
        )

        window = self._swaps[:m_fit]
        buys = [e for e in window if e.side is Side.BUY]
        buy_sizes = np.array([float(e.quote_amount) for e in buys], dtype=float)
        buyer_index: dict[str, int] = {}
        buyer_ids = np.array(
            [buyer_index.setdefault(e.signer, len(buyer_index)) for e in buys], dtype=int
        )
        all_sizes = np.array([float(e.quote_amount) for e in window], dtype=float)
        report = assess_manipulation(
            buy_sizes=buy_sizes, buyer_ids=buyer_ids, all_sizes=all_sizes
        )
        if not np.isfinite(report.suspicion):
            raise RuntimeError(
                "manipulation-suspicion channel produced a non-finite score; refusing to emit "
                "attention features without their mandatory authenticity companion (paper §9.10)"
            )

        cache = _FitCache(params=fit.params, suspicion=float(report.suspicion))
        self._fits[m_fit] = cache
        return cache

    def features_at(self, as_of: datetime) -> AttentionFeatures:
        """The tier-A+ attention features from the events with ``block_time <= as_of`` — causal.

        Deterministic in ``as_of``: the fit grid is an event-count grid and every fit reads only its
        prefix, so trades after ``as_of`` cannot alter the result. Returns a masked-missing
        :class:`AttentionFeatures` until ``min_events`` causal events exist.
        """
        m = bisect_right(self._block_times, as_of)
        if m < self.config.min_events or self._start is None:
            return AttentionFeatures(
                lambda_buy_ratio=0.0,
                branching_ratio_n=0.0,
                suspicion=0.0,
                observed=False,
                n_events=m,
            )

        cache = self._fit_prefix(self._grid_point(m))
        params = cache.params

        # λ(t) with the cached parameters over the events observed so far. The event at exactly
        # ``as_of`` is included (the window is closed on the right, matching the tier-A features
        # and ``HawkesFit.intensity_at_end``); the +eps keeps its kernel contribution ~1.
        t = (as_of - self._start).total_seconds() + _EPS
        decays = np.exp(-params.beta * (t - self._times[:m]))
        dims = self._dims[:m]
        src = np.array(
            [float(np.sum(decays[dims == ell])) for ell in range(params.n_dims)], dtype=float
        )
        lam = params.mu + params.alpha @ src
        lambda_buy = float(max(lam[BUY], 0.0))
        ratio = float(min(lambda_buy / max(float(params.mu[BUY]), _EPS), MAX_LAMBDA_RATIO))

        return AttentionFeatures(
            lambda_buy_ratio=ratio,
            branching_ratio_n=float(params.branching_ratio),
            suspicion=cache.suspicion,
            observed=True,
            n_events=m,
        )


__all__ = [
    "MAX_LAMBDA_RATIO",
    "MISSING_ATTENTION",
    "AttentionFeatures",
    "AttentionTrackerConfig",
    "HawkesAttentionTracker",
]
