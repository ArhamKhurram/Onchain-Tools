---
title: The Feed
description: Panes, layouts, the room palette, search, focus mode, and hiding users.
sidebar:
  order: 2
---

The Feed is where your rooms stream live. It's built for density — multiple
panes, fast switching, and a lot of keyboard control.

## The room palette (⌘K)

Press **⌘K** (Ctrl-K) anywhere in the Feed to open the room palette — a fuzzy
"jump to room" launcher. It lists your rooms (with unread badges) and quick
actions: **NEW ROOM**, **EDIT ROOM**, and **EDIT / EXIT PANE LAYOUT**. Navigate
with ↑↓, open with Enter, close with Esc.

You can also assign a **hotkey** to any room (in its Channels settings) to jump
straight to it without the palette.

## Panes

The Feed shows **up to four panes** side by side, each on its own room. Each
pane has a header with a room switcher and a row of controls:

- **Search messages** (Ctrl+F)
- **Room settings** (the gear)
- **Pop out** the pane into its own window
- **Move left / right** and **Lock / Unlock** (in layout-edit mode)
- **Add pane** (up to 4) and **Close pane**

Enter layout-edit mode from the ⌘K palette to drag panes around and resize.

## Layouts

Two arrangements, set in **Settings → General → Split Screen Layout**:

- **Single row** — panes side by side in one row.
- **Two rows** — a grid, better for four panes.

There's also a per-pane **Single row / Two rows** toggle in the pane header.

## Feed chrome presets

**Settings → General → Feed Layout** changes the look of the bar across the top
of the Feed:

- **Terminal** (default) — one dense status line; rooms via ⌘K.
- **Masthead** — a vertical room rail with a large editorial room header.
- **Rail** — an icon rail with inline room dividers and a bottom status bar. The
  densest option.

Whichever you pick, the status line surfaces the same essentials: the active
room and channel count, a **CA** link to the contract feed, highlighted-user and
unread counts, Discord/Telegram connection dots, and the ⌘K button.

## Reading behavior

- The view auto-sticks to the newest message. Scroll up and it freezes so you
  can read — a **"{n} new messages — Jump ↓"** pill appears, and a banner offers
  **Jump To Present**.
- **Search** (Ctrl+F) shows a live match count; Enter / Shift+Enter jump between
  matches, Esc closes.

## Focus mode

A pane's header shows a **Focus** badge that collapses the pane to a single
channel — useful when one channel in a busy room is the one you care about right
now.

## Hiding users

Right-click a message to **hide** that user in a channel (see
[Message interactions](./interactions/)). Hidden users are listed in a small
panel per channel, each with an unhide button — nothing is deleted, just
collapsed out of view.
