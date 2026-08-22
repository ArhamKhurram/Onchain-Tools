"""``PumpFunAmmCurve`` — pump.fun's post-migration AMM, with its real fee stack (Wave-2 §Step 0).

The first real calibration (PROGRESS 2026-08-22 (h)) found the pump.fun *AMM* (post-migration,
program ``pAMMBay…``) is genuinely constant-product — ``x·y=k`` reproduced 5000 real ``pumpfun_amm``
fills to ~26 bps median, zero curve-breaks. The residual was traced to the fee model: the simulator
priced it with a single flat LP fee, but pump.fun charges a **three-part stack** and treats the
parts differently on-chain. This module models that stack, which is what drives the residual down.

Fee mechanics (pump-swap SDK / on-chain program — see the module's References):

* The fee is quoted in basis points on the **quote (SOL)** leg, split into
  **LP + protocol + creator** components (mainnet defaults: LP 20, protocol 5, creator 5 → 30 bps).
* **Fees are charged *on top of* the traded amount, not deducted from it.** On a BUY the amount the
  user spends already includes the fee, so the amount that actually reaches the constant-product
  invariant is ``quote_in · 10000 / (10000 + total_bps)`` (the SDK's ``buyQuoteInput`` form) — NOT
  the Uniswap-V2 ``quote_in · (1 − f)`` the plain constant-product curve uses. On a SELL the fee is
  taken out of the gross quote the invariant produces: ``user_out = gross_out · (10000 − total_bps)
  / 10000``.
* **Only the LP portion stays in the pool** (it grows ``k``, accruing to LPs). The protocol and
  creator portions are transferred *out* to their own recipients, so they leave the reserves. The
  plain constant-product curve retains the *whole* input — over a long swap sequence that
  over-grows the quote reserve by the protocol+creator share and biases every subsequent fill. This
  curve retains only the LP share, so reserve propagation stays faithful.

The fee is **market-cap tiered** post-graduation (:class:`PumpFunAmmFeeSchedule`): tiny/young pools
pay up to 125 bps (mostly to the creator), decaying toward the mature **30 bps** tier that busy,
graduated pools — the ones the calibration measures — trade at. The default is that mature tier.

References (fetched 2026-08-22):
  * pump.fun web help — "Transaction Fees on Pump.fun" (the tiered table below).
  * pump-fun/pump-public-docs ``PUMP_SWAP_CREATOR_FEE_README`` — LP retained; protocol+creator
    transferred out; ``GlobalConfig.{lp,protocol,coin_creator}_fee_basis_points``.
  * pump-swap-sdk quote math — buy uses ``·10000/(10000+totalBps)``; DeepWiki mainnet defaults
    LP 20 / protocol 5.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import ClassVar

from oct_trading_agent.core import Side
from oct_trading_agent.sim.amm.curve import CurveFill
from oct_trading_agent.sim.amm.pool import PoolState

from .base import Curve, CurveInput
from .registry import register_curve

__all__ = [
    "FeeSplit",
    "PumpFunAmmFeeSchedule",
    "PUMPFUN_AMM_STANDARD_FEE",
    "PUMPFUN_BONDING_CURVE_FEE_BPS",
    "PumpFunAmmCurve",
]

_BPS = Decimal(10_000)

# pump.fun pre-migration BONDING CURVE total fee (protocol 95 + creator 30). Recorded here for
# reference; the bonding-curve FILL law is a separate curve a later Wave-2 agent registers.
PUMPFUN_BONDING_CURVE_FEE_BPS = 125


@dataclass(frozen=True)
class FeeSplit:
    """A pump.fun AMM fee tier: LP / protocol / creator components, in basis points.

    ``lp_bps`` stays in the pool (grows ``k``); ``protocol_bps`` and ``creator_bps`` are paid out of
    the pool to their recipients. ``total_bps`` is what a trader pays; ``pool_retained_bps`` (== LP)
    is what the reserves keep.
    """

    lp_bps: Decimal
    protocol_bps: Decimal
    creator_bps: Decimal

    def __post_init__(self) -> None:
        for name, value in (
            ("lp_bps", self.lp_bps),
            ("protocol_bps", self.protocol_bps),
            ("creator_bps", self.creator_bps),
        ):
            if value < 0:
                raise ValueError(f"{name} must be non-negative, got {value}")
        if self.total_bps >= _BPS:
            raise ValueError(f"total fee must be < 10000 bps, got {self.total_bps}")

    @property
    def total_bps(self) -> Decimal:
        """Total swap fee the trader pays (LP + protocol + creator)."""
        return self.lp_bps + self.protocol_bps + self.creator_bps

    @property
    def pool_retained_bps(self) -> Decimal:
        """The share that stays in the pool reserves (the LP fee)."""
        return self.lp_bps

    @property
    def lp_share_of_total(self) -> Decimal:
        """LP fee as a fraction of the total fee (0 when the total fee is 0)."""
        total = self.total_bps
        return self.lp_bps / total if total > 0 else Decimal(0)


# Mainnet mature tier — LP 20 / protocol 5 / creator 5 = 30 bps. What busy graduated pools trade at.
PUMPFUN_AMM_STANDARD_FEE = FeeSplit(
    lp_bps=Decimal(20), protocol_bps=Decimal(5), creator_bps=Decimal(5)
)


@dataclass(frozen=True)
class PumpFunAmmFeeSchedule:
    """The market-cap-tiered pump.fun AMM fee schedule (post-graduation).

    Fees decay with the pool's market cap in SOL: a young pool pays up to 125 bps (mostly creator),
    a mature pool pays the 30 bps standard tier. :meth:`split_for_market_cap_sol` returns the
    :class:`FeeSplit` for a given market cap; with no market cap it returns :attr:`default`.

    Honesty note: pump.fun publishes the low-mcap anchors and the mature 30 bps tier but not the full
    intermediate ramp (the public table jumps from ~3.4k SOL to 98k SOL). The tiers below are the
    published anchors; between the last explicit tier and the mature tier the schedule is documented
    only as "scales down further", so treat the intermediate region as approximate. For the
    calibration — busy, high-mcap pools — the mature 30 bps tier is the operative one.
    """

    # (inclusive upper bound of market cap in SOL, split). The final tier uses an unbounded cap.
    tiers: tuple[tuple[Decimal, FeeSplit], ...] = (
        (Decimal(420), FeeSplit(Decimal(2), Decimal(93), Decimal(30))),
        (Decimal(1470), FeeSplit(Decimal(20), Decimal(5), Decimal(95))),
        (Decimal(2460), FeeSplit(Decimal(20), Decimal(5), Decimal(90))),
        (Decimal(3440), FeeSplit(Decimal(20), Decimal(5), Decimal(85))),
        (Decimal("Infinity"), PUMPFUN_AMM_STANDARD_FEE),
    )
    default: FeeSplit = PUMPFUN_AMM_STANDARD_FEE

    def split_for_market_cap_sol(self, market_cap_sol: Decimal | None) -> FeeSplit:
        """The fee tier for ``market_cap_sol`` (mature 30 bps tier when unknown)."""
        if market_cap_sol is None:
            return self.default
        if market_cap_sol < 0:
            raise ValueError("market_cap_sol must be non-negative")
        for upper, split in self.tiers:
            if market_cap_sol <= upper:
                return split
        return self.default


@register_curve("pumpfun_amm")
class PumpFunAmmCurve(Curve):
    """Constant-product fills with pump.fun's LP + protocol + creator fee stack.

    Construct with a fixed :class:`FeeSplit` (default: the mature 30 bps tier). To price by
    market-cap tier, resolve the split from a :class:`PumpFunAmmFeeSchedule` and pass it in. The
    curve is otherwise ``x·y=k`` — the calibration confirmed the AMM obeys the constant-product law;
    only the fee treatment differs from :class:`~oct_trading_agent.sim.curves.constant_product.ConstantProductCurve`.
    """

    venues: ClassVar[tuple[str, ...]] = ("pumpfun_amm",)

    def __init__(self, *, fee: FeeSplit = PUMPFUN_AMM_STANDARD_FEE) -> None:
        self.fee = fee

    @classmethod
    def for_market_cap_sol(
        cls,
        market_cap_sol: Decimal | None,
        *,
        schedule: PumpFunAmmFeeSchedule | None = None,
    ) -> PumpFunAmmCurve:
        """Build a curve whose fee is the schedule tier for ``market_cap_sol``."""
        sched = schedule or PumpFunAmmFeeSchedule()
        return cls(fee=sched.split_for_market_cap_sol(market_cap_sol))

    def fill(self, request: CurveInput, state: PoolState) -> CurveFill:
        if request.amount_in <= 0:
            raise ValueError("amount_in must be positive")
        base_reserve = state.base_reserve
        quote_reserve = state.quote_reserve
        if base_reserve <= 0 or quote_reserve <= 0:
            raise ValueError("pool reserves must be positive")

        if request.side is Side.BUY:
            return self._fill_buy(request.amount_in, base_reserve, quote_reserve)
        return self._fill_sell(request.amount_in, base_reserve, quote_reserve)

    # -- fee-stack fills ----------------------------------------------------------------------

    def _fill_buy(
        self, quote_in: Decimal, base_reserve: Decimal, quote_reserve: Decimal
    ) -> CurveFill:
        """BUY: SOL in, token out. Fee is charged on top of ``quote_in`` (SDK ``buyQuoteInput``)."""
        total_bps = self.fee.total_bps
        mid_before = quote_reserve / base_reserve

        # Amount that actually reaches the invariant (fee sits on top of what the user spends).
        effective_quote = quote_in * _BPS / (_BPS + total_bps)
        base_out = base_reserve * effective_quote / (quote_reserve + effective_quote)

        # Split the fee: LP stays in the pool, protocol+creator leave.
        total_fee_amount = quote_in - effective_quote
        lp_fee_amount = total_fee_amount * self.fee.lp_share_of_total

        base_reserve_after = base_reserve - base_out
        quote_reserve_after = quote_reserve + effective_quote + lp_fee_amount
        executed_price = quote_in / base_out  # gross SOL paid per token (embeds the whole fee)

        return self._assemble(
            side=Side.BUY,
            base_amount=base_out,
            quote_amount=quote_in,
            executed_price=executed_price,
            mid_before=mid_before,
            base_reserve_after=base_reserve_after,
            quote_reserve_after=quote_reserve_after,
        )

    def _fill_sell(
        self, base_in: Decimal, base_reserve: Decimal, quote_reserve: Decimal
    ) -> CurveFill:
        """SELL: token in, SOL out. Fee is taken out of the gross quote (SDK ``sellBaseInput``)."""
        total_bps = self.fee.total_bps
        mid_before = quote_reserve / base_reserve

        gross_quote_out = quote_reserve * base_in / (base_reserve + base_in)
        total_fee_amount = gross_quote_out * total_bps / _BPS
        user_quote_out = gross_quote_out - total_fee_amount
        lp_fee_amount = total_fee_amount * self.fee.lp_share_of_total

        base_reserve_after = base_reserve + base_in
        # User + protocol + creator leave the quote reserve; the LP fee stays behind.
        quote_reserve_after = quote_reserve - gross_quote_out + lp_fee_amount
        executed_price = user_quote_out / base_in  # gross SOL received per token (net of fee)

        return self._assemble(
            side=Side.SELL,
            base_amount=base_in,
            quote_amount=user_quote_out,
            executed_price=executed_price,
            mid_before=mid_before,
            base_reserve_after=base_reserve_after,
            quote_reserve_after=quote_reserve_after,
        )

    @staticmethod
    def _assemble(
        *,
        side: Side,
        base_amount: Decimal,
        quote_amount: Decimal,
        executed_price: Decimal,
        mid_before: Decimal,
        base_reserve_after: Decimal,
        quote_reserve_after: Decimal,
    ) -> CurveFill:
        mid_after = quote_reserve_after / base_reserve_after
        return CurveFill(
            side=side,
            base_amount=base_amount,
            quote_amount=quote_amount,
            executed_price=executed_price,
            mid_price_before=mid_before,
            mid_price_after=mid_after,
            slippage_bps=abs(executed_price / mid_before - Decimal(1)) * _BPS,
            price_impact_bps=abs(mid_after / mid_before - Decimal(1)) * _BPS,
            base_reserve_after=base_reserve_after,
            quote_reserve_after=quote_reserve_after,
        )
