---
title: What is OCT?
description: What Onchain Tools does and how the pieces fit together.
sidebar:
  order: 1
---

Onchain Tools (OCT) is a real-time crypto intelligence console. It does two jobs:

1. **Aggregates your feeds.** It ingests the Discord and Telegram channels you
   already watch and streams them into one place, organized into **rooms** — so
   you're not tabbing between a hundred servers.
2. **Surfaces the signals.** As messages flow in, OCT detects contract
   addresses, enriches them with market data, tracks known traders, and raises
   alerts when independent signals line up.

## The three signals

OCT watches for three distinct things. They're kept separate on purpose — each
answers a different question:

- **Convergence** — a contract gets called in your feeds *and* a trader you
  track buys the same token, inside a time window you set. Two independent
  sources agreeing.
- **FOMO buys** — a trader you follow on fomo.family makes a move, live.
- **Missed runners** — a token you saw called runs to a multiple of its
  call-time market cap, and none of your wallets are holding it.

## How you'll use it

A typical setup, start to finish:

1. Sign in, open **Feed**, and press **Watch the live demo feed** — the whole
   console running on sample data, with nothing connected.
2. [Connect Discord](../../connecting/discord/) when you want your own servers
   (and optionally [Telegram](../../connecting/telegram/)).
3. Build a [room](../../feed/rooms/) or two, enabling servers as you pick channels.
4. Watch the [Feed](../../feed/feed/); let [Radar](../../callers/radar/) surface
   the crowded tokens.
5. Track a few [FOMO traders](../../fomo/overview/) and turn on the
   [alerts](../../alerts/notifications/) you want.

Step by step, with what each screen actually shows:
[quick start](./quick-start/).

## A note on the two modes

OCT runs in two modes, and a few things differ between them. Most users are on
the **hosted** web console; the desktop app runs in **local** mode. The
[Hosted vs local](./hosted-vs-local/) page covers exactly what changes — the
short version is that hosted mode adds sign-in and cross-device sync, and in
hosted mode **your Discord token never leaves your browser**.
