"""eval/ablations — per-tier + leakage-guard + convergence A/B (paper §8.4; 03 §Phase 1/2).

    * per-tier      : with-vs-without each information tier — the curriculum as instrument.
    * leakage-guard : replace a tier with noise; performance MUST collapse to the no-information
                      prior. If it doesn't, the agent was exploiting leakage (a NO-GO).
    * convergence   : convergence-with-N vs convergence-without-N — the clean A/B for Model N's lift.

TODO(Wave-1/2: eval agent): implement the ablation runners with multiple-comparison discipline.
"""

from __future__ import annotations
