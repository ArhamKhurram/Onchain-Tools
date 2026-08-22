"""Small coverage for the WS URL/parse helpers, the substreams gate, and the token accessor."""

from __future__ import annotations

import pytest

from oct_trading_agent.config import PinaxCredentials, get_pinax_api_token
from oct_trading_agent.data.pinax_client.substreams import (
    stream_substreams_swaps,
    substreams_available,
)
from oct_trading_agent.data.pinax_client.ws import (
    DEFAULT_WS_STREAM,
    PinaxWebSocketClient,
    _parse_frame,
)


def test_credentials_repr_is_redacted() -> None:
    creds = PinaxCredentials(api_key="super-secret-value")
    assert "super-secret-value" not in repr(creds)
    assert "redacted" in repr(creds)


def test_get_pinax_api_token_reads_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PINAX_API_TOKEN", "jwt-abc")
    assert get_pinax_api_token() == "jwt-abc"


def test_ws_url_uses_token_provider_and_stream() -> None:
    client = PinaxWebSocketClient(token_provider=lambda: "TOK")
    url = client._url()
    assert DEFAULT_WS_STREAM in url
    assert url.endswith("?token=TOK")


def test_parse_frame() -> None:
    assert _parse_frame('{"type":"session"}') == {"type": "session"}
    assert _parse_frame(b'{"a":1}') == {"a": 1}
    assert _parse_frame("not json") is None
    assert _parse_frame("[1,2,3]") is None  # not an object


def test_substreams_is_gated() -> None:
    assert isinstance(substreams_available(), bool)
    # Deferred path: RuntimeError if the extra is missing, else NotImplementedError.
    with pytest.raises((RuntimeError, NotImplementedError)):
        stream_substreams_swaps()
