"""PinaxRestClient: cache, retry/backoff, throttle, error handling — all with a fake transport."""

from __future__ import annotations

from pathlib import Path

import pytest

from oct_trading_agent.data.pinax_client.rest import PinaxRestClient
from oct_trading_agent.data.pinax_client.transport import HttpResponse

from .conftest import FakeTransport, json_response


def _client(transport: FakeTransport, **kw: object) -> PinaxRestClient:
    return PinaxRestClient(
        transport=transport,
        min_interval_s=0.0,
        api_key_provider=lambda: "test-key",
        sleep=lambda _s: None,  # never actually sleep in tests
        **kw,  # type: ignore[arg-type]
    )


def test_api_key_header_is_sent() -> None:
    seen: dict[str, str] = {}

    def handler(url: str, headers: dict[str, str], timeout: float) -> HttpResponse:
        seen.update(headers)
        return json_response({"data": []})

    client = _client(FakeTransport(handler))
    client.get_json("/v1/svm/swaps", {"network": "solana"}, use_cache=False)
    assert seen.get("X-Api-Key") == "test-key"


def test_disk_cache_serves_second_call(tmp_path: Path) -> None:
    transport = FakeTransport(lambda u, h, t: json_response({"data": [{"x": 1}]}))
    client = _client(transport, cache_dir=tmp_path)
    a = client.get_json("/v1/svm/swaps", {"network": "solana", "page": 1})
    b = client.get_json("/v1/svm/swaps", {"network": "solana", "page": 1})
    assert a == b
    assert len(transport.calls) == 1  # second call served from disk


def test_retries_on_500_then_succeeds() -> None:
    calls = {"n": 0}

    def handler(url: str, headers: dict[str, str], timeout: float) -> HttpResponse:
        calls["n"] += 1
        if calls["n"] < 3:
            return HttpResponse(status=500, body=b"boom")
        return json_response({"data": ["ok"]})

    client = _client(FakeTransport(handler))
    out = client.get_json("/v1/svm/swaps", {"network": "solana"}, use_cache=False)
    assert out == {"data": ["ok"]}
    assert calls["n"] == 3


def test_429_is_retried() -> None:
    calls = {"n": 0}

    def handler(url: str, headers: dict[str, str], timeout: float) -> HttpResponse:
        calls["n"] += 1
        if calls["n"] == 1:
            return HttpResponse(status=429, body=b"slow down")
        return json_response({"data": []})

    client = _client(FakeTransport(handler))
    client.get_json("/v1/svm/swaps", {"network": "solana"}, use_cache=False)
    assert calls["n"] == 2


def test_4xx_raises() -> None:
    client = _client(FakeTransport(lambda u, h, t: HttpResponse(status=404, body=b"nope")))
    with pytest.raises(RuntimeError, match="Pinax 404"):
        client.get_json("/v1/svm/swaps", {"network": "solana"}, use_cache=False)


def test_limit_bounds_are_enforced() -> None:
    client = _client(FakeTransport(lambda u, h, t: json_response({"data": []})))
    with pytest.raises(ValueError, match="limit"):
        client.get_swaps(limit=0)
    with pytest.raises(ValueError, match="limit"):
        client.get_swaps(limit=5000)
