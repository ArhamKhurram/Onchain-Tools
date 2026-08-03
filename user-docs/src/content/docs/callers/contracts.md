---
title: Contract feed
description: The live list of every contract address detected in your feeds.
sidebar:
  order: 1
---

**Callers → Contracts** is a live, running list of every contract address OCT
has detected across your Discord and Telegram feeds — newest activity first.
Where [Radar](./radar/) collapses everything into one row per token, the contract
feed is the raw stream of individual calls.

## Controls

- **View toggle** — table or card layout.
- **Chain filter** — **ALL / EVM / SOL**.
- **Search** — matches address, caller, channel, server, or token name/symbol.
- **Muted reveal** — a **{n} muted** toggle to show contracts from callers
  you've muted via [caller quality](./caller-quality/).
- **Clear All** — empties the feed (with a confirm).

## What each entry shows

- A **caller-quality band dot** (the caller's rating — see
  [caller quality](./caller-quality/)).
- The **chain** (ETH, BNB, BASE, SOL, HOOD…).
- A **NEW / RESCAN** tag.
- A **convergence badge** if this contract is part of a
  [signal convergence](../../fomo/convergence/).
- The **ticker** (`$SYMBOL`) and token name, with **FDV** and **Liquidity**.
- Source attribution — who called it, where.

## Per-item actions

- **Copy address**
- **Open chart**
- **Open in Discord / Telegram**
- **Top FOMO holders** — opens a drawer of the fomo.family traders holding this
  token.
- **Delete**
