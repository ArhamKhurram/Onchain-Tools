---
title: 'ADR-009: Branch topology — main / dev'
description: Unshipped work lives on dev; dev integrates and nothing merges out of it.
sidebar:
  order: 9
  label: '009 — Branch topology'
---

**Status:** Accepted — amended 2026-08-03 (the `LP-Feats` branch was retired)

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

Two long-lived branches:

- **`main`** — production, no LP and no sniper. Deploys to Railway + Vercel.
- **`dev`** — integration branch: everything. **Nothing merges out of it.**

Production work → PR into `main` → merge `main` down into `dev`. LP and sniper
work → branch off `dev`, PR back into `dev`. **Never merge `dev` into `main`** —
it would drag `lp-automation/` and the sniper back into production.

`LP-Feats` was deleted on 2026-08-03. It held nothing that `dev` did not
already contain; the ref is preserved as the tag `archive/LP-Feats`.

## Consequences

- The old `feature → dev → main` promotion flow is dead; `dev` exists only to
  prove composition (CI runs there, deploys nowhere).
- `main`'s `.gitignore` ignores `lp-automation/` wholesale so branch
  switching can never stage LP files onto `main`.
- The LP Supabase migration stays on `main` because prod already has the
  table — `main`'s migration set must describe the database it deploys to.
- **Merging `main` into `dev` deletes the sniper module.** `main` reverted the
  dormant sniper in #55; that revert propagates down and removes all 26 sniper
  files with no conflict, because `dev`'s copy and the revert's deletion have
  no overlapping edits. Verify `backend/src/sniper/` survives every `main` →
  `dev` merge and restore it from the pre-merge commit if not.
- See [Branching & workflow](../../contributing/branching/) for the
  contributor-facing version.
