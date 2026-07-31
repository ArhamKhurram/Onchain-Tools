---
title: 'ADR-012: Users bring their own venue accounts'
description: The sniper is multi-tenant over per-user custodial venue accounts, not one shared operator account. Records the Slotshark/GMGN venue sequencing.
sidebar:
  order: 12
  label: '012 — Venue tenancy'
---

**Status:** Accepted

## Context

OCT hosted mode is multi-user. The sniper spends real funds
([ADR-011](../011-sniper-custody/) — both venues are custodial, so OCT holds an
API token per venue, never a wallet key). That leaves one tenancy question the
custody ADR did not settle: **whose venue account do trades run through?**

Routing every user's trades through *one operator* venue account would commingle
users' funds in a wallet the operator controls — which makes OCT a custodian and
raises the money-transmission gate directly. Both venues are per-account custodial
(the user funds a wallet in the venue's own dashboard), so the alternative is
available: each user connects their **own** account.

Two partnership facts, current as of 2026-07-30, shape the sequencing:

- **Slotshark.** The developer API is available now, but on it a user's token is
  full-power — it authorises buy, **sell and withdraw** (T3). Setup and trade
  notifications route through Slotshark's Telegram bot. A **custom OAuth
  integration with scoped tokens and fee-sharing** was offered, gated on OCT
  reaching **~50k+ daily volume**.
- **GMGN.** Custodial, multi-chain, and its token *appears* to expose no
  off-platform withdrawal endpoint (T9, unverified) — a materially smaller blast
  radius than a raw Slotshark token. Whether GMGN permits executing on behalf of
  third-party users is unresolved (their ToS returned 403).

## Decision

**The sniper is multi-tenant over per-user connected venue accounts.** Each user
links their own Slotshark and/or GMGN account; OCT stores a per-user venue token
in **Supabase Vault**, RLS-scoped, decrypted only inside Postgres by the service
role at fire time — a stronger boundary than the app-level AES-GCM
(`auth/encryption.ts`) OCT uses for Discord tokens today, because the decryption
key never enters this backend's process or environment. See
[storage](../../architecture/sniper-security/#storage-where-a-venue-token-lives-at-rest).
OCT never holds a shared wallet and never commingles funds — it orchestrates over
the user's own account.

Venue sequencing follows from the two partnership facts:

- **GMGN is out of Phase 1 execution entirely**, and its eventual form is
  per-user-connected only. The operator's `GMGN_API_KEY` is an *enrichment*
  credential; trading on it would put every user's fills on the operator's account,
  which is precisely the commingling this ADR exists to prevent. `Venue` in
  `backend/src/sniper/types.ts` therefore omits it. When it returns (M11) its
  apparently-contained token — no withdrawal endpoint seen, unverified — makes it
  the *preferred* multi-tenant venue, still **gated on the GMGN third-party-user
  ToS answer** (open question 2 in the [overview](../../architecture/sniper/)).
- **Raw Slotshark tokens are not mass-onboarded.** Until the scoped-OAuth custom
  integration exists, broad multi-tenant Slotshark execution is off — a store of
  sell+withdraw-capable tokens is an aggregate honeypot. Slotshark on the
  developer API is used for the **operator's own account** (dogfood, M5) and a
  small set of trusted early users, which is also how OCT proves the volume that
  unlocks the scoped integration.
- **Slotshark's tracker is evaluated as a trigger feed, not adopted on a claim.**
  Slotshark states it is faster than J7; M2's shadow harness measures it head to
  head, and J7 stays as an independent fallback so a single provider is never both
  the trigger *and* the execution venue.

When GMGN execution does land, it fires through its **structured signed REST**
(`/v1/trade/*`); GMGN's natural-language *agent* is a Phase 3 rule-composition
surface only, never the hot path.

## Consequences

- **The per-user token store is the aggregate honeypot.** Mitigations: encryption
  at rest (existing), preferring the contained-token venue (GMGN) for multi-tenant
  execution, and adopting scoped Slotshark tokens the moment the custom
  integration ships. Tracked as a threat row in
  [security](../../architecture/sniper-security/).
- **A new milestone: per-user venue-account connect flow** (hosted). Single-operator
  milestones (M1–M11) do not need it; broad multi-tenant rollout does.
- **Two external dependencies gate the multi-tenant path**, neither blocking
  single-operator build: the GMGN third-party ToS answer, and Slotshark's scoped
  OAuth (which is itself volume-gated). Both are partnership conversations, not
  design work.
- **Not locked in.** Because execution sits behind the executor registry
  ([execution](../../architecture/sniper-execution/)), the default venue can move
  from Slotshark to GMGN — globally or per user — with no change to the risk gate,
  idempotency, or the rule schema.
