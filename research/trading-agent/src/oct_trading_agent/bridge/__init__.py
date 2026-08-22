"""bridge/ — the safety / actuator bridge to ``/sniper/v1`` (02 §2 (6), §5; paper §4.2, §10.4).

**This is the ONLY module in the entire package allowed to reference ``/sniper/v1``.** Keeping the
reference at a single seam is what makes the "propose-only, never spend" rule enforceable by code
review (02 §6 rationale). If any other module imports a sniper path, that is a bug.

Hard rules encoded here (from the root CLAUDE.md sniper section + paper §10.4):

    * The agent may only PROPOSE. ``executeFire`` (the only function that spends) lives in the
      backend and independently enforces the kill switch, per-fire/per-trigger/daily caps, max open
      positions, and auth. The bridge cannot modify a cap or disable the kill switch.
    * The agent NEVER holds the venue token (read late in the backend, never escapes the call frame).
    * ``/sniper/v1`` is NOT under ``/api`` and sits before ``app.use(cors())`` — it has its own auth,
      body parser, rate limit, and strict Origin/Host check. The bridge speaks to that plane, nothing
      else.
    * Signal-first (README): live execution is an opt-in, separately-gated extension that DEFAULTS
      OFF. In paper mode the bridge writes to the ledger, not to the sniper.

TODO(Wave-3: bridge agent): implement ``SniperBridge.propose`` as an HTTP call to ``/sniper/v1``
(propose endpoint only). Verify the safety envelope before any live promotion (eval/gate).
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from oct_trading_agent.core import AgentDecision

# The one production coupling by design. Referenced ONLY here.
SNIPER_CONTROL_PLANE_PREFIX = "/sniper/v1"


class SniperProposalResult(Protocol):
    """Opaque result of a propose call — accepted/rejected by the sniper's own controls.

    The bridge never learns the venue token, caps, or fill internals; it only learns whether the
    proposal was accepted for independent execution.
    """

    accepted: bool
    reason: str | None


@runtime_checkable
class SniperBridge(Protocol):
    """Propose-only actuator interface. NEVER spends; the sniper independently decides and executes."""

    def propose(self, decision: AgentDecision) -> SniperProposalResult:
        """Translate a decision into a ``/sniper/v1`` proposal. Propose only — never a direct spend."""
        ...
