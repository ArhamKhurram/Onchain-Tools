---
title: General settings
description: Message display, feed layout, and how OCT reacts to clicks.
sidebar:
  order: 2
---

**Settings → General** controls the look of the feed and how OCT behaves when you
click things.

## Display

- **Message Display** — **Cozy** (avatars + full headers) or **Compact** (left
  timestamps, inline usernames). Compact adds a sub-toggle, **Show avatars in
  compact mode**.
- **Feed Layout** — the feed chrome preset: **Terminal** (default, one dense
  status line), **Masthead** (vertical room rail + editorial header), or **Rail**
  (icon rail, densest). See [The Feed](../../feed/feed/#feed-chrome-presets).
- **Split Screen Layout** — **Single row** or **Two rows** for multiple panes.
- **Role Colors** — show Discord role colors on usernames.
- **Mobile Zoom Scale** — a slider (50%–150%) to size the UI on mobile.

## Behavior

- **Contract Detection** — detect SOL/EVM addresses in messages (on by default).
- **Open in Discord App** — clicking a channel badge opens the message in the
  Discord app.
- **Open in Telegram App** — same, for Telegram channel badges.
- **Badge Click Action** — what a channel badge click does: **Discord** (open the
  message), **Platform** (open the contract in your trading platform if one's
  detected, else Discord), or **Both**.

## Chat / sending messages

- **Enable sending messages through OCT** — off by default. Lets you reply and
  send from inside OCT.

:::caution[Detection risk]
Sending messages leaves an API footprint Discord can flag as automated behavior.
The setting carries an explicit warning for this reason — use it at your own risk.
:::
