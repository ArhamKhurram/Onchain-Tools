"""featurestore/tiers — per-tier feature computations (paper §3.2, §5).

    * A raw-chart   : price, liquidity (reserves), volume, trade count, buy/sell volume imbalance.
    * B wallet-flows: unique buyers, holder deltas, smart-money inflow, concentration, creator behavior.
                      (Preferably consumed via the trade-flow attention encoder — see ``agent/encoders``.)
    * C metadata    : name/ticker/supply, mint+freeze authority, LP burn/lock, safety flags.
    * D social      : X account + stats, cross-platform engagement, web-search outputs (embeddings).
    * E chatter     : Discord/TG caller attribution + honest-caller reliability.

Every feature is a :class:`~oct_trading_agent.core.features.PointInTimeFeature` so the leakage
audit can prove it is future-blind.

TODO(Wave-1: featurestore agent): implement Tier A first (Phase 1 needs only A); B-E follow the
curriculum gate (Phase 2).
"""

from __future__ import annotations
