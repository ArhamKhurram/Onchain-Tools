"""Admission gates for the QD selection layer — survival + loss discipline. TORCH-FREE, pure.

Operator directives (2026-08-24): an agent that ruins — loses (nearly) all of its risk budget on the
held-out equity path — must NEVER hold an archive niche or serve as a champion or an exploit source;
and among survivors, selection should prefer equity curves whose losses are small, bounded,
stable-size "premiums" over curves with deep retraces or escalating (martingale-style) loss sizes.

What is deliberately NOT gated: curve SHAPE. In a fat-tailed market a positive-skew (barbell)
strategy legitimately looks like a long flat-or-bleeding stretch punctuated by rare sudden step-ups —
shape alone cannot separate that skill profile from luck, so there is no smoothness / monotonicity /
ulcer-style score here. The gate reads exactly three things off :class:`~.descriptor.CurveMetrics`:

1. **Ruin floor** (hard): the equity path's minimum breached ``ruin_floor`` of the starting budget.
2. **Drawdown depth**: the deepest peak-to-trough retrace exceeded ``max_drawdown`` budget units.
3. **Loss escalation**: the tail half of the realized-loss sequence is ``max_loss_escalation``×
   larger than the early half (the doubling-down signature) — computed only once there are enough
   losses to say so (:data:`~.descriptor.MIN_LOSSES_FOR_ESCALATION`).

Thresholds default LOOSE on purpose (calibrate-loose directive): with 40–300 held-out tokens a real
rare-event strategy may catch only 1–2 runners per window, and a tight gate would false-negative
genuine skill. Concentration/repeatability diagnostics are RECORDED on the champion telemetry
(``pnl_share_top``, ``pnl_split_bps``), never gated on. Applies identically to MAP-Elites admission
(:class:`~.map_elites.EliteArchive`), PBT champion selection (:class:`~.archive.NicheArchive`), and
PBT exploit-source selection (:func:`~.pbt.select_exploit_explore`).
"""

from __future__ import annotations

from dataclasses import dataclass

from .descriptor import BehaviorProfile

#: Verdict strings — ``None`` from :func:`admission_verdict` means admissible.
VERDICT_RUINED = "ruined"
VERDICT_DRAWDOWN = "drawdown"
VERDICT_LOSS_ESCALATION = "loss_escalation"


@dataclass(frozen=True)
class AdmissionConfig:
    """The admission-gate thresholds (all relative to the starting risk budget; loose by default)."""

    enabled: bool = True
    #: Equity floor as a fraction of the starting budget: min-equity at or below this is RUIN
    #: (default 0.2 = the path lost 80% of the budget — "lost all their sol", with a margin).
    ruin_floor: float = 0.2
    #: Deepest tolerated peak-to-trough retrace, in budget units (0.5 = half the budget).
    max_drawdown: float = 0.5
    #: Max tolerated tail/early mean-loss ratio before the martingale signature is called.
    max_loss_escalation: float = 3.0


def admission_verdict(profile: BehaviorProfile, cfg: AdmissionConfig) -> str | None:
    """The single admission rule (pure): ``None`` = admissible, else the failed gate's verdict.

    Checked in severity order — ruin first (a ruined agent is ruined regardless of how it got
    there), then drawdown depth, then loss escalation.
    """
    if not cfg.enabled:
        return None
    curve = profile.curve
    if curve.min_equity <= cfg.ruin_floor:
        return VERDICT_RUINED
    if curve.max_drawdown > cfg.max_drawdown:
        return VERDICT_DRAWDOWN
    if curve.loss_escalation > cfg.max_loss_escalation:
        return VERDICT_LOSS_ESCALATION
    return None


def is_admissible(profile: BehaviorProfile, cfg: AdmissionConfig) -> bool:
    """``True`` iff ``profile`` passes every admission gate (the boolean face of the verdict)."""
    return admission_verdict(profile, cfg) is None


__all__ = [
    "VERDICT_RUINED",
    "VERDICT_DRAWDOWN",
    "VERDICT_LOSS_ESCALATION",
    "AdmissionConfig",
    "admission_verdict",
    "is_admissible",
]
