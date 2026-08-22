"""sim/rug — honeypot/rug absorbing states (02 §2 (3); paper §6.2).

Rugs and honeypots are absorbing zero states read from the tape (:class:`~oct_trading_agent.core.tape.RugEvent`):
once seen for a mint, no later swap is tradeable and the episode terminates. Avoidance is a
first-class LEARNED objective, so this belongs in the environment, not the reward alone.

Public surface: ``RugTracker`` (as-of terminality) and ``RugMarker`` (the first rug per mint).
"""

from __future__ import annotations

from .absorbing import RugMarker, RugTracker

__all__ = ["RugMarker", "RugTracker"]
