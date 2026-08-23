"""Behavioral cloning — supervise the hybrid actor to imitate labeled traders' actions. TORCH.

This is the seam that stops the from-scratch collapse. The Phase-1 PPO learner, starting from a
random policy, falls into a degenerate always-buy / always-hold corner (PROGRESS 2026-08-23 e/f).
Behavioral cloning pretrains the **same** network
(:class:`~oct_trading_agent.agent.policies.torch_actor.HybridActorCritic`) to reproduce real
traders' decisions, producing a warm-started policy that already *trades* — a mix of
OPEN_LONG/ADD/TRIM/CLOSE/HOLD — which PPO (:mod:`~oct_trading_agent.agent.online`) then fine-tunes
against the benchmark-relative reward (paper §2.4, §6.2 offline/imitation warm-start).

The loss is the natural imitation objective for the §3.3 hybrid action:

* **intent** — cross-entropy of the categorical intent head against the expert's intent;
* **size** — the negative log-likelihood of the expert's [0, 1] size under the head's ``Beta(α, β)``,
  applied **only** on sized intents (OPEN_LONG/ADD/TRIM) and masked off elsewhere — the sim ignores
  size for CLOSE/HOLD/NO_OP, so cloning it there would be noise.

Generalization is measured **held-out by token** (unseen mints), the same honesty the eval battery
uses: a BC accuracy that only holds on tokens it trained on would be memorization, not a transferable
warm-start. The distributional critic head is left untrained here — BC shapes the *actor*; PPO trains
the critic. ``torch`` is the optional ``learn`` extra; this module imports without it and raises a
clear error when a trainer is actually constructed.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

import numpy as np

from oct_trading_agent.agent.envs.action import INTENT_ORDER
from oct_trading_agent.agent.imitation.demos import DemoStep, demo_matrices

try:  # pragma: no cover - trivial import guard
    import torch

    TORCH_AVAILABLE = True
except ImportError:  # pragma: no cover
    TORCH_AVAILABLE = False


_NON_TRADING = frozenset({"no_op", "hold"})


def _require_torch() -> None:
    if not TORCH_AVAILABLE:
        raise ImportError(
            "behavioral cloning requires the optional 'learn' extra (`uv sync --extra learn`)."
        )


@dataclass(frozen=True)
class BCConfig:
    """Bounded-compute BC hyperparameters (a warm-start, not a long optimization)."""

    epochs: int = 60
    batch_size: int = 256
    learning_rate: float = 1e-3
    weight_decay: float = 1e-5
    size_coef: float = 0.5
    hidden_dim: int = 64
    val_fraction: float = 0.3
    seed: int = 0


@dataclass(frozen=True)
class BCResult:
    """Everything the cohort report needs to judge whether BC produced a policy that trades."""

    n_demos: int
    n_train: int
    n_val: int
    train_loss: float
    val_loss: float
    val_intent_accuracy: float
    expert_distribution: dict[str, int]
    bc_distribution: dict[str, int]
    untrained_distribution: dict[str, int]
    mean_size_sized: float
    trades: bool
    model: object = field(default=None, repr=False)
    policy: object = field(default=None, repr=False)


def _split_by_mint(steps: Sequence[DemoStep], val_fraction: float) -> tuple[list[int], list[int]]:
    """Held-out-by-token split: whole mints go to val (unseen tokens), the rest train.

    Falls back to a deterministic index split when there are too few distinct mints to hold one out.
    """
    mints = sorted({s.mint for s in steps})
    if len(mints) >= 2:
        n_val = max(1, min(len(mints) - 1, round(val_fraction * len(mints))))
        val_mints = set(mints[len(mints) - n_val :])
        train = [i for i, s in enumerate(steps) if s.mint not in val_mints]
        val = [i for i, s in enumerate(steps) if s.mint in val_mints]
        if train and val:
            return train, val
    # Fallback: contiguous index split (single-mint / degenerate cases).
    cut = max(1, round((1.0 - val_fraction) * len(steps)))
    return list(range(cut)), list(range(cut, len(steps)))


def _distribution(indices: np.ndarray) -> dict[str, int]:
    counts = {intent.value: 0 for intent in INTENT_ORDER}
    for i in indices.tolist():
        counts[INTENT_ORDER[int(i)].value] += 1
    return counts


def train_bc(steps: Sequence[DemoStep], config: BCConfig | None = None) -> BCResult:
    """Behavioral-clone the hybrid actor on ``steps``; return the warm-started policy and its metrics.

    Requires the ``learn`` extra. Deterministic given ``config.seed``. The returned ``policy`` is a
    :class:`~oct_trading_agent.agent.policies.TorchPolicy` (deterministic actor) ready to hand to the
    PPO fine-tuner; ``model`` is the underlying network PPO would continue training.
    """
    _require_torch()
    import torch
    from torch import nn
    from torch.distributions import Beta

    from oct_trading_agent.agent.policies import TorchPolicy
    from oct_trading_agent.agent.policies.torch_actor import ActorConfig, build_actor_critic

    cfg = config or BCConfig()
    torch.manual_seed(cfg.seed)
    np.random.seed(cfg.seed)

    train_idx, val_idx = _split_by_mint(steps, cfg.val_fraction)
    obs, intents, sizes, sized = demo_matrices(steps)

    obs_t = torch.from_numpy(obs).float()
    intent_t = torch.from_numpy(intents).long()
    size_t = torch.from_numpy(sizes).float().clamp(1e-4, 1.0 - 1e-4)
    sized_t = torch.from_numpy(sized).float()
    tr = torch.tensor(train_idx, dtype=torch.long)
    va = torch.tensor(val_idx, dtype=torch.long)

    model = build_actor_critic(ActorConfig(hidden_dim=cfg.hidden_dim))
    opt = torch.optim.Adam(
        model.parameters(), lr=cfg.learning_rate, weight_decay=cfg.weight_decay
    )
    ce = nn.CrossEntropyLoss()

    # Reference: the SAME architecture untrained (random init) — the "from-scratch" behaviour BC
    # must move away from. Snapshot its val action distribution before we train the real one.
    untrained = build_actor_critic(ActorConfig(hidden_dim=cfg.hidden_dim))

    def _loss(idx: torch.Tensor) -> torch.Tensor:
        out = model.forward(obs_t[idx])
        intent_loss = ce(out.intent_logits, intent_t[idx])
        beta = Beta(out.size_alpha, out.size_beta)
        size_nll = -beta.log_prob(size_t[idx])
        m = sized_t[idx]
        denom = m.sum().clamp_min(1.0)
        size_loss = (size_nll * m).sum() / denom
        return intent_loss + cfg.size_coef * size_loss

    n_train = int(tr.numel())
    for _epoch in range(cfg.epochs):
        if n_train == 0:
            break
        perm = tr[torch.randperm(n_train)]
        for start in range(0, n_train, cfg.batch_size):
            batch = perm[start : start + cfg.batch_size]
            opt.zero_grad()
            loss = _loss(batch)
            loss.backward()
            opt.step()

    model.eval()
    with torch.no_grad():
        train_loss = float(_loss(tr).item()) if n_train else float("nan")
        val_loss = float(_loss(va).item()) if va.numel() else float("nan")
        # Deterministic BC predictions on the held-out tokens.
        val_out = model.forward(obs_t[va]) if va.numel() else model.forward(obs_t[:0])
        bc_pred = torch.argmax(val_out.intent_logits, dim=-1) if va.numel() else torch.zeros(0)
        expert_val = intent_t[va] if va.numel() else torch.zeros(0, dtype=torch.long)
        accuracy = (
            float((bc_pred == expert_val).float().mean().item()) if va.numel() else float("nan")
        )
        # Predicted Beta-mode size on sized-intent val steps.
        if va.numel():
            a, b = val_out.size_alpha, val_out.size_beta
            mode = torch.where(
                (a > 1) & (b > 1), (a - 1) / (a + b - 2), a / (a + b)
            )
            mask = sized_t[va].bool()
            mean_size = float(mode[mask].mean().item()) if bool(mask.any()) else 0.0
        else:
            mean_size = 0.0
        untr_out = untrained.forward(obs_t[va]) if va.numel() else untrained.forward(obs_t[:0])
        untr_pred = torch.argmax(untr_out.intent_logits, dim=-1) if va.numel() else torch.zeros(0)

    bc_dist = _distribution(bc_pred.cpu().numpy()) if va.numel() else {}
    trades = any(v > 0 for k, v in bc_dist.items() if k not in _NON_TRADING)

    return BCResult(
        n_demos=len(steps),
        n_train=n_train,
        n_val=int(va.numel()),
        train_loss=train_loss,
        val_loss=val_loss,
        val_intent_accuracy=accuracy,
        expert_distribution=_distribution(expert_val.cpu().numpy()) if va.numel() else {},
        bc_distribution=bc_dist,
        untrained_distribution=_distribution(untr_pred.cpu().numpy()) if va.numel() else {},
        mean_size_sized=mean_size,
        trades=trades,
        model=model,
        policy=TorchPolicy(model, deterministic=True),
    )


__all__ = ["TORCH_AVAILABLE", "BCConfig", "BCResult", "train_bc"]
