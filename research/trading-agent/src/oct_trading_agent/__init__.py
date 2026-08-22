"""OCT autonomous trading-agent research package (Model N) — Phase 0 scaffolding.

The module tree mirrors 02-technical-design.md §6 and encodes the dependency + leakage order:

    data → featurestore → sim → agent → eval

Features are NEVER computed in ``data`` or ``sim`` so causality is auditable at one boundary
(the feature store). ``bridge`` is the ONLY module allowed to reference ``/sniper/v1`` — and it
proposes only, never spends. See ``src/README.md`` for the full conventions.

Import shared contracts from :mod:`oct_trading_agent.core`.
"""

from __future__ import annotations

__version__ = "0.0.0"
