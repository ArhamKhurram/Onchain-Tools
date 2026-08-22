"""sim/execution — latency, MEV, fees, failed-txn model (02 §2 (3)).

Models decision→inclusion delay and MEV (back-run/sandwich) as a stochastic slippage/failure
penalty early, with an explicit MEV model later; charges fees/priority fees; models failed txns.
Produces the :class:`~oct_trading_agent.core.sim.Fill` cost fields.

Public surface: ``ExecutionParams`` (the knobs; ``ExecutionParams.ideal()`` for calibration) and
``ExecutionModel`` (applies them to a curve fill).
"""

from __future__ import annotations

from .model import ExecutionModel, ExecutionParams

__all__ = ["ExecutionModel", "ExecutionParams"]
