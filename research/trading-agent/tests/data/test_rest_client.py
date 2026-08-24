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


def test_4xx_fails_fast_without_retry() -> None:
    transport = FakeTransport(lambda u, h, t: HttpResponse(status=404, body=b"nope"))
    client = _client(transport)
    with pytest.raises(RuntimeError, match="Pinax 404"):
        client.get_json("/v1/svm/swaps", {"network": "solana"}, use_cache=False)
    # Non-retryable 4xx must NOT burn retries — exactly one transport call.
    assert len(transport.calls) == 1


def test_backoff_schedule_is_exponential_with_jitter_disabled() -> None:
    calls = {"n": 0}

    def handler(url: str, headers: dict[str, str], timeout: float) -> HttpResponse:
        calls["n"] += 1
        if calls["n"] < 3:
            return HttpResponse(status=500, body=b"boom")
        return json_response({"data": ["ok"]})

    slept: list[float] = []
    client = _client(
        FakeTransport(handler),
        base_delay_s=1.0,
        max_backoff_s=30.0,
        rng=lambda: 0.0,  # jitter off -> deterministic schedule
    )
    client._sleep = slept.append
    client.get_json("/v1/svm/swaps", {"network": "solana"}, use_cache=False)
    # attempt 0 -> 1*2**0, attempt 1 -> 1*2**1; success on the 3rd call.
    assert slept == [1.0, 2.0]


def test_backoff_gives_up_after_max_retries_and_raises() -> None:
    transport = FakeTransport(lambda u, h, t: HttpResponse(status=503, body=b"down"))
    slept: list[float] = []
    client = _client(transport, max_retries=2, base_delay_s=1.0, rng=lambda: 0.0)
    client._sleep = slept.append
    with pytest.raises(RuntimeError, match="Pinax request failed"):
        client.get_json("/v1/svm/swaps", {"network": "solana"}, use_cache=False)
    assert len(transport.calls) == 3  # attempts 0,1,2 (initial + 2 retries)
    assert slept == [1.0, 2.0]  # last attempt does not sleep


def test_transient_oserror_is_retried_then_succeeds() -> None:
    calls = {"n": 0}

    def handler(url: str, headers: dict[str, str], timeout: float) -> HttpResponse:
        calls["n"] += 1
        if calls["n"] == 1:
            raise ConnectionResetError("connection reset")
        return json_response({"data": []})

    client = _client(FakeTransport(handler), base_delay_s=1.0, rng=lambda: 0.0)
    client.get_json("/v1/svm/swaps", {"network": "solana"}, use_cache=False)
    assert calls["n"] == 2


def test_retry_after_header_is_respected() -> None:
    calls = {"n": 0}

    def handler(url: str, headers: dict[str, str], timeout: float) -> HttpResponse:
        calls["n"] += 1
        if calls["n"] == 1:
            return HttpResponse(status=429, body=b"slow down", headers={"retry-after": "7"})
        return json_response({"data": []})

    slept: list[float] = []
    client = _client(FakeTransport(handler), base_delay_s=1.0, rng=lambda: 0.0)
    client._sleep = slept.append
    client.get_json("/v1/svm/swaps", {"network": "solana"}, use_cache=False)
    assert slept == [7.0]  # honoured the server's Retry-After, not the 1s exponential base


def test_backoff_applies_jitter_within_bounds() -> None:
    transport = FakeTransport(lambda u, h, t: HttpResponse(status=500, body=b"x"))
    slept: list[float] = []
    client = _client(transport, max_retries=1, base_delay_s=2.0, rng=lambda: 0.5)
    client._sleep = slept.append
    with pytest.raises(RuntimeError):
        client.get_json("/v1/svm/swaps", {"network": "solana"}, use_cache=False)
    # attempt 0: min(30, 2*2**0)=2.0 base + jitter (0.5 * base_delay=1.0) = 3.0
    assert slept == [3.0]


def test_limit_bounds_are_enforced() -> None:
    client = _client(FakeTransport(lambda u, h, t: json_response({"data": []})))
    with pytest.raises(ValueError, match="limit"):
        client.get_swaps(limit=0)
    with pytest.raises(ValueError, match="limit"):
        client.get_swaps(limit=5000)
