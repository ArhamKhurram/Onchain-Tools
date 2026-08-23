"""Ladder-logic tests for ``agent/train_market`` — the torch-FREE parts (holdout, skips, report).

Training itself needs the ``learn`` extra; the walk-forward split, skip accounting, and per-rung
evaluation/report are pure and tested here by driving them with a BASELINE policy in the agent slot.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from oct_trading_agent.agent.train_market import (
    MarketTrainConfig,
    build_market_walk_forward,
    evaluate_rung,
    format_rung,
    prepare_market_tokens,
)
from oct_trading_agent.core import Side, SwapEvent
from oct_trading_agent.eval.baselines import BuyAndHoldPolicy
from oct_trading_agent.eval.data import TokenTape


def _tape(name: str, protocol: str, *, day: int, n: int = 40) -> TokenTape:
    mint = f"Tok_{name}_00000000000000000000000000000000"
    t0 = datetime(2026, 8, 1, tzinfo=UTC) + timedelta(days=day)
    base_res, quote_res = Decimal("1500000"), Decimal("60")
    swaps: list[SwapEvent] = []
    for i in range(n):
        side = Side.BUY if i % 2 == 0 else Side.SELL
        if side is Side.BUY:
            q = Decimal("0.04")
            b = base_res * q / (quote_res + q)
            base_res -= b
            quote_res += q
            qa, ba = q, b
        else:
            b = Decimal("350")
            q = quote_res * b / (base_res + b)
            base_res += b
            quote_res -= q
            qa, ba = q, b
        swaps.append(
            SwapEvent(
                mint=mint, slot=1000 + i, block_time=t0 + timedelta(seconds=i * 3),
                signature=f"{name}s{i}", signer=f"w{i % 5}", side=side,
                base_amount=ba, quote_amount=qa, price=qa / ba, protocol=protocol,
            )
        )
    return TokenTape(mint=mint, swaps=swaps, source=f"synthetic:{name}")


def _mixed_tapes() -> list[TokenTape]:
    return [
        _tape("amm0", "pumpfun_amm", day=0),
        _tape("amm1", "pumpfun_amm", day=1),
        _tape("ray0", "raydium_amm_v4", day=2),
        _tape("clmm0", "orca_whirlpool", day=3),
        _tape("amm2", "pumpfun_amm", day=4),
        _tape("router", "jupiter_v6", day=5),  # must be skipped, not faked
    ]


def test_prepare_market_tokens_skips_router() -> None:
    prepared, skipped = prepare_market_tokens(_mixed_tapes())
    assert len(prepared) == 5  # the 5 supported-venue tokens
    router_mints = [m for m in skipped if "router" in m]
    assert len(router_mints) == 1
    assert "unsupported" in skipped[router_mints[0]]


def test_walk_forward_holds_out_newest_tokens() -> None:
    wf = build_market_walk_forward(_mixed_tapes(), test_fraction=0.4)
    # 5 tradeable tokens; ~40% newest held out for test; jupiter skipped.
    assert len(wf.train) + len(wf.test) == 5
    assert len(wf.test) >= 1
    assert len(wf.skipped) == 1
    # Test tokens launched no earlier than every train token (forward split).
    latest_train = max(p.start_time for p in wf.train)
    assert all(p.start_time >= latest_train for p in wf.test)


def test_evaluate_rung_reports_trade_behaviour_and_gate() -> None:
    """Drive the per-rung eval/report with buy-and-hold in the agent slot (no torch needed)."""
    wf = build_market_walk_forward(_mixed_tapes(), test_fraction=0.4)
    cfg = MarketTrainConfig()
    result = evaluate_rung(BuyAndHoldPolicy(size=1.0), wf, cfg, n_tokens_requested=10, seed=0)
    assert result.n_tradeable == 5
    assert result.n_skipped == 1
    assert result.skip_reasons  # histogram populated
    # buy-and-hold trades on every held-out token (one buy + a forced close each).
    assert result.agent_tokens_traded == result.n_test
    assert result.agent_total_trades >= result.n_test
    assert result.verdict is not None
    assert result.verdict.verdict in {"GO", "NO-GO", "INCONCLUSIVE"}
    text = format_rung(result)
    assert "DOES IT TRADE?" in text
    assert "VERDICT" in text


def test_evaluate_rung_handles_no_holdout() -> None:
    """One tradeable token → no held-out set → reported honestly (no gate), still shows trades."""
    wf = build_market_walk_forward([_tape("solo", "pumpfun_amm", day=0)])
    result = evaluate_rung(BuyAndHoldPolicy(size=1.0), wf, MarketTrainConfig(), n_tokens_requested=1, seed=0)
    assert result.n_test == 0
    assert result.verdict is None
    assert result.agent_tokens_traded == 1
