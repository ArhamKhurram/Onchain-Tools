"""The device seam: ``resolve_device()`` string mapping + on-device model construction.

The pure mapping (``auto`` consults ``torch.cuda.is_available``; ``cpu``/``cuda`` are literal; junk
raises) is pinned by monkeypatching CUDA availability, so it is verified on any machine. That a
constructed :class:`HybridActorCritic` — params AND the critic's registered ``taus`` buffer — lands on
the requested device is checked on CPU always, and on CUDA only where a GPU is actually present.
"""

from __future__ import annotations

import pytest


def _cuda_available() -> bool:
    try:
        import torch
    except ImportError:  # pragma: no cover - lean install has no torch
        return False
    return bool(torch.cuda.is_available())


def test_resolve_device_auto_prefers_cuda_when_available(monkeypatch: pytest.MonkeyPatch) -> None:
    torch = pytest.importorskip("torch")
    from oct_trading_agent.agent.device import resolve_device

    monkeypatch.setattr(torch.cuda, "is_available", lambda: True)
    assert resolve_device("auto").type == "cuda"


def test_resolve_device_auto_falls_back_to_cpu(monkeypatch: pytest.MonkeyPatch) -> None:
    torch = pytest.importorskip("torch")
    from oct_trading_agent.agent.device import resolve_device

    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
    assert resolve_device("auto").type == "cpu"


def test_resolve_device_cpu_is_cpu_even_with_gpu(monkeypatch: pytest.MonkeyPatch) -> None:
    torch = pytest.importorskip("torch")
    from oct_trading_agent.agent.device import resolve_device

    monkeypatch.setattr(torch.cuda, "is_available", lambda: True)
    assert resolve_device("cpu").type == "cpu"


def test_resolve_device_cuda_string_maps_to_cuda(monkeypatch: pytest.MonkeyPatch) -> None:
    torch = pytest.importorskip("torch")
    from oct_trading_agent.agent.device import resolve_device

    monkeypatch.setattr(torch.cuda, "is_available", lambda: True)
    assert resolve_device("cuda").type == "cuda"


def test_resolve_device_default_is_auto(monkeypatch: pytest.MonkeyPatch) -> None:
    torch = pytest.importorskip("torch")
    from oct_trading_agent.agent.device import resolve_device

    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
    assert resolve_device().type == "cpu"


def test_resolve_device_cuda_requested_but_unavailable_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    torch = pytest.importorskip("torch")
    from oct_trading_agent.agent.device import resolve_device

    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
    with pytest.raises(RuntimeError):
        resolve_device("cuda")


def test_resolve_device_rejects_unknown_spec() -> None:
    pytest.importorskip("torch")
    from oct_trading_agent.agent.device import resolve_device

    with pytest.raises(ValueError):
        resolve_device("gpu")


def test_build_actor_critic_lands_on_cpu_device() -> None:
    torch = pytest.importorskip("torch")
    from oct_trading_agent.agent.policies.torch_actor import ActorConfig, build_actor_critic

    model = build_actor_critic(ActorConfig(hidden_dim=16), device=torch.device("cpu"))
    assert next(model.parameters()).device.type == "cpu"
    # The critic's registered quantile-level buffer moves with the module, not just the parameters.
    assert model.critic.taus.device.type == "cpu"


def test_build_actor_critic_default_device_unchanged() -> None:
    """device=None (the default) must leave the net on CPU — the CPU-only path is untouched."""
    pytest.importorskip("torch")
    from oct_trading_agent.agent.policies.torch_actor import ActorConfig, build_actor_critic

    model = build_actor_critic(ActorConfig(hidden_dim=16))
    assert next(model.parameters()).device.type == "cpu"


@pytest.mark.skipif(not _cuda_available(), reason="CUDA not available on this machine")
def test_build_actor_critic_lands_on_cuda_device() -> None:
    from oct_trading_agent.agent.device import resolve_device
    from oct_trading_agent.agent.policies.torch_actor import ActorConfig, build_actor_critic

    device = resolve_device("cuda")
    model = build_actor_critic(ActorConfig(hidden_dim=16), device=device)
    assert next(model.parameters()).is_cuda
    assert model.critic.taus.is_cuda
