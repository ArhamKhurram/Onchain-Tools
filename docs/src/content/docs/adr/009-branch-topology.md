---
title: 'ADR-009: Branch topology — main / dev / LP-Feats'
description: LP automation lives on its own branch; dev integrates and nothing merges out of it.
sidebar:
  order: 9
  label: '009 — Branch topology'
---

**Status:** Accepted

## Context

LP automation (a Foundry/Safe-module workspace plus its dashboard and API
routes) is high-risk, deploys nowhere, and was entangled with production
deploys while it lived on `main`. Production (Railway + Vercel) should ship
without it, but the two halves must still be proven to compose.

## Decision

Three long-lived branches:

- **`main`** — production, no LP. Deploys to Railway + Vercel.
- **`LP-Feats`** — LP automation + LP dashboard only.
- **`dev`** — integration branch: `main` ∪ `LP-Feats`. **Nothing merges out
  of it.**

Non-LP work → PR into `main` → merge `main` down into `dev`. LP work → PR
into `LP-Feats` → merge down into `dev`. **Never merge `dev` into `main`** —
it would drag `lp-automation/` back into production.

## Consequences

- The old `feature → dev → main` promotion flow is dead; `dev` exists only to
  prove composition (CI runs there, deploys nowhere).
- `main`'s `.gitignore` ignores `lp-automation/` wholesale so branch
  switching can never stage LP files onto `main`.
- The LP Supabase migration stays on `main` because prod already has the
  table — `main`'s migration set must describe the database it deploys to.
- See [Branching & workflow](../../contributing/branching/) for the
  contributor-facing version.
