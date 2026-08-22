"""sim/execution — latency, MEV, fees, failed-txn model (02 §2 (3)).

Models decision→inclusion delay and MEV (back-run/sandwich) as a stochastic slippage/failure
penalty early, with an explicit MEV model later; charges fees/priority fees; models failed txns.
Produces the :class:`~oct_trading_agent.core.sim.Fill` cost fields.

TODO(Wave-1: sim agent): implement the execution/cost model. Start conservative (own-impact-only).
"""

from __future__ import annotations
