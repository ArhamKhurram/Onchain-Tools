"""Read the operator's tracked-wallets export into a bounded, balance-ranked cohort.

The operator tracks a large set of Solana wallets (the export ships ~968 rows). Each row carries an
``address`` and a human ``name`` plus a ``fundingInfo`` block whose ``nativeBalance`` (SOL) is the
one cheap wealth proxy we have *before* pulling any trades. This module parses that export into a
small typed record and selects a **bounded** subset to actually pull — the cohort report is a first
pass over the highest-signal traders, not a 968-wallet firehose (03 §Phase 0: the PR is the
deliverable, not open-ended data collection).

The export file itself is operator data — it is **never committed** and never logged here; only the
addresses/names we were handed are held in memory for the duration of a pull.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class TrackedWallet:
    """One tracked wallet from the operator's export: address, name, and SOL balance (a wealth proxy)."""

    address: str
    name: str
    native_balance: Decimal
    chain: str = "solana"


def _to_decimal(value: object) -> Decimal:
    if value is None:
        return Decimal(0)
    try:
        return Decimal(str(value))
    except (ValueError, ArithmeticError):
        return Decimal(0)


def parse_tracked_wallets(
    source: Path | str | Sequence[Any],
    *,
    chain: str = "solana",
) -> list[TrackedWallet]:
    """Parse the tracked-wallets export (a JSON array, or an already-parsed list) into records.

    Keeps only rows on ``chain`` that carry a base58-ish ``address``. Missing balances default to 0
    (they sort last). Order is preserved as-is; ranking is a separate, explicit step
    (:func:`select_cohort`).
    """
    if isinstance(source, (str, Path)):
        payload: Any = json.loads(Path(source).read_text(encoding="utf-8"))
    else:
        payload = source
    if isinstance(payload, Mapping):  # tolerate a {"wallets": [...]} envelope
        rows = payload.get("wallets", [])
    elif isinstance(payload, Sequence) and not isinstance(payload, (str, bytes)):
        rows = payload
    else:
        raise ValueError("tracked-wallets source must be a JSON array or a {'wallets': [...]} object")

    out: list[TrackedWallet] = []
    for row in rows:
        if not isinstance(row, Mapping):
            continue
        if str(row.get("chain", chain)) != chain:
            continue
        address = row.get("address")
        if not isinstance(address, str) or not address:
            continue
        funding = row.get("fundingInfo")
        native = (funding or {}).get("nativeBalance") if isinstance(funding, Mapping) else None
        name = row.get("name")
        out.append(
            TrackedWallet(
                address=address,
                name=str(name) if isinstance(name, str) and name else address[:8],
                native_balance=_to_decimal(native),
                chain=chain,
            )
        )
    return out


def select_cohort(
    wallets: Sequence[TrackedWallet],
    *,
    max_wallets: int = 40,
    min_balance: Decimal = Decimal(0),
) -> list[TrackedWallet]:
    """Rank by SOL balance (desc) and return the top ``max_wallets`` — the bounded first-pass cohort.

    Balance is a coarse wealth/seriousness proxy, **not** a profitability signal (a wallet is ranked
    by what it holds now, which mixes wins and losses — the selection-bias caveat, paper §9.3). The
    cap is what keeps a run bounded; scaling to all 968 is a matter of raising it later.
    """
    ranked = sorted(
        (w for w in wallets if w.native_balance >= min_balance),
        key=lambda w: (-w.native_balance, w.address),
    )
    return ranked[: max(0, max_wallets)]


__all__ = ["TrackedWallet", "parse_tracked_wallets", "select_cohort"]
