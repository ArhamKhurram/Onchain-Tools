---
title: Message interactions
description: What you can do with a message and a caller — highlight, hide, reply, tier, and contract clicks.
sidebar:
  order: 3
---

Most of OCT's per-message power is in the right-click menu and the contract
badges. Here's what's available.

## Right-click a message

- **Highlight / un-highlight the user** — see below.
- **Hide the user** — collapse their messages in that channel (reversible from
  the hidden-users panel).
- **Quick reply** — reply inline, if [message sending](../../settings/general/#chat--sending-messages)
  is enabled.
- **Set caller tier** — mark the caller as trusted (star) or muted, feeding
  [caller quality](../../callers/caller-quality/). A tier set inside a room
  applies to that room; set it from a global context to apply everywhere.

## Highlighting users

Highlighting makes a user stand out wherever they post. Two ways to set it:

- **Per room** — in the room's **Users** tab, with a per-user color and a
  highlight style (**Background** or **Username Color**).
- **Globally** — in **Settings → Highlighted Users**, applied across every room.

Use Discord user IDs or Telegram `@usernames`. You can also enable
**auto-open highlighted contracts** so a new tab opens whenever a highlighted
user posts a contract address (Settings → Contracts).

## Contract badges

When OCT detects a contract address in a message, it becomes a clickable badge.
What a click does is up to you (**Settings → Contracts**):

- **Contract Click Action** — **Copy**, **Copy + Open** (default), or
  **Open Only**.
- **Trading platform** — where "Open" sends you: pick a SOL platform (Axiom,
  Padre, Bloom, GMGN, or a custom URL) and an EVM platform (GMGN, Bloom, or
  custom).

Channel badges (the little source tags) can also open the original message
directly in the Discord or Telegram app — see
[General settings](../../settings/general/).

## Contract detection

Detection is on by default and can be toggled at
**Settings → General → Contract Detection**. It recognizes both SOL and EVM
addresses. Every detected contract also flows into
[Callers](../../callers/contracts/) and the [Radar](../../callers/radar/).
