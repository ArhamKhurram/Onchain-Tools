"""Shared enumerations for the trading-agent contracts.

These are the small, closed vocabularies that recur across tape events, the feature
store, the simulator, and the agent decision. Kept in one module so every contract
imports the *same* enum object (no stringly-typed drift between waves).
"""

from __future__ import annotations

from enum import StrEnum


class Side(StrEnum):
    """Direction of a swap from the *trader's* perspective on the token being tracked.

    BUY  = acquiring the tracked token (spending quote/SOL).
    SELL = disposing of the tracked token (receiving quote/SOL).
    """

    BUY = "buy"
    SELL = "sell"


class Intent(StrEnum):
    """Discrete action intent (paper §3.3). Long-only in the alpha — no shorts.

    The continuous ``size`` (fraction of risk budget) lives alongside the intent on
    :class:`~oct_trading_agent.core.sim.Order` / the agent decision, not here.
    """

    NO_OP = "no_op"  # ignore this candidate on this step
    OPEN_LONG = "open_long"  # enter a new long
    ADD = "add"  # scale into an existing long
    TRIM = "trim"  # scale out partially
    CLOSE = "close"  # fully exit
    HOLD = "hold"  # keep the current position unchanged


class FeatureTier(StrEnum):
    """The five curriculum information tiers (paper §3.2, §5; 02 §6 ``featurestore/tiers``).

    The ordering is deliberate: A is the always-present "naked chart" core; each later
    tier is gated on mastery of the previous one. Wallet flows (B) are held OUT of the
    core so Phase 1 can measure edge from price/liquidity/volume alone.
    """

    A_RAW_CHART = "A"  # price, liquidity, volume, trade count, buy/sell volume imbalance
    B_WALLET_FLOWS = "B"  # unique buyers, holder deltas, smart-money inflow, concentration
    C_METADATA = "C"  # name/ticker/supply, mint+freeze authority, LP burn/lock, safety flags
    D_SOCIAL = "D"  # X account + stats, cross-platform engagement, web-search outputs
    E_CHATTER = "E"  # Discord/TG caller attribution + honest-caller reliability


class FeatureStatus(StrEnum):
    """Why a feature value is present or absent. Missingness is EXPLICIT — never imputed.

    New pairs have ragged, sparse data; a consumer must branch on this rather than read a
    silently zero-filled value (04-data-spec.md leakage rules; 02 §2 responsibility boundary).
    """

    OBSERVED = "observed"  # a real, point-in-time value is available
    MISSING_NOT_YET_AVAILABLE = "missing_not_yet_available"  # too early — no data at as_of
    MISSING_SOURCE_GAP = "missing_source_gap"  # source down / not ingested for this token
    MISSING_NOT_APPLICABLE = "missing_not_applicable"  # feature undefined for this token/tier


class FillFailureReason(StrEnum):
    """Why a simulated fill did not execute (or executed degraded). See ``sim/execution``."""

    SLIPPAGE_EXCEEDED = "slippage_exceeded"  # realized slippage past the order's tolerance
    INSUFFICIENT_LIQUIDITY = "insufficient_liquidity"  # pool too thin for the requested size
    TX_FAILED = "tx_failed"  # dropped / failed inclusion (priority-fee model)
    RUGGED = "rugged"  # token entered an absorbing zero state before inclusion
    MEV_SANDWICH = "mev_sandwich"  # back-run/sandwich made the fill non-viable


class TerminalReason(StrEnum):
    """Why an episode terminated (paper §3.4)."""

    FULL_EXIT = "full_exit"  # agent closed the position
    TOKEN_DEATH = "token_death"  # liquidity/activity collapsed
    LIQUIDITY_FLOOR = "liquidity_floor"  # dropped below the floor
    RUG = "rug"  # absorbing zero state from the tape
    HARD_CAP = "hard_cap"  # the ~3-day compute-bounding cap (NOT behavior-shaping)
