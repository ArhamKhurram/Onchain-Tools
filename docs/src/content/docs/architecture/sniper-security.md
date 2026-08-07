---
title: "Sniper: custody and threat model"
description: Both execution venues are custodial, so OCT holds only API tokens; what can still go wrong that caps do not fix.
sidebar:
  order: 13
---

The only credential in this system that authorizes spending is a **custodial venue
API token**. There is no wallet private key anywhere, on any chain.

| Credential | What it authorizes | Blast radius |
| --- | --- | --- |
| Slotshark bearer token (Phase 1) | buy, **sell, and withdraw** against a custodial wallet | **total** — every funded wallet, off-platform |
| GMGN signing key | *not a trading credential in Phase 1* — enrichment only | n/a here; see the exclusion below |

Slotshark's token is the dangerous one, and it is dangerous in the worst way: it can
move funds **off** the platform. Detail in threat T3.

:::caution[The alpha's automatic path is outside every control on this page]
In the alpha the tweet → buy loop runs inside the operator's own Slotshark
account. OCT is never told when it fires, so `executeFire` is never reached on
that path and none of the caps, the kill switch or the dry-run flag bind it —
they bind console-fired buys only. Bounding automatic buys means bounding them in
Slotshark, or funding the wallet with less. That makes **minimum funded balance**
(T3, and open question 3 in the [overview](../sniper/)) the load-bearing control
in this release rather than one control among several.
:::

## Custody: none — the venue is custodial

**Slotshark** is the only Phase 1 venue. The account holder funds a wallet in
Slotshark's own dashboard; OCT holds a bearer token that trades against it and never
signs a transaction. So there is no signer to build, no key at rest, no KMS, no
enclave. The residual question is not "where does the key live" but **"what can a
leaked token do"** — answered in the threat model.

**GMGN is excluded from Phase 1 execution deliberately.** OCT holds a
`GMGN_API_KEY`, but it is the *operator's*, provisioned for enrichment and market
data (`utils/gmgnClient.ts`). Using it to trade would execute every user's snipes on
the operator's account — commingled funds and an accidental custody position. The
`Venue` union omits it so no code path can reach it. GMGN arrives later as a
per-user connected credential ([ADR-012](../../adr/012-venue-tenancy/)), at which
point two researched properties apply: it is custodial (swap takes
`--from <wallet_address>`, no private-key parameter, returns an `order_id`), and
`GMGN_PRIVATE_KEY` is an Ed25519 **request-signing** key, *not* a wallet key.

Relay principle, still in force: if any topology splits matching from firing, what
crosses the boundary is a *tweet*, not an instruction to spend — a forged frame must
still satisfy the operator's own rule and caps.

## Storage: where a venue token lives at rest

Hosted mode is multi-tenant ([ADR-012](../../adr/012-venue-tenancy/)), so it stores
one of these tokens per user, per venue — encryption-at-rest is not optional.

**The scheme is Supabase Vault, not app-level AES-GCM.** OCT's existing pattern for
Discord tokens (`auth/encryption.ts`) is AES-256-GCM with a key in
`TOKEN_ENCRYPTION_KEY` — a Railway env var. That works, but the key is a plaintext
secret reachable by anything with env access, and it sits in the **same environment**
as `SUPABASE_SERVICE_KEY` (T11) — one env leak is one compromise, not two.

Vault (built on `pgsodium`) moves the boundary: secrets are decrypted **inside
Postgres**, via the `vault.decrypted_secrets` view, called through two
`SECURITY DEFINER` RPCs
(`supabase/migrations/20260730170000_sniper_venue_credentials.sql`):

- **`sniper_store_venue_credential`** — grantable to `authenticated`. A user's own
  client calls this **directly against Supabase**, so a connected token crosses the
  wire straight from the user's browser/desktop app to Supabase and **never touches
  the OCT backend at connect time** — the same direct RLS-scoped write pattern
  `frontend/src` already uses for `useTrackedWallets`/`useHoldingWallets`.
- **`sniper_get_venue_secret`** — `service_role` only, no grant to `authenticated`
  or `anon`. This is the *only* way a plaintext token comes back out, and the only
  caller is `backend/src/sniper/venueCredentials.ts` at the moment `executeFire`
  is about to send. It is never cached past that call.

**Both halves are now built** (M5, 2026-08-07). The connect UI is
`frontend/src/components/sniper/VenueConnectPanel.tsx`: the token lives in a
component-local `useState`, is passed to the RPC as an argument, and is cleared in
the `finally` of submit whether the write succeeded or not — never a store, never
`localStorage`, never a URL, never a prop that outlives the form. There is
deliberately **no reveal, no copy and no fingerprint** in that UI, because none is
possible once the secret is inside Vault, and offering one would require keeping a
readable copy somewhere. Rotating means pasting a new token; disconnecting deletes
the metadata row and the vault secret together. Local mode has no connect UI at
all — it reads `SLOTSHARK_API_TOKEN` from `backend/.env`, and the console will not
write that file.

The metadata table (`sniper_venue_credentials`: venue, wallet address, region,
label) is a normal RLS-gated table a user can `select` their own rows from, for a
connected-accounts UI — it has no secret column, so that policy cannot leak a
token. There are deliberately no insert/update/delete policies on it: every
mutation goes through the RPCs above, because a mutation has to also touch
`vault.secrets`, and a bare RLS-gated write could orphan one from the other.

**What this fixes, and what it does not.** The app's env no longer holds the key
that decrypts a stored token — a leaked `TOKEN_ENCRYPTION_KEY`-equivalent secret
for the sniper simply does not exist. **It does not fix T11.** A leaked
`SUPABASE_SERVICE_KEY` still satisfies `sniper_get_venue_secret`'s only check
(`auth.role() = 'service_role'`), so it remains the single biggest exposure in
this system, sniper included. Vault removes one independent way to reach a stored
token; it does not shrink the blast radius of the credential that was already the
worst one. Un-fusing the service-role key from other secrets is separate work,
tracked at T11 — not something Vault adoption substitutes for.

**Local mode stores the token in plaintext**, in `backend/.env` /
`SLOTSHARK_API_TOKEN` / `GMGN_API_KEY` — matching the existing local-mode
convention for Discord tokens. There is one operator and no multi-tenant secret
store to defend (ADR-008's loopback argument), so Vault buys nothing there.

## The gating question, resolved

**Does GMGN's trading surface require a wallet private key? No — GMGN custodies.**
Evidence: the wallet is bound to the API key, the swap call takes a wallet *address*
and no private-key parameter, and execution returns an `order_id` OCT polls while
GMGN builds/signs/submits. Slotshark was already custodial. So **there are no wallet
private keys anywhere in v1.**

One open item remains, and it is legal, not technical: **GMGN's third-party-user
ToS is unverified** — whether GMGN permits OCT executing trades on behalf of its end
users, versus needing a separate commercial agreement, could not be confirmed (their
ToS returned 403). That is a partnership gate on hosted execution, not something this
page settles.

**Deferred: server-side wallet-key custody.** Not chosen and not needed — both
venues are custodial — so OCT-signs-its-own-transactions is off the table for v1;
revisiting it would require the full KMS/enclave/audit apparatus and a money-transmission
legal review, and is a decision to be recorded rather than drifted into.

## Threat model

| # | Threat | Mitigation | Residual |
| --- | --- | --- | --- |
| T1 | **Bait token engineered to win Phase 2 scoring** | hard per-fire cap; unpublished scoring function; per-user salt on ties; sellability check on the best candidate only; cheap authority/LP rejections; surface in the UI that laddering *increases* this exposure | **High.** The salt randomizes ties; bait that genuinely dominates still wins. A funded farmer beats any public deterministic rule. Design output: Phase 2 carries a lower cap than Phase 1 |
| T2 | **Leaked J7 JWT** | encrypt at rest; **never returned by any API**; mask in logs — note the Socket.IO handshake `40{"token":...}` is exactly what a debug log prints; liveness heartbeat if a busy feed goes quiet | **Medium.** An attacker cannot spend — they read our firehose, can get the account banned, and can silently blind the sniper via session invalidation. No programmatic rotation and no session list, so **we cannot detect misuse** |
| T3 | **Leaked Slotshark token — total drain** | held only by the executor, never in a client; **keep the funded Slotshark balance minimal — this is the primary control, and in the alpha it is very nearly the only one**; rotate on any suspicion; ~~reconcile every venue fill against our fire log, an unmatched fill means compromise~~ — **not available**: reconciliation needs a venue fill-history endpoint this repo cannot verify (see [execution](../sniper-execution/)), so an unmatched fill is not something OCT can currently detect | **Critical.** The bearer token authorizes `/sell` *and* `/wallets/withdraw`, not just buy — confirmed live, with no token scoping, no buy-only mode, no IP pinning, no withdrawal 2FA. A leaked token sells every position to SOL and withdraws the whole balance to any address: **total drain of all funded wallets**, not bounded by the next fire. There is no request-level allowlist we control. Contrast T9 |
| T4 | **SSRF via operator- or stream-supplied URL** | operator input **never becomes a URL host** — it selects from a compile-time enum, or is a path appended to a pinned base. **Never `new URL(userInput, base)`** — `//evil.com/x` escapes to another host. For `ai_suggestion_update`, parse the image basename only, **never fetch the URL**, and validate it is a well-formed base58 32-byte pubkey before treating it as a mint. No custom RPC in v1 | **Low if enforced.** Add an ESLint `no-restricted-syntax` rule against `new URL(` with a non-literal base so it is enforced, not remembered |
| T5 | **Prompt injection into the Phase 3 compiler** | the model emits a *proposal*, never executes; strict schema validation; **caps clamped server-side regardless of what the model emits**; approval diff; bound and linear-time-validate any emitted regex | **Low-medium.** A schema cannot tell a good mint from an attacker's, and humans approve carelessly — **the server-side clamps are what actually hold** |
| T6 | **Runaway fires / retry drain** | durable claim before the first external call; atomic reservation not check-then-spend; persisted attempt ceiling; **global fires-per-minute breaker** distinct from per-rule caps; **anomaly auto-kill** trips the switch rather than merely alerting; retry the send only when the previous attempt is provably dead | **Low-medium.** Remaining edges are clock skew and genuinely ambiguous outcomes, handled by the reconciler |
| T7 | **Replay of a stale tweet after a reconnect gap** | require **both** `now − created_at < maxTweetAgeMs` and `now − firstSeenAt < maxFirstSeenAgeMs`; persisted LRU of seen trigger keys across restarts; validity window against the tweet timestamp, never receipt; **seed, do not fire, on the first post-reconnect batch** | **Low.** Clock skew distorts the age check — use a monotonic clock plus an NTP sanity check at boot, and fail closed on implausible skew |
| T8 | **Malicious or hijacked J7 — a fabricated tweet** | independent verification is the only true mitigation and **it costs the product** (a second provider is +100–400 ms). Practical compromise: fire on J7 alone with the per-fire cap sized to *an amount worth losing on a fabricated tweet*, verify asynchronously **after** the fire, and trip the kill switch on mismatch. Pin TLS; strict schema validation; bound all numerics; **never let stream data choose a destination address — only a mint, re-validated on-chain** | **High, and structural.** We trust a third party with our spend trigger by design. The per-fire cap *is* the control. Note this is worse in Phase 2 than Phase 1: a fabricated tweet in Phase 1 buys a token the operator already chose; in Phase 2 it buys whatever the attacker also deployed |
| T9 | **Leaked GMGN token (contrast to T3)** | held only by the executor, never in a client; rotate on suspicion; reconcile every fill against our fire log | **Medium, apparently contained (unverified).** GMGN's documented surface is swap / order / quote / portfolio — it *appears* to expose no withdrawal or transfer endpoint, so a leaked GMGN signing key likely cannot move funds off-platform. That is a real containment advantage over Slotshark, but it rests on absence-from-docs, not confirmation — do not rely on it as a control |
| T10 | **Custodial API token stolen from the operator's machine** | never write a venue token to a client bundle; store via OS keychain (`safeStorage`), not plaintext env; minimal funded balance; rotate on suspicion | **Follows the venue.** There is no wallet key to steal — only the venue token — so the blast radius is exactly T3 (Slotshark: total drain) or T9 (GMGN: apparently contained). Custodial venues remove *our* server-side honeypot; they do not make a token on an infected machine safe |
| T11 | **Supabase service-role key leak** | rotate; keep out of any client bundle (`lib/supabase.ts` already throws at import if a `VITE_SUPABASE_SERVICE*` var exists — keep that); move the audit log outside this credential's reach | **High today**, and fused with `TOKEN_ENCRYPTION_KEY` in the same environment. **Vault does not lower this**: the service role still satisfies `sniper_get_venue_secret`'s only check, so it remains the single credential that unlocks every stored sniper token too |
| T12 | **Local control-plane authentication** | The local-mode API relies on loopback binding rather than a credential ([ADR-008](../../adr/008-local-loopback/)), which is weaker than it appears for browser-originated requests. All three requirements shipped **for the sniper surface**: a per-boot bearer token in a `0600` file under `OCT_DATA_DIR`, a strict `Origin`/`Host` check, and the routes mounted **outside** `/api` — at `/sniper/v1`, ahead of the CORS middleware. See [execution](../sniper-execution/#the-control-plane-is-part-of-this) | **Closed for the money-spending surface; still open for the pre-existing one.** The sniper did not extend `/api`, which was the condition on shipping it. The older `/api` routes are unchanged and still rely on ADR-008's argument, so this row stays open — deliberately under-specified here, because this page is public and that surface is in a shipped build. Details in the private issue |

| T13 | **Aggregate honeypot — the multi-tenant venue-token store** | per-user tokens in **Supabase Vault**, not app-level AES-GCM — decrypted only inside Postgres, only by the service role, only at fire time (see [Storage](#storage-where-a-venue-token-lives-at-rest)); **prefer the contained-token venue (GMGN) as the multi-tenant execution default**; adopt scoped Slotshark tokens the moment the custom OAuth integration ships; **do not mass-onboard raw sell+withdraw Slotshark tokens** ([ADR-012](../../adr/012-venue-tenancy/)) | **Depends on venue mix.** A store of GMGN tokens is bounded by T9 (apparently no off-platform withdrawal); a store of raw Slotshark tokens is bounded by T3 (total drain) *times every connected user* — which is why broad Slotshark multi-tenant waits for scoped tokens. Vault removes the app-env key as an independent path to the secret but, per T11, does not bound the service-role path. The full multi-tenant threat rewrite is held pending the GMGN third-party-ToS answer |

T12 is worth fixing independently of this feature.
