---
title: Discord bot DMs
description: Have OCT's bot DM you your alerts on Discord.
sidebar:
  order: 3
---

OCT has its own Discord bot that can **DM you** your alerts — personal direct
messages only, never posted in any channel. Set it up in
**Settings → Discord Bot**.

## Requirements

- Sign in to OCT **with Discord** (or link your Discord account).
- Share a server with the OCT bot.
- Run **`/ping`** in Discord to confirm the bot is online and can reach you.

## Turn it on

Enable **Send me alerts on Discord**, then choose what to DM:

- Highlighted user posts a contract *(on by default)*
- Any message from a highlighted user
- Any contract detected
- Keyword match
- **Missed runner** *(on by default)*

Below a divider, **Release notes** (off by default) DMs you when OCT ships an
update.

:::note[Convergence isn't available over DM]
[Signal convergence](../../fomo/convergence/) alerts are browser-only — they
can't be delivered by the bot. Use [Pushover](./pushover/) or an on-site toast
for those.
:::
