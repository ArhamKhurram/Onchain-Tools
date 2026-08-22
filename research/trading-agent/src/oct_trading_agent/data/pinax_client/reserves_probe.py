"""Network-gated probe: independent reserves vs the swap's executed price (the depth sanity check).

Run against LIVE Pinax to confirm the reserves this module fetches are real and correctly oriented:
pick one busy pump.fun-AMM pool from recent swaps, fetch its independent reserves, and print the
reserve-implied mid (``quote_reserve / base_reserve``) next to a nearby swap's executed price
(``quote / base``). For a recently-active pool the two should agree to within fees + the order's own
impact — that agreement is the evidence the reserves are the right vaults in the right UI units.

Gated on ``PINAX_API_KEY`` (config.py). Never run in unit tests. Invoke directly:

    uv run python -m oct_trading_agent.data.pinax_client.reserves_probe

:func:`run_probe` returns a structured :class:`ProbeReport` so a caller can assert on it; ``main``
just pretty-prints it.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from .decode import WSOL
from .reserves import PoolReserves, ReservesClient
from .rest import PinaxRestClient


@dataclass(frozen=True)
class ProbeReport:
    """One pool's reserves-vs-implied-mid comparison."""

    amm_pool: str
    base_mint: str
    swap_block: int
    swap_notional_sol: Decimal
    swap_executed_price: Decimal  # quote per base (SOL per token)
    reserves: PoolReserves

    @property
    def implied_over_executed(self) -> Decimal | None:
        """Ratio of the reserve-implied mid to the swap's executed price (1.0 ⇒ perfect)."""
        mid = self.reserves.mid_price
        if mid is None or self.swap_executed_price == 0:
            return None
        return mid / self.swap_executed_price

    def render(self) -> str:
        r = self.reserves
        lines = [
            "Independent-reserves probe (Pinax /v1/svm/balances)",
            f"  pool                 {self.amm_pool}",
            f"  base mint            {self.base_mint}",
            f"  swap block           {self.swap_block}   (notional {self.swap_notional_sol:.4f} SOL)",
            f"  reserves snapshot    block {r.snapshot_block}  ({r.snapshot_time})",
            f"  base_reserve         {r.base_reserve}",
            f"  quote_reserve (SOL)  {r.quote_reserve}",
            f"  reserve-implied mid  {r.mid_price}  (SOL/token)",
            f"  swap executed price  {self.swap_executed_price}  (SOL/token)",
            f"  implied / executed   {self.implied_over_executed}",
            f"  stale_blocks         {r.stale_blocks}  (~{r.stale_seconds_estimate} s)",
            "  historical-by-block  NOT supported for SVM balances — snapshot is latest-only.",
        ]
        return "\n".join(lines)


def _executed_price(row: dict[str, Any]) -> Decimal:
    """Executed price in quote per base (SOL per token) for a WSOL-paired swap row."""
    if row["input_mint"] == WSOL:
        return Decimal(str(row["input_value"])) / Decimal(str(row["output_value"]))
    return Decimal(str(row["output_value"])) / Decimal(str(row["input_value"]))


def _sol_notional(row: dict[str, Any]) -> Decimal:
    leg = row["input_value"] if row["input_mint"] == WSOL else row["output_value"]
    return Decimal(str(leg))


def run_probe(
    rest: PinaxRestClient | None = None, *, protocol: str = "pumpfun_amm", scan_limit: int = 300
) -> ProbeReport:
    """Fetch recent swaps, pick the busiest ``protocol`` WSOL pool, and compare reserves vs price.

    Live network call — gated on ``PINAX_API_KEY``. Raises ``RuntimeError`` if no suitable pool is
    found in the scanned window.
    """
    rest = rest or PinaxRestClient()
    payload = rest.get_json(
        "/v1/svm/swaps", {"network": "solana", "limit": scan_limit}, use_cache=False
    )
    rows = [
        r
        for r in (payload.get("data") or [])
        if isinstance(r, dict)
        and r.get("protocol") == protocol
        and WSOL in (r.get("input_mint"), r.get("output_mint"))
        and r.get("input_value")
        and r.get("output_value")
    ]
    if not rows:
        raise RuntimeError(f"no {protocol} WSOL swaps in the last {scan_limit} rows")
    pick = max(rows, key=_sol_notional)
    pool = pick["amm_pool"]
    base_mint = pick["output_mint"] if pick["input_mint"] == WSOL else pick["input_mint"]

    reserves = ReservesClient(rest).get_pool_reserves(
        pool, as_of_block=pick["block_num"], use_cache=False
    )
    return ProbeReport(
        amm_pool=pool,
        base_mint=base_mint,
        swap_block=int(pick["block_num"]),
        swap_notional_sol=_sol_notional(pick),
        swap_executed_price=_executed_price(pick),
        reserves=reserves,
    )


def main() -> None:  # pragma: no cover - manual/live entry point
    print(run_probe().render())


if __name__ == "__main__":  # pragma: no cover
    main()
