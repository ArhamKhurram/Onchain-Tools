---
title: Missed-runner alerts
description: Get told when a token you saw called runs — and you're not holding it.
sidebar:
  order: 4
---

A **missed runner** is the one that got away: a token you saw called runs to a
multiple of its call-time market cap, and **none of your wallets are holding
it**. OCT can watch for exactly that. Configure it in the missed-runner panel of
**Settings → Pushover** (it's independent of whether Pushover itself is enabled).

## Turn it on

Enable **missed-runner monitoring**, then set:

- **Deliver via** — **Toast** (in-app only), **Pushover** (phone only), or
  **Both**. (Choosing Pushover warns you if Pushover isn't enabled.)
- **Multiplier threshold** — how far it has to run vs MC@call (1.25×–5×).
- **Lookback (hours)** — how far back a call still counts (1–168).
- **Cooldown per token (hours)** — how long before the same token can alert again
  (1–168).
- **Min MC@call (optional)** — ignore tokens that were called below this market
  cap.

## How the "not holding it" check works

Balance checks run against the wallets in **Portfolio → My Wallets**. If one of
those wallets holds the token, it's not a *missed* runner and won't alert. Keep
the site open if you want toast delivery.

## Test it

There's a **test on a token** tool: paste an address, optionally **force send**
(ignoring the multiplier and cooldown), and run it. You'll get diagnostics —
MC@call → MC now, the multiplier, and the multiplier needed. The test never
writes a cooldown, so you can run it freely.

:::note
Missed-runner market data comes from GMGN — a different source than
[Portfolio](../../portfolio/portfolio/), which uses Birdeye. The two are kept
separate on purpose.
:::
