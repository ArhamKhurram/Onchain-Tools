"""PBT tests — the pure selection/perturbation logic (torch-free) and the torch-gated train loop.

The exploit/explore SELECTION rule and hyperparameter perturbation are pinned without torch; the
weight-copy (exploit actually reseeds a loser's network from a winner's) and a tiny end-to-end run
(population trains, telemetry lands schema-valid) run only where the ``learn`` extra is installed.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import numpy as np
import pytest

from oct_trading_agent.agent.population.pbt import (
    ENTROPY_BOUNDS,
    LR_BOUNDS,
    RISK_BETA_BOUNDS,
    Hyperparams,
    select_exploit_explore,
)
from oct_trading_agent.agent.train_market import build_market_walk_forward
from oct_trading_agent.core import Side, SwapEvent
from oct_trading_agent.eval.data import TokenTape

# ---------------------------------------------------------------------------
# Pure: hyperparameters + exploit/explore selection (no torch)
# ---------------------------------------------------------------------------


def test_hyperparams_sample_within_bounds() -> None:
    rng = np.random.default_rng(0)
    for _ in range(50):
        hp = Hyperparams.sample(rng)
        assert LR_BOUNDS[0] <= hp.learning_rate <= LR_BOUNDS[1]
        assert ENTROPY_BOUNDS[0] <= hp.entropy_coef <= ENTROPY_BOUNDS[1]
        assert RISK_BETA_BOUNDS[0] <= hp.risk_beta <= RISK_BETA_BOUNDS[1]


def test_hyperparams_perturb_moves_and_stays_bounded() -> None:
    rng = np.random.default_rng(1)
    hp = Hyperparams(learning_rate=3e-4, entropy_coef=0.02, risk_beta=0.1)
    moved = hp.perturb(rng)
    # LR & entropy are multiplicatively perturbed (×0.8/×1.2), so they always change.
    assert moved.learning_rate != hp.learning_rate
    assert moved.entropy_coef != hp.entropy_coef
    assert LR_BOUNDS[0] <= moved.learning_rate <= LR_BOUNDS[1]
    assert ENTROPY_BOUNDS[0] <= moved.entropy_coef <= ENTROPY_BOUNDS[1]
    assert RISK_BETA_BOUNDS[0] <= moved.risk_beta <= RISK_BETA_BOUNDS[1]


def test_perturb_clamps_at_bounds() -> None:
    rng = np.random.default_rng(2)
    hi = Hyperparams(learning_rate=LR_BOUNDS[1], entropy_coef=ENTROPY_BOUNDS[1], risk_beta=0.5)
    for _ in range(20):
        m = hi.perturb(rng)
        assert m.learning_rate <= LR_BOUNDS[1]
        assert m.entropy_coef <= ENTROPY_BOUNDS[1]
        assert m.risk_beta <= RISK_BETA_BOUNDS[1]


def test_select_exploit_explore_bottom_copies_top() -> None:
    rng = np.random.default_rng(0)
    fitnesses = [5.0, -3.0, 1.0, 9.0, -7.0, 2.0, 8.0, 0.0]  # 8 members, exploit_frac 0.25 -> k=2
    pairs = select_exploit_explore(fitnesses, rng, exploit_frac=0.25)
    assert len(pairs) == 2
    worst_two = {4, 1}  # indices of -7 and -3
    best_two = {3, 6}  # indices of 9 and 8
    for loser, winner in pairs:
        assert loser in worst_two
        assert winner in best_two
        assert loser != winner


def test_select_exploit_explore_skips_overlapping_slot() -> None:
    """With overlapping bands (tiny pop, big frac), a slot that ranks both top and bottom is left be."""
    rng = np.random.default_rng(0)
    pairs = select_exploit_explore([0.0, 1.0, 2.0], rng, exploit_frac=0.8)  # k=2, bands overlap on idx1
    # loser band {0,1}, winner band {1,2}; idx1 is in both -> only idx0 is reseeded.
    assert len(pairs) == 1
    assert pairs[0][0] == 0
    assert pairs[0][1] in {1, 2}


def test_select_exploit_explore_degenerate() -> None:
    rng = np.random.default_rng(0)
    assert select_exploit_explore([1.0], rng) == []
    assert select_exploit_explore([], rng) == []


# ---------------------------------------------------------------------------
# Synthetic market walk-forward (shared by the torch tests)
# ---------------------------------------------------------------------------

T0 = datetime(2026, 8, 20, tzinfo=UTC)


def _tape(name: str, *, day: int, n: int = 40) -> TokenTape:
    mint = f"Tok_{name}_00000000000000000000000000000000"
    t0 = T0 + timedelta(days=day)
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
                base_amount=ba, quote_amount=qa, price=qa / ba, protocol="pumpfun_amm",
            )
        )
    return TokenTape(mint=mint, swaps=swaps, source=f"synthetic:{name}")


def _walk_forward() -> object:
    tapes = [_tape(f"t{i}", day=i) for i in range(5)]
    return build_market_walk_forward(tapes, test_fraction=0.4)


# ---------------------------------------------------------------------------
# Torch-gated: exploit copies weights; end-to-end smoke run
# ---------------------------------------------------------------------------


def test_apply_exploit_copies_weights_and_perturbs_hparams() -> None:
    pytest.importorskip("torch")
    import torch

    from oct_trading_agent.agent.population.pbt import (
        Hyperparams,
        PBTConfig,
        _init_member,
        apply_exploit,
    )
    from oct_trading_agent.agent.train_market import MarketTrainConfig

    cfg = PBTConfig(hidden_dim=16, n_quantiles=8)
    base = MarketTrainConfig(hidden_dim=16)
    loser = _init_member("a000", Hyperparams(1e-4, 0.01, 0.0), cfg, base)
    winner = _init_member("a001", Hyperparams(7e-4, 0.03, 0.2), cfg, base)
    members = [loser, winner]

    # Pre-condition: the two networks differ somewhere.
    ls, ws = loser.model.state_dict(), winner.model.state_dict()
    assert any(not torch.allclose(ls[k], ws[k]) for k in ls)

    apply_exploit(members, [(0, 1)], np.random.default_rng(0), base, cfg)

    # Post: the loser's network is now a copy of the winner's, param-for-param...
    ls2, ws2 = members[0].model.state_dict(), members[1].model.state_dict()
    assert all(torch.allclose(ls2[k], ws2[k]) for k in ls2)
    # ...but it is an independent deep copy (mutating the loser doesn't touch the winner).
    with torch.no_grad():
        next(iter(members[0].model.parameters())).add_(1.0)
    ls3, ws3 = members[0].model.state_dict(), members[1].model.state_dict()
    assert any(not torch.allclose(ls3[k], ws3[k]) for k in ls3)
    # Hyperparams were inherited from the winner then EXPLORED (perturbed), so they differ from both.
    assert members[0].hyperparams.learning_rate != winner.hyperparams.learning_rate


def test_run_pbt_smoke_produces_valid_telemetry(tmp_path: Path) -> None:
    pytest.importorskip("torch")

    from oct_trading_agent.agent.population.pbt import PBTConfig, run_pbt
    from oct_trading_agent.agent.train_market import MarketTrainConfig

    wf = _walk_forward()
    out = tmp_path / "telemetry.json"
    cfg = PBTConfig(
        population_size=4, generations=2, train_steps_per_gen=1, episodes_per_iter=1,
        eval_batch_size=2, max_train_envs=2, max_test_envs=2, hidden_dim=16,
        n_quantiles=8, torch_threads=1,
    )
    doc = run_pbt(wf, out, cfg=cfg, base=MarketTrainConfig(hidden_dim=16), seed=0, log=lambda _m: None)  # type: ignore[arg-type]

    assert out.exists()
    assert doc["algo"] == "pbt"
    assert doc["cost_bps"] == 125
    assert len(doc["generations"]) == 2
    for gen in doc["generations"]:
        assert len(gen["desks"]) == 6
        assert sum(d["occupancy"] for d in gen["desks"]) == 4  # every member binned into a niche
        assert 0.0 <= gen["coverage"] <= 1.0
