"""AMM fee tiers + the pool configuration that carries them.

The **LP/swap fee** is a property of the venue's pool, not of the order. It is the reason an
executed price differs from the pre-trade mid even for an infinitesimally small trade, so we model
it as embedded in the constant-product curve (``curve.py``) rather than as a separate line item.

ASSUMPTION (flagged for Phase-0 calibration): the default fee is Raydium-style **25 bps**, the
dominant Solana constant-product venue. pump.fun's bonding curve (100 bps) and Uniswap-V2-style
pools (30 bps) are provided as named tiers. The *right* fee per venue is a calibration output — the
tape encodes the executed price, so a mis-set fee shows up directly as fill-reproduction error
(``calibration.py``). Set ``PoolConfig.fee_bps`` per the venue the tape came from.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from enum import IntEnum


class FeeTier(IntEnum):
    """Named LP-fee tiers in basis points. Values are the total swap fee taken on the input."""

    RAYDIUM_V4 = 25  # Raydium AMM v4 / standard Solana CPMM — the default assumption
    PUMPSWAP = 25  # pump AMM (pumpswap) post-migration pool
    UNISWAP_V2 = 30  # Uniswap-V2-style 0.30%
    PUMP_FUN_BONDING = 100  # pump.fun bonding curve — 1%


DEFAULT_FEE_BPS: int = int(FeeTier.RAYDIUM_V4)

# One bps = 1/10_000. Kept as Decimal so all curve math stays exact (no float drift).
_BPS = Decimal(10_000)


@dataclass(frozen=True)
class PoolConfig:
    """Static configuration for one token's pool.

    ``fee_bps`` is the LP/swap fee (embedded in the curve). ``min_quote_reserve`` and
    ``max_price_impact_bps`` are conservative liquidity guards used by the fill model to decide
    ``INSUFFICIENT_LIQUIDITY`` — a thin pool should refuse a large order rather than pretend it
    filled at a heroic price.
    """

    fee_bps: int = DEFAULT_FEE_BPS
    # Pool considered too thin to trade at all below this quote (SOL) depth. 0 disables the guard.
    min_quote_reserve: Decimal = Decimal(0)
    # An own-order that would move the mid more than this is refused as insufficient liquidity.
    # 0 disables the guard (the curve still prices any size — this is a *policy* cap, conservative).
    max_price_impact_bps: Decimal = Decimal(0)

    @property
    def fee_fraction(self) -> Decimal:
        """Fee as a Decimal fraction of the input (e.g. 25 bps -> ``0.0025``)."""
        return Decimal(self.fee_bps) / _BPS

    def __post_init__(self) -> None:
        if self.fee_bps < 0 or self.fee_bps >= int(_BPS):
            raise ValueError(f"fee_bps out of range [0, 10000): {self.fee_bps}")
        if self.min_quote_reserve < 0:
            raise ValueError("min_quote_reserve must be non-negative")
        if self.max_price_impact_bps < 0:
            raise ValueError("max_price_impact_bps must be non-negative")
