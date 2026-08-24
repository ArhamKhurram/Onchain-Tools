"""Device selection for the torch training paths — the single ``auto|cuda|cpu`` seam.

The training entry points (:mod:`.train_market`, :mod:`.population.pbt`, :mod:`.population.map_elites`)
each expose a ``--device`` flag; :func:`resolve_device` maps its value to ONE concrete
:class:`torch.device`, and that device is threaded into model construction (``build_actor_critic(...,
device=...)``). Everything downstream — rollout collection, the PPO update, the eval policy — reads
the device back off the model's own parameters, so a device is chosen in exactly one place and there
are no scattered ``.cuda()`` calls to keep in sync.

``auto`` is the default and picks ``cuda`` only when a GPU is visible, so a CPU-only machine keeps its
exact prior behaviour. Torch-gated to match the rest of the learner: this module imports without the
``learn`` extra (the ``import torch`` is lazy, inside the function); :func:`resolve_device` needs torch
only when it is actually called.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import torch

_VALID = ("auto", "cuda", "cpu")


def resolve_device(spec: str = "auto") -> torch.device:
    """Map a ``--device`` spec (``auto`` | ``cuda`` | ``cpu``) to a concrete :class:`torch.device`.

    ``auto`` selects ``cuda`` when ``torch.cuda.is_available()`` and ``cpu`` otherwise (the CPU-only
    default is unchanged). An explicit ``cuda`` that cannot be satisfied raises rather than silently
    degrading to CPU, so a GPU run that loses its device fails loudly. Requires the ``learn`` extra.
    """
    import torch

    choice = (spec or "auto").strip().lower()
    if choice not in _VALID:
        raise ValueError(f"--device must be one of {'|'.join(_VALID)}, got {spec!r}")
    if choice == "auto":
        choice = "cuda" if torch.cuda.is_available() else "cpu"
    if choice == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("--device cuda requested but torch.cuda.is_available() is False")
    return torch.device(choice)


__all__ = ["resolve_device"]
