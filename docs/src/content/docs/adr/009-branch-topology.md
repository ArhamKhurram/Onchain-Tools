---
title: 'ADR-009: Branch topology — main / dev'
description: Unshipped work lives on dev; dev integrates and nothing merges out of it.
sidebar:
  order: 9
  label: '009 — Branch topology'
---

**Status:** Accepted — amended 2026-08-03 (the `LP-Feats` branch was retired) and
2026-08-07 (the sniper shipped to `main` and LP automation was deleted, so the
branch split is no longer a list of features)

:::note[2026-08-07 amendment]
**Both original tenants of the split are gone.** The sniper shipped to `main`
(#79, then #81), and LP automation was retired outright in #80 rather than
shipped — workspace, dashboard, `/api/lp` routes and Foundry CI job deleted.

The topology below still stands, but read Context and Decision as the historical
record of *why* the split was made, not as a description of what is on either
branch today. The rule that survives is the intent: `main` holds what is meant to
deploy, `dev` holds what is not yet.

The database side of the LP removal is recorded in
`supabase/migrations/20260807120000_drop_lp_automation_worker_tables.sql`: the ten
LP migration files were left in place (applied history is append-only) and a new
migration drops the two dev-only worker tables. `lp_automation_policies` survives
on both branches for the reason given in the Consequences below.
:::

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
| LP automation (`lp-automation/`, `/api/lp`, the Foundry CI job) | **nowhere** — deleted (#80) | retired without shipping |
| Tweet-triggered sniper (`backend/src/sniper/`, `/sniper/v1`, the console's Sniper tab) | **`main`** — shipped | it ships to users; see [sniper overview](../../architecture/sniper/) |
| Launch video (Remotion compositions) | `dev` only | not a deployable artifact |

The sniper's route through this topology is the reason the decision above is
phrased by intent: it was reverted from `main` (#55), lived on `dev`, returned to
`main` dormant (#79), and then shipped. LP took the other exit — it was deleted
rather than promoted. Nothing about the branch rules changed in either case; only
which side of them the work sat on.

## Consequences

- The old `feature → dev → main` promotion flow is dead; `dev` exists only to
  prove composition (CI runs there, deploys nowhere).
- `main`'s `.gitignore` still ignores `lp-automation/` wholesale. Harmless now
  that the workspace is gone from both branches, and cheap insurance against an
  old branch or worktree staging LP files back onto `main`.
- The `lp_automation_policies` migration stays on `main` because prod already has
  the table — `main`'s migration set must describe the database it deploys to.
  `dev` keeps it for the same reason plus one more: dropping it there would make
  `dev`'s schema diverge from `main`'s to no purpose, since nothing on either
  branch reads it any more.
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
