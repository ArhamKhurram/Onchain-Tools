---
title: 'ADR-009: Branch topology — main / dev'
description: Unshipped work lives on dev; dev integrates and nothing merges out of it.
sidebar:
  order: 9
  label: '009 — Branch topology'
---

**Status:** Accepted — amended 2026-08-03 (the `LP-Feats` branch was retired) and
2026-08-07 (the sniper shipped to `main`, so the branch split is no longer a list
of features)

## Context

LP automation (a Foundry/Safe-module workspace plus its dashboard and API
routes) is high-risk, deploys nowhere, and was entangled with production
deploys while it lived on `main`. Production (Railway + Vercel) should ship
without it, but the two halves must still be proven to compose.

The original decision gave LP its own long-lived branch, `LP-Feats`, which
would merge down into `dev`. In practice that never happened: every LP feature
branch merged **straight into `dev`**, and `LP-Feats` was left holding only
seven early scaffolding commits — 93 `lp-automation/` files against `dev`'s
115. It described a workflow nobody followed.

## Decision

Two long-lived branches, distinguished by **intent rather than by a list of
features** — the feature list changes every time something ships, and an ADR that
enumerates it goes stale the moment it does:

- **`main`** — production. Everything it holds is meant to deploy. Railway +
  Vercel.
- **`dev`** — integration branch: `main` plus whatever is not ready to deploy.
  **Nothing merges out of it.**

Production work → PR into `main` → merge `main` down into `dev`. Work that must
not deploy yet → branch off `dev`, PR back into `dev`. **Never merge `dev` into
`main`** — it would push whatever `dev` is currently holding into production.

`LP-Feats` was deleted on 2026-08-03. It held nothing that `dev` did not
already contain; the ref is preserved as the tag `archive/LP-Feats`.

### What is on which branch (2026-08-07)

| Work | Branch | Why |
| --- | --- | --- |
| LP automation (`lp-automation/`, `/api/lp`, the Foundry CI job) | `dev` only | high-risk, deploys nowhere |
| Tweet-triggered sniper (`backend/src/sniper/`, `/sniper/v1`, the console's Sniper tab) | **`main`** — shipped | it ships to users; see [sniper overview](../../architecture/sniper/) |

The sniper's route through this topology is the reason the decision above is
phrased by intent: it was reverted from `main` (#55), lived on `dev`, returned to
`main` dormant (#79), and then shipped. Nothing about the branch rules changed —
only which side of them it sat on.

## Consequences

- The old `feature → dev → main` promotion flow is dead; `dev` exists only to
  prove composition (CI runs there, deploys nowhere).
- `main`'s `.gitignore` ignores `lp-automation/` wholesale so branch
  switching can never stage LP files onto `main`.
- The LP Supabase migration stays on `main` because prod already has the
  table — `main`'s migration set must describe the database it deploys to.
- **The `main` → `dev` sniper-deletion hazard is closed.** From 2026-08-03 to
  #79, merging `main` into `dev` silently deleted `backend/src/sniper/`: `main`
  carried the #55 revert, `dev` carried the module, and the two sides never
  edited the same lines, so the deletion propagated without a conflict. #79
  brought the module back onto `main` and the sniper then shipped, so there is
  no longer a deletion to propagate. The general lesson survives the specific
  hazard: **a revert on `main` propagates downward as a silent deletion**, so
  after any `main` → `dev` merge, check that what `dev` uniquely holds is still
  there.
- See [Branching & workflow](../../contributing/branching/) for the
  contributor-facing version.
