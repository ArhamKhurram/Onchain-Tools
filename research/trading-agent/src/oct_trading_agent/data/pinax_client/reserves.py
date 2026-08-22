"""Independent pool reserves via Pinax ``/v1/svm/balances`` — the depth anchor for calibration.

The first real calibration (PROGRESS 2026-08-22 (h)) fit pool reserves *to the swap sequence*
(a self-consistency fit) and so validated the constant-product **curve law** but NOT absolute
depth: trades were small vs the (fitted) pool, so large-order slippage stayed weakly identified.
This module closes that gap by sourcing reserves **independently** of the swaps — the actual
on-chain token balances of the pool's two vault accounts — so a calibration run can test the sim's
depth/slippage against real reserves instead of fitted ones.

A pool's reserves ARE the token balances of its two vault token accounts. For the pump.fun AMM
(``pAMMBay…``, the 62.5%-of-volume calibration target) those vaults are owned directly by the
``amm_pool`` account, so ``/v1/svm/balances?owner=<amm_pool>`` returns exactly the two reserve rows
(verified live 2026-08-22). For AMMs whose vaults sit under a separate authority PDA, pass the vault
token accounts explicitly via ``vault_accounts``.

THE KEY FINDING — historical-by-block is NOT supported for SVM balances
----------------------------------------------------------------------
``/v1/svm/balances`` has **no** ``block``/``block_num``/``time`` parameter (OpenAPI, verified live:
passing ``block_num`` is silently ignored and the LATEST snapshot is returned unchanged). SVM has no
historical-balances variant — only ``/v1/evm/balances/historical`` exists, and only for EVM. So this
client returns the **latest** reserve snapshot and flags its staleness against the block you asked
for (``requested_block`` → ``stale_blocks``). It **never fabricates** an as-of-block reserve.

What that means for calibration (a real finding, recorded in the PR):

* For a **recently active** pool the latest snapshot is within a block or two of the swap, so the
  independent reserves are usable as-is — the reserves-vs-implied-mid sanity check below holds to
  well within fees.
* For a **historical / now-dead** pool (most pump.fun tokens) the latest balance is dust and bears
  no relation to the reserve at the swap's block. Independent absolute depth for such pools is
  **not recoverable from this endpoint** — the calibration must fall back to the self-consistency
  fit for depth there, or capture reserves live (within a few blocks of each swap) going forward.

Everything network-touching flows through the shared :class:`~.rest.PinaxRestClient` (throttled,
disk-cached, retrying), so the anchor lookup is polite and reruns cost nothing. Every unit test runs
against captured fixtures — nothing here touches the network. Live use is gated on ``PINAX_API_KEY``.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from .decode import WSOL
from .rest import PinaxRestClient

# Pinax REST paths this module reads.
PINAX_POOLS_REST_PATH = "/v1/svm/pools"
PINAX_BALANCES_REST_PATH = "/v1/svm/balances"

# Solana produces a slot roughly every ~400 ms; used only to render a staleness estimate in seconds
# when a snapshot block is compared to a requested block. Purely informational.
SOLANA_SLOT_SECONDS = 0.4


def _to_decimal(value: object) -> Decimal | None:
    """Coerce a JSON number/string to ``Decimal`` via its text form (no float drift). ``None``-safe."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, Decimal):
        return value
    if isinstance(value, (int, float, str)):
        try:
            return Decimal(str(value))
        except (ValueError, ArithmeticError):
            return None
    return None


def _reserve_from_balance_row(row: Mapping[str, Any]) -> Decimal | None:
    """UI-unit reserve for a balance row.

    Prefers the exact ``amount`` (raw base units, string) scaled by ``decimals`` — the server's
    ``value`` float is ``amount / 10**decimals`` and carries float error. Falls back to ``value``
    only when ``amount``/``decimals`` are missing.
    """
    amount = _to_decimal(row.get("amount"))
    decimals = row.get("decimals")
    if amount is not None and isinstance(decimals, int) and decimals >= 0:
        return amount / (Decimal(10) ** decimals)
    return _to_decimal(row.get("value"))


@dataclass(frozen=True)
class PoolMeta:
    """Pool metadata from ``/v1/svm/pools`` — mints + decimals, oriented base↔quote.

    The row's ``input``/``output`` legs are NOT normalized (either can be the quote), so
    :meth:`from_pool_row` identifies the quote leg by matching ``quote_mint`` (WSOL by default) and
    puts the other leg in ``base_*``. The pools row carries no vault accounts — reserves come from
    :class:`ReservesClient`.
    """

    amm_pool: str
    base_mint: str
    quote_mint: str
    base_decimals: int | None
    quote_decimals: int | None
    protocol: str | None = None

    @classmethod
    def from_pool_row(cls, row: Mapping[str, Any], *, quote_mint: str = WSOL) -> PoolMeta | None:
        """Build from one ``/v1/svm/pools`` row, or ``None`` if it isn't a ``quote_mint`` pair."""
        amm_pool = row.get("amm_pool")
        in_mint = row.get("input_mint")
        out_mint = row.get("output_mint")
        if not isinstance(amm_pool, str) or not isinstance(in_mint, str) or not isinstance(out_mint, str):
            return None
        in_dec = row.get("input_decimals") if isinstance(row.get("input_decimals"), int) else None
        out_dec = row.get("output_decimals") if isinstance(row.get("output_decimals"), int) else None
        protocol = row.get("protocol") if isinstance(row.get("protocol"), str) else None
        if out_mint == quote_mint:
            return cls(amm_pool, in_mint, out_mint, in_dec, out_dec, protocol)
        if in_mint == quote_mint:
            return cls(amm_pool, out_mint, in_mint, out_dec, in_dec, protocol)
        return None  # token↔token pool — no quote leg we track


@dataclass(frozen=True)
class PoolReserves:
    """Independent reserves for one pool, as-of the latest available snapshot.

    ``base_reserve``/``quote_reserve`` are UI-unit ``Decimal`` reserves, or ``None`` when the vault
    balance for that leg was absent from the response (explicit missingness — never fabricated,
    never silently zero). ``snapshot_block`` is the block the balances were current at;
    ``requested_block`` is the block the caller wanted (a swap's block), and ``stale_blocks`` is the
    signed gap ``snapshot_block - requested_block`` (positive ⇒ snapshot is newer than the swap —
    the normal case, since balances are latest-only).
    """

    amm_pool: str
    base_mint: str
    quote_mint: str
    base_reserve: Decimal | None
    quote_reserve: Decimal | None
    base_account: str | None = None
    quote_account: str | None = None
    snapshot_block: int | None = None
    snapshot_time: datetime | None = None
    requested_block: int | None = None
    # SVM balances are always latest-only; kept explicit so a consumer never assumes as-of-block.
    historical_supported: bool = False

    @property
    def is_complete(self) -> bool:
        """True iff both legs have a strictly-positive reserve (usable as a depth anchor)."""
        return (
            self.base_reserve is not None
            and self.quote_reserve is not None
            and self.base_reserve > 0
            and self.quote_reserve > 0
        )

    @property
    def mid_price(self) -> Decimal | None:
        """Reserve-implied mid, quote per base (SOL per token). ``None`` unless both legs present."""
        if self.is_complete:
            assert self.quote_reserve is not None and self.base_reserve is not None
            return self.quote_reserve / self.base_reserve
        return None

    @property
    def stale_blocks(self) -> int | None:
        """Signed ``snapshot_block - requested_block``; ``None`` if either is unknown."""
        if self.snapshot_block is None or self.requested_block is None:
            return None
        return self.snapshot_block - self.requested_block

    @property
    def stale_seconds_estimate(self) -> float | None:
        """Rough staleness in seconds (``|stale_blocks| * ~0.4 s``); ``None`` if not computable."""
        gap = self.stale_blocks
        return None if gap is None else abs(gap) * SOLANA_SLOT_SECONDS

    def is_fresh(self, *, max_blocks: int) -> bool:
        """True iff complete AND the snapshot is within ``max_blocks`` of the requested block.

        With no ``requested_block`` there is nothing to be stale against, so freshness is just
        completeness.
        """
        if not self.is_complete:
            return False
        gap = self.stale_blocks
        return True if gap is None else abs(gap) <= max_blocks


class ReservesClient:
    """Fetch independent pool reserves (and metadata) via the shared Pinax REST client.

    The ``rest`` client carries the throttle, disk cache and retry ladder, so this stays a thin
    mapping layer. ``quote_mint`` defaults to WSOL — the quote leg of virtually every new-pair pool.
    """

    def __init__(
        self,
        rest: PinaxRestClient | None = None,
        *,
        network: str = "solana",
        quote_mint: str = WSOL,
    ) -> None:
        self._rest = rest or PinaxRestClient()
        self._network = network
        self._quote_mint = quote_mint

    # -- metadata -------------------------------------------------------------------------------

    def get_pool_meta(self, amm_pool: str, *, use_cache: bool = True) -> PoolMeta | None:
        """Resolve a pool's base/quote mints + decimals, or ``None`` if unknown / not a quote pair."""
        payload = self._rest.get_json(
            PINAX_POOLS_REST_PATH,
            {"network": self._network, "amm_pool": amm_pool, "limit": 5},
            use_cache=use_cache,
        )
        for row in payload.get("data") or []:
            if isinstance(row, Mapping) and row.get("amm_pool") == amm_pool:
                meta = PoolMeta.from_pool_row(row, quote_mint=self._quote_mint)
                if meta is not None:
                    return meta
        return None

    # -- reserves -------------------------------------------------------------------------------

    def get_pool_reserves(
        self,
        amm_pool: str,
        *,
        base_mint: str | None = None,
        quote_mint: str | None = None,
        as_of_block: int | None = None,
        vault_accounts: Iterable[str] | None = None,
        meta: PoolMeta | None = None,
        use_cache: bool = True,
    ) -> PoolReserves:
        """Return the pool's ``(base_reserve, quote_reserve)`` as-of the latest available snapshot.

        Historical-by-block is NOT supported (see module docstring): ``as_of_block`` is recorded as
        ``requested_block`` and used only to compute ``stale_blocks`` against the snapshot actually
        returned — it is never sent as a filter, because the endpoint ignores it.

        Resolution:

        * ``base_mint``/``quote_mint`` explicit → used directly. Else resolved from ``meta`` (or a
          fresh :meth:`get_pool_meta` call). If they still can't be resolved, both reserves come
          back ``None`` (explicit missingness).
        * ``vault_accounts`` given → balances are queried by ``token_account`` (for AMMs whose vaults
          sit under a separate authority). Otherwise queried by ``owner=amm_pool`` (works for the
          pump.fun AMM, whose vaults are the pool account's own token accounts).
        """
        quote = quote_mint or self._quote_mint
        if base_mint is None:
            resolved = meta or self.get_pool_meta(amm_pool, use_cache=use_cache)
            if resolved is not None:
                base_mint = resolved.base_mint
                quote = quote_mint or resolved.quote_mint

        params: dict[str, Any] = {"network": self._network, "limit": 50}
        if vault_accounts is not None:
            accounts = list(vault_accounts)
            if not accounts:
                return self._empty(amm_pool, base_mint, quote, as_of_block)
            # Pinax accepts a comma-separated list for multi-value filters.
            params["token_account"] = ",".join(accounts)
        else:
            params["owner"] = amm_pool

        payload = self._rest.get_json(PINAX_BALANCES_REST_PATH, params, use_cache=use_cache)
        rows = [r for r in (payload.get("data") or []) if isinstance(r, Mapping)]

        base_row = _pick_row(rows, base_mint) if base_mint is not None else None
        quote_row = _pick_row(rows, quote)

        base_reserve = _reserve_from_balance_row(base_row) if base_row is not None else None
        quote_reserve = _reserve_from_balance_row(quote_row) if quote_row is not None else None

        snapshot_block, snapshot_time = _snapshot_of(base_row, quote_row)

        return PoolReserves(
            amm_pool=amm_pool,
            base_mint=base_mint or "",
            quote_mint=quote,
            base_reserve=base_reserve,
            quote_reserve=quote_reserve,
            base_account=str(base_row.get("account")) if base_row and base_row.get("account") else None,
            quote_account=str(quote_row.get("account")) if quote_row and quote_row.get("account") else None,
            snapshot_block=snapshot_block,
            snapshot_time=snapshot_time,
            requested_block=as_of_block,
            historical_supported=False,
        )

    def _empty(
        self, amm_pool: str, base_mint: str | None, quote_mint: str, as_of_block: int | None
    ) -> PoolReserves:
        return PoolReserves(
            amm_pool=amm_pool,
            base_mint=base_mint or "",
            quote_mint=quote_mint,
            base_reserve=None,
            quote_reserve=None,
            requested_block=as_of_block,
            historical_supported=False,
        )

    # -- anchor lookup --------------------------------------------------------------------------

    def reserve_anchors(
        self,
        refs: Iterable[tuple[str, int]],
        *,
        use_cache: bool = True,
    ) -> dict[tuple[str, int], PoolReserves]:
        """Independent reserve anchors for a list of swaps, keyed by ``(amm_pool, block)``.

        ``refs`` is an iterable of ``(amm_pool, block)`` — typically each swap's pool + ``slot``.
        One balances call is made per UNIQUE pool (balances are latest-only, so every block on the
        same pool shares that single snapshot), then each requested ``(pool, block)`` gets a
        :class:`PoolReserves` carrying the shared snapshot and its own ``stale_blocks``. Throttle +
        disk cache come from the underlying REST client, so this is polite and idempotent.

        A calibration run swaps its fitted reserves for these where ``is_fresh(...)`` holds and falls
        back to the self-consistency fit elsewhere — the staleness flag makes that boundary explicit.
        """
        ref_list = list(refs)
        pools = {pool for pool, _ in ref_list}
        # One latest snapshot per pool (reserves + resolved mints).
        by_pool: dict[str, PoolReserves] = {
            pool: self.get_pool_reserves(pool, use_cache=use_cache) for pool in pools
        }
        out: dict[tuple[str, int], PoolReserves] = {}
        for pool, block in ref_list:
            snap = by_pool[pool]
            # Re-stamp the shared snapshot with this ref's requested block.
            out[(pool, block)] = PoolReserves(
                amm_pool=snap.amm_pool,
                base_mint=snap.base_mint,
                quote_mint=snap.quote_mint,
                base_reserve=snap.base_reserve,
                quote_reserve=snap.quote_reserve,
                base_account=snap.base_account,
                quote_account=snap.quote_account,
                snapshot_block=snap.snapshot_block,
                snapshot_time=snap.snapshot_time,
                requested_block=block,
                historical_supported=False,
            )
        return out


def _pick_row(rows: list[Mapping[str, Any]], mint: str) -> Mapping[str, Any] | None:
    """The balance row for ``mint`` (largest reserve if the vault appears more than once)."""
    matches = [r for r in rows if r.get("mint") == mint]
    if not matches:
        return None
    return max(matches, key=lambda r: _reserve_from_balance_row(r) or Decimal(0))


def _snapshot_of(
    base_row: Mapping[str, Any] | None, quote_row: Mapping[str, Any] | None
) -> tuple[int | None, datetime | None]:
    """Snapshot block + time = the freshest ``last_update_*`` across the two vault rows."""
    block: int | None = None
    ts: int | None = None
    for row in (base_row, quote_row):
        if row is None:
            continue
        b = row.get("last_update_block_num")
        if isinstance(b, int) and (block is None or b > block):
            block = b
        t = row.get("last_update_timestamp")
        if isinstance(t, (int, float)) and (ts is None or int(t) > ts):
            ts = int(t)
    when = datetime.fromtimestamp(ts, tz=UTC) if ts is not None else None
    return block, when


__all__ = [
    "PoolMeta",
    "PoolReserves",
    "ReservesClient",
    "PINAX_POOLS_REST_PATH",
    "PINAX_BALANCES_REST_PATH",
    "SOLANA_SLOT_SECONDS",
]
