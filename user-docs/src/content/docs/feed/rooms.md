---
title: Rooms & channels
description: How rooms group your channels, and how to build and configure them.
sidebar:
  order: 1
---

A **room** is the core organizing unit of OCT: a named set of Discord and/or
Telegram channels streamed together into one view. You might have a room for
"SOL alpha," another for "ETH majors," another for a single high-signal server.

## Enable your servers first

Servers (guilds) are **off by default**. Before a channel can go in a room, its
server has to be enabled in **Settings → Guilds** — this keeps the channel
picker from listing every server you've ever joined. The Guilds screen is a
searchable checklist showing how many channels each server has.

## Create a room

In the Feed, press **⌘K** (Ctrl-K) to open the room palette, then choose
**NEW ROOM**. You'll configure it through four tabs:

### Channels

- **Room Name** and a **Room Background Color** (with a Reset).
- **Hotkey** — press-to-capture a single key that jumps straight to this room
  from anywhere (outside a text field). Backspace/Delete/Escape clears it.
- **Channel picker** — search and select channels. Discord channels are grouped
  by server, plus a **Direct Messages** group. Selected channels show **ADDED**.
  If you have servers but none enabled, an inline panel lets you enable them
  right here.
- **Embeds per channel** — toggle **EMBEDS ON / OFF** per channel to show or
  hide rich embeds.
- **Discord / Telegram toggle** — appears when Telegram is connected; switches
  the picker to your Telegram chats (labelled **CH / SG / GP**).

### Filter

An allow-list for the room: when **Filter active** is on, only messages from the
users you list appear. Add users by Discord ID or username. (Tip: click a
username in chat to copy their ID.)

### Keywords

Room-specific [keyword alerts](../../alerts/keywords/) using the same
Contains / Exact / Regex modes as global keywords. Note: if keyword matching is
disabled globally, room keywords won't fire until you enable it.

### Users

Per-room [highlighted users](../../feed/interactions/#highlighting-users). Pick a
**Highlight Style** — **Background** (colored background + left border) or
**Username Color** (just the name, like a Discord role) — and give each user a
color.

## Colors for mixed rooms

When a room blends several servers, per-server **Guild Message Colors** (in
**Settings → Guilds**) tint each source so you can tell them apart at a glance.
The same exists for DMs and Telegram chats.
