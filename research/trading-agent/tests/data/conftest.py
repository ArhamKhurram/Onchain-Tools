"""Shared fixtures for the data-layer tests. Everything here is offline — no network."""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from oct_trading_agent.data.pinax_client.transport import HttpResponse

FIXTURES_DIR = Path(__file__).resolve().parents[1] / "fixtures"


@pytest.fixture
def fixtures_dir() -> Path:
    return FIXTURES_DIR


def load_json_fixture(name: str) -> dict[str, Any]:
    result: dict[str, Any] = json.loads((FIXTURES_DIR / name).read_text(encoding="utf-8"))
    return result


@pytest.fixture
def swaps_page() -> dict[str, Any]:
    return load_json_fixture("pinax_swaps_page.json")


@pytest.fixture
def ws_swaps() -> dict[str, Any]:
    return load_json_fixture("pinax_ws_swaps.json")


@pytest.fixture
def pool_meta() -> dict[str, Any]:
    return load_json_fixture("pinax_pool_meta.json")


@pytest.fixture
def pool_balances() -> dict[str, Any]:
    return load_json_fixture("pinax_pool_balances.json")


class FakeTransport:
    """A deterministic :class:`HttpTransport` that dispatches to a handler. Never hits the network."""

    def __init__(self, handler: Callable[[str, dict[str, str], float], HttpResponse]) -> None:
        self._handler = handler
        self.calls: list[str] = []

    def get(self, url: str, headers: dict[str, str], timeout: float) -> HttpResponse:
        self.calls.append(url)
        return self._handler(url, headers, timeout)


def json_response(payload: dict[str, Any], status: int = 200) -> HttpResponse:
    return HttpResponse(status=status, body=json.dumps(payload).encode("utf-8"))
