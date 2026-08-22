"""eval/gate — the backtest→paper→live promotion ladder (paper §8.5; 03 gates).

Live real money is gated behind paper performance and hard caps — ALWAYS, no overrides. This
module encodes the promotion criteria (and their pre-registration) so a promotion is a checked
transition, not a judgment call.

TODO(Wave-3: gate agent): implement the promotion-ladder checks. Live promotion also depends on the
``bridge`` safety envelope being verified.
"""

from __future__ import annotations
