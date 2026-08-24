"""Checkpoint + resume tests for the population trainers — crash-safety, round-trips, and continuation.

Three properties are pinned. The PURE half needs no torch: (1) :func:`atomic_write` is crash-safe — a
writer that fails mid-write leaves the prior good file intact with no temp litter; and (2) the MAP-Elites
archive round-trips through :meth:`EliteArchive.restore` (save-state → restore → identical archive). The
torch-gated half proves (3) a RESUMED run continues from the exact iteration/generation it stopped at
and does NOT redo the work already done — the whole point of checkpointing an overnight run.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from oct_trading_agent.agent.population.checkpoint import atomic_write, atomic_write_text
from oct_trading_agent.agent.population.descriptor import (
    BehavioralDescriptor,
    BehaviorProfile,
)
from oct_trading_agent.agent.population.map_elites import Elite, EliteArchive
from oct_trading_agent.agent.train_market import build_market_walk_forward
from oct_trading_agent.core import Side, SwapEvent
from oct_trading_agent.eval.data import TokenTape

# ---------------------------------------------------------------------------
# Pure: atomic write is crash-safe
# ---------------------------------------------------------------------------


def test_atomic_write_text_roundtrips(tmp_path: Path) -> None:
    path = tmp_path / "out.json"
    atomic_write_text(path, '{"ok": true}')
    assert path.read_text(encoding="utf-8") == '{"ok": true}'
    # Overwriting in place is atomic too — the new content fully replaces the old.
    atomic_write_text(path, '{"ok": false}')
    assert path.read_text(encoding="utf-8") == '{"ok": false}'


def test_atomic_write_survives_mid_write_failure(tmp_path: Path) -> None:
    """A writer that dies mid-write must leave the EXISTING file intact and drop no ``.tmp`` litter."""
    path = tmp_path / "state.bin"
    path.write_text("ORIGINAL", encoding="utf-8")

    def _boom(tmp: Path) -> None:
        tmp.write_text("HALF-WRITTEN", encoding="utf-8")  # partial write into the temp file...
        raise RuntimeError("kill -9 mid-write")  # ...then the process dies before the rename

    with pytest.raises(RuntimeError, match="mid-write"):
        atomic_write(path, _boom)

    # The good file is untouched (the temp file is what got the partial write), and nothing leaked.
    assert path.read_text(encoding="utf-8") == "ORIGINAL"
    assert list(tmp_path.iterdir()) == [path]


# ---------------------------------------------------------------------------
# Pure: the MAP-Elites archive round-trips through restore (save-state -> restore -> identical)
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


def _goblin(agent_id: str, pnl_bps: float) -> Elite:  # HIGH freq, SHORT hold
    return Elite(agent_id=agent_id, profile=_profile(freq=0.30, hold=10.0, pnl_bps=pnl_bps))


def _gizmo(agent_id: str, pnl_bps: float) -> Elite:  # LOW freq, LONG hold
    return Elite(agent_id=agent_id, profile=_profile(freq=0.02, hold=200.0, pnl_bps=pnl_bps))


def test_elite_archive_restore_is_identity(tmp_path: Path) -> None:
    """Extract the archive's saved state (elites + counters) and restore it — the result is identical."""
    archive = EliteArchive()
    archive.try_add(_goblin("g0", 5.0))
    archive.try_add(_goblin("g1", 20.0))  # takes GOBLIN
    archive.try_add(_goblin("g2", 1.0))  # rejected, but considered++
    archive.try_add(_gizmo("z0", 3.0))

    restored = EliteArchive.restore(
        archive.elites(), considered=archive.considered, admitted=archive.admitted
    )

    assert restored.filled_roles() == archive.filled_roles()
    assert restored.coverage == archive.coverage
    assert restored.considered == archive.considered  # 4 considered
    assert restored.admitted == archive.admitted  # 3 admitted (g0, g1, z0)
    for role in archive.filled_roles():
        got, exp = restored.get(role), archive.get(role)
        assert got is not None and exp is not None
        assert got.agent_id == exp.agent_id
        assert got.profile.pnl_bps == exp.profile.pnl_bps
    # The GOBLIN champion is the +20 one, preserved across the restore.
    goblin = restored.get("GOBLIN")
    assert goblin is not None and goblin.agent_id == "g1"


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


def _walk_forward() -> Any:
    tapes = [_tape(f"t{i}", day=i) for i in range(5)]
    return build_market_walk_forward(tapes, test_fraction=0.4)


# ---------------------------------------------------------------------------
# Torch-gated: MAP-Elites resume continues from the right iteration
# ---------------------------------------------------------------------------


def test_map_elites_resume_continues_from_iteration(tmp_path: Path, monkeypatch: Any) -> None:
    """A run stopped after 1 illumination step, resumed to 3, runs exactly the 2 REMAINING steps."""
    pytest.importorskip("torch")

    from oct_trading_agent.agent.population import map_elites as me
    from oct_trading_agent.agent.population.map_elites import (
        MapElitesConfig,
        load_map_elites_checkpoint,
        run_map_elites,
    )
    from oct_trading_agent.agent.train_market import MarketTrainConfig

    wf = _walk_forward()
    ckpt = tmp_path / "me.ckpt.pt"
    base = MarketTrainConfig(hidden_dim=16)
    common = dict(
        init_population=2, batch_size=2, train_steps_per_child=1, episodes_per_iter=1,
        max_train_envs=2, max_test_envs=2, hidden_dim=16, n_quantiles=8, torch_threads=1,
    )

    # Run A: seed (2) + 1 illumination step, checkpointing every evaluation.
    run_map_elites(
        wf, tmp_path / "a.json", cfg=MapElitesConfig(iterations=1, **common), base=base, seed=0,
        checkpoint_path=ckpt, checkpoint_every=1, log=lambda _m: None,
    )
    state_a = load_map_elites_checkpoint(ckpt)
    assert state_a.seed_done == 2  # the whole seed population is done
    assert state_a.iter_done == 1  # exactly one illumination step happened

    # Count evaluations on resume by spying on the (module-global) polish+evaluate call.
    calls = {"n": 0}
    original = me._polish_and_evaluate

    def _spy(*args: Any, **kwargs: Any) -> Any:
        calls["n"] += 1
        return original(*args, **kwargs)

    monkeypatch.setattr(me, "_polish_and_evaluate", _spy)

    # Run B: resume and finish to 3 illumination steps — steps 1 and 2 only (NOT a restart of 0,1,2).
    doc = run_map_elites(
        wf, tmp_path / "b.json", cfg=MapElitesConfig(iterations=3, **common), base=base, seed=0,
        checkpoint_path=ckpt, checkpoint_every=1, resume=ckpt, log=lambda _m: None,
    )
    assert calls["n"] == 2  # 2 remaining steps; a restart would have re-run seed+all = 5

    state_b = load_map_elites_checkpoint(ckpt)
    assert state_b.iter_done == 3
    assert state_b.seed_done == 2  # seeding was NOT redone
    # The telemetry timeline was continued (seeded from the checkpoint), not restarted at gen 0.
    gens = [g["gen"] for g in doc["generations"]]
    assert gens == sorted(gens) and gens[0] == 0 and len(gens) >= 3


def test_map_elites_resume_from_completed_checkpoint_is_noop(tmp_path: Path, monkeypatch: Any) -> None:
    """Resuming a run that already finished does ZERO further evaluations (recognizes it is done)."""
    pytest.importorskip("torch")

    from oct_trading_agent.agent.population import map_elites as me
    from oct_trading_agent.agent.population.map_elites import MapElitesConfig, run_map_elites
    from oct_trading_agent.agent.train_market import MarketTrainConfig

    wf = _walk_forward()
    ckpt = tmp_path / "me.ckpt.pt"
    base = MarketTrainConfig(hidden_dim=16)
    cfg = MapElitesConfig(
        init_population=2, iterations=2, batch_size=2, train_steps_per_child=1, episodes_per_iter=1,
        max_train_envs=2, max_test_envs=2, hidden_dim=16, n_quantiles=8, torch_threads=1,
    )
    run_map_elites(
        wf, tmp_path / "a.json", cfg=cfg, base=base, seed=0,
        checkpoint_path=ckpt, checkpoint_every=1, log=lambda _m: None,
    )

    calls = {"n": 0}
    original = me._polish_and_evaluate

    def _spy(*args: Any, **kwargs: Any) -> Any:
        calls["n"] += 1
        return original(*args, **kwargs)

    monkeypatch.setattr(me, "_polish_and_evaluate", _spy)
    run_map_elites(
        wf, tmp_path / "b.json", cfg=cfg, base=base, seed=0,
        checkpoint_path=ckpt, checkpoint_every=1, resume=ckpt, log=lambda _m: None,
    )
    assert calls["n"] == 0


# ---------------------------------------------------------------------------
# Torch-gated: PBT resume continues from the right generation
# ---------------------------------------------------------------------------


def test_pbt_resume_continues_from_generation(tmp_path: Path, monkeypatch: Any) -> None:
    """A PBT run stopped after gen 0, resumed to 3 generations, trains exactly gens 1 and 2."""
    pytest.importorskip("torch")

    from oct_trading_agent.agent.population import pbt as pbt_mod
    from oct_trading_agent.agent.population.pbt import PBTConfig, load_pbt_checkpoint, run_pbt
    from oct_trading_agent.agent.train_market import MarketTrainConfig

    wf = _walk_forward()
    ckpt = tmp_path / "pbt.ckpt.pt"
    base = MarketTrainConfig(hidden_dim=16)
    common = dict(
        population_size=2, train_steps_per_gen=1, episodes_per_iter=1, eval_batch_size=2,
        max_train_envs=2, max_test_envs=2, hidden_dim=16, n_quantiles=8, torch_threads=1,
    )

    run_pbt(
        wf, tmp_path / "a.json", cfg=PBTConfig(generations=1, **common), base=base, seed=0,
        checkpoint_path=ckpt, checkpoint_every=1, log=lambda _m: None,
    )
    state_a = load_pbt_checkpoint(ckpt)
    assert state_a.gen == 1  # next generation to run
    assert state_a.population_size == 2

    calls = {"n": 0}
    original = pbt_mod._train_member

    def _spy(*args: Any, **kwargs: Any) -> Any:
        calls["n"] += 1
        return original(*args, **kwargs)

    monkeypatch.setattr(pbt_mod, "_train_member", _spy)
    doc = run_pbt(
        wf, tmp_path / "b.json", cfg=PBTConfig(generations=3, **common), base=base, seed=0,
        checkpoint_path=ckpt, checkpoint_every=1, resume=ckpt, log=lambda _m: None,
    )
    # 2 members × 2 remaining generations = 4 train calls (a restart would be 2×3 = 6).
    assert calls["n"] == 4
    assert load_pbt_checkpoint(ckpt).gen == 3
    gens = [g["gen"] for g in doc["generations"]]
    assert gens == [0, 1, 2]  # continued the timeline, did not restart it


# ---------------------------------------------------------------------------
# Torch-gated: the ladder resumes mid-rung and skips completed rungs
# ---------------------------------------------------------------------------


def test_train_market_policy_resumes_mid_rung(tmp_path: Path) -> None:
    """``train_market_policy`` continues one rung from a mid-rung RungTrainState, not from iteration 0."""
    pytest.importorskip("torch")

    from oct_trading_agent.agent.train_market import (
        MarketTrainConfig,
        RungTrainState,
        train_market_policy,
    )

    wf = _walk_forward()
    cfg = MarketTrainConfig(n_iterations=2, hidden_dim=16, n_quantiles=8, episodes_per_iter=1)
    train_envs = wf.train_envs(cfg, seed=0)

    snapshots: list[RungTrainState] = []
    train_market_policy(
        train_envs, cfg, seed=0, checkpoint_every=1,
        on_checkpoint=snapshots.append, log=lambda _m: None,
    )
    assert [s.iter_done for s in snapshots] == [1, 2]  # a snapshot after each of the 2 iterations

    # Resume from the iter_done=1 snapshot: only iteration index 1 remains, so exactly ONE more snapshot.
    resumed: list[RungTrainState] = []
    train_market_policy(
        train_envs, cfg, seed=0, resume_state=snapshots[0], checkpoint_every=1,
        on_checkpoint=resumed.append, log=lambda _m: None,
    )
    assert [s.iter_done for s in resumed] == [2]  # continued from 1; a restart would give [1, 2]


def test_ladder_resume_skips_completed_rungs(tmp_path: Path) -> None:
    """After a rung completes, its ladder checkpoint marks it done and a resume skips it."""
    pytest.importorskip("torch")

    from oct_trading_agent.agent.train_market import (
        MarketTrainConfig,
        load_ladder_checkpoint,
        run_ladder,
    )

    tapes = [_tape(f"t{i}", day=i) for i in range(4)]
    ckpt = tmp_path / "ladder.ckpt.pt"
    cfg = MarketTrainConfig(n_iterations=2, hidden_dim=16, n_quantiles=8, episodes_per_iter=1)

    results_a = run_ladder(
        tapes, rungs=(2,), cfg=cfg, seed=0, checkpoint_path=ckpt, checkpoint_every=1,
        log=lambda _m: None,
    )
    assert len(results_a) == 1  # the one rung ran
    state = load_ladder_checkpoint(ckpt)
    assert state.completed_rungs == [2]
    assert state.in_progress_rung is None

    # Resume: rung 2 is already complete, so the ladder runs nothing this pass.
    results_b = run_ladder(
        tapes, rungs=(2,), cfg=cfg, seed=0, checkpoint_path=ckpt, checkpoint_every=1,
        resume=ckpt, log=lambda _m: None,
    )
    assert results_b == []
