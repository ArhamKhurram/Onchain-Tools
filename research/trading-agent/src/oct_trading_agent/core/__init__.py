"""Shared contracts for the OCT trading-agent research program (Phase 0).

Every downstream module (data, featurestore, sim, agent, eval, ledger, bridge, convergence)
imports its types from here. These are the *stable* interfaces the four Wave-1 builder agents
build against — keep them clean and typed; change them deliberately.

Type map (see each submodule's docstring for the design rationale):

* tape      — SwapEvent, LiquidityEvent, HolderChange, RugEvent, TapeEvent (firehose)
* features  — Feature, FeatureBundle, FeatureStore, PointInTimeFeature, LeakageAudit (missingness)
* sim       — Order, Fill, PositionState, SimStepResult, Simulator (replay execution)
* decision  — AgentDecision, ValueDistribution, SignalContribution, RationaleItem, Policy
* attention — AttentionState (trade-flow attention model; co-trained encoder)
* ledger    — LedgerEntry, Episode (paper-trading ledger)
* enums     — Side, Intent, FeatureTier, FeatureStatus, FillFailureReason, TerminalReason
"""

from __future__ import annotations

from .attention import AttentionState
from .base import Frozen
from .decision import (
    AgentDecision,
    Policy,
    RationaleItem,
    SignalContribution,
    ValueDistribution,
)
from .enums import (
    FeatureStatus,
    FeatureTier,
    FillFailureReason,
    Intent,
    Side,
    TerminalReason,
)
from .features import (
    Feature,
    FeatureBundle,
    FeatureStore,
    FeatureValue,
    LeakageAudit,
    LeakageAuditResult,
    PointInTimeFeature,
    TierFeatures,
)
from .ledger import Episode, LedgerEntry
from .sim import Fill, Order, PositionState, SimStepResult, Simulator
from .tape import (
    HolderChange,
    LiquidityEvent,
    Mint,
    RugEvent,
    SwapEvent,
    TapeEvent,
    Wallet,
)

__all__ = [
    # base
    "Frozen",
    # enums
    "Side",
    "Intent",
    "FeatureTier",
    "FeatureStatus",
    "FillFailureReason",
    "TerminalReason",
    # tape
    "Mint",
    "Wallet",
    "SwapEvent",
    "LiquidityEvent",
    "HolderChange",
    "RugEvent",
    "TapeEvent",
    # features
    "Feature",
    "FeatureValue",
    "TierFeatures",
    "FeatureBundle",
    "FeatureStore",
    "PointInTimeFeature",
    "LeakageAudit",
    "LeakageAuditResult",
    # sim
    "Order",
    "Fill",
    "PositionState",
    "SimStepResult",
    "Simulator",
    # decision
    "AgentDecision",
    "ValueDistribution",
    "SignalContribution",
    "RationaleItem",
    "Policy",
    # attention
    "AttentionState",
    # ledger
    "LedgerEntry",
    "Episode",
]
