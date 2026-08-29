"""``ConcentratedLiquidityCurve`` — an EFFECTIVE-LOCAL-LIQUIDITY approximation for CLMM/DLMM/Whirlpool.

Concentrated-liquidity venues (Orca Whirlpool, Raydium CLMM, Meteora DLMM) together are ~14% of
Solana new-pair swaps (PROGRESS 2026-08-22 (h): meteora_dlmm 5.8%, orca_whirlpool 5.5%,
raydium_clmm 3.0%). They do **not** obey a single global ``x·y=k`` law: liquidity is provisioned into
discrete price ranges (ticks / bins), so the depth a swap actually trades against is the *active*
liquidity ``L`` at the current tick — and that quantity is **not carried by the swap tape**.

What is and is not claimed
--------------------------
This curve is deliberately NOT a tick-accurate CLMM simulator. A faithful CLMM fill needs the tick
map (the liquidity at every initialized tick), which the firehose does not give us. What we CAN do,
honestly, is a **local approximation**:

* Uniswap-V3 math says that *within a single tick range* (where ``L`` is constant) a CLMM is exactly
  a constant-product AMM on **virtual reserves** ``x_v = L/√P``, ``y_v = L·√P`` (so ``x_v·y_v = L²``
  and the mid price ``y_v/x_v = P``). Inside that range the fill law is closed-form and exact.
* The one unknown, ``L``, is **inferred from recent swaps on the same pool** by self-consistency —
  the same idea as the AMM depth fit, but re-estimated on a *rolling local window* because ``L``
  changes every time price crosses a tick. See :class:`RollingLocalLiquidityEstimator`.

Where it holds / where it breaks (this map is the deliverable, not a false claim of exactness)
----------------------------------------------------------------------------------------------
* **Holds** — small orders that move price a small fraction *within* the current active range, on a
  pool whose active liquidity is roughly stable over the estimation window. Here the virtual-reserve
  fill reproduces observed outputs to low error.
* **Breaks** — (a) an order (or a run of orders) large enough to **cross a tick/bin**: ``L`` steps to
  a new value the single-window fit cannot see, so the extrapolation diverges; (b) **sparse / spiky
  liquidity** where ``L`` is unstable window-to-window; (c) **Meteora DLMM specifically**,
  whose bins are *constant-sum* (fixed price within a bin) rather than constant-product — the CP-local
  model is a coarser approximation there, least accurate right at a bin edge.

Because the model has a bounded validity envelope, a fill that leaves that envelope is returned as a
**flagged, low-confidence** :class:`CLMMFill` (``in_range=False``, ``confidence="low"``) — never a
silent wrong number. Structural impossibilities (non-positive input, no configured ``L``,
insufficient virtual depth) raise ``ValueError`` exactly as the constant-product path does.

Fee treatment
-------------
CLMM/V3 fees are taken on the **input** and accrue to LPs as fee-growth *outside* the active
liquidity — they do **not** re-enter the swapped reserves. So only the post-fee amount moves the
virtual reserves, and ``k_v = L²`` is preserved within the range (unlike the Uniswap-V2 retention the
plain :class:`~oct_trading_agent.sim.curves.constant_product.ConstantProductCurve` uses, where the fee
grows ``k``). ``executed_price`` still embeds the whole fee (gross in / gross out), so the reported
slippage is what the trader actually pays.

All arithmetic is ``Decimal``; the ``L`` estimator uses numpy for a fast float sweep and returns
``L`` as ``Decimal`` (the shipped curve is then driven in ``Decimal`` end-to-end).

References (fetched 2026-08-22):
  * Uniswap v3 whitepaper §6.2–6.3 — virtual reserves ``x_v=L/√P``, ``y_v=L·√P``; fee taken on input,
    accrued as fee-growth outside the pool's active liquidity.
  * Orca Whirlpools / Raydium CLMM docs — concentrated liquidity in tick ranges; per-tier fees.
  * Meteora DLMM docs — discrete *bins*, constant-sum within a bin (the approximation caveat above).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from decimal import Decimal
from typing import ClassVar, Literal

import numpy as np

from oct_trading_agent.core import Side
from oct_trading_agent.sim.amm.curve import CurveFill
from oct_trading_agent.sim.amm.fees import PoolConfig
from oct_trading_agent.sim.amm.pool import PoolState

from .base import Curve, CurveInput
from .registry import register_curve

__all__ = [
    "CLMM_VENUES",
    "DEFAULT_CLMM_FEE_BPS",
    "DEFAULT_VALID_RANGE_FRACTION",
    "CLMMFill",
    "LocalSwapObservation",
    "LocalLiquidityEstimate",
    "RollingLocalLiquidityEstimator",
    "ConcentratedLiquidityCurve",
]

_BPS = Decimal(10_000)

#: Pinax ``protocol`` ids this curve models. ``meteora_daam`` is intentionally NOT here: it is a
#: constant-product ("dynamic AMM") venue already owned by ``ConstantProductCurve`` — a CLMM model
#: would mis-price it. DLMM (``meteora_dlmm``) is the concentrated/binned Meteora venue and belongs
#: here (as a documented coarser approximation — see the module docstring).
CLMM_VENUES: tuple[str, ...] = ("orca_whirlpool", "raydium_clmm", "meteora_dlmm")

#: A representative CLMM fee tier (0.30%). Real tiers vary per pool (1 / 5 / 25 / 30 / 100 bps on
#: Orca/Raydium; base+variable on DLMM) — construct with the tier the calibration fit for the pool.
DEFAULT_CLMM_FEE_BPS = 30

#: How far (as a fraction of price) a fill may move the mid before we stop trusting the single-range
#: assumption. Beyond this the fill is flagged ``in_range=False`` / ``confidence="low"`` — the price
#: is likely crossing a tick, where ``L`` changes and the local model loses validity.
DEFAULT_VALID_RANGE_FRACTION = Decimal("0.02")  # 2%


@dataclass(frozen=True)
class CLMMFill(CurveFill):
    """A :class:`CurveFill` plus the CLMM-approximation's honesty fields.

    It **is** a ``CurveFill`` (subclass), so every downstream consumer that reads the shared fill
    shape keeps working unchanged; the extra fields let a caller that cares interrogate the model's
    confidence rather than trusting a bare number.

    * ``effective_liquidity`` — the active ``L`` the fill was priced against.
    * ``price_move_fraction`` — ``|mid_after/mid_before − 1|`` this order caused (the range it used).
    * ``valid_range_fraction`` — the configured width the local single-range assumption is trusted to.
    * ``in_range`` — whether the move stayed inside that width (``price_move_fraction <=`` it).
    * ``confidence`` — ``"high"`` when ``in_range`` (small move, ``L`` ~constant), else ``"low"``
      (likely a tick crossing / out-of-range extrapolation — treat the number as indicative only).
    * ``reserves_are_virtual`` — always ``True``: ``*_reserve_after`` are the CLMM **virtual**
      reserves ``(L/√P, L·√P)`` after the fill, NOT vault balances. They propagate correctly *within*
      a range (``k_v=L²`` preserved) and are the right state to carry for a next small local fill.
    """

    effective_liquidity: Decimal = Decimal(0)
    price_move_fraction: Decimal = Decimal(0)
    valid_range_fraction: Decimal = DEFAULT_VALID_RANGE_FRACTION
    in_range: bool = True
    confidence: Literal["high", "low"] = "high"
    reserves_are_virtual: bool = True


@dataclass(frozen=True)
class LocalSwapObservation:
    """One observed swap on a pool, in UI units — the estimator's input.

    ``amount_in`` is the input leg (SOL for a BUY, token for a SELL); ``observed_out`` is what the
    swap actually produced (token for a BUY, SOL for a SELL). Mirrors ``core.tape.SwapEvent``'s
    BUY=SOL-in / SELL=SOL-out convention and the reference ``scripts/pumpfun_fee_repro.py`` parse.
    """

    side: Side
    amount_in: Decimal
    observed_out: Decimal


@dataclass(frozen=True)
class LocalLiquidityEstimate:
    """The result of a rolling-window ``L`` fit, with the diagnostics a caller needs to trust it.

    * ``effective_liquidity`` — the fitted active ``L`` (``Decimal``).
    * ``reference_price`` — the price ``P0`` the window anchored at (quote per base).
    * ``n_samples`` — swaps the fit used.
    * ``median_rel_error`` — median ``|pred/obs − 1|`` over the window at the fitted ``L`` (fit quality;
      a large value means the single-``L`` assumption did not hold across the window).
    * ``price_drift`` — ``max/min`` executed price over the window; a proxy for how many ranges the
      window spans (``~1.0`` = stable single range; large = crossed ticks, ``L`` not constant).
    * ``reliable`` — a convenience gate: the fit is tight AND the window did not drift far.
    """

    effective_liquidity: Decimal
    reference_price: Decimal
    n_samples: int
    median_rel_error: Decimal
    price_drift: Decimal

    @property
    def reliable(self) -> bool:
        return (
            self.n_samples >= 8
            and self.median_rel_error <= Decimal("0.01")
            and self.price_drift <= Decimal("1.05")
        )


def _sqrt(x: Decimal) -> Decimal:
    """``Decimal`` square root under the active context (no global-state mutation)."""
    return x.sqrt()


def _virtual_reserves(liquidity: Decimal, price: Decimal) -> tuple[Decimal, Decimal]:
    """Uniswap-V3 virtual reserves for active liquidity ``L`` at price ``P``: ``(L/√P, L·√P)``."""
    root = _sqrt(price)
    return liquidity / root, liquidity * root


class RollingLocalLiquidityEstimator:
    """Infer the active liquidity ``L`` of a CLMM pool from a rolling window of recent swaps.

    The tape carries no active-liquidity figure, so we recover it by **self-consistency**: pick the
    single ``L`` (at an anchor price ``P0``) that, propagated through the window's swaps under the
    virtual-reserve fill law, best reproduces the observed outputs. This is the CLMM analogue of the
    constant-product depth fit — but it MUST be re-run on a rolling *local* window, because ``L``
    steps every time price crosses a tick; a global fit would smear several ranges together.

    The sweep runs on floats (fast); ``L`` is returned as ``Decimal``. No network — the caller
    supplies the observations (from the tape, or the validation script's Pinax pull).
    """

    def __init__(
        self,
        *,
        window: int = 60,
        fee_bps: int = DEFAULT_CLMM_FEE_BPS,
        grid_points: int = 48,
    ) -> None:
        if window < 4:
            raise ValueError("window must be >= 4 swaps for a meaningful fit")
        self._config = PoolConfig(fee_bps=fee_bps)  # reuse 0<=fee<10000 validation
        self.window = window
        self.grid_points = grid_points

    @property
    def fee_bps(self) -> int:
        return self._config.fee_bps

    @property
    def fee_fraction(self) -> Decimal:
        return self._config.fee_fraction

    # -- the fit --------------------------------------------------------------------------------

    def estimate(self, swaps: Sequence[LocalSwapObservation]) -> LocalLiquidityEstimate:
        """Fit ``L`` on the **last** ``window`` observations in ``swaps`` (causal — most recent local
        state). Raises ``ValueError`` if too few usable swaps."""
        window = [s for s in swaps if s.amount_in > 0 and s.observed_out > 0][-self.window :]
        if len(window) < 4:
            raise ValueError("need >= 4 usable swaps in the window to fit L")

        ins = np.array([float(s.amount_in) for s in window])
        obs = np.array([float(s.observed_out) for s in window])
        sides = np.array([1 if s.side is Side.BUY else -1 for s in window])
        fee = float(self.fee_fraction)

        # Anchor price from the first swap's executed price (SOL per token). Small-order executed
        # price ~ mid; the fit refines depth around it.
        p0 = ins[0] / obs[0] if sides[0] == 1 else obs[0] / ins[0]
        prices = np.where(sides == 1, ins / obs, obs / ins)
        drift = float(prices.max() / prices.min()) if prices.min() > 0 else float("inf")

        median_rel_error, liquidity, p_fit = self._sweep(ins, obs, sides, p0, fee)
        return LocalLiquidityEstimate(
            effective_liquidity=Decimal(str(liquidity)),
            reference_price=Decimal(str(p_fit)),
            n_samples=len(window),
            median_rel_error=Decimal(str(median_rel_error)),
            price_drift=Decimal(str(drift)),
        )

    def _sweep(
        self, ins: np.ndarray, obs: np.ndarray, sides: np.ndarray, p0: float, fee: float
    ) -> tuple[float, float, float]:
        """Geometric sweep over ``L`` then coordinate-descent on ``(L, P0)``.

        ``L`` is the depth we want; the anchor price ``P0`` is seeded from the first swap's executed
        price (which embeds fee + half-impact, so it is only *near* the true mid) and refined jointly,
        because a small ``P0`` error otherwise leaks into the ``L`` fit. Returns
        ``(median_rel_error, L, P0)``.
        """
        # A scale for L: virtual quote depth y_v = L·√P is at least a few times the largest single
        # quote inflow. Sweep a wide band around that.
        root_p = p0 ** 0.5
        quote_scale = max(float(np.sum(np.where(sides == 1, ins, obs))), 1e-9)
        l_center = quote_scale / root_p
        grid = np.geomspace(l_center * 1e-3, l_center * 1e3, self.grid_points)

        # The window is fixed across the whole sweep — only (L, P0) vary — so convert the numpy
        # windows to Python lists ONCE here rather than re-boxing them on every one of the ~160
        # _median_rel_error calls this sweep makes. (The numpy arrays are still needed above for the
        # quote-scale reduction; only the scalar recurrence wants lists.)
        ins_l: list[float] = ins.tolist()
        obs_l: list[float] = obs.tolist()
        sides_l: list[int] = sides.tolist()

        best: tuple[float, float, float] | None = None
        for liquidity in grid:
            med = self._median_rel_error(ins_l, obs_l, sides_l, liquidity, p0, fee)
            if med is not None and (best is None or med < best[0]):
                best = (med, float(liquidity), p0)
        if best is None:
            raise ValueError("L fit failed: virtual depth drained under every guess")

        med, liquidity, price = best
        for _ in range(80):
            improved = False
            # Refine L.
            for scale in (1.1, 0.9, 1.03, 0.97, 1.008, 0.992):
                m = self._median_rel_error(ins_l, obs_l, sides_l, liquidity * scale, price, fee)
                if m is not None and m < med:
                    med, liquidity, improved = m, liquidity * scale, True
            # Refine the anchor price P0.
            for scale in (1.02, 0.98, 1.005, 0.995, 1.001, 0.999):
                m = self._median_rel_error(ins_l, obs_l, sides_l, liquidity, price * scale, fee)
                if m is not None and m < med:
                    med, price, improved = m, price * scale, True
            if not improved:
                break
        return med, liquidity, price

    @staticmethod
    def _median_rel_error(
        ins: list[float], obs: list[float], sides: list[int], liquidity: float, p0: float, fee: float
    ) -> float | None:
        """Propagate the window through the virtual-reserve law at ``L`` and score |pred/obs−1|.

        Fee is taken on the input and accrues OUTSIDE the reserves (V3 fee-growth), so only the
        post-fee amount moves the virtual reserves and ``k_v`` is preserved within the range.

        HOT PATH — the profiler puts ~90% of tape-prep time here (``_sweep`` calls it ~160×/token).
        It is a scalar recurrence (each step's reserves feed the next), so it cannot vectorise across
        the window. The win is therefore to run it in *pure Python over lists*: numpy scalar indexing
        (``ins[i]``) boxes an object per access, and a per-call ``np.median`` drags partition +
        nan-check + dtype machinery over a tiny array — both cost far more than the arithmetic itself.
        Results are bit-identical: the same float64 ops in the same order, and the same median
        definition (mean of the two central order statistics for even n).
        """
        one_minus_fee = 1.0 - fee
        root = p0 ** 0.5
        x_v = liquidity / root  # base virtual reserve
        y_v = liquidity * root  # quote virtual reserve
        rel: list[float] = []
        for amt_in, amt_obs, side in zip(ins, obs, sides, strict=True):
            if x_v <= 0.0 or y_v <= 0.0:
                return None
            d_eff = amt_in * one_minus_fee
            if side == 1:  # BUY: SOL in -> token out
                out = x_v * d_eff / (y_v + d_eff)
                if out >= x_v:
                    return None
                x_v -= out
                y_v += d_eff
            else:  # SELL: token in -> SOL out
                out = y_v * d_eff / (x_v + d_eff)
                if out >= y_v:
                    return None
                x_v += d_eff
                y_v -= out
            rel.append(abs(out / amt_obs - 1.0) if amt_obs else float("inf"))
        n = len(rel)
        if n == 0:
            return None
        rel.sort()
        mid = n // 2
        return rel[mid] if n & 1 else 0.5 * (rel[mid - 1] + rel[mid])


@register_curve(*CLMM_VENUES)
class ConcentratedLiquidityCurve(Curve):
    """Effective-local-liquidity CLMM fill: constant-product on virtual reserves ``(L/√P, L·√P)``.

    Construct with the active liquidity ``L`` (from :class:`RollingLocalLiquidityEstimator` on recent
    pool swaps) and the pool's fee tier. The registry auto-registers a zero-arg *template* (``L``
    unset) for venue dispatch; that template can price nothing until given an ``L`` — call
    :meth:`with_liquidity` or :meth:`from_recent_swaps`, or construct directly.

    The pre-trade **price** comes from ``PoolState.mid_price`` (``quote_reserve/base_reserve``); the
    pre-trade **depth** does NOT — for a CLMM the vault reserves are not the swap depth, so only the
    price ratio is read from ``PoolState`` and the virtual depth comes from ``L``.
    """

    venues: ClassVar[tuple[str, ...]] = CLMM_VENUES

    def __init__(
        self,
        *,
        effective_liquidity: Decimal | None = None,
        fee_bps: int = DEFAULT_CLMM_FEE_BPS,
        valid_range_fraction: Decimal = DEFAULT_VALID_RANGE_FRACTION,
        protocol: str | None = None,
    ) -> None:
        if effective_liquidity is not None and effective_liquidity <= 0:
            raise ValueError("effective_liquidity must be positive when provided")
        if valid_range_fraction <= 0:
            raise ValueError("valid_range_fraction must be positive")
        self._config = PoolConfig(fee_bps=fee_bps)  # reuse fee validation + fraction conversion
        self.effective_liquidity = effective_liquidity
        self.valid_range_fraction = valid_range_fraction
        self.protocol = protocol

    # -- construction helpers -------------------------------------------------------------------

    @property
    def fee_bps(self) -> int:
        return self._config.fee_bps

    @property
    def fee_fraction(self) -> Decimal:
        return self._config.fee_fraction

    def with_liquidity(self, effective_liquidity: Decimal) -> ConcentratedLiquidityCurve:
        """A copy of this curve pinned to ``effective_liquidity`` (keeps fee / range / protocol)."""
        return ConcentratedLiquidityCurve(
            effective_liquidity=effective_liquidity,
            fee_bps=self.fee_bps,
            valid_range_fraction=self.valid_range_fraction,
            protocol=self.protocol,
        )

    @classmethod
    def from_recent_swaps(
        cls,
        swaps: Sequence[LocalSwapObservation],
        *,
        fee_bps: int = DEFAULT_CLMM_FEE_BPS,
        valid_range_fraction: Decimal = DEFAULT_VALID_RANGE_FRACTION,
        window: int = 60,
        protocol: str | None = None,
    ) -> tuple[ConcentratedLiquidityCurve, LocalLiquidityEstimate]:
        """Fit ``L`` on ``swaps`` and return ``(curve, estimate)``. The estimate carries the fit
        diagnostics (``median_rel_error`` / ``price_drift`` / ``reliable``) so the caller can decide
        whether to trust the resulting fills."""
        estimator = RollingLocalLiquidityEstimator(window=window, fee_bps=fee_bps)
        estimate = estimator.estimate(swaps)
        curve = cls(
            effective_liquidity=estimate.effective_liquidity,
            fee_bps=fee_bps,
            valid_range_fraction=valid_range_fraction,
            protocol=protocol,
        )
        return curve, estimate

    # -- the fill -------------------------------------------------------------------------------

    def fill(self, request: CurveInput, state: PoolState) -> CLMMFill:
        if request.amount_in <= 0:
            raise ValueError("amount_in must be positive")
        if self.effective_liquidity is None:
            raise ValueError(
                "ConcentratedLiquidityCurve has no effective_liquidity; construct with one "
                "(with_liquidity / from_recent_swaps) — the registry template cannot price a fill"
            )
        price = state.mid_price
        if price is None or price <= 0:
            raise ValueError("pool state has no positive price to anchor the local range")

        liquidity = self.effective_liquidity
        x_v, y_v = _virtual_reserves(liquidity, price)
        fee = self.fee_fraction

        if request.side is Side.BUY:
            return self._fill_buy(request.amount_in, x_v, y_v, price, liquidity, fee)
        return self._fill_sell(request.amount_in, x_v, y_v, price, liquidity, fee)

    def _fill_buy(
        self,
        quote_in: Decimal,
        x_v: Decimal,
        y_v: Decimal,
        mid_before: Decimal,
        liquidity: Decimal,
        fee: Decimal,
    ) -> CLMMFill:
        """BUY: SOL in, token out. Fee on the quote input, accrued outside (k_v preserved)."""
        dq_eff = quote_in * (Decimal(1) - fee)
        base_out = x_v * dq_eff / (y_v + dq_eff)
        if base_out >= x_v:
            raise ValueError("order exceeds available virtual base depth at the current tick")
        x_v_after = x_v - base_out
        y_v_after = y_v + dq_eff
        executed_price = quote_in / base_out  # gross SOL per token (embeds the fee)
        return self._assemble(
            side=Side.BUY,
            base_amount=base_out,
            quote_amount=quote_in,
            executed_price=executed_price,
            mid_before=mid_before,
            x_v_after=x_v_after,
            y_v_after=y_v_after,
            liquidity=liquidity,
        )

    def _fill_sell(
        self,
        base_in: Decimal,
        x_v: Decimal,
        y_v: Decimal,
        mid_before: Decimal,
        liquidity: Decimal,
        fee: Decimal,
    ) -> CLMMFill:
        """SELL: token in, SOL out. Fee on the base input, accrued outside (k_v preserved)."""
        db_eff = base_in * (Decimal(1) - fee)
        quote_out = y_v * db_eff / (x_v + db_eff)
        if quote_out >= y_v:
            raise ValueError("order exceeds available virtual quote depth at the current tick")
        x_v_after = x_v + db_eff
        y_v_after = y_v - quote_out
        executed_price = quote_out / base_in  # gross SOL per token (net of fee)
        return self._assemble(
            side=Side.SELL,
            base_amount=base_in,
            quote_amount=quote_out,
            executed_price=executed_price,
            mid_before=mid_before,
            x_v_after=x_v_after,
            y_v_after=y_v_after,
            liquidity=liquidity,
        )

    def _assemble(
        self,
        *,
        side: Side,
        base_amount: Decimal,
        quote_amount: Decimal,
        executed_price: Decimal,
        mid_before: Decimal,
        x_v_after: Decimal,
        y_v_after: Decimal,
        liquidity: Decimal,
    ) -> CLMMFill:
        mid_after = y_v_after / x_v_after
        price_move_fraction = abs(mid_after / mid_before - Decimal(1))
        in_range = price_move_fraction <= self.valid_range_fraction
        return CLMMFill(
            side=side,
            base_amount=base_amount,
            quote_amount=quote_amount,
            executed_price=executed_price,
            mid_price_before=mid_before,
            mid_price_after=mid_after,
            slippage_bps=abs(executed_price / mid_before - Decimal(1)) * _BPS,
            price_impact_bps=price_move_fraction * _BPS,
            base_reserve_after=x_v_after,
            quote_reserve_after=y_v_after,
            effective_liquidity=liquidity,
            price_move_fraction=price_move_fraction,
            valid_range_fraction=self.valid_range_fraction,
            in_range=in_range,
            confidence="high" if in_range else "low",
            reserves_are_virtual=True,
        )
