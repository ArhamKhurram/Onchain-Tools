"""Feature-store contract — ``(token, as_of) -> FeatureBundle`` with EXPLICIT missingness.

This is the leakage firewall boundary (02 §2, §6). The feature store reconstructs, for any
``(mint, as_of)``, exactly the features knowable *at that instant* — nothing that "knows the
future" (04-data-spec.md "Data hygiene"; paper §7). Two rules are encoded in the types:

1. **Missingness is explicit, never imputed.** A feature is a :class:`Feature` carrying both a
   value and a :class:`~oct_trading_agent.core.enums.FeatureStatus`. Consumers MUST branch on
   status; a silently zero-filled "missing" value is the exact bug this design forbids.
2. **Everything is tier-tagged.** A :class:`FeatureBundle` is keyed by
   :class:`~oct_trading_agent.core.enums.FeatureTier` (A raw-chart … E chatter), so an ablation
   can add/remove a whole tier and the leakage guard can be run per tier (03 §Phase 1/2).

The point-in-time computation itself lives in ``featurestore/`` (Wave-1). This module defines
only the value types and the Protocols that layer must satisfy.
"""

from __future__ import annotations

from datetime import datetime
from typing import Generic, Protocol, TypeVar, runtime_checkable

from pydantic import model_validator

from .base import Frozen
from .enums import FeatureStatus, FeatureTier
from .tape import Mint, TapeEvent

# What a single feature slot may hold. Embeddings/text are carried as list[float].
FeatureValue = float | int | bool | str | list[float]

T = TypeVar("T", bound=FeatureValue)


class Feature(Frozen, Generic[T]):
    """A single point-in-time feature value with explicit provenance and missingness.

    Invariant (enforced): ``status == OBSERVED`` iff ``value is not None``. This makes
    "missing" un-fakeable — you cannot present a real value while claiming missing, nor a
    ``None`` while claiming observed.

    ``as_of`` is the instant the value is known as-of; it must never be after the request's
    ``as_of`` (the leakage audit checks this — see :class:`LeakageAudit`).
    """

    value: T | None
    status: FeatureStatus
    as_of: datetime

    @model_validator(mode="after")
    def _check_missingness(self) -> Feature[T]:
        observed = self.status is FeatureStatus.OBSERVED
        if observed and self.value is None:
            raise ValueError("OBSERVED feature must carry a value")
        if not observed and self.value is not None:
            raise ValueError("missing feature must not carry a value (no silent imputation)")
        return self

    @property
    def observed(self) -> bool:
        """True iff a real value is present. Consumers branch on this."""
        return self.status is FeatureStatus.OBSERVED


# A tier's payload: named feature slots. Heterogeneous value types across a tier are fine
# (a tier mixes scalars, counts, and embeddings), so the value parameter is the broad union.
TierFeatures = dict[str, Feature[FeatureValue]]


class FeatureBundle(Frozen):
    """The response of a point-in-time feature request: tier-keyed feature slots for one token.

    Only the tiers unlocked by the current curriculum phase need be present; a tier that is
    requested-but-empty differs from a tier that is absent (the former appears with all-missing
    slots). Consumers read via :meth:`get` and must handle both an absent tier and a missing slot.
    """

    mint: Mint
    as_of: datetime
    tiers: dict[FeatureTier, TierFeatures]

    def get(self, tier: FeatureTier, name: str) -> Feature[FeatureValue] | None:
        """Return a feature slot, or None if the tier or slot is absent."""
        return self.tiers.get(tier, {}).get(name)


@runtime_checkable
class FeatureStore(Protocol):
    """The point-in-time feature-store interface. Implemented in ``featurestore/`` (Wave-1).

    ``userId``-free by design: features are token-scoped, not user-scoped (contrast the OCT
    ``StorageProvider``). The store owns as-of reconstruction and missingness; it MUST NOT read
    any event with ``timestamp > as_of``.
    """

    def assemble(
        self,
        mint: Mint,
        as_of: datetime,
        tiers: frozenset[FeatureTier],
    ) -> FeatureBundle:
        """Reconstruct the requested tiers for ``mint`` as-of ``as_of``. No look-ahead."""
        ...


@runtime_checkable
class PointInTimeFeature(Protocol):
    """The contract a single feature computation must satisfy to be leakage-auditable.

    A feature is a pure function of the tape *up to and including* ``as_of``. The standing
    leakage audit (``featurestore/leakage_audit``) exploits exactly this shape: it runs
    ``compute_as_of`` twice — once with the real past, once with the past PLUS injected future
    events — and asserts the output is **identical**. A feature that "knows the future" changes
    its output when future events are appended, and therefore FAILS the audit (03 §Phase 1
    leakage-guard; paper §7).
    """

    name: str
    tier: FeatureTier

    def compute_as_of(self, tape: list[TapeEvent], as_of: datetime) -> Feature[FeatureValue]:
        """Compute this feature from ``tape`` restricted to events at/before ``as_of``."""
        ...


class LeakageAuditResult(Frozen):
    """Outcome of auditing one feature for future-leakage."""

    feature_name: str
    tier: FeatureTier
    passed: bool
    detail: str | None = None


@runtime_checkable
class LeakageAudit(Protocol):
    """Standing causality test (02 §6 ``featurestore/leakage_audit``; Wave-1 owns the impl).

    The single assertion it must make: *a feature that knows the future must fail the audit.*
    """

    def audit(
        self,
        feature: PointInTimeFeature,
        tape_past: list[TapeEvent],
        tape_future: list[TapeEvent],
        as_of: datetime,
    ) -> LeakageAuditResult:
        """Assert ``feature.compute_as_of`` is invariant to appending ``tape_future``."""
        ...
