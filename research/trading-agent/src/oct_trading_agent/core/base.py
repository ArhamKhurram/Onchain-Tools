"""Base model config shared by every contract type.

All contracts are frozen (immutable) and forbid extra fields: a tape event or a decision
is a value, not a mutable bag, and a typo in a field name should fail loudly rather than
silently attach an ignored attribute.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class Frozen(BaseModel):
    """Immutable, strict-schema pydantic base for all shared contracts."""

    model_config = ConfigDict(frozen=True, extra="forbid")
