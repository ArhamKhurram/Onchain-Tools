"""Pinax REST client — throttled, disk-cached, retrying. The primary path for historical backfill.

Mirrors the proven JS reference (``../oct-revival/spike/revival-scanner/src/pinax.js``):

* **Throttle** — a minimum interval between live calls (default 350 ms), so a long backfill stays
  polite and under the plan's rate limit.
* **Disk cache** — successful responses are cached to disk keyed by the full URL, so reruns of a
  backfill cost nothing and the same fixtures replay deterministically.
* **Retry/backoff** — 429 and 5xx (and transient connection errors) get *exponential backoff with
  full jitter* (base 1 s, ×2 per attempt, capped ~30 s), honouring a ``Retry-After`` header when the
  server sends one. Non-retryable 4xx (auth/not-found/bad-request) fail fast — retrying them only
  burns quota. This is what lets a big cohort backfill (dozens of wallets, hundreds of pages) survive
  a rate-limited window instead of aborting on the first sustained 429.
* **Pacing** — an optional ``inter_request_delay_s`` adds a deliberate gap before each live request so
  a large sequential pull does not burst the endpoint (on top of the ``min_interval_s`` throttle).

Auth is the ``X-Api-Key: <PINAX_API_KEY>`` header (config.py proven facts). The key is read from
:func:`oct_trading_agent.config.get_pinax_credentials` at call time and **never** logged or cached
(only response bodies are cached; the URL key is a hash, and headers are never written to disk).

The HTTP call goes through the injected :class:`~.transport.HttpTransport`, so tests drive the
whole throttle/cache/retry/pagination machine with a deterministic fake transport and never touch
the network. **Live backfill is gated on ``PINAX_API_KEY`` being set.**
"""

from __future__ import annotations

import hashlib
import json
import random
import time
from collections.abc import Callable, Iterator, Mapping
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

from oct_trading_agent.config import (
    PINAX_REST_API_KEY_HEADER,
    PINAX_REST_BASE,
    PINAX_SWAPS_REST_PATH,
    get_pinax_credentials,
)

from .transport import HttpResponse, HttpTransport, UrllibTransport

# Pinax plan-restricted maximum page size (openapi: limit max 1000; spike used 500).
PAGE_LIMIT_MAX = 1000
DEFAULT_PAGE_LIMIT = 500

# Pinax expects a User-Agent on requests (a bare urllib default is a soft red flag); identify the
# research client without leaking anything sensitive. Sent on every call alongside the API key.
PINAX_USER_AGENT = "oct-trading-agent/pinax-client (+research)"

# Retry/backoff defaults. Base 1 s, ×2 per attempt, capped ~30 s, plus full jitter — polite under a
# rate-limited window and bounded so a wedged endpoint never stalls a cohort pull indefinitely.
DEFAULT_MAX_RETRIES = 5
DEFAULT_BASE_DELAY_S = 1.0
DEFAULT_MAX_BACKOFF_S = 30.0
# Absolute ceiling on an honoured ``Retry-After`` — the server's hint is respected up to this bound
# so a hostile/huge value cannot park the whole run (we simply retry again after the ceiling).
RETRY_AFTER_CEILING_S = 120.0


def _retry_after_seconds(resp: HttpResponse, *, now: Callable[[], datetime]) -> float | None:
    """Parse a ``Retry-After`` header into seconds — integer-seconds or HTTP-date form.

    Returns ``None`` when the header is absent or unparseable (the caller falls back to exponential
    backoff). A date in the past clamps to ``0``. ``now`` is injected so tests are deterministic.
    """
    raw = resp.headers.get("retry-after")
    if raw is None:
        return None
    raw = raw.strip()
    if not raw:
        return None
    try:
        return max(0.0, float(int(raw)))
    except ValueError:
        pass
    try:
        when = parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        return None
    if when is None:
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    return max(0.0, (when - now()).total_seconds())


class PinaxRestClient:
    """A polite, cached, retrying Pinax REST client.

    Parameters
    ----------
    cache_dir:
        Directory for the on-disk response cache. ``None`` disables caching (used in tests that
        assert transport call counts). When set, the directory is created on first write.
    transport:
        The HTTP transport. Defaults to :class:`~.transport.UrllibTransport` (stdlib, zero deps).
        Tests inject a fake.
    min_interval_s:
        Minimum spacing between live (non-cached) calls, in seconds (the base throttle).
    inter_request_delay_s:
        Extra deliberate pacing applied before each live request, on top of ``min_interval_s``. Left
        at ``0`` for single calls; a big cohort pull sets a small value (e.g. 0.25–0.5 s) so a burst
        of sequential requests does not trip the endpoint's rate limiter.
    max_retries:
        How many times a *retryable* failure (429, 5xx, transient connection error) is retried before
        the request is declared failed. Non-retryable 4xx never retry.
    base_delay_s / max_backoff_s:
        Exponential-backoff base and cap: sleep ≈ ``min(max_backoff_s, base_delay_s * 2**attempt)``
        plus full jitter in ``[0, base_delay_s)``. A ``Retry-After`` header, when present, overrides
        the exponential term (still jittered and ceiling-bounded).
    api_key_provider:
        Callable returning the API key. Defaults to reading it from config at call time (so the
        key is never captured at construction and never held longer than a request).
    rng:
        Source of jitter in ``[0, 1)`` (defaults to :func:`random.random`). Injected so tests get a
        deterministic backoff schedule.
    """

    def __init__(
        self,
        *,
        cache_dir: Path | None = None,
        transport: HttpTransport | None = None,
        base_url: str = PINAX_REST_BASE,
        min_interval_s: float = 0.35,
        inter_request_delay_s: float = 0.0,
        max_retries: int = DEFAULT_MAX_RETRIES,
        base_delay_s: float = DEFAULT_BASE_DELAY_S,
        max_backoff_s: float = DEFAULT_MAX_BACKOFF_S,
        timeout_s: float = 45.0,
        api_key_provider: Callable[[], str] | None = None,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        rng: Callable[[], float] = random.random,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._cache_dir = cache_dir
        self._transport: HttpTransport = transport or UrllibTransport()
        self._base_url = base_url.rstrip("/")
        self._min_interval_s = min_interval_s
        self._inter_request_delay_s = inter_request_delay_s
        self._max_retries = max_retries
        self._base_delay_s = base_delay_s
        self._max_backoff_s = max_backoff_s
        self._timeout_s = timeout_s
        self._api_key_provider = api_key_provider or (lambda: get_pinax_credentials().api_key)
        self._clock = clock
        self._sleep = sleep
        self._rng = rng
        self._now = now or (lambda: datetime.now(UTC))
        self._last_call = 0.0

    # -- URL / cache helpers -------------------------------------------------------------------

    def _build_url(self, path: str, params: Mapping[str, Any]) -> str:
        clean = {k: v for k, v in params.items() if v is not None}
        query = urlencode({k: str(v) for k, v in clean.items()})
        base = f"{self._base_url}/{path.lstrip('/')}"
        return f"{base}?{query}" if query else base

    def _cache_path(self, url: str) -> Path | None:
        if self._cache_dir is None:
            return None
        digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:40]
        return self._cache_dir / f"{digest}.json"

    # -- core GET ------------------------------------------------------------------------------

    def get_json(
        self, path: str, params: Mapping[str, Any], *, use_cache: bool = True
    ) -> dict[str, Any]:
        """GET ``path`` with query ``params``; return the parsed JSON object.

        Serves from disk cache when available; otherwise throttles, calls the transport, retries
        on 429/5xx and transport errors, and caches a successful body.
        """
        url = self._build_url(path, params)
        cache_path = self._cache_path(url) if use_cache else None
        if cache_path is not None and cache_path.exists():
            loaded = json.loads(cache_path.read_text(encoding="utf-8"))
            return dict(loaded)

        headers = {
            PINAX_REST_API_KEY_HEADER: self._api_key_provider(),
            "User-Agent": PINAX_USER_AGENT,
        }
        last_error: Exception | None = None
        for attempt in range(self._max_retries + 1):
            if self._inter_request_delay_s > 0:
                self._sleep(self._inter_request_delay_s)
            self._throttle()
            try:
                resp = self._transport.get(url, headers, self._timeout_s)
            except OSError as exc:  # DNS/connection/timeout — retryable transport failure
                last_error = exc
                if attempt == self._max_retries:
                    break
                self._sleep(self._backoff_delay(attempt))
                continue

            if resp.status == 429 or resp.status >= 500:
                if attempt == self._max_retries:
                    last_error = RuntimeError(f"Pinax {resp.status} for {path} (retries exhausted)")
                    break
                retry_after = _retry_after_seconds(resp, now=self._now)
                self._sleep(self._backoff_delay(attempt, retry_after=retry_after))
                continue
            if resp.status >= 400:  # non-retryable 4xx (auth/not-found/bad-request) — fail fast
                snippet = resp.body[:300].decode("utf-8", "replace")
                raise RuntimeError(f"Pinax {resp.status} for {path}: {snippet}")

            parsed = json.loads(resp.body.decode("utf-8"))
            result = dict(parsed)
            if cache_path is not None:
                self._cache_dir.mkdir(parents=True, exist_ok=True)  # type: ignore[union-attr]
                cache_path.write_text(json.dumps(result), encoding="utf-8")
            return result

        raise RuntimeError(f"Pinax request failed for {path}") from last_error

    def _backoff_delay(self, attempt: int, *, retry_after: float | None = None) -> float:
        """Seconds to sleep before the next retry: honoured ``Retry-After`` (ceiling-bounded) or
        exponential ``base * 2**attempt`` (capped at ``max_backoff_s``), each plus full jitter."""
        if retry_after is not None:
            base = min(retry_after, RETRY_AFTER_CEILING_S)
        else:
            base = min(self._max_backoff_s, self._base_delay_s * (2**attempt))
        return base + self._rng() * self._base_delay_s

    def _throttle(self) -> None:
        wait = self._last_call + self._min_interval_s - self._clock()
        if wait > 0:
            self._sleep(wait)
        self._last_call = self._clock()

    # -- swaps -------------------------------------------------------------------------------

    def get_swaps(
        self,
        *,
        network: str = "solana",
        amm_pool: str | None = None,
        input_mint: str | None = None,
        output_mint: str | None = None,
        start_time: str | None = None,
        end_time: str | None = None,
        limit: int = DEFAULT_PAGE_LIMIT,
        page: int = 1,
        use_cache: bool = True,
    ) -> dict[str, Any]:
        """One page of ``/v1/svm/swaps``. Returns the raw JSON (``data`` + ``pagination`` + meta)."""
        if not 1 <= limit <= PAGE_LIMIT_MAX:
            raise ValueError(f"limit must be in [1, {PAGE_LIMIT_MAX}], got {limit}")
        params = {
            "network": network,
            "amm_pool": amm_pool,
            "input_mint": input_mint,
            "output_mint": output_mint,
            "start_time": start_time,
            "end_time": end_time,
            "limit": limit,
            "page": page,
        }
        return self.get_json(PINAX_SWAPS_REST_PATH, params, use_cache=use_cache)

    def iter_swap_rows(
        self,
        *,
        network: str = "solana",
        amm_pool: str | None = None,
        input_mint: str | None = None,
        output_mint: str | None = None,
        start_time: str | None = None,
        end_time: str | None = None,
        limit: int = DEFAULT_PAGE_LIMIT,
        max_pages: int = 16,
        use_cache: bool = True,
    ) -> Iterator[dict[str, Any]]:
        """Yield raw swap rows across pages until a short page or ``max_pages``.

        The API paginates newest-first via the ``page`` param; a page shorter than ``limit`` is the
        last page (mirrors the spike's backfill loop).
        """
        for page in range(1, max_pages + 1):
            payload = self.get_swaps(
                network=network,
                amm_pool=amm_pool,
                input_mint=input_mint,
                output_mint=output_mint,
                start_time=start_time,
                end_time=end_time,
                limit=limit,
                page=page,
                use_cache=use_cache,
            )
            rows = payload.get("data") or []
            for row in rows:
                if isinstance(row, dict):
                    yield row
            if len(rows) < limit:
                return


__all__ = [
    "PinaxRestClient",
    "PAGE_LIMIT_MAX",
    "DEFAULT_PAGE_LIMIT",
    "PINAX_USER_AGENT",
    "DEFAULT_MAX_RETRIES",
    "DEFAULT_BASE_DELAY_S",
    "DEFAULT_MAX_BACKOFF_S",
]
