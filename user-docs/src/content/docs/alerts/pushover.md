---
title: Pushover (phone push)
description: Get OCT alerts on your phone via Pushover, with triggers, filters, and priority.
sidebar:
  order: 2
---

[Pushover](https://pushover.net) delivers OCT alerts to your phone. Set it up in
**Settings → Pushover**. The section has a built-in step-by-step setup guide, but
here's the shape of it.

## Setup

1. Create a Pushover account and copy your **User Key**.
2. Create an application in Pushover and copy its **API Token**.
3. In OCT, enable **Pushover notifications** and paste both the **Application API
   Token** and **User Key**.

## Triggers

Choose which events push to your phone:

- Highlighted user posts a contract
- Highlighted user sends any message
- Any contract address detected
- Keyword pattern matched
- **Signal convergence** (contract call + FOMO buy overlap)

## Filters

By default every matching event pushes. You can narrow it with three optional
filters (empty = no filter):

- **Only from these highlighted users**
- **Only from these servers**
- **Only from these channels**

## Delivery settings

- **Priority** — Lowest (no alert), Low (no sound), Normal, High (bypass quiet
  hours), or Emergency (repeats until you acknowledge).
- **Sound** — pick from Pushover's built-in tones (or None for silent).

:::tip
Pushover is the right channel for **convergence** alerts — those aren't
available over [Discord DM](./discord-bot/).
:::
