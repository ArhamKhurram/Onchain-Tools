---
title: Hosted vs local mode
description: What actually differs between the hosted web console and the desktop app.
sidebar:
  order: 3
---

OCT runs in two modes. You don't choose a mode with a setting — it's determined
by how you're running OCT:

- **Hosted** — the web console. Multi-user, with sign-in and cross-device sync.
- **Local** — the desktop app. A single user, everything stored on your machine.

Most of the app is identical. Here's what a user actually notices.

## What changes

| | Hosted (web) | Local (desktop) |
| --- | --- | --- |
| **Sign-in** | Required (Supabase — Discord or email) | None; you're always "signed in" |
| **Settings & rooms** | Synced across devices | Stored on your machine |
| **Where your Discord token lives** | Only in your browser — it never touches the server | On your machine |
| **Discord connection** | Runs in your browser, direct to Discord | Runs on your machine |
| **Connection proxy** | Not available | Available (Settings → Tokens) |
| **Settings export** | Excludes secrets (tokens, Telegram creds, Pushover keys) | Includes Discord tokens + Telegram credentials |

## Why the token handling differs

In hosted mode OCT deliberately keeps your Discord token **in your browser
only**. The Discord connection is made directly from your browser to Discord —
the OCT servers never see or store the token. You'll see this stated in the app
wherever you paste a token ("tokens are stored only in this browser and connect
directly to Discord — they never touch our servers").

In local mode there is no server to worry about — the token stays on your own
machine.

## Export & backup

Both modes support **Settings → Help & Features → Backup & Restore**. The one
difference is what's included:

- **Hosted export** never contains sensitive keys — it's safe to share for
  copying preferences, but you'll re-enter tokens on the new device.
- **Local export** *does* include Discord tokens and Telegram credentials (API
  ID, hash, session), so treat that file as a secret. Pushover keys are never
  included in either.
