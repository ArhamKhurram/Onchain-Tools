---
title: 'ADR-002: Browser Discord gateway in hosted mode'
description: The user gateway connection moves into the browser so tokens never touch the server.
sidebar:
  order: 2
  label: '002 — Browser gateway'
---

**Status:** Accepted

## Context

OCT ingests Discord with *user* tokens. In hosted mode, holding many users'
Discord tokens server-side is a serious custody liability: a server breach
leaks accounts, and running many user-gateway connections from one datacenter
IP is a ban-risk fingerprint.

## Decision

In hosted mode the full Discord gateway client runs **in the browser**
(`frontend/src/discord/browserGateway.ts` — a deliberate near-clone of the
backend gateway): direct `wss://gateway.discord.gg` plus Discord REST from
the user's own IP. The token stays client-side. Detected contracts and Rick
embeds are POSTed to the backend (`/api/contracts*`) so server-side
enrichment, cataloging, and fan-out still happen. The backend WS keeps
serving Telegram, FOMO, and enrichment frames (`skipDiscordWs`).

## Consequences

- Discord tokens never hit the server in hosted mode; the encrypted
  `discord_tokens` table is legacy/API parity, not the gateway path.
- Each user's gateway traffic originates from their own residential IP.
- Two gateway implementations must be kept in lockstep (accepted cost; the
  public surfaces are intentionally identical).
- The browser twin cannot see rejected WebSocket upgrades, so IP-block
  fast-fail exists only server-side.
- Hosted mode and browser-gateway mode are **the same mode** — there is no
  supported hosted configuration with a server-side Discord user gateway.
