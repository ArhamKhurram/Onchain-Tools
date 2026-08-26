---
title: Quick start
description: What actually happens the first time you open OCT, step by step.
sidebar:
  order: 2
---

You do **not** have to connect anything to see OCT work. The console ships a
demo feed you can watch first. Here is the real first-run path, in order.

## 1. Open the console

Go to the console (**[ OPEN CONSOLE ]** on the landing page, or
`/dashboard`). You land on the module grid — `PICK A MODULE. GET TO WORK.` —
with a **Session** panel showing `GUEST`.

## 2. Sign in

Every module needs an account, so this is the one unavoidable step on the
hosted console. Click **[ SIGN IN ]** in the top-right. You can continue with
Discord or use email + password. Signing in syncs your rooms and settings
across devices.

On the desktop app there is no sign-in — you're in
[local mode](./hosted-vs-local/) and everything is stored on your machine.

## 3. Open Feed and watch the demo

Click **Feed**. Until you have a Discord token connected, the Feed page shows a
**Connect Discord** screen — and the first button on it is:

> ▶ **Watch the live demo feed** — sample calls, streaming live. No account
> access required.

Press it. The console fills with sample rooms and a feed that keeps scrolling:
messages arrive every few seconds, contract addresses get detected and rendered
as pills exactly the way real ones do. A **Demo feed** banner stays pinned
across the top so you always know what you're looking at.

**This is the fastest way to decide whether OCT is for you.** Nothing here
touches your Discord account.

When you're ready, hit **Connect Discord** in that banner — it clears the sample
data and returns you to the token screen.

## 4. Connect Discord

This is the step that turns the demo into *your* feed. The token screen has
three things on it:

- **The token field** — paste your Discord token and press **Connect**.
- **Where your token goes** — a diagram showing browser → Discord, with
  *OCT servers* crossed out on the hosted console. Your token is used only in
  that browser tab.
- **How do I get my Discord token?** — an expandable panel with the exact steps,
  plus an honest note that this is user-account automation ("self-bots"), which
  is against Discord's Terms of Service in principle.

Full walkthrough, including how to extract the token:
[Connect Discord](../../connecting/discord/).

Coming from another install? **Import settings** at the bottom of the same
screen restores your token, rooms and settings from a `config.json` export.

Optionally [connect Telegram](../../connecting/telegram/) too.

## 5. Create your first room

The moment a real token connects with no rooms yet, the Feed shows an
**Almost there** card: a three-step checklist with the first two already ticked,
and one button — **Create your first room**.

A **room** is a set of channels streamed together. Name it and pick your
channels. If none of your servers are enabled yet, the channel picker says so
and lets you enable them right there — you do not have to detour through
Settings. (You still can: **Settings → Guilds**.)

More on rooms: [Rooms & channels](../../feed/rooms/).

## 6. Watch, then tune

- The [Feed](../../feed/feed/) now streams your channels live.
- Every contract mentioned flows into [Callers](../../callers/contracts/), and
  [Radar](../../callers/radar/) ranks tokens by how many callers are on them.
- Track a few [FOMO traders](../../fomo/overview/) and turn on the
  [alerts](../../alerts/notifications/) you want — toasts, sounds, or phone push.

## The modules

These are the tabs across the top of the console.

| Module | What it's for |
| --- | --- |
| **Feed** | Live Discord/Telegram chat, aggregated into rooms |
| **Callers** | Contracts detected in your feeds + the Radar ranking |
| **FOMO** | Live trades from fomo.family traders you follow |
| **Sniper** | A pre-declared buy you fire yourself, behind caps and a kill switch. The one module that spends money — [read its safety notes first](../../sniper/sniper/) |
| **Pump.fun** | pump.fun caller tracking *(not covered by this guide yet)* |
| **Directory** | A watchlist of on-chain wallets to monitor |
| **Portfolio** | PnL/holdings/activity for your own wallets |
| **Workspace** | Build your own multi-column dashboard |
| **Settings** | Everything else — see the [settings reference](../../settings/) |
