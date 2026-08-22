"""Causal self-attention encoder — the learned *student* backbone (paper §4.4, §5, §6.4). TORCH.

Part II of the trade-flow attention model: a masked (causal) self-attention transformer over the
swap sequence that produces the compact ``embedding`` the RL agent consumes, pretrained
self-supervised with a **Hawkes-intensity distillation** head (the interpretable teacher of
``hawkes.py`` supervises the student, paper §5.3).

**Torch is an OPTIONAL extra.** Importing this module never fails when torch is absent — only
constructing an encoder does, with a clear message. Everything the pipeline needs without torch
(the numpy embedding) lives in ``pipeline.py``; the feature adapter :func:`swaps_to_event_features`
here is pure numpy and testable on its own.

The two-head structure of §6.4 (the co-training contract Model N wires into) is implemented
literally:

* **One shared backbone**, co-trained. During agent training the total loss is
  ``L = L_RL + β · L_SSL`` — RL gradients from the policy/critic *and* the standing self-supervised
  loss both flow into the backbone. ``β`` is annealed (high early to keep the representation honest
  on tiny per-token samples, lower later to let the task specialize it). This module builds the
  **encoder + the SSL pretraining**; the RL loop that adds ``L_RL`` is Model N's to wire in.
* **PRIVATE head (task-coupled).** Reads the pooled representation directly, so RL gradients shape
  it — the agent's specialized, co-trained view of attention. ``EncoderOutput.private_embedding``.
* **PUBLIC head (stop-gradient / ``detach()``).** Reads a *detached* copy of the pooled
  representation, so nothing downstream of it (convergence, the standalone alert) can push
  task-shaping back into the backbone. ``EncoderOutput.public_embedding`` is what the convergence
  layer and :class:`~...pipeline.build_attention_state` are allowed to read — flow-derived and
  mechanically independent of the agent's objective (paper §4.3/§6.4).
* **The reflexive own-flow correction (paper §8.4/§9.10).** The agent's own fills enter
  ``λ_buy``/``λ_sell`` and inflate the very ``n`` that would justify them. The last input feature is
  an **own-flow tag**: Model N sets it on the agent's own swaps so the co-trained encoder learns to
  subtract its own market impact rather than trade its own shadow. It is a covariate here, wired by
  Model N when the RL loop comes online.
"""

from __future__ import annotations

from datetime import datetime

import numpy as np

from oct_trading_agent.core.enums import Side
from oct_trading_agent.core.tape import SwapEvent

# Per-event input feature layout (paper §5.2). Kept as a module constant so the torch encoder and
# the numpy adapter agree on the width, and Model N knows which column is the own-flow tag.
FEATURE_NAMES: tuple[str, ...] = (
    "dt_since_last",  # inter-trade time (the raw point-process input)
    "side_sign",  # +1 buy, -1 sell
    "log_size",  # log1p quote size
    "running_unique_buyers",  # breadth so far (normalized)
    "running_concentration",  # Herfindahl of buy volume so far
    "own_flow",  # reflexive tag — Model N sets this on the agent's own fills (§8.4)
)
N_FEATURES = len(FEATURE_NAMES)
OWN_FLOW_COL = FEATURE_NAMES.index("own_flow")


def swaps_to_event_features(
    swaps: list[SwapEvent],
    as_of: datetime,
    *,
    own_flow_wallets: frozenset[str] = frozenset(),
) -> np.ndarray:
    """Build the ``(N, N_FEATURES)`` causal event-feature matrix from a swap window (pure numpy).

    Rows are in tape order; every feature is causal (computed from events up to and including that
    row). This is the transformer's input and is also useful on its own for inspection.
    """
    causal = sorted(
        (e for e in swaps if e.block_time <= as_of), key=lambda e: (e.slot, e.block_time)
    )
    n = len(causal)
    feats = np.zeros((n, N_FEATURES), dtype=float)
    if n == 0:
        return feats

    start = causal[0].block_time
    prev_t = 0.0
    seen_buyers: set[str] = set()
    buyer_vol: dict[str, float] = {}
    for i, e in enumerate(causal):
        t = (e.block_time - start).total_seconds()
        dt = t - prev_t
        prev_t = t
        is_buy = e.side is Side.BUY
        size = float(e.quote_amount)
        if is_buy:
            seen_buyers.add(e.signer)
            buyer_vol[e.signer] = buyer_vol.get(e.signer, 0.0) + size
        vols = np.array(list(buyer_vol.values()), dtype=float)
        total = float(np.sum(vols))
        hhi = float(np.sum((vols / total) ** 2)) if total > 0 else 0.0
        feats[i, 0] = np.log1p(max(dt, 0.0))
        feats[i, 1] = 1.0 if is_buy else -1.0
        feats[i, 2] = np.log1p(size)
        feats[i, 3] = len(seen_buyers) / 100.0
        feats[i, 4] = hhi
        feats[i, 5] = 1.0 if e.signer in own_flow_wallets else 0.0
    return feats


# ---------------------------------------------------------------------------
# Torch-only pieces. Guarded so the module imports cleanly in a lean install.
# ---------------------------------------------------------------------------
try:  # pragma: no cover - trivial import guard
    import torch
    from torch import nn

    TORCH_AVAILABLE = True
except ImportError:  # pragma: no cover
    TORCH_AVAILABLE = False


def _require_torch() -> None:
    if not TORCH_AVAILABLE:
        raise ImportError(
            "the transformer attention encoder requires the optional 'torch' extra "
            "(`pip install -e '.[torch]'`); the Hawkes teacher, manipulation channel, "
            "standalone signal and AttentionState pipeline all run without it"
        )


if TORCH_AVAILABLE:

    class _TemporalEncoding(nn.Module):  # type: ignore[misc, unused-ignore]  # torch Any in lean check
        """Sinusoidal encoding of *actual* cumulative time (paper §5.2 — timestamps, not indices)."""

        def __init__(self, d_model: int) -> None:
            super().__init__()
            self.d_model = d_model
            div = torch.exp(
                torch.arange(0, d_model, 2, dtype=torch.float32)
                * (-np.log(10000.0) / d_model)
            )
            self.register_buffer("div_term", div)

        def forward(self, cum_time: torch.Tensor) -> torch.Tensor:
            # cum_time: (B, T) seconds. Returns (B, T, d_model).
            ct = cum_time.unsqueeze(-1)  # (B, T, 1)
            angles = ct * self.div_term  # type: ignore[operator, unused-ignore]  # torch buffer stub
            enc = torch.zeros(*cum_time.shape, self.d_model, device=cum_time.device)
            enc[..., 0::2] = torch.sin(angles)
            enc[..., 1::2] = torch.cos(angles)
            return enc

    class EncoderOutput:
        """Container for the three outputs of one forward pass (a plain object, not a tensor)."""

        def __init__(
            self,
            private_embedding: torch.Tensor,
            public_embedding: torch.Tensor,
            ssl_prediction: torch.Tensor,
        ) -> None:
            self.private_embedding = private_embedding  # task-coupled (RL grads flow)
            self.public_embedding = public_embedding  # stop-gradient copy (convergence/alert)
            self.ssl_prediction = ssl_prediction  # (B, 4): next_dt, next_side, λ_buy, λ_sell

    class SwapSequenceEncoder(nn.Module):  # type: ignore[misc, unused-ignore]  # torch Any in lean check
        """Causal self-attention encoder over the swap sequence with the §6.4 two-head structure.

        SSL head predicts (next inter-trade time, next side) and distills the Hawkes intensity
        (λ_buy, λ_sell) — dense self-supervision without labels (paper §5.2 (iii), §6.4).
        """

        def __init__(
            self,
            *,
            d_model: int = 32,
            n_heads: int = 4,
            n_layers: int = 2,
            embedding_dim: int = 12,
            dropout: float = 0.0,
        ) -> None:
            _require_torch()
            super().__init__()
            self.d_model = d_model
            self.embedding_dim = embedding_dim
            self.input_proj = nn.Linear(N_FEATURES, d_model)
            self.temporal = _TemporalEncoding(d_model)
            layer = nn.TransformerEncoderLayer(
                d_model=d_model,
                nhead=n_heads,
                dim_feedforward=d_model * 4,
                dropout=dropout,
                batch_first=True,
                activation="gelu",
            )
            self.encoder = nn.TransformerEncoder(layer, num_layers=n_layers)
            self.private_head = nn.Linear(d_model, embedding_dim)
            self.public_head = nn.Linear(d_model, embedding_dim)
            self.ssl_head = nn.Linear(d_model, 4)  # next_dt, next_side, λ_buy, λ_sell

        def _pool(self, features: torch.Tensor) -> torch.Tensor:
            """Encode a (B, T, N_FEATURES) batch causally and pool the last position → (B, d_model)."""
            t = features.shape[1]
            cum_time = torch.cumsum(torch.expm1(features[..., 0]).clamp(min=0.0), dim=1)
            h = self.input_proj(features) + self.temporal(cum_time)
            causal_mask = torch.triu(
                torch.full((t, t), float("-inf"), device=features.device), diagonal=1
            )
            z = self.encoder(h, mask=causal_mask)  # (B, T, d_model)
            return z[:, -1, :]  # type: ignore[no-any-return, unused-ignore]  # torch stub returns Any

        def forward(self, features: torch.Tensor) -> EncoderOutput:
            pooled = self._pool(features)
            private = self.private_head(pooled)  # RL gradients flow into the backbone
            public = self.public_head(pooled.detach())  # stop-gradient boundary (§6.4)
            ssl = self.ssl_head(pooled)  # SSL trains the backbone
            return EncoderOutput(private, public, ssl)

        def public_embedding(self, events: list[SwapEvent], as_of: datetime) -> list[float]:
            """Return the detached PUBLIC embedding for a swap window (implements PublicEmbedder).

            This is the *only* embedding a convergence/alert consumer may read (paper §6.4).
            """
            feats = swaps_to_event_features(events, as_of)
            if feats.shape[0] == 0:
                return [0.0] * self.embedding_dim
            self.eval()
            with torch.no_grad():
                x = torch.from_numpy(feats).float().unsqueeze(0)
                out = self.forward(x)
            return [float(v) for v in out.public_embedding.squeeze(0).cpu().numpy()]

    def ssl_targets_from_hawkes(
        features: torch.Tensor,
        lambda_buy: float,
        lambda_sell: float,
    ) -> torch.Tensor:
        """Build the SSL target vector: (next_dt, next_side, λ_buy, λ_sell) for the last step.

        ``next_dt``/``next_side`` are self-supervised from the sequence itself; ``λ_buy``/``λ_sell``
        are the Hawkes teacher's distillation targets (paper §5.3). A tiny/synthetic helper for
        the pretraining step — Model N supplies real teacher intensities at scale.
        """
        b = features.shape[0]
        tgt = torch.zeros(b, 4)
        tgt[:, 0] = features[:, -1, 0]  # reuse last dt as a stand-in next-dt target
        tgt[:, 1] = (features[:, -1, 1] > 0).float()  # next-side (buy=1)
        tgt[:, 2] = lambda_buy
        tgt[:, 3] = lambda_sell
        return tgt

    def ssl_loss(prediction: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
        """L_SSL: timing/mark regression + Hawkes-intensity distillation (MSE blend).

        This is the standing self-supervised loss that co-trains the backbone alongside L_RL; the
        joint objective Model N optimizes is ``L = L_RL + β · L_SSL`` (paper §6.4).
        """
        return nn.functional.mse_loss(prediction, target)

    def ssl_pretrain_step(
        encoder: SwapSequenceEncoder,
        features: torch.Tensor,
        lambda_buy: float,
        lambda_sell: float,
        optimizer: torch.optim.Optimizer,
    ) -> float:
        """One tiny SSL pretraining step (encoder-only, pre-RL). Returns the scalar loss.

        Deliberately minimal — enough to prove the SSL head trains the backbone and the public head
        stays detached. The full pretraining schedule and β-annealing live in Model N's training
        code (paper §6.4).
        """
        _require_torch()
        encoder.train()
        optimizer.zero_grad()
        out = encoder.forward(features)
        target = ssl_targets_from_hawkes(features, lambda_buy, lambda_sell)
        loss = ssl_loss(out.ssl_prediction, target)
        loss.backward()  # type: ignore[no-untyped-call, unused-ignore]  # torch stub untyped
        optimizer.step()
        return float(loss.detach().cpu())
