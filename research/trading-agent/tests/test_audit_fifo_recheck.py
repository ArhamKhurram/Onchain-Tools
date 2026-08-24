"""Audit Round 1 script logic: the lot-free recheck agrees with the FIFO engine on synthetic tapes."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import numpy as np

from oct_trading_agent.data.census.fifo import fifo_pair_pnl

_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "audit" / "fifo_recheck.py"


def _load_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("fifo_recheck", _SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # Registered BEFORE exec: dataclass annotation resolution looks the module up in sys.modules.
    sys.modules["fifo_recheck"] = module
    spec.loader.exec_module(module)
    return module


def _engine_row(
    is_buy: list[bool], base: list[float], quote: list[float]
) -> dict[str, float]:
    ts = np.arange(len(is_buy), dtype=float)
    pnl = fifo_pair_pnl(np.array(is_buy), np.array(base), np.array(quote), ts)
    return {
        "n_buys": float(pnl.n_buys),
        "n_sells": float(pnl.n_sells),
        "quote_in": pnl.quote_in,
        "quote_out": pnl.quote_out,
        "realized_pnl": pnl.realized_pnl,
        "uncosted_sell_quote": pnl.uncosted_sell_quote,
        "residual_base": pnl.residual_base,
    }


def test_fully_closed_pair_net_flow_equals_fifo() -> None:
    mod = _load_script()
    # Two buys at different prices, two sells closing the whole position at a higher price.
    is_buy = [True, True, False, False]
    base = [100.0, 50.0, 120.0, 30.0]
    quote = [1.0, 0.75, 2.4, 0.6]  # bought for 1.75, sold for 3.0 -> +1.25 realized
    indep = mod.independent_pair_stats(is_buy, base, quote)
    assert indep.fully_closed and indep.fully_costed
    assert indep.net_flow_realized is not None
    assert abs(indep.net_flow_realized - 1.25) < 1e-12
    engine = _engine_row(is_buy, base, quote)
    assert mod.compare_pair(engine, indep) == []
    assert abs(engine["realized_pnl"] - indep.net_flow_realized) < 1e-9


def test_oversold_pair_uncosted_matches_engine_and_blocks_net_flow() -> None:
    mod = _load_script()
    # Buy 100, sell 150 (50 arrived by transfer): the extra 50's proceeds must be uncosted.
    is_buy = [True, False]
    base = [100.0, 150.0]
    quote = [1.0, 3.0]  # sell price 0.02/unit -> uncosted 50 * 0.02 = 1.0
    indep = mod.independent_pair_stats(is_buy, base, quote)
    assert not indep.fully_costed
    assert indep.net_flow_realized is None  # net flow would credit transfer proceeds — refused
    assert abs(indep.uncosted_quote - 1.0) < 1e-12
    engine = _engine_row(is_buy, base, quote)
    assert mod.compare_pair(engine, indep) == []


def test_partial_close_residual_matches_engine() -> None:
    mod = _load_script()
    # Buy 200, sell 80: 120 stays open — never profit, only residual.
    is_buy = [True, False]
    base = [200.0, 80.0]
    quote = [2.0, 1.6]
    indep = mod.independent_pair_stats(is_buy, base, quote)
    assert not indep.fully_closed
    assert indep.net_flow_realized is None
    assert abs(indep.residual_base - 120.0) < 1e-9
    engine = _engine_row(is_buy, base, quote)
    assert mod.compare_pair(engine, indep) == []


def test_degenerate_rows_skipped_like_the_engine() -> None:
    mod = _load_script()
    is_buy = [True, True, False]
    base = [0.0, 100.0, 100.0]  # first row degenerate (zero base) — both methods must skip it
    quote = [1.0, 1.0, 2.0]
    indep = mod.independent_pair_stats(is_buy, base, quote)
    engine = _engine_row(is_buy, base, quote)
    assert indep.n_buys == 1 and indep.n_sells == 1
    assert mod.compare_pair(engine, indep) == []


def test_compare_pair_flags_a_realized_pnl_mismatch() -> None:
    mod = _load_script()
    is_buy = [True, False]
    base = [100.0, 100.0]
    quote = [1.0, 2.0]
    indep = mod.independent_pair_stats(is_buy, base, quote)
    engine = _engine_row(is_buy, base, quote)
    engine["realized_pnl"] += 0.5  # inject a booking bug
    problems = mod.compare_pair(engine, indep)
    assert any("REALIZED PNL MISMATCH" in p for p in problems)
