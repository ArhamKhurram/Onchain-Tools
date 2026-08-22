"""The reward — realized, cost-inclusive, RISK-ADJUSTED PnL, with a structural anti-unrealized guard.

This module implements paper §3.5 for the Phase-1 substrate. Four commitments are load-bearing and
are enforced by *construction*, not by convention:

1. **Primary term = realized, cost-inclusive, risk-adjusted PnL** (§3.5.2 class 2). The per-step
   return is the realized PnL booked on that step (0 except on a sell; already net of fees + MEV —
   see ``sim/replay/position.py``) divided by the capital base. The risk adjustment is Moody &
   Saffell's **differential Sharpe ratio** (DSR): an online, incremental Sharpe whose per-step
   increment *is* the reward. This is exactly the term that suppresses the martingale/lottery
   attractor (§3.5.1): a policy that occasionally 100×'s and usually zeroes has high return variance
   and therefore a *worse* DSR than a steadier earner, even at equal mean.

2. **Proxies enter ONLY as potential-based shaping** (§3.5.3-A). Any proxy is admitted as
   ``F = γ·Φ(s') − Φ(s)`` for a bounded potential ``Φ`` — the one shaping form proven to leave the
   optimal policy unchanged (Ng, Harada & Russell 1999). The default potential is the zero potential
   (shaping contributes exactly 0); a real ``Φ`` may read only causal *observation* features, never a
   value/PnL quantity. The mechanism is here so a learner can add microstructure shaping without ever
   moving the optimum.

3. **Cost/behavioral terms keep the policy honest** (§3.5.2 class 5): a mild per-step holding cost
   that *induces* (never mandates) the fast-rotation scalper style, and an explicit charge for gas/
   MEV burned on no-fill/failed steps so churn is never free.

4. **The hard rule: no unrealized or peak quantity ever enters the reward** (§3.5.4). This is
   enforced at the type level — :class:`RewardInput` carries only realized figures and observation
   features; there is **no field for ``mark_price``, position value, or any unrealized/peak PnL**.
   :func:`reward_from_step` is the only bridge from a ``SimStepResult`` and it reads
   ``result.realized_pnl_quote`` and the fill's realized costs *only* — never ``result.position
   .mark_price`` (asserted by :func:`assert_no_unrealized_read` and by a standing test that the
   reward is invariant to ``mark_price``).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal

from oct_trading_agent.core import Intent, SimStepResult

# A potential function over causal observation features (proxies only; never a value/PnL quantity).
PotentialFn = Callable[[tuple[float, ...]], float]

# Intents that spend/receive — used only to attribute the (already-realized) costs, never to read
# any unrealized value.
_TRADE_INTENTS = frozenset(
    {Intent.OPEN_LONG, Intent.ADD, Intent.TRIM, Intent.CLOSE}
)


@dataclass(frozen=True)
class RewardInput:
    """The ONLY inputs the reward may read. Realized figures + observation features — nothing else.

    There is deliberately **no** ``mark_price``, no unrealized PnL, no peak-equity field: the type
    cannot express the forbidden quantity (paper §3.5.4). ``realized_pnl_quote`` is the realized,
    cost-inclusive PnL booked on this step (0 unless a sell filled); ``cost_quote`` is gas + MEV
    actually paid out this step (charged even when nothing filled, so churn is never free);
    ``position_open`` gates the holding cost; ``obs_features`` is the causal observation vector a
    (potential-based) shaping term may read.
    """

    realized_pnl_quote: Decimal
    cost_quote: Decimal
    position_open: bool
    intent: Intent
    obs_features: tuple[float, ...] = ()


@dataclass(frozen=True)
class RewardConfig:
    """Weights and knobs for the composed reward. Primary (DSR) dominates; the rest are small."""

    # Adaptation rate of the differential-Sharpe EMAs (Moody & Saffell). Smaller = longer memory.
    dsr_eta: float = 0.01
    # Weight on the primary risk-adjusted term.
    pnl_weight: float = 1.0
    # Class-5 holding/opportunity cost per step while a position is open (percent of capital base).
    # Induces (does not mandate) fast rotation — the scalper style is LEARNED (paper §3.4).
    holding_cost: float = 0.0
    # Weight on the explicit gas/MEV cost charged each step (kept honest; churn is never free).
    cost_weight: float = 1.0
    # Discount used by the potential-based shaping telescoping term.
    gamma: float = 0.99
    # Weight on the potential-based shaping contribution (proxies only; default present-but-zero).
    shaping_weight: float = 1.0

    def __post_init__(self) -> None:
        if not 0.0 < self.dsr_eta <= 1.0:
            raise ValueError("dsr_eta must be in (0, 1]")
        if self.holding_cost < 0.0:
            raise ValueError("holding_cost must be non-negative")
        if not 0.0 <= self.gamma <= 1.0:
            raise ValueError("gamma must be in [0, 1]")


@dataclass(frozen=True)
class RewardBreakdown:
    """A per-step reward and its decomposition (for logging, ablations, and reward audits)."""

    total: float
    risk_adjusted_pnl: float
    holding_cost: float
    trade_cost: float
    shaping: float
    raw_return: float  # the underlying realized percent-return this step (pre risk-adjustment)


class PotentialShaper:
    """A potential-based shaping term ``F = γ·Φ(s') − Φ(s)`` over observation features (proxies only).

    The default :class:`PotentialShaper` uses the **zero potential**, so it contributes exactly 0 —
    the substrate ships with no proxy shaping active, keeping the reward purely the primary term. A
    learner supplies a real ``potential`` callable (bounded, a pure function of the *causal
    observation features only* — never a value/PnL/mark quantity) to steer microstructure exploration
    without moving the optimum (the telescoping guarantee, paper §3.5.3-A).
    """

    def __init__(self, potential: PotentialFn | None = None, gamma: float = 0.99) -> None:
        self._potential = potential or (lambda _f: 0.0)
        self._gamma = gamma
        self._prev: float | None = None

    def reset(self) -> None:
        self._prev = None

    def step(self, obs_features: tuple[float, ...]) -> float:
        phi_next = float(self._potential(obs_features))
        phi_prev = 0.0 if self._prev is None else self._prev
        self._prev = phi_next
        # F = γ·Φ(s') − Φ(s). On the first step Φ(s) is taken as 0 (episode-start potential).
        return self._gamma * phi_next - phi_prev


class DifferentialSharpe:
    """Online differential Sharpe ratio (Moody & Saffell 1998) — the risk-adjusted per-step reward.

    Maintains EMAs of the first (``a``) and second (``b``) moments of the return series; the DSR
    increment ``D_t`` at each step is the reward. ``D_t`` is undefined until the variance estimate is
    positive, so the first steps return 0 (no risk estimate yet) — deliberately, not as a bug.
    """

    def __init__(self, eta: float = 0.01) -> None:
        self._eta = eta
        self._a = 0.0  # EMA of returns
        self._b = 0.0  # EMA of squared returns
        self._initialized = False

    def reset(self) -> None:
        self._a = 0.0
        self._b = 0.0
        self._initialized = False

    def step(self, ret: float) -> float:
        if not self._initialized:
            # Seed the EMAs on the first observed return; no DSR increment is defined yet.
            self._a = self._eta * ret
            self._b = self._eta * ret * ret
            self._initialized = True
            return 0.0
        delta_a = ret - self._a
        delta_b = ret * ret - self._b
        variance = self._b - self._a * self._a
        if variance <= 1e-18:
            dsr = 0.0
        else:
            dsr = (self._b * delta_a - 0.5 * self._a * delta_b) / (variance**1.5)
        self._a += self._eta * delta_a
        self._b += self._eta * delta_b
        return float(dsr)


class RewardFunction:
    """Composes the per-step reward from a :class:`RewardInput`. Stateful (DSR + shaper carry EMAs).

    Call :meth:`reset` at episode start. :meth:`step` returns a :class:`RewardBreakdown`. The class
    NEVER receives a ``PositionState`` or a ``mark_price`` — its only trade input is a
    :class:`RewardInput`, which cannot express an unrealized quantity (paper §3.5.4).
    """

    def __init__(
        self,
        config: RewardConfig | None = None,
        capital_base: Decimal = Decimal(1),
        shaper: PotentialShaper | None = None,
    ) -> None:
        self.config = config or RewardConfig()
        if capital_base <= 0:
            raise ValueError("capital_base must be positive")
        self._capital_base = capital_base
        self._dsr = DifferentialSharpe(self.config.dsr_eta)
        self._shaper = shaper or PotentialShaper(gamma=self.config.gamma)

    def reset(self) -> None:
        self._dsr.reset()
        self._shaper.reset()

    def step(self, item: RewardInput) -> RewardBreakdown:
        # 1) Primary: realized percent-return this step, risk-adjusted online (DSR).
        raw_return = float(item.realized_pnl_quote) / float(self._capital_base)
        risk_adjusted = self.config.pnl_weight * self._dsr.step(raw_return)

        # 2) Class-5 holding/opportunity cost (only while a position is open) — induces fast rotation.
        holding = -self.config.holding_cost if item.position_open else 0.0

        # 3) Explicit realized trade/gas/MEV cost, so churn and failed txns are never free.
        trade_cost = -self.config.cost_weight * (
            float(item.cost_quote) / float(self._capital_base)
        )

        # 4) Potential-based shaping (proxies only; default zero potential -> exactly 0).
        shaping = self.config.shaping_weight * self._shaper.step(item.obs_features)

        total = risk_adjusted + holding + trade_cost + shaping
        return RewardBreakdown(
            total=total,
            risk_adjusted_pnl=risk_adjusted,
            holding_cost=holding,
            trade_cost=trade_cost,
            shaping=shaping,
            raw_return=raw_return,
        )


def reward_from_step(
    result: SimStepResult, obs_features: tuple[float, ...] = ()
) -> RewardInput:
    """Build a :class:`RewardInput` from a ``SimStepResult`` — the single, audited bridge.

    Reads ONLY ``result.realized_pnl_quote`` (realized, cost-inclusive) and the fill's realized gas +
    MEV. It never touches ``result.position.mark_price`` or any unrealized figure — see
    :func:`assert_no_unrealized_read`, and the standing invariance test.
    """
    fill = result.fill
    cost = fill.fee_quote + fill.mev_penalty_quote
    return RewardInput(
        realized_pnl_quote=result.realized_pnl_quote,
        cost_quote=cost,
        position_open=result.position.is_open,
        intent=fill.intent,
        obs_features=obs_features,
    )


def assert_no_unrealized_read(item: RewardInput) -> None:
    """Standing structural guard: a :class:`RewardInput` cannot carry an unrealized quantity.

    ``RewardInput`` has no ``mark_price``/unrealized/peak field by design; this asserts the type has
    not drifted (a regression that added such a field would be caught here and by the invariance
    test in ``tests/``). It is cheap and is called on the reward path in the env.
    """
    forbidden = {"mark_price", "unrealized", "peak", "mtm", "mark"}
    fields = set(item.__dataclass_fields__)
    leaked = fields & forbidden
    if leaked:
        raise AssertionError(
            f"RewardInput must never carry an unrealized/peak quantity; found {sorted(leaked)} "
            "(paper §3.5.4 — never reward unrealized/peak PnL)"
        )


__all__ = [
    "DifferentialSharpe",
    "PotentialFn",
    "PotentialShaper",
    "RewardBreakdown",
    "RewardConfig",
    "RewardFunction",
    "RewardInput",
    "assert_no_unrealized_read",
    "reward_from_step",
]
