"""Agent trade-log exporter — re-run a MAP-Elites archive's niche champions, record every trade.

Loads a MAP-Elites checkpoint (the archive the research program actually ships — one elite per
behavioral niche, genome weights included), rebuilds each champion's deterministic eval policy
exactly as the trainer evaluates it (:class:`TorchPolicy` with the genome's own weights +
observation normalizer, argmax intent / Beta-mode size), and re-runs it on a BOUNDED sample of the
run's held-out tokens (the newest-tokens split — same walk-forward as training, so nothing leaks).
Every fill is recorded by :func:`~.record.record_policy_rollout` into the trade-log substrate
(:class:`~.log.TradeLogStore`), one segment per run — the same seam any future training/eval run
uses to append its own trades.

Deterministic by construction: the policy is deterministic, the env's sim seed is fixed from
``--seed``, and the held-out token sample is the split's FIRST ``--tokens-per-champion`` test
tokens — the same command reproduces byte-identical rows.

Deliberately polite: ``--torch-threads`` defaults to 1 and ``--device`` to cpu (a heavy run may own
this machine); the nets are tiny and the work is a handful of episodes per champion.

Run (needs the ``learn`` extra)::

    uv run --extra learn python -m oct_trading_agent.traces.agents \
        --checkpoint data/desk_telemetry/mapelites-800.ckpt.pt \
        --dataset data/market_dataset_snap800 --tokens 800 --root data/replay_traces
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

from oct_trading_agent.agent.envs import vector_length
from oct_trading_agent.agent.policies import EnvPolicy
from oct_trading_agent.agent.population.descriptor import bin_descriptor, bin_style_cell
from oct_trading_agent.agent.population.map_elites import (
    Elite,
    EliteGenome,
    MapElitesCheckpoint,
    load_map_elites_checkpoint,
)
from oct_trading_agent.agent.train_market import (
    MarketTrainConfig,
    MarketWalkForward,
    build_market_walk_forward,
)
from oct_trading_agent.data.dataset import MarketSwapDataset

from .curate import curate_group
from .log import TradeLogStore, write_curated_index
from .record import RecordedEpisode, record_policy_rollout
from .schema import TradeRow


def _load_checkpoint(path: Path) -> MapElitesCheckpoint:  # pragma: no cover - torch
    """Load a MAP-Elites checkpoint even when the training run pickled its classes as ``__main__``.

    A run launched via ``python -m ...population.map_elites`` executes that module AS ``__main__``,
    so its dataclasses pickle as ``__main__.MapElitesCheckpoint`` etc.; loading from any other
    entrypoint then fails to resolve them. Aliasing the real classes onto the CURRENT ``__main__``
    before unpickling restores exactly the objects the trainer saved — no re-pickling, no copies.
    """
    import sys

    import torch

    main_mod = sys.modules["__main__"]
    for cls in (MapElitesCheckpoint, Elite, EliteGenome):
        if not hasattr(main_mod, cls.__name__):
            setattr(main_mod, cls.__name__, cls)
    ckpt = load_map_elites_checkpoint(path, device=torch.device("cpu"))
    for elite in ckpt.elites:
        if elite.genome is not None:
            elite.genome.normalizer = _repair_normalizer(elite.genome.normalizer)
    return ckpt


def _repair_normalizer(normalizer: Any) -> Any:  # pragma: no cover - checkpoint compat
    """Migrate a normalizer pickled by an OLDER ``RunningNormalizer`` onto the current class.

    The old class stored ``_mask_slice`` as an instance attribute (a ``slice``) and had no
    ``_n_features``; unpickled onto the current class, the stale attribute shadows the method and
    the missing one breaks ``_ensure``. The statistical state is unchanged between versions, so the
    exact policy the trainer evaluated is reconstructed by copying it onto a FRESH normalizer and
    recovering the feature-block width from the legacy slice (its ``start`` IS ``n_features``), or
    from the observation contract (``D = 2 * n_features + len(STATE_SLOTS)``) when absent.
    """
    from oct_trading_agent.agent.envs.observation import STATE_SLOTS
    from oct_trading_agent.agent.online.normalize import RunningNormalizer

    legacy = vars(normalizer)
    if "_n_features" in legacy and "_mask_slice" not in legacy:
        return normalizer  # already the current format
    fresh = RunningNormalizer()
    for key in ("_eps", "_clip", "_warmup", "_d", "_count", "_mean", "_m2"):
        if key in legacy:
            setattr(fresh, key, legacy[key])
    mask = legacy.get("_mask_slice")
    if isinstance(mask, slice) and mask.start is not None:
        fresh._n_features = int(mask.start)
    elif int(getattr(fresh, "_d", 0)) > 0:
        fresh._n_features = (int(fresh._d) - len(STATE_SLOTS)) // 2
    return fresh


def elite_policy(elite: Elite) -> EnvPolicy:  # pragma: no cover - torch
    """Rebuild one champion's deterministic eval policy from its checkpointed genome.

    The net's dimensions are INFERRED from the genome's own weight shapes (``torso.0.weight`` is
    ``(hidden, d_in)``; ``critic.head.weight`` is ``(n_quantiles, hidden)``), so this loads elites
    from any run configuration — including the attention-features ablation — without being told.
    """
    from oct_trading_agent.agent.policies import TorchPolicy
    from oct_trading_agent.agent.policies.torch_actor import ActorConfig, build_actor_critic

    genome = elite.genome
    assert genome is not None, f"elite {elite.agent_id} carries no genome (pure-test archive?)"
    state = genome.state_dict
    hidden, d_in = (int(x) for x in state["torso.0.weight"].shape)
    n_quantiles = int(state["critic.head.weight"].shape[0])
    model = build_actor_critic(
        ActorConfig(hidden_dim=hidden, n_quantiles=n_quantiles, d_in=d_in)
    )
    model.load_state_dict(state)
    return TorchPolicy(model, normalizer=genome.normalizer, deterministic=True)


def _attention_from_genome(elite: Elite) -> bool:  # pragma: no cover - torch
    """Whether the genome was trained on the attention-widened observation (drives env building)."""
    genome = elite.genome
    assert genome is not None
    d_in = int(genome.state_dict["torso.0.weight"].shape[1])
    return d_in == vector_length(attention=True)


def _held_out_sample(wf: MarketWalkForward, n: int) -> list[Any]:
    """The FIRST ``n`` held-out tokens (oldest of the test split) — a deterministic bounded sample."""
    prepared = wf.test or wf.train
    return prepared[: max(1, n)]


def export_agents(
    store: TradeLogStore,
    checkpoint: Path,
    dataset_root: Path,
    *,
    tokens: int,
    protocols: tuple[str, ...],
    min_swaps: int,
    tokens_per_champion: int,
    seed: int,
) -> tuple[str, list[TradeRow], list[dict[str, Any]], dict[str, list[RecordedEpisode]]]:  # pragma: no cover - torch/IO
    """Re-run every niche champion on the held-out sample; write the run's trade-log segment."""
    import torch

    torch.set_num_threads(1)  # politeness floor; the CLI's --torch-threads can raise it pre-call
    ckpt = _load_checkpoint(checkpoint)
    run_id = ckpt.run_id
    elites = ckpt.elites
    print(f"[agents] checkpoint {checkpoint.name}: run_id={run_id} elites={len(elites)}")

    dataset = MarketSwapDataset(dataset_root)
    tapes = dataset.load_token_tapes(max_tokens=tokens, min_swaps=min_swaps, protocols=protocols)
    wf = build_market_walk_forward(tapes)
    attention = any(_attention_from_genome(e) for e in elites)
    cfg = MarketTrainConfig(attention_features=attention)
    sample = _held_out_sample(wf, tokens_per_champion)
    envs = [wf.env(p, cfg, seed=seed + 1) for p in sample]
    print(
        f"[agents] dataset: {len(tapes)} tapes -> train={len(wf.train)} test={len(wf.test)} "
        f"skipped={len(wf.skipped)}; replaying each champion on {len(envs)} held-out token(s)"
    )

    torch.manual_seed(seed)
    rows: list[TradeRow] = []
    actors: list[dict[str, Any]] = []
    episodes: dict[str, list[RecordedEpisode]] = {}
    for elite in elites:
        policy = elite_policy(elite)
        recorded = [
            record_policy_rollout(env, policy, actor_id=elite.agent_id, group_id=run_id)
            for env in envs
        ]
        episodes[elite.agent_id] = recorded
        elite_rows = [row for ep in recorded for row in ep.rows]
        rows.extend(elite_rows)
        profile = elite.profile
        actors.append(
            {
                "actor_id": elite.agent_id,
                "actor_kind": "agent",
                "group_id": run_id,
                "tokens_touched": sum(1 for ep in recorded if ep.rows),
                "n_trades": len(elite_rows),
                "realized_pnl_quote": sum(ep.realized_pnl_quote for ep in recorded),
                "role": bin_descriptor(profile.descriptor),
                "style_cell": bin_style_cell(profile.descriptor),
                "pnl_bps": profile.pnl_bps,
                "win_rate": profile.win_rate,
                "meta_json": json.dumps(
                    {
                        "archive_n_trades": profile.n_trades,
                        "archive_n_tokens": profile.n_tokens,
                        "mean_hold_secs": profile.mean_hold_secs,
                        "trade_frequency": profile.descriptor.trade_frequency,
                        "replay_seed": seed,
                        "replay_tokens": [str(p.mint) for p in sample],
                    },
                    sort_keys=True,
                ),
            }
        )
        print(
            f"[agents] {elite.agent_id} ({bin_descriptor(profile.descriptor)}): "
            f"{len(elite_rows)} trade row(s) on {sum(1 for ep in recorded if ep.rows)}/{len(envs)} tokens, "
            f"replay realized={sum(ep.realized_pnl_quote for ep in recorded):+.6f} SOL "
            f"(archive held-out {profile.pnl_bps:+.1f} bps)"
        )

    store.write_segment(f"agents-{run_id}", rows)
    store.write_actors(f"agents-{run_id}", actors)
    return run_id, rows, actors, episodes


def curate_agents(
    store: TradeLogStore,
    dataset_root: Path,
    *,
    run_id: str,
    rows: list[TradeRow],
    actors: list[dict[str, Any]],
    max_price_points: int,
) -> dict[str, Any]:
    """Write the curated per-(champion, token) trace JSONs (tier 3; already bounded by the re-eval)."""
    return curate_group(
        store, dataset_root, group_id=run_id, actor_kind="agent",
        rows=rows, actors=actors, max_price_points=max_price_points,
    )


def main() -> None:  # pragma: no cover - CLI/torch
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=str, required=True, help="MAP-Elites .ckpt.pt path")
    parser.add_argument("--dataset", type=str, required=True, help="MarketSwapDataset root")
    parser.add_argument("--root", type=str, default="data/replay_traces", help="trace-store root")
    parser.add_argument("--tokens", type=int, default=800, help="tapes to load (match the run's rung)")
    parser.add_argument("--protocols", type=str, default="pumpfun_amm", help="comma-separated venues")
    parser.add_argument("--min-swaps", type=int, default=24)
    parser.add_argument(
        "--tokens-per-champion", type=int, default=8,
        help="held-out tokens each champion is replayed on (bounded, deterministic sample)",
    )
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--torch-threads", type=int, default=1, help="keep small — be polite")
    parser.add_argument("--no-curated", action="store_true", help="skip the tier-3 JSON showcase")
    parser.add_argument("--max-price-points", type=int, default=500)
    args = parser.parse_args()

    import torch

    torch.set_num_threads(max(1, args.torch_threads))
    store = TradeLogStore(Path(args.root))
    protocols = tuple(p.strip() for p in args.protocols.split(",") if p.strip())
    start = time.perf_counter()
    run_id, rows, actors, _episodes = export_agents(
        store, Path(args.checkpoint), Path(args.dataset),
        tokens=args.tokens, protocols=protocols, min_swaps=args.min_swaps,
        tokens_per_champion=args.tokens_per_champion, seed=args.seed,
    )
    print(
        f"[agents] segment agents-{run_id}: {len(rows)} trade row(s) from {len(actors)} champion(s) "
        f"in {time.perf_counter() - start:.1f}s"
    )
    if not args.no_curated:
        entry = curate_agents(
            store, Path(args.dataset), run_id=run_id, rows=rows, actors=actors,
            max_price_points=args.max_price_points,
        )
        index_path = write_curated_index(store.root, [entry])
        n_files = sum(len(a["tokens"]) for a in entry["actors"])
        print(f"[agents] curated {n_files} trace JSON(s); index -> {index_path}")


if __name__ == "__main__":  # pragma: no cover
    main()


__all__ = ["elite_policy", "export_agents", "curate_agents"]
