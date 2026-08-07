---
title: Portfolio
description: PnL, holdings, and activity for your own wallets, powered by Birdeye.
sidebar:
  order: 1
---

The **Portfolio** module is a dashboard for **your own** trading wallets — PnL,
open holdings, and recent activity. The data comes from **Birdeye**.

## Add your wallets

Wallet management lives right in the Portfolio header: the wallet picker
dropdown plus **+** (add), **pencil** (edit), and **trash** (remove) buttons.
Supported chains: **SOL, Base, BSC, ETH**, and **Robinhood (HOOD)**. EVM wallets
aggregate **ETH · Base · BSC** together, and there's an **All wallets combined**
option to see everything at once.

## The dashboard

- **Period toggle** — 7d / 30d — and a **Refresh** button.
- **Summary cards** — Realized PnL, Unrealized PnL, Win Rate, Total Spent,
  Buys / Sells, and PnL Ratio (with an approximate holdings value).
- **PnL Chart** and **PnL Calendar** — two modals driven by your daily PnL.
- **Holdings table** — Token, Balance, USD Value, Total PnL, PnL %, Avg Cost,
  Buys / Sells.
- **Activity feed** — Type (Buy/Sell/Trade), Token (with a tx-explorer link),
  Amount, market cap, and Age.

## Good to know

- **Portfolio uses Birdeye, not GMGN.** GMGN is reserved for
  [missed-runner alerts](../../alerts/missed-runner/); Portfolio never calls it.
  If the backend is missing a Birdeye key, a banner tells you.
- **Rate limits** — Birdeye's tier caps wallet traffic. If data is slow, select
  a single wallet rather than the combined view.
- These are the same wallets used for **missed-runner balance checks** (your
  "My Wallets") — a token you already hold won't trigger a missed-runner alert.
