---
title: Notifications & sounds
description: On-site toasts, desktop notifications, and the four sound channels.
sidebar:
  order: 1
---

OCT can get your attention three ways on the device you're using — toasts,
desktop notifications, and sounds — all in **Settings → Sounds & Notifications**.
For phone push, see [Pushover](./pushover/); for Discord DMs, see the
[Discord bot](./discord-bot/).

## On-site toasts

Toggle **on-site toast alerts** to get in-app popups for highlighted users,
contracts, keywords, and convergence. Pick where they appear with **Toast
position** — top/bottom × left/center/right, or center (default is top-right).

## Desktop notifications

Toggle **Desktop Notifications** to get browser notifications when the tab isn't
focused. Enabling it asks for your browser's notification permission; if you've
blocked it, OCT will tell you.

## Sounds

A master **Enable notification sounds** toggle gates four independent sound
channels — each with its own on/off, a preview button, a **volume** slider, and
a **sound source**:

| Channel | Fires on |
| --- | --- |
| **Highlighted User** | A highlighted user posts |
| **Contract Alert** | A contract is detected |
| **Keyword Match** | A keyword pattern matches |
| **FOMO Trade** | A tracked trader trades |

**Sound source** is one of:

- **Default** — the built-in tone.
- **Preset** — one of ten built-in tones (Ping, Double Ping, Rising Chime,
  Falling Chime, Pop, Alert, Bell, Chirp, Deep, Sparkle).
- **Custom** — upload your own (`.mp3`, `.wav`, `.ogg`, `.webm`, `.m4a`).

## Per-channel sounds

Further down, **Channel Sounds** plays a sound for **every message** in specific
channels — even without a highlight or keyword. Channels are grouped by server;
click one to enable it, then set the same volume and source controls. Handy for a
single must-not-miss channel.
