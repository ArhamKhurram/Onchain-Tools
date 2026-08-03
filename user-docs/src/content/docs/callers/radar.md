---
title: Radar
description: Every column on the Radar decoded — how OCT ranks tokens by crowd.
sidebar:
  order: 2
---

**Callers → Radar** takes every contract mention from your feeds and collapses
it into **one row per token**. Instead of a stream of individual calls, you see
which tokens are getting crowded, which are early, and how they're moving. It's
the single best surface for "what is everyone suddenly talking about."

## Time window

The top bar has a **time-window filter — 1h / 4h / 24h / all** (default 24h).
Everything in the table is scoped to that window: a token only appears if it was
mentioned inside it, and the counts reflect that range.

## The columns

Every column is sortable — click its header. Some are hidden by default; turn
them on in the **columns** popover. Your choices persist between visits.

| Column | What it means |
| --- | --- |
| **Token** | Chain dot + `$SYMBOL` (or short address). A **crowded** tag means ≥5 mentions; **early** means exactly 1. Copy button included. |
| **Mentions** | Total mentions in the window (includes muted callers). |
| **Callers** | Number of *distinct* callers. |
| **Groups** | Number of distinct servers/channels it appeared in. |
| **FOMO** | How many of your tracked [FOMO traders](../../fomo/overview/) hold it (handles in the tooltip). Hidden by default. |
| **Window mentions** | Mentions within a shorter sub-window — **15m / 1h / 4h** — that you choose in the columns popover. Good for spotting acceleration. |
| **Latest** | Time since the most recent mention. |
| **MC@call** | Market cap when the token was first called. |
| **MC now** | Live market cap, auto-refreshing about every 60 seconds, with an age stamp. |
| **×** | Multiple of MC now vs MC@call — green when ≥1. The at-a-glance "did it run." |
| **Caller** | The best caller-quality band on the token (colored dot + label). |
| **First caller** | Who called it first, colored by their own quality band. Hidden by default. |

## Reading it

- **Callers vs Mentions** — a high *Mentions* but low *Callers* means a few
  people repeating themselves; high *Callers* means genuine spread.
- **Groups** — spread across many servers is a stronger signal than a single
  echo chamber.
- **Window mentions** — a token quiet over 24h but spiking in the last 15m is
  accelerating right now.
- **× and MC now** — these come from a live market-data source and update on
  their own; **MC@call** is captured at call time, so the ratio tells you how
  far it's moved since the crowd first noticed.

## Refreshing & muted callers

- The **refresh** button re-pulls market caps and token names for the top rows;
  each row also has its own refresh button.
- A **{n} muted** toggle reveals tokens whose only callers you've muted. Muting
  is set through [caller quality](./caller-quality/).
