"""Resumable, venue-preserving swap dataset — the substrate for the token-count training ladder.

The Phase-1 loaders pull ONE network-wide page of ``/v1/svm/swaps`` and stop (``eval/data``,
``agent/train_data``). That caps a run at the handful of tokens one page happens to carry (~<1k) and
re-pulls every session. Training on 10 → 100 → 1,000 → 10,000 → 100,000 tokens (the coordinator's
ladder) needs a **persisted, resumable, columnar accumulator** that grows across many pages and many
sessions without re-pulling — this module is it.

Why not the append-only tape log (:mod:`oct_trading_agent.data.log`)? That log is decoded-``TapeEvent``
rows partitioned by DATE and — critically — its schema drops the swap's ``protocol`` (venue) tag,
which the multi-venue env *requires* to pick the right fill curve. So this dataset keeps the **raw
Pinax swap rows** (venue included), partitioned by **pool** (the ladder groups by token), deduped on
the swap's identity so overlapping pulls are idempotent — the same idempotency guarantee the tape log
gives, kept at the raw-row level.

Layout on disk::

    <root>/manifest.json            # cursor + counts for resumability
    <root>/pools/<amm_pool>.parquet # one token's raw swap rows (deduped, venue-tagged)

The pure core (:meth:`MarketSwapDataset.append_rows`, dedup, manifest, :meth:`load_token_tapes`) takes
already-fetched rows, so the whole accumulator is unit-tested with no network. :func:`build_dataset`
wires a live :class:`~oct_trading_agent.data.pinax_client.rest.PinaxRestClient` for a real backfill;
that path is network-gated on ``PINAX_API_KEY`` and never unit-tested.

Scale note (a real finding, not a limit hidden): paginated REST tops out where the plan's page budget
does — good for the 10 / 100 / 1,000 rungs and into the low thousands, but 10k / 100k tokens is a
**bulk-historical** job for the Substreams gRPC firehose (``solana.substreams.pinax.network:443``,
bearer = raw ``PINAX_API_KEY``, pkg ``dex-swaps-v0.5.2.spkg``). This dataset's on-disk format is the
same target a gRPC backfill would write into, so the ladder's top rungs are a data-collection job, not
a code change.
"""

from __future__ import annotations

import json
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import polars as pl

from oct_trading_agent.data.pinax_client.decode import WSOL, decode_swap_row
from oct_trading_agent.eval.data import TokenTape

__all__ = [
    "MarketSwapDataset",
    "DatasetManifest",
    "build_dataset",
    "RAW_ROW_SCHEMA",
    "SUPPORTED_VENUES",
]

# The venues the multi-venue env can actually fill (a superset check is the registry's job; this is
# the pull filter so the dataset does not accumulate router/unsupported rows it will only skip later).
SUPPORTED_VENUES: tuple[str, ...] = (
    "pumpfun",
    "pumpfun_amm",
    "raydium_amm_v4",
    "raydium_cpmm",
    "meteora_daam",
    "orca_whirlpool",
    "raydium_clmm",
    "meteora_dlmm",
)

# The raw Pinax swap-row fields we persist — exactly what ``decode_swap_row`` reads, plus the venue
# (``protocol``) and pool the tape-log schema drops. Amounts stay the server's UI-unit floats.
RAW_ROW_SCHEMA: dict[str, pl.DataType] = {
    "amm_pool": pl.String(),
    "protocol": pl.String(),
    "signature": pl.String(),
    "signer": pl.String(),
    "block_num": pl.Int64(),
    "timestamp": pl.Int64(),
    "transaction_index": pl.Int64(),
    "instruction_index": pl.Int64(),
    "input_mint": pl.String(),
    "output_mint": pl.String(),
    "input_value": pl.Float64(),
    "output_value": pl.Float64(),
}

_KEY_COLUMNS = ["signature", "transaction_index", "instruction_index"]


def _first_signer(row: Mapping[str, Any]) -> str | None:
    signer = row.get("signer")
    if isinstance(signer, str) and signer:
        return signer
    signers = row.get("signers")
    if isinstance(signers, list) and signers and isinstance(signers[0], str):
        return signers[0]
    for key in ("user", "fee_payer"):
        v = row.get(key)
        if isinstance(v, str) and v:
            return v
    return None


def _num(value: object) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def _int(value: object) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


def normalise_raw_row(row: Mapping[str, Any]) -> dict[str, Any] | None:
    """Project a raw Pinax swap row onto :data:`RAW_ROW_SCHEMA`, or ``None`` if it is unusable.

    Keeps only WSOL-quoted rows with both value legs and a signature — the same admissibility
    ``decode_swap_row`` enforces, applied at ingest so the dataset never stores rows it cannot decode.
    """
    pool = row.get("amm_pool")
    protocol = row.get("protocol")
    signature = row.get("signature")
    if not isinstance(pool, str) or not pool:
        return None
    if not isinstance(protocol, str) or not protocol:
        return None
    if not isinstance(signature, str) or not signature:
        return None
    in_mint, out_mint = row.get("input_mint"), row.get("output_mint")
    if not (isinstance(in_mint, str) and isinstance(out_mint, str)):
        return None
    if WSOL not in (in_mint, out_mint) or in_mint == out_mint:
        return None
    block_num, timestamp = _int(row.get("block_num")), _int(row.get("timestamp"))
    in_val, out_val = _num(row.get("input_value")), _num(row.get("output_value"))
    signer = _first_signer(row)
    if block_num is None or timestamp is None or in_val is None or out_val is None:
        return None
    if signer is None or in_val <= 0 or out_val <= 0:
        return None
    return {
        "amm_pool": pool,
        "protocol": protocol,
        "signature": signature,
        "signer": signer,
        "block_num": block_num,
        "timestamp": timestamp,
        "transaction_index": _int(row.get("transaction_index")) or 0,
        "instruction_index": _int(row.get("instruction_index")) or 0,
        "input_mint": in_mint,
        "output_mint": out_mint,
        "input_value": in_val,
        "output_value": out_val,
    }


@dataclass
class DatasetManifest:
    """Resumability cursor + counts for a :class:`MarketSwapDataset`."""

    network: str = "solana"
    protocols: list[str] = field(default_factory=list)
    pages_pulled: int = 0
    total_rows: int = 0
    pool_row_counts: dict[str, int] = field(default_factory=dict)
    updated_at: str | None = None

    @property
    def n_pools(self) -> int:
        return len(self.pool_row_counts)

    def to_json(self) -> dict[str, Any]:
        return {
            "network": self.network,
            "protocols": self.protocols,
            "pages_pulled": self.pages_pulled,
            "total_rows": self.total_rows,
            "pool_row_counts": self.pool_row_counts,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_json(cls, data: Mapping[str, Any]) -> DatasetManifest:
        return cls(
            network=str(data.get("network", "solana")),
            protocols=list(data.get("protocols", [])),
            pages_pulled=int(data.get("pages_pulled", 0)),
            total_rows=int(data.get("total_rows", 0)),
            pool_row_counts=dict(data.get("pool_row_counts", {})),
            updated_at=data.get("updated_at"),
        )


class MarketSwapDataset:
    """A resumable, pool-partitioned, venue-tagged raw-swap accumulator on disk.

    Construct with a ``root`` directory. :meth:`append_rows` merges new rows idempotently (dedup on
    swap identity); :meth:`load_token_tapes` reads the cache back into decoded :class:`TokenTape`\\ s
    ready for the env. Both are pure (no network) — a live backfill calls :meth:`append_rows` with
    rows a :class:`PinaxRestClient` fetched (see :func:`build_dataset`).
    """

    def __init__(self, root: Path | str) -> None:
        self._root = Path(root)
        self._pools_dir = self._root / "pools"
        self._manifest_path = self._root / "manifest.json"

    @property
    def root(self) -> Path:
        return self._root

    def _pool_file(self, pool: str) -> Path:
        # Pool addresses are base58 (filesystem-safe); keep them verbatim for a legible cache.
        return self._pools_dir / f"{pool}.parquet"

    def load_manifest(self) -> DatasetManifest:
        if self._manifest_path.exists():
            return DatasetManifest.from_json(json.loads(self._manifest_path.read_text("utf-8")))
        return DatasetManifest()

    def _write_manifest(self, manifest: DatasetManifest) -> None:
        manifest.updated_at = datetime.now(UTC).isoformat()
        self._root.mkdir(parents=True, exist_ok=True)
        self._manifest_path.write_text(json.dumps(manifest.to_json(), indent=2), "utf-8")

    def append_rows(self, rows: Iterable[Mapping[str, Any]], *, pages_pulled: int = 0) -> int:
        """Merge ``rows`` into the per-pool cache, deduped on swap identity. Returns NEW-row count.

        Overlapping pulls are idempotent: a swap already stored (same signature + tx/ix index) is not
        re-added. Updates the manifest's per-pool counts and (if given) advances the page cursor.
        """
        normalised = [n for r in rows if (n := normalise_raw_row(r)) is not None]
        by_pool: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in normalised:
            by_pool[row["amm_pool"]].append(row)

        manifest = self.load_manifest()
        new_total = 0
        for pool, pool_rows in by_pool.items():
            incoming = pl.DataFrame(pool_rows, schema=RAW_ROW_SCHEMA)
            path = self._pool_file(pool)
            if path.exists():
                existing = pl.read_parquet(path)
                before = existing.height
                merged = pl.concat([existing, incoming]).unique(
                    subset=_KEY_COLUMNS, keep="first"
                )
            else:
                before = 0
                merged = incoming.unique(subset=_KEY_COLUMNS, keep="first")
            merged = merged.sort(["block_num", "transaction_index", "instruction_index"])
            self._pools_dir.mkdir(parents=True, exist_ok=True)
            merged.write_parquet(path)
            gained = merged.height - before
            new_total += gained
            manifest.pool_row_counts[pool] = merged.height

        manifest.total_rows = int(sum(manifest.pool_row_counts.values()))
        manifest.protocols = sorted(
            {*manifest.protocols, *{r["protocol"] for r in normalised}}
        )
        if pages_pulled:
            manifest.pages_pulled += pages_pulled
        self._write_manifest(manifest)
        return new_total

    def load_token_tapes(
        self,
        *,
        max_tokens: int | None = None,
        min_swaps: int = 24,
        protocols: Sequence[str] | None = None,
    ) -> list[TokenTape]:
        """Decode the cache into :class:`TokenTape`\\ s (oldest-first), venue tag preserved.

        Keeps pools with ``>= min_swaps`` decodable WSOL-paired swaps, optionally filtered to
        ``protocols``. Returns oldest-first (by earliest print) so a downstream time-holdout on tokens
        is well-defined; caps at ``max_tokens`` (the ladder rung size).
        """
        if not self._pools_dir.exists():
            return []
        wanted = set(protocols) if protocols else None
        tapes: list[TokenTape] = []
        for path in sorted(self._pools_dir.glob("*.parquet")):
            frame = pl.read_parquet(path)
            if frame.height < min_swaps:
                continue
            rows = frame.to_dicts()
            protocol = _majority_protocol(rows)
            if protocol is None or (wanted is not None and protocol not in wanted):
                continue
            tracked = _tracked_mint(rows)
            if tracked is None:
                continue
            swaps = []
            for row in rows:
                event = decode_swap_row(row, tracked, quote_mint=WSOL)
                if event is not None:
                    swaps.append(event.model_copy(update={"protocol": row.get("protocol")}))
            if len(swaps) < min_swaps:
                continue
            swaps.sort(key=lambda s: (s.slot, s.block_time))
            tapes.append(
                TokenTape(mint=tracked, swaps=swaps, source=f"dataset:{path.stem[:8]}...")
            )
        tapes.sort(key=lambda t: min(e.block_time for e in t.swaps))
        return tapes[:max_tokens] if max_tokens is not None else tapes


def _majority_protocol(rows: Sequence[Mapping[str, Any]]) -> str | None:
    counts: dict[str, int] = defaultdict(int)
    for row in rows:
        p = row.get("protocol")
        if isinstance(p, str):
            counts[p] += 1
    if not counts:
        return None
    return max(counts.items(), key=lambda kv: kv[1])[0]


def _tracked_mint(rows: Sequence[Mapping[str, Any]]) -> str | None:
    for row in rows:
        for leg in (row.get("input_mint"), row.get("output_mint")):
            if isinstance(leg, str) and leg and leg != WSOL:
                return leg
    return None


def build_dataset(
    root: Path | str,
    *,
    protocols: Sequence[str] = ("pumpfun_amm",),
    target_tokens: int = 100,
    max_pages: int = 200,
    min_swaps: int = 24,
    network: str = "solana",
    page_limit: int = 500,
    cache_dir: Path | None = None,
) -> DatasetManifest:  # pragma: no cover - live/network
    """Backfill ``root`` with paginated ``/v1/svm/swaps`` until ``target_tokens`` qualifying pools or
    ``max_pages`` (whichever first). RESUMABLE: continues from the manifest's page cursor, so a second
    call extends the same cache. Network-gated on ``PINAX_API_KEY``.

    ``protocols`` filters the venues accumulated (each page is network-wide; rows off other venues are
    dropped at ingest). Returns the final manifest — inspect ``n_pools`` for where the pull landed and
    ``pages_pulled`` for how far the REST cursor reached (the honest scale-limit signal).
    """
    from oct_trading_agent.data.pinax_client.rest import PinaxRestClient

    dataset = MarketSwapDataset(root)
    client = PinaxRestClient(cache_dir=cache_dir)
    wanted = set(protocols)
    start_page = dataset.load_manifest().pages_pulled + 1

    for page in range(start_page, start_page + max_pages):
        payload = client.get_swaps(
            network=network, limit=page_limit, page=page, use_cache=cache_dir is not None
        )
        rows = [
            r for r in (payload.get("data") or [])
            if isinstance(r, dict) and r.get("protocol") in wanted
        ]
        dataset.append_rows(rows, pages_pulled=1)
        qualifying = sum(1 for c in dataset.load_manifest().pool_row_counts.values() if c >= min_swaps)
        if qualifying >= target_tokens:
            break
        if not (payload.get("data") or []):
            break  # firehose exhausted this window
    return dataset.load_manifest()
