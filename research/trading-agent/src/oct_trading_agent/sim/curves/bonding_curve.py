"""``PumpFunBondingCurve`` — pump.fun's PRE-migration bonding curve (Wave-2, Agent E).

This is the venue a brand-new pump.fun pair launches into and lives on until it graduates — the
**earliest-life regime**, and the one the paper's first-minutes focus cares about most (PROGRESS
2026-08-22 (h): ``pumpfun`` is ~8% of swaps and the earliest-life regime). Unlike the post-migration
:class:`~oct_trading_agent.sim.curves.pumpfun.PumpFunAmmCurve` — whose absolute depth had to be
*fitted* — the bonding curve's parameters are **on-chain constants**, so every fill is
**predictable from a closed formula, not fitted**. Give the curve a token's cumulative position
along it (its current virtual reserves) and each swap's output is exact.

Mechanics (all sourced 2026-08-22 — see References):

* **Constant product over VIRTUAL reserves.** The curve prices off *synthetic* reserves seeded at
  creation: ``virtual_token = 1,073,000,000`` and ``virtual_sol = 30`` (UI units). The invariant is
  ``k = virtual_token · virtual_sol`` — Uniswap-V2 form, but on the virtuals, not a real LP pool.
* **A fixed real-token float sits on the curve.** ``real_token = 793,100,000`` of the
  ``1,000,000,000`` total supply are actually sellable on the curve; the ``virtual − real`` gap
  (279.9M tokens) is the synthetic bootstrap that gives the first buyer a finite price. Tokens sold
  come out of *both* the virtual and the real token reserve, so
  ``real_token = initial_real_token − (initial_virtual_token − virtual_token)`` — the curve derives
  the graduation-tracking real reserve from the virtual reserve it is handed, keeping ``(base,
  quote)`` the one reconstructable contract every venue shares.
* **Fees are entirely external (no LP).** A trade pays ``protocol + creator`` bps (mainnet: 95 + 30
  = **125 bps**); both legs are transferred *out* to their recipients, so **none** stays in the
  curve. Consequently ``k`` is preserved *exactly* on both sides — the distinguishing feature from
  the Uniswap-V2 :class:`~oct_trading_agent.sim.curves.constant_product.ConstantProductCurve`
  (retains the whole input, ``k`` grows) and the pump AMM (retains the LP share, ``k`` grows).
  * BUY: the fee sits on **top** of the SOL spent — the amount reaching the invariant is
    ``sol_in · 10000 / (10000 + total_bps)`` (the SDK's ``buyQuoteInput`` form).
  * SELL: the fee is taken **out of** the gross SOL the invariant produces —
    ``user_out = gross_out · (10000 − total_bps) / 10000``.
* **Graduation.** The curve *completes* when the last real token is sold (``real_token == 0``, ~85
  SOL raised), after which the token migrates to the pump AMM and THIS curve no longer applies. A
  buy that would cross the boundary is **capped** at the remaining real tokens (the on-chain
  ``min(tokens_out, real_token_reserves)``) — the faithful final fill. Calling :meth:`fill` on an
  already-completed state raises :class:`BondingCurveComplete` (the explicit handoff signal), never a
  silent extrapolation past the curve's domain.

Decimal math throughout (on-chain amounts are large; float drift is unacceptable — 03 §Phase 0).

References (fetched 2026-08-22):
  * pump-fun/pump-public-docs ``PUMP_PROGRAM_README`` + DeepWiki "Bonding Curve Mechanism":
    ``initial_virtual_token_reserves = 1_073_000_000_000_000``,
    ``initial_virtual_sol_reserves = 30_000_000_000`` lamports,
    ``initial_real_token_reserves = 793_100_000_000_000``,
    ``token_total_supply = 1_000_000_000_000_000`` (all raw, 6-decimal tokens / 9-decimal SOL);
    ``complete`` set when ``real_token_reserves == 0``; ``k = v_token · v_sol``, buy solves the
    invariant then caps at real reserves.
  * pump.fun help "Fees" + froglabs.io fee breakdown (verified 2026-08-22): bonding-curve trades pay
    **1.25% total = 0.95% protocol + 0.30% creator**. (The older ``PUMP_PROGRAM_README`` 100/0 split
    is superseded — the tape free-fit below confirms the 125 bps stack.)
  * nirholas/pump-fun-sdk ``bonding-curve-math``: buy ``inputAmount = solAmount·10000/(10000+bps)``
    then ``tokensOut = inputAmount·vToken/(vSol+inputAmount)``, ``result = min(tokensOut, realToken)``.
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
    "BondingCurveFee",
    "BondingCurveParams",
    "BondingCurveComplete",
    "PUMPFUN_BONDING_CURVE_STANDARD_FEE",
    "PumpFunBondingCurve",
]

_BPS = Decimal(10_000)

# On-chain Global-account constants (RAW integer units: 6-decimal tokens, 9-decimal lamports).
# Recorded exactly as published so a caller working in raw units can build a matching curve.
RAW_INITIAL_VIRTUAL_TOKEN_RESERVES = Decimal(1_073_000_000_000_000)
RAW_INITIAL_VIRTUAL_SOL_RESERVES = Decimal(30_000_000_000)
RAW_INITIAL_REAL_TOKEN_RESERVES = Decimal(793_100_000_000_000)
RAW_TOKEN_TOTAL_SUPPLY = Decimal(1_000_000_000_000_000)

_TOKEN_DECIMALS = Decimal(10) ** 6
_SOL_DECIMALS = Decimal(10) ** 9


@dataclass(frozen=True)
class BondingCurveFee:
    """The bonding-curve fee stack: protocol + creator basis points, both paid OUT of the curve.

    There is no LP leg on the bonding curve — every fee bp leaves the reserves (transferred to the
    ``fee_recipient`` / ``creator_vault``), so unlike the AMM's :class:`FeeSplit` there is no
    "retained" share and ``k`` is preserved exactly. ``total_bps`` is what a trader pays.
    """

    protocol_bps: Decimal
    creator_bps: Decimal

    def __post_init__(self) -> None:
        for name, value in (("protocol_bps", self.protocol_bps), ("creator_bps", self.creator_bps)):
            if value < 0:
                raise ValueError(f"{name} must be non-negative, got {value}")
        if self.total_bps >= _BPS:
            raise ValueError(f"total fee must be < 10000 bps, got {self.total_bps}")

    @property
    def total_bps(self) -> Decimal:
        """Total swap fee the trader pays (protocol + creator)."""
        return self.protocol_bps + self.creator_bps


# Mainnet bonding-curve fee — protocol 95 + creator 30 = 125 bps (verified 2026-08-22).
PUMPFUN_BONDING_CURVE_STANDARD_FEE = BondingCurveFee(
    protocol_bps=Decimal(95), creator_bps=Decimal(30)
)


@dataclass(frozen=True)
class BondingCurveParams:
    """The four on-chain seed constants that fully determine a pump.fun bonding curve.

    Reserves are carried in whatever units the caller prices in — the default
    :meth:`mainnet_ui` expresses them in UI units (tokens / SOL), :meth:`mainnet_raw` in raw
    on-chain integer units (base atoms / lamports). A :class:`PumpFunBondingCurve` derives the
    live real-token reserve, and thus graduation, from these seeds plus the virtual reserve it is
    handed — so the units of the :class:`~oct_trading_agent.sim.amm.pool.PoolState` passed to
    :meth:`PumpFunBondingCurve.fill` MUST match the units of these constants.
    """

    initial_virtual_token_reserves: Decimal
    initial_virtual_sol_reserves: Decimal
    initial_real_token_reserves: Decimal
    token_total_supply: Decimal

    def __post_init__(self) -> None:
        for name, value in (
            ("initial_virtual_token_reserves", self.initial_virtual_token_reserves),
            ("initial_virtual_sol_reserves", self.initial_virtual_sol_reserves),
            ("initial_real_token_reserves", self.initial_real_token_reserves),
            ("token_total_supply", self.token_total_supply),
        ):
            if value <= 0:
                raise ValueError(f"{name} must be positive, got {value}")
        if self.initial_real_token_reserves > self.initial_virtual_token_reserves:
            raise ValueError("real token reserves cannot exceed virtual token reserves")

    @classmethod
    def mainnet_ui(cls) -> BondingCurveParams:
        """Mainnet seeds in UI units (1.073B virtual tokens, 30 SOL, 793.1M real tokens, 1B supply)."""
        return cls(
            initial_virtual_token_reserves=RAW_INITIAL_VIRTUAL_TOKEN_RESERVES / _TOKEN_DECIMALS,
            initial_virtual_sol_reserves=RAW_INITIAL_VIRTUAL_SOL_RESERVES / _SOL_DECIMALS,
            initial_real_token_reserves=RAW_INITIAL_REAL_TOKEN_RESERVES / _TOKEN_DECIMALS,
            token_total_supply=RAW_TOKEN_TOTAL_SUPPLY / _TOKEN_DECIMALS,
        )

    @classmethod
    def mainnet_raw(cls) -> BondingCurveParams:
        """Mainnet seeds in raw on-chain integer units (base atoms / lamports)."""
        return cls(
            initial_virtual_token_reserves=RAW_INITIAL_VIRTUAL_TOKEN_RESERVES,
            initial_virtual_sol_reserves=RAW_INITIAL_VIRTUAL_SOL_RESERVES,
            initial_real_token_reserves=RAW_INITIAL_REAL_TOKEN_RESERVES,
            token_total_supply=RAW_TOKEN_TOTAL_SUPPLY,
        )


class BondingCurveComplete(LookupError):
    """Raised by :meth:`PumpFunBondingCurve.fill` when the curve has already graduated.

    Graduation (``real_token_reserves == 0``) migrates the token to the pump AMM, so the bonding
    curve's fill law no longer applies. This is a **venue handoff**, deliberately distinct from the
    ``ValueError`` the base contract raises for an untradeable (empty-depth) pool: a caller should
    re-resolve the swap onto :class:`~oct_trading_agent.sim.curves.pumpfun.PumpFunAmmCurve`, not
    treat it as an ``INSUFFICIENT_LIQUIDITY`` fill. Carries the remaining real-token reserve (``<=
    0``) for diagnostics.
    """

    def __init__(self, real_token_reserves: Decimal) -> None:
        self.real_token_reserves = real_token_reserves
        super().__init__(
            "pump.fun bonding curve has graduated (real_token_reserves="
            f"{real_token_reserves}); token migrated to the pump AMM — resolve PumpFunAmmCurve"
        )


@register_curve("pumpfun")
class PumpFunBondingCurve(Curve):
    """pump.fun pre-migration bonding curve: closed-form constant-product on virtual reserves.

    Construct with a :class:`BondingCurveParams` (default: mainnet UI-unit seeds) and a
    :class:`BondingCurveFee` (default: the 125 bps protocol+creator stack). The
    :class:`~oct_trading_agent.sim.amm.pool.PoolState` passed to :meth:`fill` carries the CURRENT
    virtual reserves — ``base_reserve`` = virtual token, ``quote_reserve`` = virtual SOL — in the
    same units as the params. The curve derives the live real-token reserve (graduation tracking)
    from the seeds and the handed virtual token reserve, so no extra state channel is needed.

    The fill is deterministic given the pre-trade virtual state, which is the whole point: reserves
    are reconstructable from the KNOWN initial seeds by folding the token's swaps, so each fill is
    predicted, not fitted.
    """

    venues: ClassVar[tuple[str, ...]] = ("pumpfun",)

    def __init__(
        self,
        *,
        params: BondingCurveParams | None = None,
        fee: BondingCurveFee = PUMPFUN_BONDING_CURVE_STANDARD_FEE,
    ) -> None:
        self.params = params or BondingCurveParams.mainnet_ui()
        self.fee = fee

    # -- graduation / real-reserve derivation ------------------------------------------------

    def real_token_reserves(self, state: PoolState) -> Decimal:
        """Real (sellable) tokens left on the curve, derived from the virtual token reserve.

        Tokens sold so far = ``initial_virtual_token − current_virtual_token``; the real float
        drops by the same amount. Clamped at 0 (the curve never sells past its float).
        """
        sold = self.params.initial_virtual_token_reserves - state.base_reserve
        remaining = self.params.initial_real_token_reserves - sold
        return remaining if remaining > 0 else Decimal(0)

    def is_complete(self, state: PoolState) -> bool:
        """True once the last real token has been sold (``real_token_reserves == 0``)."""
        return self.real_token_reserves(state) <= 0

    def graduation_progress(self, state: PoolState) -> Decimal:
        """Fraction of the real-token float sold so far, in ``[0, 1]`` (1.0 == graduated)."""
        initial = self.params.initial_real_token_reserves
        sold = initial - self.real_token_reserves(state)
        progress = sold / initial
        if progress < 0:
            return Decimal(0)
        return progress if progress < 1 else Decimal(1)

    # -- fill ---------------------------------------------------------------------------------

    def fill(self, request: CurveInput, state: PoolState) -> CurveFill:
        if request.amount_in <= 0:
            raise ValueError("amount_in must be positive")
        v_token = state.base_reserve
        v_sol = state.quote_reserve
        if v_token <= 0 or v_sol <= 0:
            raise ValueError("virtual reserves must be positive")

        real_token = self.real_token_reserves(state)
        if real_token <= 0:
            # Already graduated: the bonding curve no longer prices this token.
            raise BondingCurveComplete(real_token)

        if request.side is Side.BUY:
            return self._fill_buy(request.amount_in, v_token, v_sol, real_token)
        return self._fill_sell(request.amount_in, v_token, v_sol)

    def _fill_buy(
        self, sol_in: Decimal, v_token: Decimal, v_sol: Decimal, real_token: Decimal
    ) -> CurveFill:
        """BUY: SOL in, token out. Fee on top (``buyQuoteInput``); output capped at real reserves."""
        total_bps = self.fee.total_bps
        mid_before = v_sol / v_token

        # Amount that actually reaches the invariant (the fee sits on top of the SOL spent).
        effective_sol = sol_in * _BPS / (_BPS + total_bps)
        tokens_out = v_token * effective_sol / (v_sol + effective_sol)

        if tokens_out >= real_token:
            # This buy exhausts the real float and graduates the curve. On-chain the program caps
            # tokens_out at the remaining real reserve, so only the SOL needed for that many tokens
            # is spent (invert the invariant), not the full requested amount.
            tokens_out = real_token
            effective_sol = v_sol * tokens_out / (v_token - tokens_out)
            sol_in = effective_sol * (_BPS + total_bps) / _BPS

        v_token_after = v_token - tokens_out
        v_sol_after = v_sol + effective_sol  # fees are external -> only the net enters the pool
        executed_price = sol_in / tokens_out  # gross SOL paid per token (embeds the whole fee)

        return self._assemble(
            side=Side.BUY,
            base_amount=tokens_out,
            quote_amount=sol_in,
            executed_price=executed_price,
            mid_before=mid_before,
            base_reserve_after=v_token_after,
            quote_reserve_after=v_sol_after,
        )

    def _fill_sell(self, tokens_in: Decimal, v_token: Decimal, v_sol: Decimal) -> CurveFill:
        """SELL: token in, SOL out. Fee taken out of the gross SOL the invariant produces."""
        total_bps = self.fee.total_bps
        mid_before = v_sol / v_token

        gross_sol_out = v_sol * tokens_in / (v_token + tokens_in)
        user_sol_out = gross_sol_out * (_BPS - total_bps) / _BPS

        v_token_after = v_token + tokens_in
        v_sol_after = v_sol - gross_sol_out  # gross leaves; fee is skimmed to recipients, not pooled
        executed_price = user_sol_out / tokens_in  # net SOL received per token

        return self._assemble(
            side=Side.SELL,
            base_amount=tokens_in,
            quote_amount=user_sol_out,
            executed_price=executed_price,
            mid_before=mid_before,
            base_reserve_after=v_token_after,
            quote_reserve_after=v_sol_after,
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
