---
title: Sniper
description: Fire a pre-declared buy at Slotshark from the console — behind caps, a kill switch, and a dry-run default.
sidebar:
  order: 1
---

The **Sniper** module lets you write a buy down in advance — which token, how
much, from which wallets, behind which caps — and then fire it from the console
in one press. Execution happens at **Slotshark** (Solana), using **your own**
Slotshark account. OCT never holds a wallet key; Slotshark holds the wallet, and
OCT holds an API token that trades against it.

This is the only part of OCT that spends money. Read the next section before you
connect anything.

## Read this first

**1. Triggers live in Slotshark, not here.** OCT does not watch Twitter. If you
have automatic tweet → buy triggers, they are the ones in *your Slotshark
account*, they fire without OCT's involvement, and OCT is never told that they
fired. Nothing on this page can list them, cap them or stop them — you do that in
Slotshark's own dashboard, or by defunding the wallet. Everything below (caps,
kill switch, dry run) binds **buys you fire from the OCT console**, and only
those. The console shows this as a permanent yellow band, which you cannot
dismiss, for exactly this reason.

**2. Every rule starts in dry run.** A new rule is a draft, in dry run, and
saving it can never fire it. Taking it live is a separate, separately confirmed
act — as is arming it, and as is firing it.

**3. Arming does not mean watching.** *Armed* means one thing: this rule may be
fired **live** by the fire button. It does not start any automation.

**4. Your Slotshark token can sell and withdraw, not just buy.** That is a
property of the venue's API, not of OCT. Anyone who obtains that token can sell
every position in the connected wallets and withdraw the balance off-platform, so
**the funded balance is your real blast radius**. Fund it with an amount you
would accept losing outright, top it up as you go rather than parking a float
there, and rotate the token immediately if you have any doubt about it.

## Getting set up

The Sniper tab has four sub-tabs — **Rules**, **Fires**, **Wallets**,
**Venues** — and a status bar that stays on screen across all of them. Work
through them in this order.

### 1. Connect Slotshark (Venues)

**Hosted (onchaintools.tech):** paste your Slotshark **API token**, pick a
**region** (`us` or `eu`), and optionally add a label and the venue wallet
address. The token goes from your browser straight into an encrypted vault — it
never passes through OCT's servers when you connect it, and the backend reads it
only at the instant it is about to send a buy.

You will notice there is no *reveal*, no *copy* and no *last-four* here. That is
deliberate: once stored, the token cannot be read back by anyone, including you.
To rotate, paste the new token over it. **Disconnect** deletes the stored token
and the metadata together — after that, a live fire refuses with `no_credential`.

**Desktop / local:** there is no connect form. Put `SLOTSHARK_API_TOKEN` (and
optionally `SLOTSHARK_REGION=us|eu`) in `backend/.env` and restart the backend.
The console deliberately cannot write that file for you. The Venues tab shows
whether the token is set and which region is in use.

### 2. Add a wallet (Wallets)

A sniper wallet is a **Slotshark-held wallet plus the caps that bound it**:

| Field | What it does |
| --- | --- |
| Address | the Solana address Slotshark funds and trades from |
| Unit | the native unit its caps are counted in (`SOL` or `USDC`) |
| Per-fire cap | the most one leg on this wallet may cost |
| Daily cap | the most this wallet may spend in a UTC day |
| Max open | how many positions it may hold at once |

Caps are in native units, not dollars — there is no price conversion anywhere in
the fire path, on purpose. The table shows **today / daily** and **open / max**
inline so you can see how much room is left.

Two things to know: chain and venue are fixed once a wallet exists (make a new
one instead), and **raising a cap does not rewrite today's numbers** — the day's
budget is snapshotted when the first fire of that day is reserved, so a raise
takes effect tomorrow, or on a wallet that has not fired yet today.

### 3. Write a rule (Rules)

A rule is a saved buy. The fields that matter:

- **Name** and **mint** — the token address is bound now, not later.
- **Size per wallet** and **unit** — what one trigger spends *per wallet*, before
  any ladder split.
- **Entry** — `single`, or `ladder` with a split like `0.5, 0.3, 0.2` (weights
  must add up to 1). Each wallet × ladder step is one **leg**, sent separately.
- **Wallets** — one or many. Three wallets on a ladder of three is nine legs.
- **Per-fire cap** (one leg) and **per-trigger cap** (everything one press
  spends, across every wallet and every leg).
- **Slippage**, **anti-MEV**, and optional **tip** / **priority fee** — leave the
  fee fields blank to let the venue price them automatically.
- **Market-cap ceiling** (optional), **fire window** and **max attempts**.
- **Disable automatically after it moves money** — on by default. Leave it on.

The form also has a greyed-out **Trigger — stored, not wired** section with
handles and keywords in it. Those are saved, and nothing reads them: OCT has no
tweet feed yet. They are there so a rule you write today still means the same
thing when that lands.

### 4. Rehearse, then go live

- **Dry run** is not a simulation with the safety checks skipped — it runs the
  whole path, takes a real budget reservation, and then releases it. Twenty
  rehearsals will not eat your daily cap, but a rule whose caps are wrong will
  refuse in a rehearsal exactly as it would live.
- **Arm** it. The server re-validates the whole rule at this point and tells you
  precisely what is wrong if it refuses.
- **Go live** — a separate confirmation. A live rule's row is tinted and
  edge-marked in the table, so "which of these spends real money" is readable at
  a glance.
- **Fire** — the modal lists every leg, its amount, its estimated fees, and the
  trigger total against your per-trigger cap, under a band that reads either
  `DRY RUN — NO MONEY MOVES` or `LIVE — REAL FUNDS AT SLOTSHARK`. You have to
  type `FIRE` to enable the button.

A live fire requires an armed rule. A dry-run fire works from any state, so you
can rehearse a draft.

## What the caps actually bound

| Cap | Bounds |
| --- | --- |
| Per-fire | one leg, on one wallet |
| Per-trigger | the whole press — every wallet, every ladder leg |
| Daily (on the wallet) | that wallet's spend for the UTC day |
| Max open (on the wallet) | how many positions it holds at once |

Every one of those counts the **amount plus fees** — Slotshark's 0.5%, plus any
tip and priority fee you set. A cap that only counted the swap amount would be
soft by an unknown margin.

Without the per-trigger cap, a five-leg ladder each at the per-fire cap would
spend five times what you thought "per fire" meant. That is why both exist.

If a fire is refused you get the reason in plain words — per-trigger cap,
per-fire cap, daily cap, max open, unit mismatch, kill switch, market-cap
ceiling, no credential, and so on. Nothing was spent in any of those cases.

## The kill switch

Top right, on every sub-tab. Switching it on blocks **every buy fired from this
console**, survives a restart, and applies to your account only.

:::caution
The kill switch does **not** stop Slotshark's own Twitter triggers. It cannot —
OCT is not in that path and is never told they fired. To stop those, disable them
in Slotshark or defund the wallet.
:::

## The Fires tab

Every fire lands here, dry run or live, filled or refused, with the reason
spelled out. Columns: when, mode (dry/live), venue, mint, amount, leg, attempts,
state.

Four states, and one of them needs you:

- **filled** — the venue confirmed it.
- **aborted** — refused before or during sending; the reason is on the row.
- **expired** — the fire window or attempt ceiling ran out.
- **unknown** — the send returned nothing (a timeout, or a 5xx). **This does not
  mean it failed.** The buy may have landed. OCT deliberately does not retry it,
  because retrying a send that actually landed buys the token twice — and it
  holds the budget reservation, because releasing it would let you overspend the
  day if the trade did land.

An `unknown` leg therefore sits there, keeping its share of your daily cap
reserved, until you resolve it: check the trade in Slotshark's dashboard, then
use **resolve** on that row to record what you found. The status bar shows an
`N UNRESOLVED` badge while any are outstanding, and the tab pins a banner
counting them. OCT cannot do this for you yet — reconciling automatically needs a
fill-history API that Slotshark does not publish.

## What this module does not do

- It does not watch Twitter, or any other feed.
- It cannot see, cap or stop triggers configured inside Slotshark.
- It does not sell. There is no exit, stop-loss or take-profit here — manage
  positions in Slotshark.
- It supports Solana through Slotshark only. Other chains and venues are modelled
  but not enabled.
- It cannot tell you your Slotshark balance; caps count what *OCT* has spent, not
  what is in the wallet.

## If something looks wrong

1. Hit the **kill switch** — it stops console fires immediately.
2. Disable your triggers in Slotshark, or move funds out of the wallet. That is
   the only thing that stops the automatic path.
3. **Rotate the API token** in Slotshark and paste the new one into the Venues
   tab. Assume a leaked token means every connected wallet can be emptied, and
   act at that speed.
