---
title: Settings overview
description: Every settings section at a glance, and how saving works.
sidebar:
  order: 1
---

Everything OCT lets you tune lives under **Settings**, organized into a sidebar
of sections. This page maps them; the deeper pages here cover the two you'll
touch most.

## The sections

| Section | Covers | Documented in |
| --- | --- | --- |
| **Tokens** | Discord tokens, connection proxy, Telegram | [Connect Discord](../../connecting/discord/) · [Telegram](../../connecting/telegram/) |
| **General** | Message display, feed layout, interaction behavior | [General](./general/) |
| **Contracts** | Contract clicks, trading platforms, convergence window, address colors | [Contracts](./contracts/) |
| **Caller Quality** | Manual tiers + earned scores | [Caller quality](../../callers/caller-quality/) |
| **Sounds & Notifications** | Toasts, desktop, sounds | [Notifications](../../alerts/notifications/) |
| **Pushover** | Phone push + missed-runner | [Pushover](../../alerts/pushover/) · [Missed runner](../../alerts/missed-runner/) |
| **Discord Bot** | Alert DMs | [Discord bot](../../alerts/discord-bot/) |
| **Keywords** | Global keyword patterns | [Keywords](../../alerts/keywords/) |
| **Mentions** | @-mention capture | [Keywords & mentions](../../alerts/keywords/#mentions) |
| **Highlighted Users** | Global highlight list | [Interactions](../../feed/interactions/#highlighting-users) |
| **Guilds** | Enable servers + per-server colors | [Rooms & channels](../../feed/rooms/) |
| **Help & Features** | In-app manual + backup/restore | below |

## Saving

Changes are staged as you make them and committed with one **Save** at the
bottom. The bar turns yellow and shows **Unsaved changes** until you save, and
OCT warns you if you try to navigate away or close the tab with unsaved changes.
**Reset** discards staged changes.

## Backup & restore

**Settings → Help & Features → Backup & Restore** exports your settings to a
JSON file and imports them back. What's included depends on your mode:

- **Hosted** — the export **never** contains secrets (Discord tokens, Telegram
  credentials, Pushover keys). Good for copying preferences between accounts.
- **Local (desktop)** — the export **includes** Discord tokens and Telegram
  credentials (API ID, hash, session), so treat the file as sensitive. Pushover
  keys are never included.

The Help & Features section also hosts an in-app manual covering the same ground
as this guide, if you'd rather read it inside the app.
