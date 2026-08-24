"""LiveCaptureEngine tests — new-token detection, migration transition, dataset writes.

Fully offline: the engine is a synchronous state machine fed synthetic WS frames (the shape
``PinaxWebSocketClient.stream_frames`` yields), so no socket and no credentials are involved.
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from typing import Any

from oct_trading_agent.data.capture import (
    BONDING_PROTOCOL,
    LiveCaptureConfig,
    LiveCaptureEngine,
    MintPhase,
    MintTracker,
    ws_event_to_raw_row,
)
from oct_trading_agent.data.dataset import MarketSwapDataset
from oct_trading_agent.data.pinax_client.decode import WSOL

FRESH = "FreshBondingMint000000000000000000000000000"
FRESH_POOL = "FreshBondingPool00000000000000000000000000"
OLD = "AlreadyMigratedMint0000000000000000000000000"
OLD_POOL = "AlreadyMigratedPool000000000000000000000000"
_BASE_DECIMALS = 6


def _event(
    mint: str,
    pool: str,
    *,
    protocol: str,
    side: str,
    i: int,
) -> dict[str, Any]:
    """A raw WS event. BUY = WSOL in / token out; amounts are RAW base-unit strings."""
    if side == "buy":
        in_mint, out_mint = WSOL, mint
        in_amt, out_amt = "50000000", str(1_200_000_000 + i)  # 0.05 SOL in, ~1200 tokens out
    else:
        in_mint, out_mint = mint, WSOL
        in_amt, out_amt = str(1_000_000_000 + i), "40000000"  # ~1000 tokens in, 0.04 SOL out
    return {
        "input_mint": in_mint,
        "output_mint": out_mint,
        "input_amount": in_amt,
        "output_amount": out_amt,
        "protocol": protocol,
        "amm_pool": pool,
        "signature": f"sig-{mint[:6]}-{i}",
        "signers": [f"wallet{i % 5}"],
    }


def _frame(events: list[dict[str, Any]], *, block_num: int, ts: int = 1_787_408_924) -> dict[str, Any]:
    return {
        "network": "solana",
        "table": "swaps",
        "block_num": block_num,
        "timestamp_seconds": ts + block_num,
        "events": events,
    }


# --------------------------------------------------------------------------- MintTracker


def test_tracker_flags_first_seen_bonding_as_fresh() -> None:
    tracker = MintTracker()
    assert tracker.observe(FRESH, BONDING_PROTOCOL) is MintPhase.NEW_FRESH
    assert tracker.is_tracked(FRESH)
    # A second bonding swap on the same mint stays TRACKED (still pre-migration).
    assert tracker.observe(FRESH, BONDING_PROTOCOL) is MintPhase.TRACKED


def test_tracker_rejects_first_seen_on_amm_as_not_fresh() -> None:
    tracker = MintTracker()
    assert tracker.observe(OLD, "pumpfun_amm") is MintPhase.NOT_FRESH
    assert not tracker.is_tracked(OLD)
    # Every later swap on a not-fresh mint is skipped (unknown-age, not captured).
    assert tracker.observe(OLD, "raydium_amm_v4") is MintPhase.SKIP


def test_tracker_marks_migration_once_then_post_migration() -> None:
    tracker = MintTracker()
    tracker.observe(FRESH, BONDING_PROTOCOL)  # NEW_FRESH
    assert tracker.observe(FRESH, "pumpfun_amm") is MintPhase.MIGRATION
    assert FRESH in tracker.migrated_mints
    # Subsequent AMM swaps are POST_MIGRATION (still captured, but migration counted once).
    assert tracker.observe(FRESH, "pumpfun_amm") is MintPhase.POST_MIGRATION
    assert tracker.observe(FRESH, "raydium_amm_v4") is MintPhase.POST_MIGRATION


# --------------------------------------------------------------------------- row projection


def test_ws_event_to_raw_row_scales_and_carries_venue() -> None:
    ev = _event(FRESH, FRESH_POOL, protocol=BONDING_PROTOCOL, side="buy", i=0)
    row = ws_event_to_raw_row(ev, block_num=1000, timestamp=1_787_000_000, base_decimals=_BASE_DECIMALS)
    assert row is not None
    assert row["protocol"] == BONDING_PROTOCOL
    assert row["amm_pool"] == FRESH_POOL
    # WSOL leg scaled by 1e9, token leg by 1e6.
    assert row["input_value"] == float(Decimal("50000000") / Decimal(10**9))
    assert row["output_value"] == float(Decimal("1200000000") / Decimal(10**6))


def test_ws_event_to_raw_row_rejects_non_quote_pair() -> None:
    ev = _event(FRESH, FRESH_POOL, protocol=BONDING_PROTOCOL, side="buy", i=0)
    ev["input_mint"] = "SomeOtherMintNotWsol00000000000000000000000"
    assert ws_event_to_raw_row(ev, block_num=1, timestamp=1, base_decimals=_BASE_DECIMALS) is None


# --------------------------------------------------------------------------- engine + dataset


def test_engine_captures_only_fresh_bonding_token(tmp_path: Path) -> None:
    ds = MarketSwapDataset(tmp_path)
    engine = LiveCaptureEngine(ds, LiveCaptureConfig(flush_every=1000))

    events = [
        _event(FRESH, FRESH_POOL, protocol=BONDING_PROTOCOL, side="buy", i=0),
        _event(OLD, OLD_POOL, protocol="pumpfun_amm", side="buy", i=0),  # already migrated -> skipped
    ]
    engine.ingest_frame(_frame(events, block_num=1))
    engine.flush()

    assert engine.stats.fresh_tokens == 1
    assert engine.stats.swaps_captured == 1  # only the fresh bonding token's swap
    manifest = ds.load_manifest()
    assert manifest.pool_row_counts.get(FRESH_POOL) == 1
    assert OLD_POOL not in manifest.pool_row_counts


def test_engine_captures_through_migration(tmp_path: Path) -> None:
    ds = MarketSwapDataset(tmp_path)
    engine = LiveCaptureEngine(ds, LiveCaptureConfig(flush_every=1000))

    # Bonding-curve swaps, then the same mint migrates to pumpfun_amm mid-session.
    for i in range(3):
        engine.ingest_frame(
            _frame([_event(FRESH, FRESH_POOL, protocol=BONDING_PROTOCOL, side="buy", i=i)], block_num=i)
        )
    engine.ingest_frame(
        _frame([_event(FRESH, "MigratedPool00000000000000000000000000000", protocol="pumpfun_amm",
                       side="buy", i=99)], block_num=10)
    )
    engine.flush()

    assert engine.stats.fresh_tokens == 1
    assert engine.stats.migrations == 1
    assert engine.stats.swaps_captured == 4  # 3 bonding + 1 migration swap, all captured
    protocols = set(ds.load_manifest().protocols)
    assert {"pumpfun", "pumpfun_amm"} <= protocols  # both venues preserved on disk


def test_engine_is_idempotent_across_reruns(tmp_path: Path) -> None:
    ds = MarketSwapDataset(tmp_path)
    frames = [
        _frame([_event(FRESH, FRESH_POOL, protocol=BONDING_PROTOCOL, side="buy" if i % 2 else "sell", i=i)],
               block_num=i)
        for i in range(5)
    ]

    first = LiveCaptureEngine(ds, LiveCaptureConfig(flush_every=2))
    for f in frames:
        first.ingest_frame(f)
    first.flush()
    assert first.stats.rows_written == 5

    # A fresh engine over the same dataset dir re-ingesting the SAME frames writes nothing new.
    second = LiveCaptureEngine(ds, LiveCaptureConfig(flush_every=2))
    for f in frames:
        second.ingest_frame(f)
    second.flush()
    assert second.stats.swaps_captured == 5  # it still saw them ...
    assert second.stats.rows_written == 0  # ... but dedup on signature persisted none


def test_engine_should_stop_on_max_tokens() -> None:
    ds = MarketSwapDataset(Path("unused"))  # never written: flush_every huge, we stop first
    engine = LiveCaptureEngine(ds, LiveCaptureConfig(max_tokens=2, flush_every=10_000))
    mints = [f"Mint{i}".ljust(40, "x") for i in range(3)]
    for k, mint in enumerate(mints):
        pool = f"Pool{k}".ljust(40, "x")
        engine.ingest_frame(_frame([_event(mint, pool, protocol=BONDING_PROTOCOL, side="buy", i=0)], block_num=k))
        if engine.should_stop():
            break
    assert engine.stats.fresh_tokens == 2
    assert engine.should_stop()


def test_engine_should_stop_on_max_swaps() -> None:
    ds = MarketSwapDataset(Path("unused"))
    engine = LiveCaptureEngine(ds, LiveCaptureConfig(max_swaps=3, flush_every=10_000))
    for i in range(10):
        engine.ingest_frame(
            _frame([_event(FRESH, FRESH_POOL, protocol=BONDING_PROTOCOL, side="buy", i=i)], block_num=i)
        )
        if engine.should_stop():
            break
    assert engine.stats.swaps_captured == 3
