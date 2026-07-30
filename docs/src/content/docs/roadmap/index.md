---
title: Roadmap
description: A living list of features discussed but not yet shipped, plus what shipped recently and known gaps.
sidebar:
  order: 1
---

A living list of features we've discussed but haven't shipped yet, so nothing
gets lost. Move items up to **Planned** when we commit to them, and into
[`CHANGELOG.md`](https://github.com/ArhamKhurram/Onchain-Tools/blob/main/CHANGELOG.md)
once shipped.

## In progress

_(Nothing actively in flight — pick from Planned next.)_

## Planned next

### Caller quality — follow-ups

Phases 1 and 2 shipped Jul 30 (see [Recently shipped](#recently-shipped-jul-2026)
below). Remaining:

- **Backfill.** Scores only start accumulating once the peak sampler has been
  running — a token called before the first pass has no peak, so early scores are
  thin. Consider a one-off backfill over recent contracts.
- **Peak fidelity.** The sampler polls every 3 min, so a spike between passes is
  missed. Fine for banding, wrong for anything that claims to be an exact ATH —
  don't surface `bestMultiple` as a precise number without fixing this.
- **Per-room scores.** Scores are currently global per caller. A caller can be
  sharp in one room and noise in another; the manual tier covers that case by
  hand today.
- **Radar `allMuted` cost.** `buildRadar` runs twice per render (once for the
  muted counter). Fine at 2,000 contracts, worth memoising if the cap rises.

### FOMO prod reliability rework

Prod FOMO works locally but breaks on Railway: Cloudflare blocks datacenter IPs
(`upstream 0`), leaderboard/holders fail without a warm browser session, and API
volume is uncached. **Do not** solve with 20 manual accounts — one shared
service account is correct; fix infra + caching instead.

**Root causes (three different limits):**

- **Cloudflare** — cold Playwright on a Railway datacenter IP; manually copying
  `FOMO_CF_*` env is a band-aid. Dev works because it's a home IP + warm session.
- **FOMO API rate limit** — HTTP 429 from too many calls on one account/IP.
- **OCT express limiter** — 120 req/min on `/api` in hosted mode; needs
  `trust proxy` behind Railway.

**Tier 0 (current):** one shared account, fan-out poller, no caching — breaks in prod.

**Recommended path:**

*Phase 1 — stop the bleeding (1–2 days)*
- Init the browser **once** at boot; reuse the shared client for all routes (no
  re-`init()` per leaderboard request).
- **Server-side cache** — leaderboard 5–15 min, hodlers overlap 15 min.
- **Adaptive poll interval** — 10s when users are connected, 30–60s when idle.
- **`trust proxy`** on Railway for express-rate-limit.
- Richer **`/api/fomo/status`** — last successful poll, last CF error, token age.

*Phase 2 — prod behaves like dev (3–5 days)*
- **Dedicated FOMO worker** on an always-on VPS/Fly with a persistent Playwright
  profile (survives redeploys). OCT backend calls the internal proxy. — **Shipped**,
  see [fomo-worker](../architecture/fomo-worker/).
- Optional residential proxy if Cloudflare still blocks.

*Phase 3 — account pool (only if 429s persist after Phase 1–2)*
- `fomo_service_accounts` table; 2–3 service accounts; auto-rotate on 429.
- Fully automated — no manual cookie copying.

**Do not:** run 20 manual accounts, build per-user FOMO OAuth (Option B/C), or run
an uncached leaderboard + overlap + poller from one cold Railway container.

**Privy refresh token:** already auto-rotates into `fomo_poll_state` — a manual
update is only needed when the session is fully revoked.

## Recently shipped (Jul 2026)

### Caller quality — slop filter + ranking (Phases 1–2)

Rank contract calls by who sent them.

- **Manual tiers** — `callerTiers` in config: `muted` / `normal` / `trusted`, global
  or per room, room beating global; most restrictive wins when several rooms match.
  Set from the user context menu, managed in Settings → Caller Quality.
- **Earned scores** — `packages/shared/src/callerQuality.ts` (pure, unit-tested):
  median multiple, 2x/5x hit rates, slop rate, banded `slop → elite`. Attribution is
  **per row** against each caller's own `fdvAtCall`, and one caller/token pair counts
  once. `unrated` below 10 scored calls.
- **Peak input** — `tokenPeakSampler` + `tokenPeakStore` record each token's
  high-water MC (`token_peaks`, migration `20260729120000`). Kept as its own loop
  rather than hooked into `missedRunnerPoller`, whose walk is gated on that alert
  being enabled — piggybacking would make scores depend on an unrelated setting.
  Local mode backs it with a JSON file so the desktop app scores too.
- **Surfaces** — contract feed + Radar filter and rank; chat only colours the
  username. `GET /api/callers/scores`, derived on read with a 2-minute cache.
- Stayed a display/filter layer — deliberately not folded into convergence.

### Token enrichment pipeline (Phase 1–2)

- **Rick + Dex merge fix** — Dex/GMGN fallbacks now run when `tokenSymbol` is
  missing, even on Rick-enriched rows; secondary sources fill symbol/name only
  without overwriting Rick FDV/liquidity.
- **`token_catalog` table** — global Supabase cache (address, chain, symbol, fdv,
  price, source, raw JSON); migration `20260721100000_token_catalog.sql`.
- **GMGN adapter** — `backend/src/utils/gmgnClient.ts` + `gmgnEnrichment.ts`;
  Robinhood chain first when `GMGN_API_KEY` is set; DexScreener fallback.
- **Snapshot API** — `GET /api/tokens/:chain/:address/snapshot` returns cached
  MC/price; refreshes when stale (>5 min). Radar live MC now uses this instead of
  client-side Dex calls.

**Phase 3 (follow-ups):**
- Background catalog warmer / batch refresh for top Radar tokens.
- Extend GMGN to all supported chains in the catalog (not just Robinhood-first).
- Wire the snapshot into Feed contract rows (not only Radar).

### FOMO tracking (v1 — fan-out)

- **Core client** — `FomoClient` + Playwright stealth Chromium; Privy refresh →
  JWT; auto-persists the rotated token to `fomo_poll_state`.
- **Auth model:** Option A — single shared service account (`FOMO_*` env + DB).
- **Architecture:** fan-out-on-write — one global poll of `/feed/tradingActivity`
  → route trades to OCT users who track that FOMO user.
- **UI:** Wallets → FOMO tab — track list, live trade feed, leaderboard, Pushover
  bell per row.
- **Token info + in-app alerts** — trades now carry `tokenName`/`marketCap`
  (resolved from the token catalog, not FOMO's own payload) and a dedicated
  toast + sound (`SoundSettings.fomoTrade`), gated by the same per-tracker
  toggle that already drove Pushover.
- **Leaderboard** — top traders (24h / all-time); one-click track.
- **Holder overlap** — Radar shows how many tracked FOMO traders hold each contract.
- **Signal convergence v1** — in-app alert when a contract call and a FOMO buy hit
  the same token within a configurable window; badge on Feed + Radar; optional
  Pushover.

### Console & landing

- **Radar sorting** — sortable column headers; `sort: latest` toolbar preset;
  Latest column (last mention time).
- **Code-splitting** — lazy routes, lazy `GlobalSettings`, vendor manualChunks
  (~150 kB main chunk).
- **Contract feed** — scans now show immediately on detection and enrich in
  place (Rick, then the backend's own Dex/GMGN fallback) rather than holding
  the row invisible for up to 30s+; Dex/catalog fallbacks; client-gateway
  persistence; ticker in feed rows.
- **Landing** — reskin; `/dashboard` split routing; Updates changelog section;
  footer/nav polish.

### Infra & auth

- **Hosted mode** — Supabase auth, RLS, Railway backend + Vercel frontend split.
- **Browser-side Discord gateway** — client-gateway mode; OAuth callback fix. See
  [ADR-002](../adr/002-browser-gateway/).
- **OCT Discord bot** — in-process bot, opt-in DM alerts, `/api/v1/bot`
  machine-auth surface. See [Discord bot](../architecture/discord-bot/) and
  [ADR-006](../adr/006-in-process-bot/).
- **Developer docs** — this site.

## Deferred / backlog

### On-chain wallet detection engine

The Wallets page is currently a **watchlist only** (`user_tracked_wallets` CRUD in
Supabase). The `alerts_on_toast/feed/bubble` flags exist but nothing watches
addresses on-chain. Real detection needs a chain data provider (Helius / Bitquery
/ etc.) with its own cost + rate limits. Big build; deferred.

Caveat: FOMO trades are gasless/relayed, so a FOMO user's exposed EOA may not
show normal DEX swaps — on-chain detection could miss FOMO activity.

### Auto-bridge FOMO wallets → Wallet Tracker

FOMO's `/wallets` exposes each user's SOL/EVM addresses. When a user tracks a FOMO
account, auto-populate the on-chain watchlist with their real wallets. Only pays
off once the on-chain detection engine above exists — deferred until then.

### Unified alerts center

One place for every trigger — Discord highlight, contract detected, FOMO
tracked-user buy, (future) wallet movement — with per-source rules. Pushover is
already wired; this unifies routing/config.

:::note[Design principle — keep the signals separate]
Convergence, FOMO buys, and missed-runner are intentionally *distinct* signals
and must stay that way at the source (see
[ADR-004](../adr/004-independent-signals/)). Each carries independent
information; collapsing them into one merged "score" or event would destroy the
very independence that makes convergence meaningful (two independent signals
agreeing is far more meaningful than one blended signal). A unified alerts
center should **route and display** them side by side under one roof — shared
config, one inbox — **not fuse** the underlying detections. Combine the
*surface*, never the *substance*. Revisit this note before any refactor that
touches signal generation.
:::

### Per-tracked-user notification rules (beyond notify on/off)

Filters per tracked FOMO user: buys only, min $ size threshold, specific chains.
`notify_pushover` is currently one on/off gate driving both Pushover and the
in-app toast/sound together; these would need their own sub-toggles.

### Signal convergence v2

Configurable time window in Settings; richer dedupe across tabs; unified alerts
center integration.

### FOMO auth — Options B / C (revisit later)

We chose Option A (shared account). Alternatives if it hits rate limits / ToS
issues:

- **B:** each user pastes their own FOMO refresh token once (encrypted per-user
  via the existing `TOKEN_ENCRYPTION_KEY`); the rotation hook means they never
  re-enter it.
- **C:** full "Login with FOMO" (embed the Privy Apple/Google flow). Best UX,
  most work, possible ToS risk.

## Known gaps

- **FOMO prod** — leaderboard/holders can fail on Railway (Cloudflare datacenter
  block) when the VPS proxy isn't in front; see [Planned next](#planned-next).
- **Vercel** — confirm `VITE_API_URL` → Railway and `VITE_SUPABASE_ANON_KEY` are
  set (sensitive vars can't be auto-verified).
- **Express** — `trust proxy` not set in hosted mode produces rate-limit warnings
  in Railway logs.
- Confirm whether `/feed/tradingActivity` is a global firehose or following-only
  (auto-follow via `FOMO_ENSURE_FOLLOWS` mitigates if following-scoped).

Code-structure debt (the "god files" being split) lives on its own page: see
[Tech debt](../architecture/tech-debt/).
