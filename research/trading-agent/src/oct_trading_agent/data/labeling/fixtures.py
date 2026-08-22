"""Fixture loader for the labeled-wallet DB (Phase-0 stand-in for the Phase-1 source).

Loads :class:`~.schema.LabeledWallet`\\ s from a JSON document so the whole labeling pipeline is
testable without the real DB. The JSON shape mirrors the schema exactly::

    {
      "wallets": [
        {
          "wallet": "So1...",
          "labels": ["smart-money"],
          "trades": [
            {"timestamp": "2026-08-01T00:00:00Z", "mint": "Tok...", "side": "buy",
             "base_amount": "1000000", "quote_amount": "1.5", "price": null,
             "signature": "sig..."}
          ]
        }
      ]
    }

**Phase-1 swap point:** replace :func:`load_labeled_wallets` with a DB-backed loader that yields the
same :class:`LabeledWallet` objects; nothing downstream (:func:`~.reconstruct.build_trajectories`)
changes. Amounts are parsed as exact ``Decimal`` (pydantic handles str/number/Decimal).
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from .schema import LabeledWallet


def load_labeled_wallets(
    source: Path | str | Mapping[str, Any] | Sequence[Any],
) -> list[LabeledWallet]:
    """Load labeled wallets from a JSON file path or an already-parsed mapping.

    Accepts either the ``{"wallets": [...]}`` envelope or a bare list of wallet objects.
    """
    if isinstance(source, (str, Path)):
        payload: Any = json.loads(Path(source).read_text(encoding="utf-8"))
    else:  # already-parsed mapping or list
        payload = source

    if isinstance(payload, Mapping):
        wallets = payload.get("wallets", [])
    elif isinstance(payload, Sequence) and not isinstance(payload, (str, bytes)):
        wallets = payload
    else:
        raise ValueError("labeled-wallet source must be a mapping or a list")

    return [LabeledWallet.model_validate(w) for w in wallets]


__all__ = ["load_labeled_wallets"]
