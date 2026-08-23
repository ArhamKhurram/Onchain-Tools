"""Signer-based Pinax loader + tracked-wallets file reader — fake transport, no network."""

from __future__ import annotations

import json
from decimal import Decimal
from urllib.parse import parse_qs, urlparse

from oct_trading_agent.core.enums import Side
from oct_trading_agent.data.labeling.pinax_loader import load_wallet_trades
from oct_trading_agent.data.labeling.wallets_file import (
    parse_tracked_wallets,
    select_cohort,
)
from oct_trading_agent.data.pinax_client.rest import PinaxRestClient
from oct_trading_agent.data.pinax_client.transport import HttpResponse

from .conftest import FIXTURES_DIR, FakeTransport, json_response

SIGNER = "Trader1imitationLearnWa11et11111111111111111"


def _client(transport: FakeTransport) -> PinaxRestClient:
    return PinaxRestClient(
        transport=transport,
        min_interval_s=0.0,
        api_key_provider=lambda: "test-key",
        sleep=lambda _s: None,
    )


def _signer_page() -> dict[str, object]:
    payload: dict[str, object] = json.loads(
        (FIXTURES_DIR / "pinax_signer_swaps.json").read_text(encoding="utf-8")
    )
    return payload


def _paged_handler() -> FakeTransport:
    """Return the fixture rows on page 1 and an empty page afterwards (ends the scan)."""
    payload = _signer_page()

    def handler(url: str, headers: dict[str, str], timeout: float) -> HttpResponse:
        page = int(parse_qs(urlparse(url).query).get("page", ["1"])[0])
        if page == 1:
            return json_response({"data": payload["data"]})
        return json_response({"data": []})

    return FakeTransport(handler)


def test_loads_signer_trades_and_skips_non_wsol_route() -> None:
    transport = _paged_handler()
    wallet = load_wallet_trades(_client(transport), SIGNER, labels=["tracked"], limit=500)

    assert wallet.wallet == SIGNER
    assert wallet.labels == ["tracked"]
    # 4 WSOL-quoted trades decode; the token->token route row is skipped.
    assert len(wallet.trades) == 4
    sides = [t.side for t in wallet.trades]
    assert sides == [Side.BUY, Side.BUY, Side.SELL, Side.SELL]
    # Trades are time-ordered and carry the tracked (non-WSOL) mint.
    assert all(t.mint == "Tok1imitationLearnDemoMint1111111111111111" for t in wallet.trades)
    assert wallet.trades[0].quote_amount == Decimal("2.0")
    assert wallet.trades[0].base_amount == Decimal("1000000.0")
    assert [t.signature for t in wallet.trades] == [
        "sig-buy-1", "sig-buy-2", "sig-sell-1", "sig-sell-2"
    ]


def test_signer_query_param_is_sent() -> None:
    seen: dict[str, list[str]] = {}

    def handler(url: str, headers: dict[str, str], timeout: float) -> HttpResponse:
        seen.update(parse_qs(urlparse(url).query))
        return json_response({"data": []})

    load_wallet_trades(_client(FakeTransport(handler)), SIGNER, limit=500)
    assert seen.get("signer") == [SIGNER]
    assert seen.get("network") == ["solana"]


def test_reconstructs_into_one_closed_trajectory() -> None:
    from oct_trading_agent.data.labeling.reconstruct import build_trajectories

    wallet = load_wallet_trades(_client(_paged_handler()), SIGNER, limit=500)
    trajectories = build_trajectories(wallet)
    assert len(trajectories) == 1
    traj = trajectories[0]
    assert traj.outcome == "win"  # bought 3 SOL, sold 3.8 SOL
    # OPEN_LONG, ADD, TRIM, CLOSE
    assert [s.intent.value for s in traj.steps] == ["open_long", "add", "trim", "close"]


def test_tracked_wallets_file_parse_and_rank() -> None:
    tracked = parse_tracked_wallets(FIXTURES_DIR.parent / "fixtures" / "tracked_wallets_sample.json")
    # Ethereum row dropped; the four solana rows kept.
    assert len(tracked) == 4
    assert all(w.chain == "solana" for w in tracked)

    cohort = select_cohort(tracked, max_wallets=2)
    assert [w.name for w in cohort] == ["Whale One", "Mid Two"]  # top-2 by SOL balance
    assert cohort[0].native_balance == Decimal("1337.5")


def test_select_cohort_respects_min_balance() -> None:
    tracked = parse_tracked_wallets(FIXTURES_DIR.parent / "fixtures" / "tracked_wallets_sample.json")
    cohort = select_cohort(tracked, max_wallets=10, min_balance=Decimal(1))
    # "Low Three" (0.5) and "No Funding" (0) fall below the floor.
    assert {w.name for w in cohort} == {"Whale One", "Mid Two"}
