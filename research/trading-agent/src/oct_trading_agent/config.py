"""Runtime configuration + Pinax credential loading.

The Pinax API key is read at RUNTIME from the monorepo's ``backend/.env`` (var ``PINAX_API_KEY``),
mirroring the proven JS reference client at
``../oct-revival/spike/revival-scanner/src/env.js``. A ``PINAX_API_KEY`` process-env var overrides
the file.

SECURITY — non-negotiable:
    * The key is NEVER hardcoded, logged, printed, or committed.
    * ``PinaxCredentials.__repr__`` is redacted so an accidental log/print cannot leak it.
    * Nothing in this repo writes the key to disk or to a network request body; it is presented
      only as the documented auth header / bearer at the moment of a call (Wave-1 clients).

PROVEN Pinax facts (recorded here so Wave-1's data agent does not have to re-derive them; verified
against the working JS client on the dates noted):

    * REST base:        https://api.pinax.network            (auth header: ``X-Api-Key: <PINAX_API_KEY>``)
    * Substreams gRPC:  https://solana.substreams.pinax.network:443
                        bearer = the RAW ``PINAX_API_KEY`` (NOT an account JWT — VERIFIED 2026-08-04:
                        substreams REJECTS the JWT with "invalid api key").
    * Package:          dex-swaps-v0.5.2.spkg  (pinax-network/substreams-svm, release svm-dex-v0.5.2)
                        — same data as REST ``/v1/svm/swaps``.

Reference client: ``../oct-revival/spike/revival-scanner/src/{pinax.js, grpc-hello.js, env.js}``.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

# --- Proven Pinax constants (see module docstring) ------------------------------------------
PINAX_REST_BASE = "https://api.pinax.network"
PINAX_REST_API_KEY_HEADER = "X-Api-Key"
PINAX_SUBSTREAMS_ENDPOINT = "https://solana.substreams.pinax.network:443"
PINAX_SWAPS_SPKG = "dex-swaps-v0.5.2.spkg"  # pinax-network/substreams-svm, svm-dex-v0.5.2
PINAX_SWAPS_REST_PATH = "/v1/svm/swaps"  # same data as the substreams package

# The env var carrying the key, and the canonical backend/.env location (with a relative fallback
# that resolves from this file up to the monorepo root — mirrors env.js's two candidates).
PINAX_API_KEY_ENV = "PINAX_API_KEY"
_CANONICAL_BACKEND_ENV = Path("D:/Projects/Coding/active/Onchain Tools/backend/.env")
_RELATIVE_BACKEND_ENV = Path(__file__).resolve().parents[4] / "backend" / ".env"


@dataclass(frozen=True)
class PinaxCredentials:
    """The Pinax API key. Redacted in repr so it cannot leak via logs/prints."""

    api_key: str

    def __repr__(self) -> str:  # pragma: no cover - trivial redaction
        return "PinaxCredentials(api_key=<redacted>)"


def _find_backend_env() -> Path:
    for candidate in (_CANONICAL_BACKEND_ENV, _RELATIVE_BACKEND_ENV):
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(
        "backend/.env not found; set PINAX_API_KEY in the process environment instead"
    )


def _parse_dotenv(text: str) -> dict[str, str]:
    """Minimal dotenv parse (KEY=VALUE, optional surrounding quotes). Mirrors env.js."""
    out: dict[str, str] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        if key:
            out[key] = value
    return out


def get_pinax_credentials() -> PinaxCredentials:
    """Return the Pinax key: process env first, else ``backend/.env``. Never logs the value.

    Raises ``RuntimeError`` if the key cannot be found anywhere.
    """
    key = os.environ.get(PINAX_API_KEY_ENV)
    if not key:
        env = _parse_dotenv(_find_backend_env().read_text(encoding="utf-8"))
        key = env.get(PINAX_API_KEY_ENV)
    if not key:
        raise RuntimeError(
            f"{PINAX_API_KEY_ENV} missing (checked process env and backend/.env). "
            "Do not hardcode it — set it in the environment or backend/.env."
        )
    return PinaxCredentials(api_key=key)
