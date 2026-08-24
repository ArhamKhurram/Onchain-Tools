"""MAP-Elites tests — the pure elite-replacement rule + archive (torch-free) and the torch-gated loop.

Two invariants are pinned without torch: (1) the cell-replacement RULE (:func:`elite_beats`) — an empty
cell always accepts, a strictly-better challenger replaces, an equal-or-worse one does not; and (2) the
archive keeps one elite per niche and NEVER empties a filled niche (coverage is monotone up), which is
the exact property PBT lacked. The weight-mutation and a tiny end-to-end run (archive fills, telemetry
lands schema-valid with ``algo="map_elites"``) run only where the ``learn`` extra is installed.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import numpy as np
import pytest

from oct_trading_agent.agent.population.descriptor import (
    MEMECOIN_ROLES,
    BehavioralDescriptor,
    BehaviorProfile,
)
from oct_trading_agent.agent.population.map_elites import (
    Elite,
    EliteArchive,
    elite_beats,
)
from oct_trading_agent.agent.train_market import build_market_walk_forward
from oct_trading_agent.core import Side, SwapEvent
from oct_trading_agent.eval.data import TokenTape

# ---------------------------------------------------------------------------
# Pure fixtures — synthetic elites whose descriptor lands them in a known niche
# ---------------------------------------------------------------------------


def _profile(*, freq: float, hold: float, pnl_bps: float) -> BehaviorProfile:
    desc = BehavioralDescriptor(
        trade_frequency=freq, mean_hold_secs=hold,
        entry_latency_frac=0.3, sell_ratio=0.5, mean_size=0.5,
    )
    return BehaviorProfile(
        pnl_bps=pnl_bps, win_rate=0.5, n_trades=10, mean_hold_secs=hold,
        descriptor=desc, n_tokens=4,
    )


def _elite(agent_id: str, *, freq: float, hold: float, pnl_bps: float) -> Elite:
    # genome=None: the archive is torch-free and never inspects the genome payload.
    return Elite(agent_id=agent_id, profile=_profile(freq=freq, hold=hold, pnl_bps=pnl_bps))


# GOBLIN = HIGH freq, SHORT hold; GIZMO = LOW freq, LONG hold (per the goofy-codename grid).
def _goblin(agent_id: str, pnl_bps: float) -> Elite:
    return _elite(agent_id, freq=0.30, hold=10.0, pnl_bps=pnl_bps)


def _gizmo(agent_id: str, pnl_bps: float) -> Elite:
    return _elite(agent_id, freq=0.02, hold=200.0, pnl_bps=pnl_bps)


# ---------------------------------------------------------------------------
# Pure: the elite-replacement rule
# ---------------------------------------------------------------------------


def test_elite_beats_empty_cell_always_accepts() -> None:
    assert elite_beats(_profile(freq=0.3, hold=10.0, pnl_bps=-999.0), None) is True


def test_elite_beats_requires_strictly_greater_pnl() -> None:
    incumbent = _profile(freq=0.3, hold=10.0, pnl_bps=10.0)
    assert elite_beats(_profile(freq=0.3, hold=10.0, pnl_bps=10.1), incumbent) is True
    assert elite_beats(_profile(freq=0.3, hold=10.0, pnl_bps=10.0), incumbent) is False  # tie: no churn
    assert elite_beats(_profile(freq=0.3, hold=10.0, pnl_bps=9.9), incumbent) is False


# ---------------------------------------------------------------------------
# Pure: the archive keeps one elite per niche and never empties a filled niche
# ---------------------------------------------------------------------------


def test_archive_admits_better_and_rejects_worse_in_same_niche() -> None:
    archive = EliteArchive()
    role, took = archive.try_add(_goblin("g0", 5.0))
    assert role == "GOBLIN" and took is True

    # A stronger GOBLIN takes the cell; a weaker one is rejected but the cell STAYS filled.
    _, took_better = archive.try_add(_goblin("g1", 20.0))
    _, took_worse = archive.try_add(_goblin("g2", 1.0))
    assert took_better is True
    assert took_worse is False
    champ = archive.get("GOBLIN")
    assert champ is not None and champ.agent_id == "g1"  # the +20, not +5 or +1
    assert archive.is_filled("GOBLIN")
    assert archive.size == 1


def test_archive_coverage_is_monotone_and_distinct_niches_coexist() -> None:
    archive = EliteArchive()
    assert archive.coverage == 0.0
    archive.try_add(_goblin("g0", 5.0))
    assert archive.coverage == pytest.approx(1 / 6)
    archive.try_add(_gizmo("z0", -3.0))  # a different descriptor -> a different niche
    assert archive.coverage == pytest.approx(2 / 6)
    # Adding a worse challenger to an existing niche NEVER reduces coverage (the anti-collapse property).
    archive.try_add(_goblin("g1", -100.0))
    assert archive.coverage == pytest.approx(2 / 6)
    assert set(archive.filled_roles()) == {"GOBLIN", "GIZMO"}
    assert archive.considered == 3 and archive.admitted == 2


def test_archive_sample_parent_only_from_filled_niches() -> None:
    archive = EliteArchive()
    assert archive.sample_parent(np.random.default_rng(0)) is None  # empty archive
    archive.try_add(_goblin("g0", 5.0))
    archive.try_add(_gizmo("z0", 2.0))
    ids = {archive.sample_parent(np.random.default_rng(s)).agent_id for s in range(20)}  # type: ignore[union-attr]
    assert ids <= {"g0", "z0"}  # only ever draws a filled-niche elite


def test_archive_snapshot_renders_schema_valid_generation() -> None:
    """The archive snapshots into the reused telemetry path: one champion per filled niche, coverage=size/6."""
    from oct_trading_agent.agent.population.telemetry import generation_from_archive

    archive = EliteArchive()
    archive.try_add(_goblin("g0", 25.0))
    archive.try_add(_gizmo("z0", 5.0))
    snap = archive.to_niche_archive()
    gen = generation_from_archive(snap, gen=3, population_size=archive.size)

    assert [d["role"] for d in gen["desks"]] == list(MEMECOIN_ROLES)  # one desk per role, display order
    assert gen["coverage"] == round(2 / 6, 3)
    filled = {d["role"]: d for d in gen["desks"] if d["occupancy"] > 0}
    assert set(filled) == {"GOBLIN", "GIZMO"}
    assert filled["GOBLIN"]["occupancy"] == 1  # exactly one elite per niche in a MAP-Elites archive
    assert filled["GOBLIN"]["champion"]["agent_id"] == "g0"
    for role, desk in filled.items():
        assert desk["champion"]["pnl_bps"] == (25.0 if role == "GOBLIN" else 5.0)


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
# Torch-gated: mutation perturbs weights; end-to-end smoke run
# ---------------------------------------------------------------------------


def test_mutate_genome_perturbs_weights_and_leaves_parent_intact() -> None:
    pytest.importorskip("torch")
    import torch

    from oct_trading_agent.agent.population.map_elites import (
        MapElitesConfig,
        _random_genome,
        mutate_genome,
    )
    from oct_trading_agent.agent.population.pbt import Hyperparams

    cfg = MapElitesConfig(hidden_dim=16, n_quantiles=8, mutation_sigma=0.1)
    parent = _random_genome(Hyperparams(3e-4, 0.02, 0.1), cfg)
    before = {k: v.clone() for k, v in parent.state_dict.items()}
    child = mutate_genome(parent, np.random.default_rng(0), cfg)

    # The child's float weights moved off the parent's...
    assert any(
        not torch.allclose(child.state_dict[k], parent.state_dict[k])
        for k, v in child.state_dict.items()
        if torch.is_floating_point(v)
    )
    # ...and the parent genome was NOT mutated in place (mutation returns a fresh genome).
    assert all(torch.allclose(before[k], parent.state_dict[k]) for k in before)
    # Hyperparameters were explored (perturbed) off the parent's.
    assert child.hyperparams.learning_rate != parent.hyperparams.learning_rate


def test_run_map_elites_smoke_fills_and_holds_niches(tmp_path: Path) -> None:
    pytest.importorskip("torch")

    from oct_trading_agent.agent.population.map_elites import MapElitesConfig, run_map_elites
    from oct_trading_agent.agent.train_market import MarketTrainConfig

    wf = _walk_forward()
    out = tmp_path / "mapelites.json"
    cfg = MapElitesConfig(
        init_population=4, iterations=8, batch_size=4, train_steps_per_child=1,
        episodes_per_iter=1, max_train_envs=2, max_test_envs=2, hidden_dim=16,
        n_quantiles=8, torch_threads=1,
    )
    doc = run_map_elites(
        wf, out, cfg=cfg, base=MarketTrainConfig(hidden_dim=16), seed=0, log=lambda _m: None  # type: ignore[arg-type]
    )

    assert out.exists()
    assert doc["algo"] == "map_elites"
    assert doc["cost_bps"] == 125
    assert doc["roles"] == list(MEMECOIN_ROLES)
    assert len(doc["generations"]) >= 2  # a seed generation plus at least one illumination batch

    from itertools import pairwise

    coverages = [g["coverage"] for g in doc["generations"]]
    # MAP-Elites never empties a filled niche: coverage is monotone NON-DECREASING (the anti-collapse
    # contrast with PBT, whose coverage fell generation over generation).
    assert all(b >= a for a, b in pairwise(coverages))
    for gen in doc["generations"]:
        assert len(gen["desks"]) == 6
        # Each filled niche holds exactly one elite (the MAP-Elites archive invariant).
        assert all(d["occupancy"] in (0, 1) for d in gen["desks"])
        assert 0.0 < gen["coverage"] <= 1.0
