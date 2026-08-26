# 08 — Feature-store performance: scope

**Status:** scoped, not started. Written 2026-08-26 after rollout vectorization landed.

## Why this is next

Vectorizing the rollout collector (`480e5ec`) removed 68x of the CUDA collector's own cost —
2,723 → 40 µs/env-step, 5,949 forwards per collect → 33. That moved the bottleneck rather than
removing it:

| | sequential | vectorized |
| --- | ---: | ---: |
| collector (prep + net) | 2,723 µs/env-step | **40 µs** |
| `env.step` share of an iteration | 11.8% | **87.6%** |

So `env.step` is now ~77–88% of ladder iteration time. Nothing else is worth optimizing until it is.

## Where the time actually goes

`TradingEnv.step` (`agent/envs/env.py`) calls `_observe()` twice — once as `pre_obs` (:217) and once
as `next_obs` (:255). `_observe` calls `PointInTimeFeatureStore.assemble(mint, as_of, tiers)`, whose
first act is:

```python
scoped = [e for e in self._tape if e.mint == mint and e.block_time <= as_of]
```

Measured on the deepest real tape in `market_dataset_snap800` (7,582 events, Tier-A only, median of
10 calls per depth):

| depth | `assemble` | scoping scan alone | scan share |
| ---: | ---: | ---: | ---: |
| 10 | 973 µs | 303 µs | 31% |
| 50 | 301 µs | 307 µs | **102%** |
| 200 | 409 µs | 303 µs | 74% |
| 600 | 620 µs | 296 µs | 48% |
| 1200 | 926 µs | 305 µs | 33% |

**Two independent costs, and they need different fixes:**

1. **A flat ~300 µs scoping scan.** It is flat because it walks the *entire* tape on every call,
   regardless of `as_of`. This is pure waste and dominates at the shallow depths where most steps
   happen.
2. **An O(depth) feature cost** stacked on top: each of the six Tier-A features re-walks the scoped
   slice. This is what makes an episode quadratic in its own length and what caused the incumbent
   run to *decelerate* as the policy learned to hold.

## Tier 1 — safe, and probably most of the win

**1a. Index the tape by mint once, and cut with `bisect`.**
The store is handed the full multi-mint tape and re-derives the same per-mint, time-clipped slice on
every call. Build `dict[Mint, list[TapeEvent]]` sorted by `block_time` in `__init__`; then the cut is
`bisect_right(times, as_of)` — O(log N) instead of O(N). Removes the flat ~300 µs.

**1b. Cache the bundle on `as_of` with a one-entry cache.**
`next_obs` at step *i* and `pre_obs` at step *i+1* resolve to the **same** `as_of`, so consecutive
steps recompute an identical `FeatureBundle`. The surrounding `Observation` still differs (position,
balance, `steps_elapsed_frac` all change), so only the bundle is cacheable — but the bundle is the
expensive part. A one-entry cache halves `assemble` calls.

Neither touches the leakage firewall: the same events reach each feature, in the same order, and
every feature still re-applies its own `block_time <= as_of` filter.

**Expected:** removes the flat term and halves the calls. Roughly 2–4x on `env.step` at typical
depth, with no change to the causality contract.

## Tier 2 — moderate risk

**Pass a view, not a copy.** Even with Tier 1, the slice is *materialized* per call — O(depth)
allocation and copying. Passing `(events, hi)` and having features iterate `events[:hi]` without
copying removes it.

This changes the `PointInTimeFeature.compute_as_of` signature, which is a documented audit surface.
Doable, but it is an interface change and the leakage audit must be re-run and re-certified.

## Tier 3 — real risk, do not start without a decision

**Incremental features with a monotonic cursor.** Within an episode `as_of` only advances, so each
feature could maintain running state and update in O(1) amortized rather than recomputing from the
slice. This is the only fix that removes the quadratic term outright.

It also **dissolves the property the feature store exists to guarantee.** Today causality is
enforced twice — once by the store's clip, once inside each feature — and the standing leakage audit
(`featurestore/leakage_audit`) certifies the second. An incremental feature has *memory*, so
"this function cannot see the future" stops being checkable by inspection and becomes a claim about
state management. That is a research-integrity change, not a perf change, and it should be argued
explicitly in `02-technical-design.md` before any code moves.

## Recommendation

Do **Tier 1 only**, measure, and stop. It is contained, it needs no change to the causality contract,
and the measurements say it removes the term that dominates at the depths most steps occur at.
Re-measure `env.step`'s share afterward before deciding whether Tier 2 is worth its audit cost.

Do not do Tier 3 as a performance task.

## How to verify any of this

`scripts/bench_rollout_vectorization.py` (`db2685d`) already measures the collector/env split
end-to-end on the real ladder path. Extend it rather than writing a new harness, and report the
`env.step` share before and after — the share, not the microbenchmark, is the number that matters.
