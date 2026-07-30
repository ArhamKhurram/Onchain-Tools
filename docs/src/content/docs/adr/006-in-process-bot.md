---
title: 'ADR-006: In-process Discord bot'
description: The OCT bot runs inside the backend process rather than as a separate service.
sidebar:
  order: 6
  label: '006 — In-process bot'
---

**Status:** Accepted

## Context

The OCT bot needs the same data the backend already holds: FOMO client,
token snapshots, storage, and the live alert stream. Running it as a separate
microservice would require an HTTP surface for all of that, a second deploy
target, and a forwarding channel for alerts.

## Decision

The bot runs in-process (`backend/src/bot/`): command handlers call
`bot/service.ts` directly, and alert DMs subscribe to the single
`WsServer.onAlert` seam so no alert emission site changed. It self-gates on
`DISCORD_BOT_TOKEN` and swallows every failure — a bot problem must never
take down ingestion, the API, or the WS. A thin machine-auth HTTP surface
(`/api/v1/bot/*`) exists for *external* consumers (e.g. the changelog
announce workflow), not for the bot itself.

## Consequences

- Zero-latency access to services and one deploy target; the bot inherits
  backend restarts (accepted: Discord interactions tolerate brief gaps).
- The bot lives wherever the backend runs with the token set — hosting the
  bot elsewhere means either extracting it (alert forwarding + announce
  relocation) or running a second backend.
- Slash-command *registration* is still out-of-band
  (`npm run bot:deploy -w backend`).
