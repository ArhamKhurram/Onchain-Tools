"""Behavioral-cloning trainer — torch-gated (skipped without the 'learn' extra). Tiny + synthetic."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from oct_trading_agent.core.enums import Side
from oct_trading_agent.data.labeling.schema import LabeledTrade, LabeledWallet

pytest.importorskip("torch")

from oct_trading_agent.agent.imitation.bc import BCConfig, train_bc
from oct_trading_agent.agent.imitation.cohort import (
    format_report,
    run_cohort_imitation,
)
from oct_trading_agent.agent.imitation.demos import DemoConfig, build_demos

T0 = datetime(2026, 8, 22, 12, 0, 0, tzinfo=UTC)


def _trade(mint: str, side: Side, base: str, quote: str, tsec: int, sig: str) -> LabeledTrade:
    return LabeledTrade(
        timestamp=T0 + timedelta(seconds=tsec),
        mint=mint,
        side=side,
        base_amount=Decimal(base),
        quote_amount=Decimal(quote),
        signature=sig,
    )


def _synthetic_cohort(n_mints: int = 12) -> list[LabeledWallet]:
    """Many single-token win episodes (open -> close) plus interleaving prints, across many mints.

    Enough distinct mints that the held-out-by-token split is non-trivial and BC has a learnable
    signal (flat -> OPEN_LONG, holding -> CLOSE).
    """
    experts: list[LabeledTrade] = []
    others: list[LabeledTrade] = []
    for k in range(n_mints):
        mint = f"Tok{k:02d}imitationBcMint{'X' * 24}"[:44]
        base = k * 10_000
        experts.append(_trade(mint, Side.BUY, "1000000", "2.0", base + 100, f"e{k}-open"))
        experts.append(_trade(mint, Side.BUY, "300000", "0.8", base + 150, f"e{k}-add"))
        experts.append(_trade(mint, Side.SELL, "400000", "1.2", base + 300, f"e{k}-trim"))
        experts.append(_trade(mint, Side.SELL, "900000", "2.6", base + 500, f"e{k}-close"))
        # Cohort prints before entry (NO_OP) and during the hold (HOLD).
        others.append(_trade(mint, Side.BUY, "20000", "0.05", base + 40, f"o{k}-pre"))
        others.append(_trade(mint, Side.BUY, "20000", "0.05", base + 200, f"o{k}-mid1"))
        others.append(_trade(mint, Side.SELL, "15000", "0.05", base + 400, f"o{k}-mid2"))
    return [
        LabeledWallet(wallet="Wa11etBcExpert1111111111111111111111111111111", labels=["tracked"], trades=experts),
        LabeledWallet(wallet="Wa11etBcOther11111111111111111111111111111111", labels=["tracked"], trades=others),
    ]


def test_bc_produces_a_trading_policy() -> None:
    dataset = build_demos(_synthetic_cohort(), DemoConfig())
    assert len(dataset) > 20
    result = train_bc(dataset.steps, BCConfig(epochs=40, seed=0))

    assert result.n_val > 0
    assert result.n_train > 0
    # The verdict that matters: the cloned policy emits real trading intents on held-out tokens —
    # NOT the degenerate always-HOLD / always-NO_OP the from-scratch PPO collapsed to.
    assert result.trades is True
    trading = sum(
        v for k, v in result.bc_distribution.items() if k not in ("hold", "no_op")
    )
    assert trading > 0
    # Imitation accuracy is a real fraction in [0, 1].
    assert 0.0 <= result.val_intent_accuracy <= 1.0
    # The deterministic policy is usable downstream (satisfies the EnvPolicy act() seam).
    assert result.policy is not None


def test_bc_beats_a_trivial_majority_floor() -> None:
    dataset = build_demos(_synthetic_cohort(16), DemoConfig())
    result = train_bc(dataset.steps, BCConfig(epochs=60, seed=1))
    # Majority-class frequency on the held-out set (predict the single most common intent).
    total = sum(result.expert_distribution.values())
    majority = max(result.expert_distribution.values()) / total if total else 0.0
    # BC should do at least as well as always guessing the majority class (it has the state signal).
    assert result.val_intent_accuracy >= majority - 1e-6


def test_cohort_report_runs_and_formats() -> None:
    report = run_cohort_imitation(_synthetic_cohort(), demo_config=DemoConfig())
    text = format_report(report)
    assert "IMITATION" in text
    assert "BC POLICY VERDICT" in text
    assert "CAVEAT" in text
    assert report.n_demos == len(build_demos(_synthetic_cohort(), DemoConfig()))
