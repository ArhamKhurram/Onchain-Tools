"""featurestore/tiers — per-tier feature computations (paper §3.2, §5).

    * A raw-chart   : price, liquidity (reserves), volume, trade count, buy/sell volume imbalance,
                      inter-trade timing. **Implemented** in :mod:`.tier_a` — the naked chart, computed
                      without resolving any wallet. Phase 1 needs only Tier A.
    * B wallet-flows: unique buyers, holder deltas, smart-money inflow, concentration, creator behavior.
                      (Preferably consumed via the trade-flow attention encoder — see ``agent/encoders``.)
    * C metadata    : name/ticker/supply, mint+freeze authority, LP burn/lock, safety flags.
    * D social      : X account + stats, cross-platform engagement, web-search outputs (embeddings).
    * E chatter     : Discord/TG caller attribution + honest-caller reliability.

Every feature is a :class:`~oct_trading_agent.core.features.PointInTimeFeature` so the leakage
audit can prove it is future-blind.

Tiers B-E are declared here as empty registries with TODOs — the curriculum gates them on Phase 2+
(paper §5), and several draw on inputs (wallet labels, metadata, social, chatter) that other waves
own. They deliberately return **no** features today, which the store surfaces as a
present-but-empty tier (explicit, not imputed).
"""

from __future__ import annotations

from oct_trading_agent.core import PointInTimeFeature

from .tier_a import (
    BuySellImbalance,
    LastPrice,
    MeanInterTradeSeconds,
    PoolLiquidityQuote,
    RollingVolumeQuote,
    TradeCount,
    default_tier_a_features,
)


def default_tier_b_features() -> list[PointInTimeFeature]:
    """Wallet-flow features (unique buyers, holder deltas, concentration, creator behavior).

    TODO(Wave-2: featurestore B): implement over ``HolderChange`` + wallet-labeled swaps. Prefer
    surfacing these through the trade-flow attention encoder (``agent/encoders``); this registry
    holds only the raw, wallet-resolved flow scalars. Empty until Phase 2 unlocks Tier B.
    """
    return []


def default_tier_c_features() -> list[PointInTimeFeature]:
    """Token-metadata features (supply, mint/freeze authority, LP burn/lock, safety flags).

    TODO(Wave-2: featurestore C): source from OCT enrichment (GMGN/DexScreener) reconstructed
    as-of, not from a later snapshot (04 §3 rule 2). Empty until Phase 3 unlocks Tier C.
    """
    return []


def default_tier_d_features() -> list[PointInTimeFeature]:
    """Narrative/social features (X account + stats, engagement, web-search embeddings).

    TODO(Wave-2: featurestore D): text embeddings + counts; untrusted external content is data,
    never instructions (paper §9.7). Empty until Phase 4 unlocks Tier D.
    """
    return []


def default_tier_e_features() -> list[PointInTimeFeature]:
    """Crowd-chatter features (caller identity, call timing vs price, caller reliability).

    TODO(Wave-2: featurestore E): the most adversarial tier (shills/coordination). Empty until
    Phase 5 unlocks Tier E.
    """
    return []


__all__ = [
    "BuySellImbalance",
    "LastPrice",
    "MeanInterTradeSeconds",
    "PoolLiquidityQuote",
    "RollingVolumeQuote",
    "TradeCount",
    "default_tier_a_features",
    "default_tier_b_features",
    "default_tier_c_features",
    "default_tier_d_features",
    "default_tier_e_features",
]
