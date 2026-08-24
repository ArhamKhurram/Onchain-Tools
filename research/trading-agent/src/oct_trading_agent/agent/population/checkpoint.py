"""Crash-safe checkpoint I/O for the population trainers — atomic writes + resume. TORCH-FREE import.

A long overnight run (hundreds of iterations / generations) must survive an interruption — a Windows
Update restart, a crash, a ``kill``. The trainers persist their resumable state through
:func:`atomic_write`: every write goes to a sibling temp file that is flushed and then renamed into
place with :func:`os.replace` (an atomic same-directory rename on POSIX *and* Windows), so a crash
mid-write can never truncate or corrupt an existing checkpoint (or the telemetry JSON, which reuses
:func:`atomic_write_text`). A failed write removes the temp file and leaves the prior good file intact.

The torch payload helpers (:func:`save_torch` / :func:`load_torch`) import torch lazily, so this module
stays import-safe without the ``learn`` extra — the pure atomic-write path and the telemetry writer that
depends on it carry no torch. ``load_torch`` passes ``weights_only=False`` on purpose: a trainer
checkpoint holds dataclasses and RNG state alongside the weight tensors, not tensors alone.
"""

from __future__ import annotations

import os
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any


def atomic_write(path: Path, write: Callable[[Path], None]) -> None:
    """Write ``path`` crash-safely: ``write`` fills a sibling temp file, then it is renamed into place.

    The temp file is created in the SAME directory as ``path`` (so the final :func:`os.replace` is a
    same-filesystem atomic rename, not a cross-device copy) and is removed if ``write`` raises, so a
    failed or interrupted write leaves the existing ``path`` untouched with no ``.tmp`` litter behind.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    os.close(fd)
    tmp = Path(tmp_name)
    try:
        write(tmp)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def atomic_write_text(path: Path, text: str, *, encoding: str = "utf-8") -> None:
    """Atomically (temp file + rename) write ``text`` to ``path`` — the crash-safe ``write_text``."""

    def _write(tmp: Path) -> None:
        tmp.write_text(text, encoding=encoding)

    atomic_write(path, _write)


def save_torch(path: Path, payload: Any) -> None:  # pragma: no cover - torch
    """Atomically ``torch.save`` ``payload`` to ``path`` (temp file + rename, so a mid-write kill is safe)."""
    import torch

    atomic_write(path, lambda tmp: torch.save(payload, tmp))


def load_torch(path: Path, *, map_location: Any = None) -> Any:  # pragma: no cover - torch
    """``torch.load`` a checkpoint written by :func:`save_torch`.

    ``weights_only=False`` because a trainer checkpoint carries dataclasses (elites, hyperparameters) and
    RNG state, not just weight tensors; ``map_location`` moves the loaded tensors onto the resume device.
    """
    import torch

    return torch.load(path, map_location=map_location, weights_only=False)


__all__ = ["atomic_write", "atomic_write_text", "save_torch", "load_torch"]
