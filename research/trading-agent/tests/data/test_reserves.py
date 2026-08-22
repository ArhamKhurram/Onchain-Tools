"""ReservesClient + reserve-anchor lookup + probe — all against captured fixtures, no network.

The fixtures (``pinax_pool_meta.json``, ``pinax_pool_balances.json``) are REAL Pinax responses for a
live pump.fun-AMM pool captured 2026-08-22. These tests pin the mapping (base↔quote orientation,
exact UI-unit reserves from ``amount``+``decimals``, snapshot/staleness bookkeeping, explicit
missingness) and the reserves-vs-implied-mid probe.
"""

from __future__ import annotations

import json
from decimal import Decimal
from typing import Any

from oct_trading_agent.data.pinax_client.decode import WSOL
from oct_trading_agent.data.pinax_client.reserves import (
    PoolMeta,
    ReservesClient,
    _reserve_from_balance_row,
)
from oct_trading_agent.data.pinax_client.reserves_probe import run_probe
from oct_trading_agent.data.pinax_client.rest import PINAX_USER_AGENT, PinaxRestClient
from oct_trading_agent.data.pinax_client.transport import HttpResponse

from .conftest import FakeTransport, json_response

POOL = "FARg7kxWgE9nVPXNtWsrF57WE5LdJRbQdErf3FWv4uvZ"
BASE_MINT = "B4e4hWwcr5g9Pt8JWUUGxH6gB4qkux9WWL2L26vMKgq6"
SNAPSHOT_BLOCK = 440961563


def _client(handler: Any) -> ReservesClient:
    rest = PinaxRestClient(
        transport=FakeTransport(handler),
        min_interval_s=0.0,
        api_key_provider=lambda: "test-key",
        sleep=lambda _s: None,
    )
    return ReservesClient(rest)


def _dispatch(pool_meta: dict[str, Any], pool_balances: dict[str, Any]) -> Any:
    def handler(url: str, headers: dict[str, str], timeout: float) -> HttpResponse:
        if "/v1/svm/pools" in url:
            return json_response(pool_meta)
        if "/v1/svm/balances" in url:
            return json_response(pool_balances)
        raise AssertionError(f"unexpected url {url}")

    return handler


# -- metadata orientation -----------------------------------------------------------------------


def test_pool_meta_orients_base_and_quote(pool_meta: dict[str, Any]) -> None:
    # The captured pool row has the BASE as input_mint and WSOL as output_mint — orientation must
    # still put WSOL in quote_* and the token in base_*.
    meta = PoolMeta.from_pool_row(pool_meta["data"][0])
    assert meta is not None
    assert meta.quote_mint == WSOL
    assert meta.base_mint == BASE_MINT
    assert meta.base_decimals == 6
    assert meta.quote_decimals == 9
    assert meta.protocol == "pumpfun_amm"


def test_pool_meta_none_for_non_quote_pair() -> None:
    row = {"amm_pool": "p", "input_mint": "AAA", "output_mint": "BBB"}
    assert PoolMeta.from_pool_row(row) is None


# -- reserves mapping ---------------------------------------------------------------------------


def test_get_pool_reserves_maps_exact_ui_units(
    pool_meta: dict[str, Any], pool_balances: dict[str, Any]
) -> None:
    client = _client(_dispatch(pool_meta, pool_balances))
    res = client.get_pool_reserves(POOL)

    # Reserves come from amount+decimals (exact), matching the fixture's UI `value`.
    assert res.quote_reserve == Decimal("1685510891478") / (Decimal(10) ** 9)
    assert res.base_reserve == Decimal("12461517517714381") / (Decimal(10) ** 6)
    assert res.quote_mint == WSOL
    assert res.base_mint == BASE_MINT
    assert res.snapshot_block == SNAPSHOT_BLOCK
    assert res.is_complete
    assert res.historical_supported is False
    # Reserve-implied mid ≈ quote/base (SOL per token).
    assert res.mid_price is not None
    assert Decimal("1.3e-7") < res.mid_price < Decimal("1.4e-7")


def test_reserve_from_row_prefers_amount_over_value_float() -> None:
    # amount+decimals is exact; value is a lossy float — the exact path must win.
    row = {"amount": "1000000001", "decimals": 9, "value": 1.0}
    assert _reserve_from_balance_row(row) == Decimal("1.000000001")
    # Falls back to value only when amount/decimals absent.
    assert _reserve_from_balance_row({"value": 2.5}) == Decimal("2.5")
    assert _reserve_from_balance_row({}) is None


# -- staleness / historical-not-supported -------------------------------------------------------


def test_requested_block_produces_positive_staleness(
    pool_meta: dict[str, Any], pool_balances: dict[str, Any]
) -> None:
    client = _client(_dispatch(pool_meta, pool_balances))
    # Ask as-of an earlier block than the (latest) snapshot: snapshot is NEWER, so stale_blocks > 0.
    older = SNAPSHOT_BLOCK - 500
    res = client.get_pool_reserves(POOL, as_of_block=older)
    assert res.requested_block == older
    assert res.stale_blocks == 500
    assert res.stale_seconds_estimate == 500 * 0.4
    assert res.is_fresh(max_blocks=1000) is True
    assert res.is_fresh(max_blocks=100) is False


def test_explicit_missingness_when_quote_row_absent(
    pool_meta: dict[str, Any], pool_balances: dict[str, Any]
) -> None:
    # Drop the WSOL row → quote_reserve is None (never fabricated / never zero), mid is None.
    only_base = json.loads(json.dumps(pool_balances))
    only_base["data"] = [r for r in only_base["data"] if r["mint"] != WSOL]
    client = _client(_dispatch(pool_meta, only_base))
    res = client.get_pool_reserves(POOL)
    assert res.base_reserve is not None
    assert res.quote_reserve is None
    assert res.is_complete is False
    assert res.mid_price is None


# -- anchor lookup: one call per unique pool ----------------------------------------------------


def test_reserve_anchors_dedupes_by_pool(
    pool_meta: dict[str, Any], pool_balances: dict[str, Any]
) -> None:
    calls: list[str] = []

    def handler(url: str, headers: dict[str, str], timeout: float) -> HttpResponse:
        calls.append(url)
        if "/v1/svm/pools" in url:
            return json_response(pool_meta)
        return json_response(pool_balances)

    client = _client(handler)
    b1, b2 = SNAPSHOT_BLOCK - 10, SNAPSHOT_BLOCK - 3
    anchors = client.reserve_anchors([(POOL, b1), (POOL, b2)])

    # Two distinct (pool, block) anchors, but only ONE pool + ONE balances fetch for the pool.
    assert set(anchors) == {(POOL, b1), (POOL, b2)}
    assert sum("/v1/svm/pools" in u for u in calls) == 1
    assert sum("/v1/svm/balances" in u for u in calls) == 1
    # Same snapshot, per-ref requested block + staleness.
    assert anchors[(POOL, b1)].snapshot_block == SNAPSHOT_BLOCK
    assert anchors[(POOL, b1)].stale_blocks == 10
    assert anchors[(POOL, b2)].stale_blocks == 3
    assert anchors[(POOL, b1)].base_reserve == anchors[(POOL, b2)].base_reserve


# -- vault-accounts path + User-Agent -----------------------------------------------------------


def test_vault_accounts_uses_token_account_filter(pool_balances: dict[str, Any]) -> None:
    seen: dict[str, str] = {}

    def handler(url: str, headers: dict[str, str], timeout: float) -> HttpResponse:
        seen["url"] = url
        seen.update(headers)
        return json_response(pool_balances)

    client = _client(handler)
    client.get_pool_reserves(
        POOL, base_mint=BASE_MINT, vault_accounts=["acctA", "acctB"], use_cache=False
    )
    assert "token_account=acctA%2CacctB" in seen["url"]  # comma-joined multi-value filter
    assert "owner=" not in seen["url"]
    assert seen.get("User-Agent") == PINAX_USER_AGENT  # UA sent on every Pinax call


# -- probe report -------------------------------------------------------------------------------


def test_run_probe_compares_reserves_to_executed_price(
    pool_meta: dict[str, Any], pool_balances: dict[str, Any]
) -> None:
    # A real-shaped pump.fun-AMM WSOL swap on the fixture pool. Executed price ~ the reserve mid.
    swap_row = {
        "block_num": SNAPSHOT_BLOCK - 1,
        "amm_pool": POOL,
        "protocol": "pumpfun_amm",
        "input_mint": WSOL,
        "input_value": 15.0966,
        "output_mint": BASE_MINT,
        "output_value": 111_500_000.0,  # → executed ≈ 1.354e-7 SOL/token
    }
    swaps_payload = {"data": [swap_row]}

    def handler(url: str, headers: dict[str, str], timeout: float) -> HttpResponse:
        if "/v1/svm/swaps" in url:
            return json_response(swaps_payload)
        if "/v1/svm/pools" in url:
            return json_response(pool_meta)
        return json_response(pool_balances)

    rest = PinaxRestClient(
        transport=FakeTransport(handler),
        min_interval_s=0.0,
        api_key_provider=lambda: "test-key",
        sleep=lambda _s: None,
    )
    report = run_probe(rest)
    assert report.amm_pool == POOL
    assert report.base_mint == BASE_MINT
    ratio = report.implied_over_executed
    assert ratio is not None
    # Reserve-implied mid within ~2% of the swap's executed price (fees + the order's own impact).
    assert Decimal("0.98") < ratio < Decimal("1.02")
    assert "NOT supported" in report.render()
