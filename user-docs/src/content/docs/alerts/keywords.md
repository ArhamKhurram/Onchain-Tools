---
title: Keywords & mentions
description: Match patterns in your feeds and catch when you're @-mentioned.
sidebar:
  order: 5
---

Two related ways to make specific messages jump out: **keyword patterns** and
**mentions**.

## Keyword alerts

**Settings → Keywords.** Enable keyword matching, then add patterns. Each pattern
has a **match mode** and an optional **label**:

- **Contains** — substring match (the default).
- **Exact** — whole-word match.
- **Regex** — full regular expressions, for advanced patterns. (There's a
  regex101.com link inline for testing.)

A match triggers an orange highlight in the feed and fires any alert channels you
have on for keywords ([sounds](./notifications/), [Pushover](./pushover/),
[Discord DM](./discord-bot/)).

### Room-specific keywords

Rooms can have their own keyword patterns too — in the room's **Keywords** tab.
One catch: room keywords only fire if keyword matching is **enabled globally**.
If it's off, the room tab warns you.

## Mentions

**Settings → Mentions** collects messages where you were mentioned into a
dedicated **Mentions** room. Only channels already in your rooms are scanned.
Four independent toggles:

- **User mentions** — someone @-mentions you directly *(on by default)*
- **Role mentions** — one of your roles is mentioned *(on by default)*
- **@here** — used in a channel you monitor *(off by default)*
- **@everyone** — used in a channel you monitor *(off by default)*
