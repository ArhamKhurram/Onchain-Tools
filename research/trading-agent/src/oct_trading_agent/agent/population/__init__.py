"""agent/population — PBT, ES, MAP-Elites archive (02 §2 (4); paper §6.4).

The deliverable is an ARCHIVE of individually edge-positive archetypes, not one champion. The
behavioral-descriptor space (holding time, risk appetite, turnover, narrative sensitivity,
wallet-flow reliance) is the MAP-Elites axis set (final axes are a Phase-2 experimental choice).
Reward weightings are an explicit PBT dimension (paper §3.5.3-B). Optional dep group: ``population``
(ray[tune], ribs).

TODO(Wave-2: population agent): implement PBT + ES + the MAP-Elites archive.
"""

from __future__ import annotations
