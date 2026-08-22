"""agent/offline — IQL/CQL offline pretraining (02 §2 (4); paper §6).

Offline-RL pretrain on the historical tape + trader demonstrations, conservative about OOD actions
(the data cannot be regenerated). Optional dep group: ``offline`` (d3rlpy).

TODO(Wave-1: agent agent): implement offline pretraining. Do not import d3rlpy at module top level
unless the group is installed (keep the base install lean).
"""

from __future__ import annotations
