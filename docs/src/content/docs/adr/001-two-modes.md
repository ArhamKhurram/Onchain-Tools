---
title: 'ADR-001: Two deployment modes'
description: One codebase serves both a single-user desktop app and a multi-tenant hosted service.
sidebar:
  order: 1
  label: '001 — Two modes'
---

**Status:** Accepted

## Context

OCT ships as an Electron desktop app (one user, their own machine, their own
tokens) *and* as a hosted web service (many users, Railway + Vercel,
Supabase). Maintaining two backends would duplicate the entire ingest and
enrichment pipeline.

## Decision

One codebase with a single mode switch: `OCT_MODE=local` (default) vs
`OCT_MODE=hosted`, read through exactly one backend function
(`isHostedMode()`) and one frontend signal (`VITE_SUPABASE_URL` present).
Everything mode-dependent — storage, auth, gateway placement, encryption,
bind address, middleware hardening — branches off that switch.

## Consequences

- The desktop app and the SaaS share every feature and every bug fix.
- Every contributor must internalize the two-mode table before touching
  anything ([Two deployment modes](../../architecture/two-modes/)).
- Local mode's "no auth, loopback only" stance is load-bearing
  ([ADR-008](../008-local-loopback/)).
- Features that only make sense hosted (FOMO fan-out, missed-runner,
  multi-tenant tables) self-gate on Supabase presence rather than on the mode
  flag directly, so a local server still runs cleanly.
