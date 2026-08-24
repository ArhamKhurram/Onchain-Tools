"""Replay Room — the local trade-replay browser's stdlib HTTP server.

Serves ``scripts/replay-room.html`` at ``/`` plus three read-only JSON endpoints over the
replay-trace store (contract: ``replay-trace-schema.md``):

* ``GET /api/actors``                       — the full actors index (all groups, agents + wallets)
* ``GET /api/actor_tokens?actor=&group=``   — one actor's per-token trade summary
* ``GET /api/trace?actor=&mint=&group=``    — one (actor, token) replay trace, built on demand

Run (from anywhere — paths are anchored to this file)::

    .venv/Scripts/python.exe scripts/replay_server.py     # -> http://127.0.0.1:5299

Read-only by construction: every endpoint only reads parquet/JSON already on disk. (The one
write the trace layer can ever do — the first-ever ``mint_index.parquet`` build — is already
cached on disk.) Bound to loopback; stdlib ``http.server`` only, no web-framework deps.
"""

from __future__ import annotations

import json
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import polars as pl

from oct_trading_agent.traces.build import build_trace
from oct_trading_agent.traces.curate import actor_meta
from oct_trading_agent.traces.log import TradeLogStore
from oct_trading_agent.traces.schema import trace_to_json

HOST = "127.0.0.1"
PORT = 5299

#: Anchored to this file so the server works from any working directory (launch.json runs it
#: from the repo root; a shell may run it from ``research/trading-agent``).
AGENT_ROOT = Path(__file__).resolve().parents[1]
TRACE_ROOT = AGENT_ROOT / "data" / "replay_traces"
DATASET_ROOT = AGENT_ROOT / "data" / "market_dataset_snap800"
PAGE_PATH = Path(__file__).with_name("replay-room.html")


@lru_cache(maxsize=1)
def _store() -> TradeLogStore:
    return TradeLogStore(TRACE_ROOT)


@lru_cache(maxsize=1)
def list_actors() -> str:
    """The ``/api/actors`` payload (pre-serialized once — the index is immutable while serving)."""
    actors: list[dict[str, Any]] = []
    for rec in _store().load_actors().to_dicts():
        actors.append(
            {
                "actor_id": rec["actor_id"],
                "actor_kind": rec["actor_kind"],
                "group_id": rec["group_id"],
                "tokens_touched": rec["tokens_touched"],
                "n_trades": rec["n_trades"],
                "realized_pnl_quote": rec["realized_pnl_quote"],
                "meta": actor_meta(rec),
            }
        )
    return json.dumps({"actors": actors})


def actor_tokens(actor_id: str, group_id: str | None = None) -> dict[str, Any]:
    """One actor's tokens from the trade log: per-mint trade count + final realized PnL."""
    lf = _store().scan_trades().filter(pl.col("actor_id") == actor_id)
    if group_id is not None:
        lf = lf.filter(pl.col("group_id") == group_id)
    frame = (
        lf.group_by("mint")
        .agg(
            pl.len().alias("n_trades"),
            pl.col("realized_cum")
            .sort_by(pl.col("t"), pl.col("seq"))
            .last()
            .alias("realized_pnl"),
            pl.col("t").min().alias("t_first"),
            pl.col("t").max().alias("t_last"),
            pl.col("actor_kind").first().alias("actor_kind"),
            pl.col("group_id").first().alias("group_id"),
        )
        .sort(pl.col("realized_pnl").abs().fill_null(0.0), descending=True)
        .collect()
    )
    if frame.height == 0:
        raise ValueError(f"no logged trades for actor {actor_id!r}")
    groups = sorted(set(frame.get_column("group_id").to_list()))
    if len(groups) > 1:
        raise ValueError(f"actor {actor_id!r} is ambiguous across groups {groups}; pass group=")
    tokens = frame.drop("actor_kind", "group_id").to_dicts()
    return {
        "actor_id": actor_id,
        "actor_kind": str(frame.get_column("actor_kind")[0]),
        "group_id": str(groups[0]),
        "tokens": tokens,
    }


def trace_payload(actor_id: str, mint: str, group_id: str | None = None) -> dict[str, Any]:
    """One (actor, token) replay trace via the tier-2 on-demand builder, in-process."""
    trace = build_trace(TRACE_ROOT, DATASET_ROOT, actor_id, mint, group_id=group_id)
    payload: dict[str, Any] = trace_to_json(trace)
    return payload


def _q(query: dict[str, list[str]], key: str) -> str | None:
    values = query.get(key)
    return values[0] if values else None


class ReplayRoomHandler(BaseHTTPRequestHandler):
    """GET-only, loopback-only, read-only. Everything else is a 404/405."""

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        self._send(status, json.dumps(payload).encode("utf-8"), "application/json; charset=utf-8")

    def do_GET(self) -> None:  # http.server's required casing
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        try:
            if parsed.path in ("/", "/index.html"):
                self._send(200, PAGE_PATH.read_bytes(), "text/html; charset=utf-8")
            elif parsed.path == "/api/actors":
                self._send(200, list_actors().encode("utf-8"), "application/json; charset=utf-8")
            elif parsed.path == "/api/actor_tokens":
                actor = _q(query, "actor")
                if actor is None:
                    self._send_json(400, {"error": "missing required query param: actor"})
                    return
                self._send_json(200, actor_tokens(actor, _q(query, "group")))
            elif parsed.path == "/api/trace":
                actor, mint = _q(query, "actor"), _q(query, "mint")
                if actor is None or mint is None:
                    self._send_json(400, {"error": "missing required query params: actor, mint"})
                    return
                self._send_json(200, trace_payload(actor, mint, _q(query, "group")))
            else:
                self._send_json(404, {"error": f"unknown path {parsed.path!r}"})
        except ValueError as exc:  # unknown actor/mint, ambiguous group — the builder's own errors
            self._send_json(404, {"error": str(exc)})
        except BrokenPipeError:  # client went away mid-response; nothing to answer
            pass
        except Exception as exc:  # last-resort: report, never crash the server
            self._send_json(500, {"error": f"{type(exc).__name__}: {exc}"})

    def log_message(self, format: str, *args: Any) -> None:  # stdlib signature ("format" name)
        print(f"[replay-room] {self.address_string()} {format % args}")


def main() -> None:
    if not TRACE_ROOT.exists():
        raise SystemExit(f"trace store not found: {TRACE_ROOT}")
    if not PAGE_PATH.exists():
        raise SystemExit(f"page not found: {PAGE_PATH}")
    n_actors = len(json.loads(list_actors())["actors"])  # warm the index before accepting requests
    server = ThreadingHTTPServer((HOST, PORT), ReplayRoomHandler)
    print(f"[replay-room] {n_actors} actors indexed from {TRACE_ROOT}")
    print(f"[replay-room] serving http://{HOST}:{PORT}/  (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
