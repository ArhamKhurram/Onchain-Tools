---
title: FOMO overview
description: Track real fomo.family traders live — and what each of the five tabs does.
sidebar:
  order: 1
---

The **FOMO** module tracks real traders from **fomo.family**. Follow the traders
you rate, and OCT streams their buys and sells live, shows leaderboards, and lets
you look up who's holding any token. It's the "smart money" half of OCT — and it
powers [signal convergence](./convergence/).

FOMO has five tabs.

## Live

A live trade feed of every tracked trader's moves. Each row shows **BUY / SELL**
(green/red), the trader, the token (linked to its chart) with a short address,
the token's **market cap**, the chain, the USD value, and a timestamp. When you
open the console, the **last 24 hours are replayed** so you don't miss what
happened while you were away.

## Leaderboard

The top traders by PnL, with a **24H / ALL** window toggle. Each row shows rank,
name/handle, and PnL. Hit **Track** on anyone to start following them — it shows
up in the Tracking tab immediately.

## Tracking

Your followed traders. Add one by username with the **Track a FOMO trader…**
field. Each tracked trader has:

- A **Pushover bell** toggle — get a [phone push](../../alerts/pushover/) on
  their trades.
- An **untrack** button.

If the backend isn't configured with a FOMO service account, this tab tells you
so.

## Holders

Paste a **token address** and OCT shows the top fomo.family traders holding it —
Solana or any EVM chain, auto-detected. Useful for gut-checking a token: is real
money in it, or just chat?

## Traders

Look up any trader by handle or display name to see their **portfolio PnL**,
**live perp PnL**, wallet addresses, and **top holdings** (symbol, value, PnL).
Read-only — nothing is saved.

## What to do next

- Track a few traders whose taste you trust.
- Watch the **FOMO** column on the [Radar](../../callers/radar/) — it shows how
  many of your tracked traders hold each token.
- Turn on [convergence](./convergence/) so you're alerted when a tracked trader
  buys something your feeds are already calling.
