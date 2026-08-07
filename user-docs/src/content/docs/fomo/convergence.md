---
title: Signal convergence
description: When your feeds and a tracked trader agree on the same token.
sidebar:
  order: 2
---

**Convergence** is OCT's headline signal. It fires when two *independent* things
line up:

1. A contract gets **called in your feeds**, and
2. A **trader you track** on fomo.family **buys the same token**,

…within a time window you set. The idea: chatter is cheap, and so is one trader's
buy — but the two agreeing, close together, is worth a look.

## Turn it on

The window is set at **Settings → Contracts → Signal Convergence Window** — a
value in minutes (1–240, default 30). A convergence is raised when a fed contract
and a tracked FOMO buy of the same token happen within that many minutes of each
other.

## Where it shows up

- A **convergence badge** appears on the token in the
  [contract feed](../../callers/contracts/).
- You can be alerted the moment it happens — turn on the **Signal convergence**
  trigger under [Pushover](../../alerts/pushover/).

:::note[Not available over Discord DM]
Convergence alerts are browser-only — they're **not** delivered through the
[Discord bot DMs](../../alerts/discord-bot/). Use Pushover (or an on-site toast)
if you want to be notified while away from the console.
:::

## Why it's kept separate

Convergence, FOMO buys, and missed runners are three distinct signals by design.
OCT shows them together but never fuses the underlying detections — so a
convergence badge always means the same specific thing: feed + tracked buy, same
token, inside your window.
