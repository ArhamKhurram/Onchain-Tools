"""Demo builder — env-aligned (observation, expert-action) demonstrations. Pure numpy, no torch."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from oct_trading_agent.agent.envs.observation import vector_length
from oct_trading_agent.agent.imitation.demos import (
    DemoConfig,
    build_cohort_tape,
    build_demos,
    demo_matrices,
    intent_distribution,
)
from oct_trading_agent.core.enums import Intent, Side
from oct_trading_agent.data.labeling.schema import LabeledTrade, LabeledWallet

T0 = datetime(2026, 8, 22, 12, 0, 0, tzinfo=UTC)
MINT_A = "Tok1imitationDemoMintAAAAAAAAAAAAAAAAAAAAAAA"
MINT_B = "Tok2imitationDemoMintBBBBBBBBBBBBBBBBBBBBBBB"


def _trade(mint: str, side: Side, base: str, quote: str, tsec: int, sig: str) -> LabeledTrade:
    return LabeledTrade(
        timestamp=T0 + timedelta(seconds=tsec),
        mint=mint,
        side=side,
        base_amount=Decimal(base),
        quote_amount=Decimal(quote),
        signature=sig,
    )


def _cohort() -> list[LabeledWallet]:
    """Three wallets across two mints, interleaved so HOLD/NO_OP decision instants exist."""
    # The expert we clone: a full win episode on MINT_A (open, add, trim, close).
    expert = LabeledWallet(
        wallet="Wa11etExpert111111111111111111111111111111111",
        labels=["tracked"],
        trades=[
            _trade(MINT_A, Side.BUY, "1000000", "2.0", 1000, "a-open"),
            _trade(MINT_A, Side.BUY, "400000", "1.0", 1100, "a-add"),
            _trade(MINT_A, Side.SELL, "600000", "1.5", 1300, "a-trim"),
            _trade(MINT_A, Side.SELL, "800000", "2.4", 1500, "a-close"),
            # A second, losing episode on MINT_B (open then close at a loss).
            _trade(MINT_B, Side.BUY, "500000", "3.0", 2000, "b-open"),
            _trade(MINT_B, Side.SELL, "500000", "1.0", 2200, "b-close"),
        ],
    )
    # Other cohort members trade the same mints, providing prints the expert HELD / watched through.
    other1 = LabeledWallet(
        wallet="Wa11etOther1111111111111111111111111111111111",
        labels=["tracked"],
        trades=[
            _trade(MINT_A, Side.BUY, "50000", "0.1", 700, "o1-pre"),   # pre-entry -> NO_OP candidate
            _trade(MINT_A, Side.BUY, "50000", "0.1", 1150, "o1-mid1"),  # in-episode -> HOLD candidate
            _trade(MINT_A, Side.SELL, "40000", "0.1", 1250, "o1-mid2"),
            _trade(MINT_B, Side.BUY, "10000", "0.2", 1900, "o1-bpre"),
        ],
    )
    other2 = LabeledWallet(
        wallet="Wa11etOther2222222222222222222222222222222222",
        labels=["tracked"],
        trades=[
            _trade(MINT_A, Side.BUY, "30000", "0.05", 850, "o2-pre"),
            _trade(MINT_A, Side.SELL, "20000", "0.05", 1200, "o2-mid"),
            _trade(MINT_A, Side.BUY, "20000", "0.05", 1400, "o2-mid3"),
        ],
    )
    return [expert, other1, other2]


def test_cohort_tape_pools_all_wallets_and_is_causal() -> None:
    tape = build_cohort_tape(_cohort())
    # 6 + 4 + 3 synthesized swaps.
    assert len(tape) == 13
    # Sorted by (mint, slot, block_time).
    mints = [e.mint for e in tape]
    assert mints == sorted(mints)


def test_build_demos_produces_trading_and_passive_actions() -> None:
    dataset = build_demos(_cohort(), DemoConfig())
    assert dataset.n_wallets == 3
    # Expert has 2 episodes; the others contribute their own (open/close-less) episodes too.
    assert dataset.n_trajectories >= 3
    assert dataset.outcome_counts.get("win", 0) >= 1

    dist = intent_distribution(dataset.steps)
    # The expert's real actions are present...
    assert dist[Intent.OPEN_LONG.value] >= 1
    assert dist[Intent.CLOSE.value] >= 1
    assert dist[Intent.TRIM.value] >= 1
    # ...and the do-nothing decisions were synthesized (so BC won't learn "always act").
    assert dist[Intent.HOLD.value] >= 1
    assert dist[Intent.NO_OP.value] >= 1


def test_demo_vectors_and_sizes_are_well_formed() -> None:
    dataset = build_demos(_cohort(), DemoConfig())
    obs, intents, sizes, _sized = demo_matrices(dataset.steps)
    n = len(dataset)
    assert obs.shape == (n, vector_length())
    assert intents.shape == (n,)
    assert ((sizes >= 0.0) & (sizes <= 1.0)).all()
    # Only sized intents (open/add/trim) carry a nonzero size flag.
    for step in dataset.steps:
        if step.intent in (Intent.OPEN_LONG, Intent.ADD, Intent.TRIM):
            assert step.is_sized
        else:
            assert not step.is_sized
            assert step.size == 0.0


def test_open_long_has_no_position_close_has_position() -> None:
    # has_position lives in the state block (last 3 dims); index 0 of that block is has_position.
    dataset = build_demos(_cohort(), DemoConfig(hold_ratio=0.0, noop_ratio=0.0))
    state_has_pos_idx = vector_length() - 3
    for step in dataset.steps:
        has_pos = step.observation[state_has_pos_idx]
        if step.intent is Intent.OPEN_LONG:
            assert has_pos == 0.0
        if step.intent in (Intent.ADD, Intent.TRIM, Intent.CLOSE):
            assert has_pos == 1.0


def test_max_demos_caps_output() -> None:
    dataset = build_demos(_cohort(), DemoConfig(max_demos=3))
    assert len(dataset) == 3
