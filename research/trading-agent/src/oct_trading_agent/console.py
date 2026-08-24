"""Encoding-safe console output — a wallet name must never be able to crash a run.

The operator's tracked-wallets export carries human names with emoji/unicode (the export has an
``emoji`` field and names to match). A cp1252 Windows console cannot encode those, so a bare
``print`` interpolating one raises ``UnicodeEncodeError`` mid-run. Worse than the traceback: broad
exception handling upstream once mistook that *logging* failure for a *data* failure and silently
turned the ``tracked_traders`` baseline off. These helpers make console text lossy-but-safe
(unencodable characters become ``?``) so logging can never raise — the only exceptions left for
callers to degrade on are genuine data/network ones.
"""

from __future__ import annotations

import sys
from typing import IO


def safe_console_text(text: str, stream: IO[str] | None = None) -> str:
    """Return ``text`` reduced to what ``stream`` (default: ``sys.stdout``) can actually encode.

    Round-trips the text through the stream's encoding with ``errors="replace"``: on a UTF-8-capable
    stream it passes through unchanged; on cp1252 an emoji becomes ``?`` instead of raising. A
    missing or unknown encoding falls back to ASCII rather than raise — this function must never be
    the thing that fails.
    """
    target = sys.stdout if stream is None else stream
    encoding = getattr(target, "encoding", None) or "utf-8"
    try:
        return text.encode(encoding, errors="replace").decode(encoding, errors="replace")
    except (LookupError, UnicodeError):
        return text.encode("ascii", errors="replace").decode("ascii")


def safe_print(message: str, *, stream: IO[str] | None = None) -> None:
    """``print`` that cannot raise ``UnicodeEncodeError``: sanitise via :func:`safe_console_text`.

    Use for any log line that interpolates operator/user-supplied strings (wallet names, exception
    messages). A logging call must never abort a run or trip a degrade path.
    """
    target = sys.stdout if stream is None else stream
    try:
        print(safe_console_text(message, target), file=target)
    except UnicodeError:  # a stream lying about its encoding — degrade to ASCII, still print
        print(message.encode("ascii", errors="replace").decode("ascii"), file=target)


__all__ = ["safe_console_text", "safe_print"]
