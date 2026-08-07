---
title: Caller quality
description: Rank callers so the good ones float and the noise sinks.
sidebar:
  order: 3
---

Not every caller is worth the same attention. Caller quality lets you **mute the
noise and float the callers worth watching** — and it feeds the **Caller** and
**First caller** columns on the [Radar](./radar/) and the band dots in the
[contract feed](./contracts/).

Muted callers are **collapsed, not deleted** — you can always expand them.

## Manual tiers

You set a caller's tier by **right-clicking their name in any chat feed** and
choosing trusted (star) or muted. Manage the list in
**Settings → Caller Quality**:

- A **room-specific tier beats a global one** — so you can trust someone in one
  room and ignore them elsewhere.
- Each entry shows whether it's muted or starred, the platform, and its scope
  ("Everywhere" if global).

## Earned scores

Beyond your manual tiers, OCT **scores callers automatically** from their track
record. For each call it compares the token's market cap at call time against
the token's peak since — so a caller who repeatedly calls tokens before they run
earns a high score. The **Settings → Caller Quality** leaderboard shows the top
rated callers with:

- **Median** and **Best** performance
- **Hit 2x** — how often their calls at least doubled
- **Band** — the overall grade that colors their name across OCT

A caller stays **unrated** until they have enough priced calls to score fairly.

## What doesn't get scored

Enrichment bots like **Rick** repost an embed for every contract that crosses the
feed. Those are scans, not calls — scored, a bot ends up describing the room's
average rather than anyone's judgement, sitting mid-leaderboard on hundreds of
"calls" it never made. Known bots are left out of scoring by default, and you can
add your own under **Not scored** in **Settings → Caller Quality** (a display
name, or a caller key like `discord:123456`).

This is **not** a mute. An excluded author still posts, still shows in the feed,
and its embeds still enrich your contracts — it just doesn't get a band.

## Two toggles worth knowing

- **Keep muted callers reachable** — collapses muted callers' contracts behind
  an expandable counter instead of hiding them.
- **Rank the contract feed by caller quality** — trusted and high-scoring
  callers sort to the top of the contract feed. Off means newest-first.
