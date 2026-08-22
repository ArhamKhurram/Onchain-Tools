"""sim/amm — pool-state reconstruction + AMM slippage/impact (02 §2 (3)).

Reconstructs the bonding-curve / constant-product pool state at a decision timestamp from the tape,
then computes realistic slippage as a function of size vs pool depth and the own-order price impact.
The AMM impact map is CLOSED-FORM (a genuine advantage over LOB microstructure, paper §4.4).

TODO(Wave-1: sim agent): implement reserve reconstruction (filling optional tape reserve gaps) and
the closed-form impact function. Keep it vectorized (numpy) behind the Simulator hot loop.
"""

from __future__ import annotations
