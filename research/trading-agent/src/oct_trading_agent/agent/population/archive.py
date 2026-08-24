"""The archetype-niche ARCHIVE — MAP-Elites-style, accumulated from mini-batches. TORCH-FREE.

The durable state of a population run is **per-niche**, not per-agent: one champion and an occupancy
count for each archetype role. :class:`NicheArchive` is that durable state. A mini-batch of freshly
trained agents is *binned into* it (:meth:`add_batch`) and then discarded — only the per-niche
champion, occupancy, and a cheap pnl summary survive. This is what lets the population scale far past
what fits in memory: you never need the whole population resident at once, just the archive plus the
mini-batch currently in hand.

The interface is deliberately small — ``add`` / ``add_batch`` a stream of
``(descriptor, agent, fitness)`` reports, then read back per-niche occupancy / champion / median and
the population roll-ups. It carries no torch and no viz formatting (that lives in :mod:`.telemetry`),
so it is a pure, testable accumulator and the clean seam a full MAP-Elites archive slots into.
"""

from __future__ import annotations

import statistics
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from .admission import VERDICT_RUINED, AdmissionConfig, admission_verdict
from .descriptor import MEMECOIN_ROLES, BehaviorProfile, bin_descriptor


@dataclass(frozen=True)
class AgentReport:
    """One agent's archive entry: its id and its behavioral profile (fitness + descriptor).

    Deliberately holds NO torch model — binning a mini-batch keeps only these light records (and, per
    niche, the single best one as champion), so the archive's footprint stays O(roles), never O(agents).
    """

    agent_id: str
    profile: BehaviorProfile


class NicheArchive:
    """A persistent per-niche archive, accumulated from mini-batches (MAP-Elites style).

    Each added agent is binned by its behavioral descriptor into exactly one role; the archive keeps
    that role's occupancy count, its single best occupant (the champion), and its occupants' pnls for
    the median. Population roll-ups (coverage, best/mean pnl) are maintained incrementally. Adding is
    order-independent and streaming: ``add_batch`` a mini-batch, drop it, repeat — the archive is the
    only thing that has to persist.
    """

    def __init__(
        self,
        roles: Sequence[str] = MEMECOIN_ROLES,
        *,
        admission: AdmissionConfig | None = None,
    ) -> None:
        self._roles: tuple[str, ...] = tuple(roles)
        self._admission = admission
        self._occupancy: dict[str, int] = {r: 0 for r in self._roles}
        self._champion: dict[str, AgentReport | None] = {r: None for r in self._roles}
        self._pnls: dict[str, list[float]] = {r: [] for r in self._roles}
        self._n = 0
        self._pnl_sum = 0.0
        self._best: float | None = None
        self._ruined = 0
        self._curve_rejected = 0

    @property
    def roles(self) -> tuple[str, ...]:
        return self._roles

    def add(self, report: AgentReport) -> str:
        """Bin one agent into its niche; update that niche's champion/occupancy and the roll-ups.

        Returns the role it landed in. The niche is a pure function of the agent's own descriptor.
        With an :class:`AdmissionConfig` set, an INADMISSIBLE agent (ruined / undisciplined equity
        curve) is excluded from the desk stats entirely — no occupancy, no median, and above all
        never a champion or the run's ``best_pnl_bps`` — and is counted in the ``ruined`` /
        ``curve_rejected`` tallies the telemetry reports instead. Excluding (rather than counting
        champion-less) preserves the viz contract's invariant that occupancy > 0 ⇒ champion present.
        """
        role = bin_descriptor(report.profile.descriptor)
        verdict = (
            admission_verdict(report.profile, self._admission)
            if self._admission is not None
            else None
        )
        if verdict is not None:
            if verdict == VERDICT_RUINED:
                self._ruined += 1
            else:
                self._curve_rejected += 1
            return role
        pnl = report.profile.pnl_bps
        self._occupancy[role] += 1
        self._pnls[role].append(pnl)
        champ = self._champion[role]
        if champ is None or pnl > champ.profile.pnl_bps:
            self._champion[role] = report
        self._n += 1
        self._pnl_sum += pnl
        self._best = pnl if self._best is None else max(self._best, pnl)
        return role

    def add_batch(self, reports: Iterable[AgentReport]) -> None:
        """Bin a whole mini-batch of trained agents into the archive, then the batch can be dropped."""
        for report in reports:
            self.add(report)

    # -- per-niche reads --------------------------------------------------------------------------

    def occupancy(self, role: str) -> int:
        return self._occupancy[role]

    def champion(self, role: str) -> AgentReport | None:
        return self._champion[role]

    def median_pnl_bps(self, role: str) -> float | None:
        pnls = self._pnls[role]
        return statistics.median(pnls) if pnls else None

    # -- population roll-ups ----------------------------------------------------------------------

    @property
    def total(self) -> int:
        """Admissible agents binned so far (across all niches)."""
        return self._n

    @property
    def ruined(self) -> int:
        """Agents barred by the hard ruin floor (equity path lost ~all the risk budget)."""
        return self._ruined

    @property
    def curve_rejected(self) -> int:
        """Agents barred by the loss-discipline gates (drawdown depth / loss escalation)."""
        return self._curve_rejected

    @property
    def coverage(self) -> float:
        """Fraction of role-niches with at least one occupant (0..1)."""
        filled = sum(1 for r in self._roles if self._occupancy[r] > 0)
        return filled / len(self._roles)

    @property
    def best_pnl_bps(self) -> float:
        return self._best if self._best is not None else 0.0

    @property
    def mean_pnl_bps(self) -> float:
        return self._pnl_sum / self._n if self._n else 0.0


__all__ = ["AgentReport", "NicheArchive"]
