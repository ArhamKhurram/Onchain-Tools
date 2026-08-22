"""sim/ — the replay simulator (02 §2 (3); the single largest engineering item).

Responsibility: fill orders against reconstructed AMM pool state — realistic slippage vs pool
depth, own-order price impact, latency/inclusion delay, MEV penalty, fees/priority fees/failed
txns, and rugs/honeypots as absorbing zero states. Default to conservative own-impact-only
counterfactual assumptions (02 §7). The paper→live fidelity gap is measured against this.

Subpackages: amm (pool-state reconstruction + slippage/impact), execution (latency/MEV/fees/
failed-txn), rug (absorbing states), replay (recent-window replay + frozen regime battery).

Contracts (Order, Fill, PositionState, SimStepResult, Simulator) live in
:mod:`oct_trading_agent.core.sim`.

PERFORMANCE NOTE (src/README.md): the correctness reference is Python (numpy/polars vectorized).
The hot loop sits behind the ``Simulator`` protocol so a Rust kernel (PyO3/maturin) can replace it
ONLY where profiling proves it necessary — no premature native code.

TODO(Wave-1: sim agent): a Rust kernel behind ``core.sim.Simulator`` only where profiling demands it.
"""

from __future__ import annotations

from .amm import FeeTier, PoolConfig, PoolReconstructor, PoolState
from .calibration import (
    CalibrationConfig,
    CalibrationReport,
    calibrate,
    load_tape_parquet,
)
from .execution import ExecutionModel, ExecutionParams
from .replay import RecentWindowReplay, ReplaySimulator, SimConfig
from .rug import RugTracker

__all__ = [
    # amm
    "PoolConfig",
    "FeeTier",
    "PoolReconstructor",
    "PoolState",
    # execution
    "ExecutionModel",
    "ExecutionParams",
    # rug
    "RugTracker",
    # replay
    "ReplaySimulator",
    "SimConfig",
    "RecentWindowReplay",
    # calibration
    "calibrate",
    "CalibrationConfig",
    "CalibrationReport",
    "load_tape_parquet",
]
