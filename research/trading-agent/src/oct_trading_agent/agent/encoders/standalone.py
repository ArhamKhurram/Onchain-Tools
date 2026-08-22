"""The standalone "attention is igniting" signal (paper §4.4 point 3, §6.3) — pure numpy.

Independently of the RL agent, an igniting-attention alert is a shippable OCT signal in the family
of the existing revival and missed-runner alerts. Per §6.3 the condition is a conjunction:

    rising λ_buy  ∧  broadening unique buyers  ∧  n climbing toward 1  ∧  LOW manipulation-suspicion

The last conjunct is not optional decoration — it is the §9.10 discipline in code: a high λ with a
high manipulation-suspicion is *precisely* the wash-trading failure mode, so ignition with poor
authenticity is suppressed, never fired.

The signal works from a single :class:`AttentionState` using level thresholds, and sharpens when a
previous state is supplied so the genuinely *dynamic* conditions ("rising", "climbing", "broadening")
can be read as derivatives rather than levels. Because the state that feeds this alert is the
**stop-gradient / public** copy of the representation (paper §6.4), the alert stays mechanically
independent of the agent's objective — this module must be given the public attention state, never
the policy-shaped one.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from oct_trading_agent.core.attention import AttentionState


@dataclass(frozen=True)
class IgnitionThresholds:
    """Tunable bar for the standalone alert. Defaults are deliberately conservative.

    ``n_low`` / ``n_high`` bracket the near-critical band: ``n`` must be climbing *toward* 1 but an
    ``n`` well past 1 is explosive/manipulated, not "igniting". ``max_manipulation`` is the hard
    authenticity gate (§9.10).
    """

    min_lambda_buy: float = 0.0
    min_unique_buyers: int = 10
    n_low: float = 0.5
    n_high: float = 1.2
    max_manipulation: float = 0.4
    min_buy_sell_ratio: float = 1.0


@dataclass(frozen=True)
class IgnitionSignal:
    """The alert verdict plus its per-condition breakdown and a continuous strength in ``[0, 1]``.

    ``igniting`` is the hard boolean (all conditions met, authenticity gate passed). ``strength``
    is a graded score for ranking candidate pairs even below the firing bar; it is forced to 0 when
    the authenticity gate fails, so a manipulated pair can never rank as igniting.
    """

    igniting: bool
    strength: float
    rising_lambda_buy: bool
    broadening_buyers: bool
    n_near_critical: bool
    low_manipulation: bool
    reason: str


def evaluate_ignition(
    state: AttentionState,
    *,
    previous: AttentionState | None = None,
    thresholds: IgnitionThresholds | None = None,
) -> IgnitionSignal:
    """Evaluate the "attention igniting" condition for one token at one instant.

    Parameters
    ----------
    state
        The current (public / stop-gradient) attention state.
    previous
        An earlier state for the same token, if available. When given, the "rising" / "broadening"
        / "climbing" conditions are read as strict increases; otherwise they fall back to level
        thresholds (a single-snapshot approximation).
    """
    th = thresholds or IgnitionThresholds()

    # --- rising λ_buy: buy pressure dominant, and increasing if we have history ---
    buy_dominant = state.lambda_buy > th.min_buy_sell_ratio * max(state.lambda_sell, 1e-9)
    if previous is not None:
        rising_lambda_buy = buy_dominant and state.lambda_buy > previous.lambda_buy
    else:
        rising_lambda_buy = buy_dominant and state.lambda_buy > th.min_lambda_buy

    # --- broadening unique buyers ---
    if previous is not None:
        broadening = (
            state.unique_buyer_breadth >= th.min_unique_buyers
            and state.unique_buyer_breadth > previous.unique_buyer_breadth
        )
    else:
        broadening = state.unique_buyer_breadth >= th.min_unique_buyers

    # --- n climbing toward 1 (near-critical band), climbing if we have history ---
    in_band = th.n_low <= state.branching_ratio_n <= th.n_high
    if previous is not None:
        n_near_critical = in_band and state.branching_ratio_n > previous.branching_ratio_n
    else:
        n_near_critical = in_band

    # --- authenticity gate (§9.10): LOW manipulation-suspicion is mandatory ---
    low_manipulation = state.manipulation_suspicion <= th.max_manipulation

    igniting = bool(
        rising_lambda_buy and broadening and n_near_critical and low_manipulation
    )

    # Graded strength: a soft product of the same factors, gated hard on authenticity.
    lam_factor = float(np.clip(state.lambda_buy / (state.lambda_buy + state.lambda_sell + 1e-9), 0.0, 1.0))
    breadth_factor = float(np.clip(state.unique_buyer_breadth / max(th.min_unique_buyers * 2, 1), 0.0, 1.0))
    # peak of n-factor at 1.0, falling off outside the band
    n_factor = float(np.clip(1.0 - abs(state.branching_ratio_n - 1.0), 0.0, 1.0))
    auth_factor = float(np.clip(1.0 - state.manipulation_suspicion / max(th.max_manipulation, 1e-9), 0.0, 1.0))
    strength = lam_factor * breadth_factor * n_factor * auth_factor
    if not low_manipulation:
        strength = 0.0

    if not low_manipulation:
        reason = f"suppressed: manipulation_suspicion={state.manipulation_suspicion:.2f} exceeds gate"
    elif igniting:
        reason = "igniting: rising buy-intensity, broadening buyers, near-critical n, low manipulation"
    else:
        missing = [
            name
            for name, ok in (
                ("rising_λ_buy", rising_lambda_buy),
                ("broadening_buyers", broadening),
                ("n_near_critical", n_near_critical),
            )
            if not ok
        ]
        reason = "not igniting: missing " + ", ".join(missing)

    return IgnitionSignal(
        igniting=igniting,
        strength=float(np.clip(strength, 0.0, 1.0)),
        rising_lambda_buy=rising_lambda_buy,
        broadening_buyers=broadening,
        n_near_critical=n_near_critical,
        low_manipulation=low_manipulation,
        reason=reason,
    )


def is_igniting(
    state: AttentionState,
    *,
    previous: AttentionState | None = None,
    thresholds: IgnitionThresholds | None = None,
) -> bool:
    """Convenience boolean wrapper around :func:`evaluate_ignition`."""
    return evaluate_ignition(state, previous=previous, thresholds=thresholds).igniting
