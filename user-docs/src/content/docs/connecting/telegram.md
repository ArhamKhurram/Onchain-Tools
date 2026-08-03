---
title: Connect Telegram
description: Get your Telegram API credentials and connect through the setup wizard.
sidebar:
  order: 2
---

Telegram is optional, but if the calls you care about happen in Telegram groups
and channels, connecting it streams them into the same rooms as your Discord
feeds.

## Get your API credentials

Telegram requires an API ID and hash tied to your account:

1. Go to **[my.telegram.org/apps](https://my.telegram.org/apps)** and log in.
2. Create an application (any name/short-name works).
3. Copy the **API ID** (a number) and **API Hash**.

## Run the setup wizard

**Settings → Tokens → Connect Telegram** opens a short wizard:

1. **Credentials** — enter your **API ID**, **API Hash**, and **Phone Number**
   (with country code, e.g. `+1234567890`). Click **Send Verification Code**.
2. **Verification code** — Telegram sends a code to your Telegram app. Enter it
   and click **Verify Code**.
3. **Two-factor** — *only if your account has 2FA.* Enter your Telegram password
   and click **Submit Password**.
4. **Done** — you're connected. You can now add Telegram chats to your rooms.

:::note
The verification step is time-sensitive — if you don't finish within about five
minutes, the pending login is cleaned up and you'll need to request a new code.
:::

## Managing the connection

Back in **Settings → Tokens**, the Telegram panel shows one of three states:

- **Telegram connected** (green) — with a **Disconnect Telegram** button.
- **Configured but not connected** (yellow) — with **Remove Telegram Session**.
- **Not connected** — with the **Connect Telegram** button.

## Using Telegram chats

Once connected, open a room's settings and use the **Discord / Telegram** toggle
in the **Channels** tab to browse your Telegram chats. They're labelled by type
— **CH** (channel), **SG** (supergroup), **GP** (group). From there Telegram
works like Discord throughout OCT: per-chat colors, sounds, and highlighted
users (by `@username`). See [Rooms & channels](../../feed/rooms/).

## A note on storage

Your Telegram credentials (API ID, hash, and session) are stored encrypted. In
**local mode** they're included if you export your settings, so treat that
export file as a secret. In **hosted mode** they're never included in exports.
