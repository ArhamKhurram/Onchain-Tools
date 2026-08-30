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

Two things are genuinely in flight. Everything else on this page is either
already shipped (see [Recently shipped](#recently-shipped-aug-2026)) or still
an idea we haven't committed to.

### Production hardening pass

A batch of small changes is in review against `main`. It isn't one feature —
it's a sweep, and each piece lands on its own as it passes review:

- **Failure isolation** — process-level error guards so a single transient
  ingest error can't take the server down for everyone, plus a `/health/deep`
  readiness probe kept deliberately separate from the liveness check the
  platform restarts on.
- **Auth and input hardening** — authentication required on the portfolio
  status endpoint in hosted mode, and non-finite sniper spend caps rejected
  (a non-numeric cap disabled the limit instead of raising it).
- **Performance** — the caller-stats sweep walks active users rather than every
  registered one; analytics loads on demand instead of on every page load.
- **Readability** — a real type scale for the console, so body text clears the
  12px tier.

### Research spike — trading agent

A separate branch (`research/trading-agent`) is exploring whether a
reinforcement-learning agent can trade newly launched pairs. So far that means
a replay simulator and paper ledger, a point-in-time feature store with a
leakage firewall, multi-venue curve models, and a first learner.

**Nothing from this ships today and none of it is promised.** It lives off
`main`, touches no part of the console, and its first honest evaluation gate
came back **no-go** — recorded as such rather than quietly rerun until it
passed. It is listed here because it is real work in progress, not because it
is a planned feature.

## Planned next

### Caller quality — follow-ups

Phases 1 and 2 shipped Jul 30, and a second pass in August moved scoring onto a
durable record and put peak MC and caller bands on the feed itself (see
[Recently shipped](#recently-shipped-aug-2026)). Remaining:

- **Backfill.** Scores only accumulate once the peak refresh has been running —
  a token called before the first pass has no peak, so early scores are thin.
  Consider a one-off backfill over recent contracts.
- **Peak fidelity.** Peaks are sampled periodically, so a spike between passes
  is missed. That is fine for banding, and every surfaced figure is presented as
  a floor ("at least this high") for exactly that reason — but it means no peak
  number should ever be dressed up as an exact all-time high.
- **Per-room scores.** Scores are currently global per caller. A caller can be
  sharp in one room and noise in another; the manual tier covers that case by
  hand today.

### FOMO prod reliability rework

Prod FOMO used to work locally and break on Railway: Cloudflare blocks datacenter
IPs (`upstream 0`), leaderboard/holders failed without a warm browser session,
and API volume was uncached. The fix was never 20 manual accounts — one shared
service account is correct, with the infrastructure and caching fixed around it.
Most of that has now shipped; this section is kept because the reasoning still
governs anything that touches FOMO upstream calls.

**Root causes (three different limits):**

- **Cloudflare** — cold Playwright on a Railway datacenter IP; manually copying
  `FOMO_CF_*` env is a band-aid. Dev works because it's a home IP + warm session.
- **FOMO API rate limit** — HTTP 429 from too many calls on one account/IP.
- **OCT express limiter** — 120 req/min on `/api` in hosted mode; needs
  `trust proxy` behind Railway.

**Phases 1 and 2 have shipped.** What landed:

- The browser is initialised **once** at boot and the shared client is reused
  across routes, instead of re-initialising per leaderboard request.
- **Server-side cache** — leaderboard 5 min, hodlers overlap 15 min, theses
  3 min, each overridable by env.
- **Adaptive poll interval** — the poller backs off to a slower cadence when no
  authenticated client is connected.
- **`trust proxy`** is set in hosted mode, so express-rate-limit sees the real
  client IP behind the platform proxy.
- **`/api/fomo/status`** reports poll and session health.
- **Dedicated FOMO worker** on an always-on VPS with a persistent Playwright
  profile that survives redeploys; the backend calls it as an internal proxy.
  See [fomo-worker](../architecture/fomo-worker/).

Still open: an optional residential proxy if Cloudflare blocks the worker's IP
anyway, and the account pool below.

*Phase 3 — account pool (only if 429s persist)*
- `fomo_service_accounts` table; 2–3 service accounts; auto-rotate on 429.
- Fully automated — no manual cookie copying.

**Do not:** run 20 manual accounts, build per-user FOMO OAuth (Option B/C), or run
an uncached leaderboard + overlap + poller from one cold Railway container.

**Privy refresh token:** already auto-rotates into `fomo_poll_state` — a manual
update is only needed when the session is fully revoked.

## Recently shipped (Aug 2026)

Written up for users in
[`CHANGELOG.md`](https://github.com/ArhamKhurram/Onchain-Tools/blob/main/CHANGELOG.md);
the structural summary is below.

### A fourth and fifth signal

- **Revival alerts** — a token that died and then came back gets its own alert,
  with 24-hour outcome tracking on every one.
- **Breakout alerts** — revival's sibling: a token consolidating near its highs
  and then igniting is a different setup, so it fires its own amber alert with
  its own sound rather than being folded into revival.
- **Price alerts** — a manual level watch. Nothing is detected or scored: you
  name a token and a level, it fires once on the crossing. The first reading
  after arming is a baseline only, so a token already past the level doesn't
  ping immediately.
- **FOMO new-join alerts** — a ping when a notable account joins fomo.family,
  on the theory that the join is the signal and the first buys are already late.

These stay separate detections, per the design principle below.

### Caller quality, second pass

- **Durable caller record** — ranking reads a persistent record written on scan
  and re-folded by a reconciler, rather than the rolling contract log. A caller
  appears on the board milliseconds after a scan, and the sweep re-prices the
  same row once enrichment fills `fdvAtCall` in.
- **Peak MC on the feed** — contract rows show MC at call, highest MC since, and
  the multiple. Peaks are floors by construction, a run before someone's call is
  never credited to them, and the UI says so.
- **Caller bands on the CA feed** — Elite / Solid / Mixed / Slop, or an honest
  Unrated below the evidence threshold — never a made-up neutral score.
- **Global first on the radar** — earliest known call anyone made, from Rick's
  cross-server data plus an anonymous network pool of first sightings that
  stores only token, time, and market cap — never who saw it or where.

### Sniper (alpha)

Operator-declared buys at a custodial venue, shipped from `main`. A new rule is
a dry run; arming, going live, and firing are three further confirmations; a
kill switch blocks every console buy at once and survives restart. The venue
token is written to an encrypted vault by the user's own browser and read only
at the moment of firing. **Triggers still live in the venue account, not in
OCT** — the automatic loop fires without OCT and never calls back, so OCT's caps
bind console-fired buys only. See the
[sniper overview](../architecture/sniper/).

### pump.fun

Trader tracking (live buys/sells, per-token realized and unrealized PnL), a live
callout feed with the market cap at each call, opt-in callout DMs, and per-caller
mutes.

### Console and platform

- **Onboarding** — a demo feed on first run instead of an empty console, plus a
  token trust panel.
- **Top Callers Feed pane** — a Workspace pane restricted to elite and trusted
  callers, with inline stats.
- **Rescan collapsing** — repeat scans of one contract fold into a single row
  with a scan count instead of flooding the feed.
- **Daily digest DM** — opt-in bot DM covering your alerts and how they resolved.
- **Circuit breaker on DexScreener enrichment** — fail fast during provider
  outages rather than queueing into one.
- **Privacy-first analytics** — pageview capture with URL sanitisation.

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

### Liquidation heatmap (Hyperliquid) — might do

An on-chain liquidation map: every leveraged position's liquidation price plotted
against time, shorts above spot and longs below, with cluster size shown as
intensity. Liquidations are forced market orders, so dense clusters are pools of
guaranteed counterparty flow — which is why price tends to accelerate through them
and stall where the map is empty.

Feasible because Hyperliquid is an on-chain perp DEX: positions, leverage and
margin are public, so liquidation prices can be **computed** rather than inferred.
Most liquidation heatmaps estimate from volume and open interest; this would not
have to.

Two honest reasons it is deferred rather than planned:

- **It is a different product.** OCT is new-pair memecoin intelligence on Solana
  and EVM. This is perp-market structure on a venue we do not otherwise touch, for
  an audience that overlaps ours only partly.
- **It is a map of fuel, not a prediction.** Clusters get taken out, ignored, or sit
  untouched for weeks. Shipped without that caveat attached, it would be read as a
  forecast — which is exactly the kind of overclaiming the caller-quality work has
  been careful to avoid.

Prerequisite if it is ever picked up: a real-time Hyperliquid position feed and
somewhere to put a chart this dense — the Workspace, not the Feed.

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
- ~~**Express** — `trust proxy` not set in hosted mode produces rate-limit
  warnings in Railway logs~~ — fixed; hosted mode sets `trust proxy`.
- ~~Confirm whether `/feed/tradingActivity` is a global firehose or
  following-only~~ — moot: the tracked-trader poller pulls from
  `/v2/users/{id}/activity`, not `/feed/tradingActivity`, so following-scope
  on the latter can't affect it either way. The speculative auto-follow
  mitigation (`FOMO_ENSURE_FOLLOWS`) guessed at two undocumented follow
  endpoints that always 404'd and was removed 2026-08-18.

Code-structure debt (the "god files" being split) lives on its own page: see
[Tech debt](../architecture/tech-debt/).
