# OCT — Ideas & Backlog

A living list of features we've discussed but haven't shipped yet, so nothing gets
lost. Move items up to "Planned" when we commit to them, and into `CHANGELOG.md`
once shipped.

---

## In progress

_(Nothing actively in flight — pick from Planned next.)_

---

## Planned next

### FOMO prod reliability rework
Prod FOMO works locally but breaks on Railway: Cloudflare blocks datacenter IPs
(`upstream 0`), leaderboard/holders fail without warm browser session, and API
volume is uncached. **Do not** solve with 20 manual accounts — one shared
service account is correct; fix infra + caching.

**Root causes (three different limits):**
- **Cloudflare** — cold Playwright on Railway datacenter IP; manual `FOMO_CF_*`
  env copy is a band-aid. Dev works because home IP + warm session.
- **FOMO API rate limit** — HTTP 429 from too many calls on one account/IP.
- **OCT express limiter** — 120 req/min on `/api` in hosted mode; needs
  `trust proxy` behind Railway.

**Tier 0 (current):** one shared account, fan-out poller, no caching — breaks in prod.

**Recommended path:**

*Phase 1 — stop the bleeding (1–2 days)*
- Init browser **once** at boot; reuse shared client for all routes (no re-`init()`
  per leaderboard request).
- **Server-side cache** — leaderboard 5–15 min, hodlers overlap 15 min.
- **Adaptive poll interval** — 10s when users connected, 30–60s when idle.
- **`trust proxy`** on Railway for express-rate-limit.
- Richer **`/api/fomo/status`** — last successful poll, last CF error, token age.

*Phase 2 — prod behaves like dev (3–5 days)*
- **Dedicated FOMO worker** on always-on VPS/Fly with persistent Playwright
  profile (survives redeploys). OCT backend calls internal proxy.
- Optional residential proxy if CF still blocks.

*Phase 3 — account pool (only if 429s persist after Phase 1–2)*
- `fomo_service_accounts` table; 2–3 service accounts; auto-rotate on 429.
- Fully automated — no manual cookie copying.

**Do not:** 20 manual accounts, per-user FOMO OAuth (Option B/C), uncached
leaderboard + overlap + poller from one cold Railway container.

**Privy refresh token:** already auto-rotates into `fomo_poll_state` — manual
update only when session fully revoked. Friend's bot likely = warm browser +
VPS + caching, not account rotation.

---

## Recently shipped (Jul 2026)

### Token enrichment pipeline (Phase 1–2)
- **Rick + Dex merge fix** — Dex/GMGN fallbacks now run when `tokenSymbol` is missing, even
  on Rick-enriched rows; secondary sources fill symbol/name only without overwriting Rick FDV/Liq.
- **`token_catalog` table** — global Supabase cache (address, chain, symbol, fdv, price, source,
  raw JSON); migration `20260721100000_token_catalog.sql`.
- **GMGN adapter** — `backend/src/utils/gmgnClient.ts` + `gmgnEnrichment.ts`; Robinhood chain
  first when `GMGN_API_KEY` is set; DexScreener fallback.
- **Snapshot API** — `GET /api/tokens/:chain/:address/snapshot` returns cached MC/price; refreshes
  when stale (>5 min). Radar live MC now uses this instead of client-side Dex calls.
- **Env** — set `GMGN_API_KEY` on Railway backend (see `backend/.env.example`).

**Phase 3 (follow-ups):**
- Background catalog warmer / batch refresh for top Radar tokens.
- Extend GMGN to all supported chains in catalog (not just Robinhood-first).
- Wire snapshot into Feed contract rows (not only Radar).
- Prod migration apply + verify `token_catalog` on prod Supabase.

### FOMO tracking (v1 — fan-out)
- **Core client** — `FomoClient` + Playwright stealth Chromium; Privy refresh →
  JWT; auto-persist rotated token to `fomo_poll_state`.
- **Auth model:** Option A — single shared service account (`FOMO_*` env + DB).
- **Architecture:** fan-out-on-write — one global poll of `/feed/tradingActivity`
  → route trades to OCT users who track that FOMO user.
- **UI:** Wallets → FOMO tab — track list, live trade feed, leaderboard, Pushover
  bell per row.
- **Storage fix** — console persists tracked users via Supabase RLS; backend
  `/api/fomo/resolve` + `/api/fomo/tracked` for handle lookup + follow sync.
- **Leaderboard** — top traders (24h / all-time); one-click track; parsing fix for
  `responseObject.leaderboard` envelope.
- **Holder overlap** — Radar shows how many tracked FOMO traders hold each contract.
- **Signal convergence v1** — in-app alert when contract call + FOMO buy hit same
  token within configurable window; badge on Feed + Radar; optional Pushover.
- **Railway Playwright** — nixpacks Chromium + system deps; Ubuntu Noble
  `libasound2t64` fix.

### Console & landing
- **Radar sorting** — sortable column headers (red active state); `sort: latest`
  toolbar preset; Latest column (last mention time).
- **Code-splitting** — lazy routes, lazy `GlobalSettings`, vendor manualChunks
  (~150 kB main chunk).
- **Contract feed** — 30s Rick wait queue; Dex/catalog fallbacks; client-gateway
  persistence; ticker in feed rows.
- **Landing** — stope-style reskin; `/dashboard` split routing; Updates changelog
  section; footer/nav polish.

### Infra & auth
- **Hosted mode** — Supabase auth, RLS, Railway backend + Vercel frontend split.
- **Browser-side Discord gateway** — client-gateway mode; OAuth callback fix.
- **OCT rebrand** — neobrutalist cockpit theme across console.

---

## Deferred / backlog

### On-chain wallet detection engine
The Wallets page is currently a **watchlist only** (`user_tracked_wallets` CRUD in
Supabase). The `alerts_on_toast/feed/bubble` flags exist but nothing watches
addresses on-chain. Real detection needs a chain data provider (Helius / Bitquery
/ etc.) with its own cost + rate limits. Big build; deferred.
- Caveat: FOMO trades are gasless/relayed, so a FOMO user's exposed EOA may not
  show normal DEX swaps — on-chain detection could miss FOMO activity.

### Auto-bridge FOMO wallets → Wallet Tracker
FOMO's `/wallets` exposes each user's SOL/EVM addresses. When a user tracks a FOMO
account, auto-populate the on-chain watchlist with their real wallets. Only pays
off once the on-chain detection engine above exists — deferred until then.

### Holder overlap on contracts
~~In the Radar / contract view, show "N of your tracked traders hold this" via
`/hodlers/top`. Instant conviction signal on a contract.~~ **Shipped Jul 2026.**

### Leaderboard → one-click track
~~Surface FOMO's top traders (`/v2/leaderboard`, `/v2/leaderboard/24h`); tap a row
to add them to your FOMO track list.~~ **Shipped Jul 2026.**

### Unified alerts center
One place for every trigger — Discord highlight, contract detected, FOMO
tracked-user buy, (future) wallet movement — with per-source rules. Pushover is
already wired; this unifies routing/config.

### Per-tracked-user notification rules (beyond Pushover on/off)
Filters per tracked FOMO user: buys only, min $ size threshold, specific chains,
custom sound. Routes through existing Pushover triggers.

### Signal convergence v2
Configurable time window in Settings; richer dedupe across tabs; unified alerts
center integration.

### FOMO auth — Options B / C (revisit later)
We chose Option A (shared account). Alternatives if it hits rate limits / ToS
issues:
- **B:** each user pastes their own FOMO refresh token once (encrypted per-user
  via existing `TOKEN_ENCRYPTION_KEY`); rotation hook means they never re-enter it.
- **C:** full "Login with FOMO" (embed Privy Apple/Google flow). Best UX, most
  work, possible ToS risk.

### Discord bot integration (Outpost)
Port the Outpost bot's slash commands (`/holders`, `/thesis`, `/wallets`) that
consume the FOMO client. Explicitly **not doing yet** — FOMO client is merged as a
reusable backend service; the Discord layer is future work.

---

## Known gaps / tech debt
- **FOMO prod** — leaderboard/holders fail on Railway (CF datacenter block);
  `FOMO_PRIVY_TOKEN` synced to Railway; CF cookies still manual. See Planned next.
- **Vercel** — confirm `VITE_API_URL` → Railway, `VITE_SUPABASE_ANON_KEY` set
  (cannot auto-update sensitive vars).
- **Express** — `trust proxy` not set in hosted mode (rate-limit warnings in Railway logs).
- Prod Supabase (`vmlxyqzjdaegkfylxfka`) migrations status vs dev — verify before
  relying on prod schema.
- Confirm whether `/feed/tradingActivity` is global firehose or following-only
  (auto-follow via `FOMO_ENSURE_FOLLOWS` mitigates if following-scoped).
