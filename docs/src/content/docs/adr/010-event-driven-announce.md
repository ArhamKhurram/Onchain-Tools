---
title: 'ADR-010: Event-driven changelog announcements'
description: Discord announcements fire on pushes that add a dated changelog heading — never on a schedule.
sidebar:
  order: 10
  label: '010 — Announce trigger'
---

**Status:** Accepted

## Context

Releases were shipping unannounced: the bot had a complete announce rail
(`POST /api/v1/bot/announce` rendering branded Components V2 containers) but
nothing called it. A cron would either double-post or miss, and rewording an
already-shipped entry must not re-announce it to everyone.

## Decision

`.github/workflows/announce.yml` fires on pushes to `main` that touch
`CHANGELOG.md`, and no-ops unless the push actually **added** a `## <date>`
heading (pure, unit-tested diff check in `scripts/lib/changelog.mjs`). It
posts through the existing bot announce endpoint — no webhook, no second
Discord login. `workflow_dispatch` offers `dry_run` (preview) and `force`
(backfill). DMs to opted-in users require a deliberate manual `--dm` run — a
push can never DM.

## Consequences

- Exactly one source of truth for what shipped: `CHANGELOG.md`.
- Announcing is part of the merge, not a separate ritual; editing prose
  never re-announces.
- Requires two repo secrets (`OCT_BOT_API_KEY`, `OCT_API_BASE`) and the bot
  online on the backend the workflow points at.
- See [Announcements](../../operations/announcements/) for operations.
