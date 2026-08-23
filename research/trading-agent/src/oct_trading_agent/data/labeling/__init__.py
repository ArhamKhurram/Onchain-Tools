"""labeling/ — trader-labeling pipeline (02 §2 (5); 04-data-spec §1.2).

Reconstructs a labeled wallet's **full win-and-loss** on-chain history into per-token demonstration
trajectories for Phase-1 imitation/IRL warm-start. Built entirely against a documented FIXTURE
schema (:mod:`.schema`, :mod:`.fixtures`) — the real labeled-wallet DB is a **Phase-1** input, wired
by swapping :func:`load_labeled_wallets` for a DB-backed loader that yields the same
:class:`LabeledWallet`\\ s (03 §Phase 0). Losing episodes are first-class: nothing is
hindsight-filtered (leakage rule 7).
"""

from __future__ import annotations

from .fixtures import load_labeled_wallets
from .pinax_loader import iter_signer_swaps, load_wallet_trades
from .reconstruct import build_trajectories, build_trajectories_for
from .schema import (
    DemonstrationStep,
    DemonstrationTrajectory,
    LabeledTrade,
    LabeledWallet,
    TrajectoryOutcome,
)
from .wallets_file import TrackedWallet, parse_tracked_wallets, select_cohort

__all__ = [
    "LabeledWallet",
    "LabeledTrade",
    "DemonstrationStep",
    "DemonstrationTrajectory",
    "TrajectoryOutcome",
    "load_labeled_wallets",
    "build_trajectories",
    "build_trajectories_for",
    "iter_signer_swaps",
    "load_wallet_trades",
    "TrackedWallet",
    "parse_tracked_wallets",
    "select_cohort",
]
