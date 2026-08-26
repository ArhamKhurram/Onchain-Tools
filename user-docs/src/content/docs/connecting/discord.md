---
title: Connect Discord
description: Find your Discord token, paste it into OCT, and understand how it's handled.
sidebar:
  order: 1
---

Connecting Discord is what turns OCT into *your* console — the Feed, contract
detection, Callers, and most alerts all run off your Discord stream.

:::tip[You can look before you connect]
You don't have to do this first. Open **Feed** and press **Watch the live demo
feed** to see the whole console working on sample data, with nothing connected.
See the [quick start](../../getting-started/quick-start/).
:::

:::caution[Self-bots and Discord's Terms of Service]
OCT connects using your personal **user token**, which Discord's Terms of
Service disallow ("self-bots"). This is the same trade-off every feed-aggregator
of this kind makes. Use it at your own risk, and never share your token — anyone
with it has full access to your account.
:::

## Where you paste it

Two places, same result:

- **Feed.** With no token configured, the Feed page *is* the connect screen:
  a **Discord Token** field, a **Connect** button, and the trust panel described
  below. This is where new users land.
- **Settings → Tokens.** The field is labelled **"Paste Discord token…"** with a
  show/hide eye toggle. Paste, press Enter (or the **+** button), and OCT
  connects. Use this to add or replace a token later.

## What the connect screen tells you

Under the token field, OCT shows a short **Where your token goes** panel:

- A diagram — **your browser → Discord** — with **OCT servers** crossed out on
  the hosted console. Nothing carrying your token is sent to us, and the panel
  invites you to check: open DevTools → Network and watch.
- An expandable **How do I get my Discord token?** section with the extraction
  steps.
- A plain-English note that this is user-account automation and where Discord
  stands on it.

## How to find your token

1. Open **discord.com/app** in your browser and log in.
2. Open your browser's **Developer Tools** (F12) and go to the **Network** tab.
3. Refresh the page.
4. In the request filter, type **`@me`**.
5. Click one of the matching requests and find the **Request Headers**.
6. Copy the value of the **`authorization`** header — that's your token.

Paste it into the Feed connect screen or **Settings → Tokens**.

The in-app panel gives the same steps with a `/api` request filter instead of
`@me` — either filter surfaces requests carrying the same `authorization`
header, so use whichever shows results first.

:::caution[Don't screenshot this step]
The `authorization` header **is** your token. A screenshot of that Network-tab
panel is as good as handing someone your account, so don't paste one into a
support thread or an issue.
:::

## Multiple accounts

You can add more than one token. Each shows as a masked entry with an index
badge (`#1`, `#2`, …). All the servers and channels across every token become
available when you build rooms — so you can monitor several accounts side by
side. Remove a token with the trash icon. If a token stops working, OCT flags it
with a red **Invalid** badge.

## Where your token lives

On the **hosted web console**, your token is stored **only in your browser**,
and the Discord connection is made **directly from your browser to Discord**. It
never touches the OCT servers. You'll see this stated right above the token
field. On the **desktop app** the token stays on your own machine. Either way,
OCT is the only thing holding it. See [Hosted vs local](../../getting-started/hosted-vs-local/).

## Connection proxy (desktop only)

If Discord won't load over a VPN, the desktop app has a **Connection** panel in
**Settings → Tokens** where you can route the connection through an HTTP/HTTPS
proxy (`http://user:pass@host:port`). Leave it blank to connect directly. SOCKS
proxies aren't supported. This panel doesn't appear on the hosted console.

## Next

Once a token connects and you have no rooms yet, the Feed shows an **Almost
there** card with a **Create your first room** button — follow it. The channel
picker lets you enable your servers inline if none are enabled yet, so the
**Settings → Guilds** detour is optional.

- [Build a room](../../feed/rooms/).
- [Connect Telegram](./telegram/) to add Telegram channels too.
