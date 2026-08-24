"""The tracked-traders baseline: cohort action-tape build + ``CohortReplayPolicy`` replay.

Pure numpy, no torch. Asserts (1) the reconstructed per-mint action tape carries the traders' real
intents + demos-style sizes, (2) the replay policy fires each cohort decision at the first env instant
at/after it and HOLD/NO_OPs in between, (3) an untouched mint yields no fabricated trade, and (4) the
policy trades through a real ``MarketReplayEnv`` under the shared eval battery.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from oct_trading_agent.agent.envs import (
    EnvAction,
    MarketReplayEnv,
    Observation,
    build_market_regime,
    market_sim_config,
)
from oct_trading_agent.agent.envs.observation import AgentState, encode
from oct_trading_agent.agent.imitation.demos import CohortAction, build_cohort_action_tape
from oct_trading_agent.agent.policies import EnvPolicy
from oct_trading_agent.core import (
    Feature,
    FeatureBundle,
    FeatureStatus,
    FeatureTier,
    Intent,
    Side,
    SwapEvent,
    TierFeatures,
)
from oct_trading_agent.data.labeling.schema import LabeledTrade, LabeledWallet
from oct_trading_agent.eval.baselines import CohortReplayPolicy
from oct_trading_agent.eval.runner import evaluate_policy

T0 = datetime(2026, 8, 22, 12, 0, 0, tzinfo=UTC)
MINT_A = "Tok1cohortReplayMintAAAAAAAAAAAAAAAAAAAAAAAA"
MINT_B = "Tok2cohortReplayMintBBBBBBBBBBBBBBBBBBBBBBBB"


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
    """One tracked trader: a full win episode on MINT_A, plus a small open/close on MINT_B."""
    return [
        LabeledWallet(
            wallet="Wa11etCohortReplay1111111111111111111111111",
            labels=["tracked"],
            trades=[
                _trade(MINT_A, Side.BUY, "1000000", "2.0", 100, "a-open"),
                _trade(MINT_A, Side.BUY, "400000", "1.0", 200, "a-add"),
                _trade(MINT_A, Side.SELL, "600000", "1.5", 300, "a-trim"),
                _trade(MINT_A, Side.SELL, "800000", "2.4", 400, "a-close"),
                _trade(MINT_B, Side.BUY, "500000", "3.0", 500, "b-open"),
                _trade(MINT_B, Side.SELL, "500000", "1.0", 600, "b-close"),
            ],
        )
    ]


def _obs(mint: str, as_of: datetime, *, has_position: bool) -> Observation:
    slots: TierFeatures = {"price": Feature(value=0.001, status=FeatureStatus.OBSERVED, as_of=as_of)}
    bundle = FeatureBundle(mint=mint, as_of=as_of, tiers={FeatureTier.A_RAW_CHART: slots})
    return encode(bundle, AgentState(has_position=has_position, steps_elapsed_frac=0.0, balance_ratio=1.0))


# ---------------------------------------------------------------------------
# build_cohort_action_tape
# ---------------------------------------------------------------------------


def test_action_tape_reconstructs_intents_and_sizes() -> None:
    tape = build_cohort_action_tape(_cohort())
    seq = tape[MINT_A]
    assert [a.action.intent for a in seq] == [
        Intent.OPEN_LONG,
        Intent.ADD,
        Intent.TRIM,
        Intent.CLOSE,
    ]
    # Time-ordered.
    assert [a.at for a in seq] == sorted(a.at for a in seq)
    # Buys sized as a fraction of the trader's own largest buy (2.0 SOL): open=1.0, add=0.5.
    assert seq[0].action.size == 1.0
    assert seq[1].action.size == 0.5
    # TRIM sold 600k of 1.4M held -> ~0.43; CLOSE carries size 0 (sim sells the whole book).
    assert 0.0 < seq[2].action.size < 1.0
    assert seq[3].action.size == 0.0
    # Every size is a valid [0, 1] fraction.
    assert all(0.0 <= a.action.size <= 1.0 for a in seq)


def test_action_tape_mints_filter_is_leakage_gate() -> None:
    # Restricting to MINT_A must drop every MINT_B action (the honesty gate for held-out-only tapes).
    tape = build_cohort_action_tape(_cohort(), mints={MINT_A})
    assert set(tape) == {MINT_A}
    assert MINT_B not in tape
    # An empty allow-set yields an empty tape (nothing held out -> nothing to replay).
    assert build_cohort_action_tape(_cohort(), mints=set()) == {}


# ---------------------------------------------------------------------------
# CohortReplayPolicy
# ---------------------------------------------------------------------------


def test_replay_policy_is_env_policy() -> None:
    assert isinstance(CohortReplayPolicy({}), EnvPolicy)


def test_replay_fires_due_actions_and_holds_between() -> None:
    tape = {
        MINT_A: [
            CohortAction(at=T0 + timedelta(seconds=100), action=_open()),
            CohortAction(at=T0 + timedelta(seconds=300), action=_close()),
        ]
    }
    p = CohortReplayPolicy(tape)
    p.reset()
    # Before the first trade is due, flat -> NO_OP.
    assert p.act(_obs(MINT_A, T0 + timedelta(seconds=50), has_position=False)).intent is Intent.NO_OP
    # At/after the first trade time -> the OPEN_LONG fires.
    fired = p.act(_obs(MINT_A, T0 + timedelta(seconds=100), has_position=False))
    assert fired.intent is Intent.OPEN_LONG
    # Holding, nothing due -> HOLD (not NO_OP).
    assert p.act(_obs(MINT_A, T0 + timedelta(seconds=200), has_position=True)).intent is Intent.HOLD
    # The CLOSE fires once its time has come (first instant at/after it).
    assert p.act(_obs(MINT_A, T0 + timedelta(seconds=350), has_position=True)).intent is Intent.CLOSE
    # Tape exhausted, flat -> NO_OP again.
    assert p.act(_obs(MINT_A, T0 + timedelta(seconds=400), has_position=False)).intent is Intent.NO_OP


def test_replay_untouched_mint_never_fabricates_a_trade() -> None:
    tape = build_cohort_action_tape(_cohort(), mints={MINT_A})
    p = CohortReplayPolicy(tape)
    p.reset()
    # Driven on a mint the cohort never traded: only passive intents, ever.
    for sec in range(0, 500, 50):
        action = p.act(_obs(MINT_B, T0 + timedelta(seconds=sec), has_position=False))
        assert action.intent is Intent.NO_OP


def test_replay_reset_re_arms_the_cursor() -> None:
    tape = {MINT_A: [CohortAction(at=T0 + timedelta(seconds=100), action=_open())]}
    p = CohortReplayPolicy(tape)
    p.reset()
    assert p.act(_obs(MINT_A, T0 + timedelta(seconds=100), has_position=False)).intent is Intent.OPEN_LONG
    # After reset the same first decision fires again (per-episode replay, order-independent).
    p.reset()
    assert p.act(_obs(MINT_A, T0 + timedelta(seconds=100), has_position=False)).intent is Intent.OPEN_LONG


# ---------------------------------------------------------------------------
# End-to-end through a real MarketReplayEnv (shared eval battery)
# ---------------------------------------------------------------------------


def _open() -> EnvAction:
    return EnvAction(intent=Intent.OPEN_LONG, size=1.0)


def _close() -> EnvAction:
    return EnvAction(intent=Intent.CLOSE, size=0.0)


def _venue_tape(mint: str, *, n: int = 50) -> list[SwapEvent]:
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
                mint=mint, slot=1000 + i, block_time=T0 + timedelta(seconds=i * 3),
                signature=f"{mint[:6]}s{i}", signer=f"w{i % 5}", side=side,
                base_amount=ba, quote_amount=qa, price=qa / ba, protocol="pumpfun_amm",
            )
        )
    return swaps


def test_replay_trades_through_market_env_and_untouched_token_does_not() -> None:
    mint = "TokVenueCohortReplay0000000000000000000000000"
    regime = build_market_regime(_venue_tape(mint))
    assert regime.tradeable and regime.decision_times is not None
    dts = regime.decision_times

    # Cohort buys early, sells late — both on real env decision instants.
    tape = {
        mint: [
            CohortAction(at=dts[2], action=_open()),
            CohortAction(at=dts[-3], action=_close()),
        ]
    }

    def _env() -> MarketReplayEnv:
        return MarketReplayEnv.from_regime(regime, market_sim_config())

    traded = evaluate_policy([_env()], CohortReplayPolicy(tape), "tracked_traders")
    assert traded.outcomes[0].n_trades >= 1  # it actually trades the token the cohort touched

    # The SAME policy on a token the cohort never traded books no trade (honest hold-SOL fallback).
    untouched = evaluate_policy([_env()], CohortReplayPolicy({}), "tracked_traders")
    assert untouched.outcomes[0].n_trades == 0
