"""sim/amm — pool-state reconstruction + AMM slippage/impact (02 §2 (3)).

Reconstructs the bonding-curve / constant-product pool state at a decision timestamp from the tape,
then computes realistic slippage as a function of size vs pool depth and the own-order price impact.
The AMM impact map is CLOSED-FORM (a genuine advantage over LOB microstructure, paper §4.4).

Public surface:
    * ``curve``   — closed-form constant-product fills (``fill_buy``/``fill_sell``, ``CurveFill``).
    * ``pool``    — ``PoolReconstructor`` / ``PoolState`` (reserve reconstruction as-of any slot).
    * ``fees``    — ``PoolConfig`` + named ``FeeTier`` LP-fee tiers.
"""

from __future__ import annotations

from .curve import CurveFill, fill_buy, fill_sell, mid_price
from .fees import DEFAULT_FEE_BPS, FeeTier, PoolConfig
from .pool import PoolReconstructor, PoolState

__all__ = [
    "CurveFill",
    "fill_buy",
    "fill_sell",
    "mid_price",
    "PoolConfig",
    "FeeTier",
    "DEFAULT_FEE_BPS",
    "PoolReconstructor",
    "PoolState",
]
