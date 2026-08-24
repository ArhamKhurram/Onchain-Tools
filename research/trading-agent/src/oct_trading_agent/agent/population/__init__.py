"""agent/population — PBT, ES, MAP-Elites archive (02 §2 (4); paper §6.4).

The deliverable is an ARCHIVE of individually edge-positive archetypes, not one champion. The
behavioral-descriptor space (holding time, risk appetite, turnover, narrative sensitivity,
wallet-flow reliance) is the MAP-Elites axis set (final axes are a Phase-2 experimental choice).
Reward weightings are an explicit PBT dimension (paper §3.5.3-B). Optional dep group: ``population``
(ray[tune], ribs).

**Phase-D shipped: PBT + MAP-Elites.** :mod:`.pbt` clones the Phase-1 hybrid actor-critic into a
population with perturbed hyperparameters and runs the exploit + explore loop; :mod:`.descriptor`
computes a behavioral descriptor per agent and bins it into a memecoin archetype niche (the shared QD
seam); :mod:`.telemetry` aggregates the population into the per-niche desk telemetry contract
(``O(roles × generations)``, never per-agent). :mod:`.map_elites` is the quality-DIVERSITY trainer —
an :class:`~.map_elites.EliteArchive` of one elite per niche, illuminated by mutate-and-evaluate, that
keeps every niche alive (the fix for PBT's diversity collapse). The pure pieces (descriptor → niche,
telemetry aggregation, hyperparameter perturbation, exploit/explore selection, the elite-replacement
rule + archive) are torch-free; training/eval is behind the ``learn`` extra. ES remains.
"""

from __future__ import annotations

from .archive import AgentReport, NicheArchive
from .checkpoint import atomic_write, atomic_write_text, load_torch, save_torch
from .descriptor import (
    BehavioralDescriptor,
    BehaviorProfile,
    behavioral_rollout,
    bin_descriptor,
    profile_policy,
    summarize_behavior,
)
from .map_elites import (
    Elite,
    EliteArchive,
    EliteGenome,
    MapElitesCheckpoint,
    MapElitesConfig,
    elite_beats,
    load_map_elites_checkpoint,
    mutate_genome,
    run_map_elites,
    save_map_elites_checkpoint,
)
from .pbt import (
    Hyperparams,
    PBTCheckpoint,
    PBTConfig,
    PBTMember,
    PBTMemberState,
    apply_exploit,
    load_pbt_checkpoint,
    run_pbt,
    save_pbt_checkpoint,
    select_exploit_explore,
)
from .telemetry import DeskTelemetryWriter, aggregate_generation, generation_from_archive

__all__ = [
    "AgentReport",
    "NicheArchive",
    "atomic_write",
    "atomic_write_text",
    "save_torch",
    "load_torch",
    "BehavioralDescriptor",
    "BehaviorProfile",
    "behavioral_rollout",
    "bin_descriptor",
    "profile_policy",
    "summarize_behavior",
    "Hyperparams",
    "PBTConfig",
    "PBTMember",
    "PBTMemberState",
    "PBTCheckpoint",
    "apply_exploit",
    "run_pbt",
    "save_pbt_checkpoint",
    "load_pbt_checkpoint",
    "select_exploit_explore",
    "Elite",
    "EliteArchive",
    "EliteGenome",
    "MapElitesConfig",
    "MapElitesCheckpoint",
    "elite_beats",
    "mutate_genome",
    "run_map_elites",
    "save_map_elites_checkpoint",
    "load_map_elites_checkpoint",
    "DeskTelemetryWriter",
    "aggregate_generation",
    "generation_from_archive",
]
