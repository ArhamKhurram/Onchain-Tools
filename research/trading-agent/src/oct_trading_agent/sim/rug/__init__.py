"""sim/rug — honeypot/rug absorbing states (02 §2 (3); paper §6.2).

Rugs and honeypots are absorbing zero states read from the tape (:class:`~oct_trading_agent.core.tape.RugEvent`):
once seen for a mint, no later swap is tradeable and the episode terminates. Avoidance is a
first-class LEARNED objective, so this belongs in the environment, not the reward alone.

TODO(Wave-1: sim agent): implement absorbing-state handling — mark terminal on RugEvent, fail fills
attempted at/after it with FillFailureReason.RUGGED.
"""

from __future__ import annotations
