"""HTTP transport seam for the Pinax REST client.

The throttle / cache / retry logic in :mod:`.rest` is transport-agnostic: it talks to this
:class:`HttpTransport` Protocol, never to a concrete HTTP library. That is what lets every test
inject a deterministic fake transport and **never touch the network** (the task's hard rule).

The default :class:`UrllibTransport` uses only the standard library, so live backfill works with
**zero optional installs** once ``PINAX_API_KEY`` is set. :class:`HttpxTransport` is offered for
callers who prefer ``httpx`` (install the ``http`` extra); it is a drop-in and never the default.
"""

from __future__ import annotations

import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Protocol, runtime_checkable


@dataclass(frozen=True)
class HttpResponse:
    """A minimal HTTP response: status code and raw body bytes.

    Deliberately tiny — the client only needs the status (for retry/backoff decisions) and the
    body (JSON to decode). No headers are surfaced; the Pinax REST API does not require them for
    pagination (it uses an explicit ``page`` query param).
    """

    status: int
    body: bytes


@runtime_checkable
class HttpTransport(Protocol):
    """Perform a single GET. Implementations must not retry or throttle — that is the client's job."""

    def get(self, url: str, headers: dict[str, str], timeout: float) -> HttpResponse:
        """GET ``url`` with ``headers``; return status + body even for 4xx/5xx (do not raise on them)."""
        ...


class UrllibTransport:
    """Standard-library transport (no third-party dependency). The default.

    Returns 4xx/5xx as an :class:`HttpResponse` rather than raising, so the client's retry/backoff
    ladder sees the status. Genuine network failures (DNS, connection reset, timeout) propagate as
    :class:`OSError`, which the client treats as a retryable transport error.
    """

    def get(self, url: str, headers: dict[str, str], timeout: float) -> HttpResponse:
        req = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return HttpResponse(status=resp.status, body=resp.read())
        except urllib.error.HTTPError as exc:  # 4xx/5xx — surface the status for the retry ladder
            body = exc.read() if hasattr(exc, "read") else b""
            return HttpResponse(status=exc.code, body=body)


class HttpxTransport:
    """Optional ``httpx``-backed transport. Requires the ``http`` extra (``pip install '.[http]'``).

    Imported lazily so the package imports cleanly without ``httpx`` installed.
    """

    def __init__(self) -> None:
        try:
            import httpx
        except ModuleNotFoundError as exc:  # pragma: no cover - exercised only without the extra
            raise RuntimeError(
                "HttpxTransport requires the 'http' extra: pip install 'oct-trading-agent[http]'"
            ) from exc
        self._httpx = httpx

    def get(self, url: str, headers: dict[str, str], timeout: float) -> HttpResponse:
        resp = self._httpx.get(url, headers=headers, timeout=timeout)
        return HttpResponse(status=resp.status_code, body=resp.content)


__all__ = ["HttpResponse", "HttpTransport", "UrllibTransport", "HttpxTransport"]
