---
title: 'ADR-011: The sniper never holds a wallet key'
description: Trade execution uses custodial venues; OCT holds only API tokens, never a wallet private key.
sidebar:
  order: 11
  label: '011 — Sniper custody'
---

**Status:** Accepted

## Context

The tweet-triggered sniper ([overview](../../architecture/sniper/)) spends real
funds. Both execution venues we use are **custodial**, so the only credential OCT
ever holds is an API token, never a wallet private key:

- **Slotshark** (Phase 1; Solana only) — the account holder funds a wallet in the
  venue's own dashboard; OCT holds a bearer token that authorizes trading against
  it.
- **GMGN** (later, per-user only — see below) — also custodial: a swap takes
  `--from <wallet_address>` and no private-key parameter; GMGN builds, signs and
  submits server-side and returns an `order_id` to poll.

Neither shape puts a wallet key on our side. An earlier proposal — store operators'
private keys server-side so OCT could sign EVM trades itself — is moot: GMGN
already custodies the EVM (and Solana) wallet, so there is no key to store, no
operator-side signer to build, and no custody/money-transmission question raised by
*holding a key*. What remains is protecting API tokens and understanding what a
leaked one can do.

## Decision

**OCT executes only through custodial venues, and therefore never holds a wallet
private key.** Phase 1 ships exactly one: Slotshark (Solana). OCT holds only an API
token and asks the venue to build, sign and submit. No `oct-signer`, no key at rest,
no server-side key custody — those designs are retired, not deferred.

**A venue credential must belong to the person whose funds move.** The operator's
own `GMGN_API_KEY` exists in this backend for enrichment, and promoting it to a
trading credential would execute every user's snipes on the operator's account. So
GMGN is excluded from Phase 1 execution entirely, and `Venue` in
`backend/src/sniper/types.ts` omits it — the exclusion is enforced by the type, not
by remembering. GMGN returns later as a per-user connected credential
([ADR-012](../012-venue-tenancy/)).

The residual custody risk is therefore **a leaked API token**, not a leaked key —
and the two venues differ sharply in what a leaked token can do (see
[custody and threat model](../../architecture/sniper-security/)).

Corollary: **what crosses a process boundary is a tweet, not a decision to spend.**
A relayed pre-authorized intent lets a forged frame spend; a relayed tweet must
still satisfy the operator's own rule and caps.

## Consequences

- **No key material anywhere simplifies v1.** There is no signer to build, no key
  wrap, no KMS, no enclave, no money-transmission gate. Milestone M1 is a dry run
  against a custodial venue's API, not a signer integration.
- **The custodial venues are not equal in blast radius.** A leaked token is now the
  worst case, and Slotshark's is severe: its bearer token authorizes `/sell` and
  `/wallets/withdraw`, not just buy. There is no token scoping, no buy-only mode, no
  IP pinning, no withdrawal 2FA. A leaked Slotshark token lets an attacker sell every
  position to SOL and withdraw the entire balance to any address — a **total drain**
  of all funded wallets, not just the amount at risk on the next fire. The controls
  are: keep the funded Slotshark balance minimal, rotate on any suspicion, and
  reconcile every fill against the fire log.
- **GMGN's token appears more contained (unverified).** GMGN's documented surface is
  swap / order / quote / portfolio — it *appears* to expose no withdrawal or transfer
  endpoint, so a leaked GMGN signing key likely cannot move funds off-platform. That
  is a real containment advantage over Slotshark, but it rests on absence-from-docs,
  not confirmation — treat it as *appears / unverified*.
- **[ADR-008](../008-local-loopback/) does not extend to this.** Loopback binding
  is not authentication: local mode also applies wildcard CORS
  (`app.use(cors())`) and sets `req.userId = 'local'` unconditionally, so any web
  page the operator visits can reach the local API cross-origin. Sniper routes
  therefore require a per-boot bearer token and an `Origin`/`Host` check, and must
  not mount on the existing `/api` router. The pre-existing credential exposure on
  that surface is worth fixing on its own.
- **GMGN's third-party-user ToS is unresolved.** Whether GMGN permits executing
  trades on behalf of OCT's end users (versus needing a separate commercial
  agreement) could not be verified — their ToS returned 403. This is a
  partnership/legal gate on hosted execution, not something this ADR settles.
