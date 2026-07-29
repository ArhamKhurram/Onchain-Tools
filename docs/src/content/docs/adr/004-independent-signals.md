---
title: 'ADR-004: Signals stay independent'
description: Convergence, FOMO buys, missed-runner, and caller quality are distinct detections, never fused.
sidebar:
  order: 4
  label: '004 — Independent signals'
---

**Status:** Accepted

## Context

It is tempting to build one composite "alpha score" that blends contract
calls, FOMO trader buys, convergence, and caller quality. Fused scores are
opaque: when one input misbehaves (a provider outage, a scoring bug) the
whole signal degrades and nobody can tell why.

## Decision

Each signal is an independent detection with its own inputs, thresholds, and
delivery: convergence (call + tracked buy in a window), FOMO trades,
missed-runner (MC multiple + zero balance), caller quality (per-caller
historical performance). They are routed and displayed together but the
underlying detections never feed each other. Caller quality is explicitly a
display/filter layer, not an input to convergence.

## Consequences

- Any signal can be disabled, debugged, or re-tuned in isolation.
- The UI carries the burden of composition (showing signals side by side)
  instead of the detection layer.
- Feature requests of the form "boost convergence when the caller is elite"
  are rejected by design; build a new independent signal instead if needed.
