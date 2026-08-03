# CLAUDE.md

Working guide for this repository. Read this before making changes.

Full developer documentation (architecture, ADRs, API reference, database
schema, test plan, operations runbook, roadmap) lives at
https://arhamkhurram.github.io/Onchain-Tools/ — this file stays a terse
operating summary; anything long-form belongs there instead.

Onchain Tools (OCT) is a real-time crypto intelligence console: it ingests Discord
and Telegram streams, detects + enriches contract addresses, tracks fomo.family
traders, and raises convergence/missed-runner alerts. It ships as a web console, a
landing site, and an Electron desktop app.

---

## The one concept to internalize first: two modes

Almost every branch in this codebase keys off **local vs hosted mode**. Get this
right and the rest follows.

| | **Local** (`OCT_MODE=local`, default) | **Hosted** (`OCT_MODE=hosted`) |
| --- | --- | --- |
| Users | one implicit user (`userId = 'local'`) | many; Supabase-verified `userId` per request |
| Storage | JSON files in `backend/data/` | Supabase (Postgres) with row-level security |
| Auth | none | Supabase bearer token (REST + WS) |
| Discord gateway | one global connection **on the server** | runs **in the browser** — token never hits the server |
| Telegram / gateways | single global manager | per-user pool with idle eviction |
| Token storage | plaintext in JSON | AES-256-GCM encrypted at rest |
| Used by | desktop app | Railway + Vercel deployment |

The switch is read in exactly two places:
- Backend: `isHostedMode()` in `backend/src/storage/index.ts` (`OCT_MODE`/`TRENCHCORD_MODE === 'hosted'`).
- Frontend: `isHostedMode` / `isClientGatewayMode()`, both derived from `VITE_SUPABASE_URL` being set (`frontend/src/lib/supabase.ts`, `frontend/src/discord/clientGateway.ts`). **Hosted mode and browser-Discord-gateway mode are the same deployment mode.**

---

## Monorepo layout (npm workspaces)

Root `package.json` declares
`workspaces: [packages/*, backend, frontend, landing, fomo-worker, lp-automation]`.
`desktop` is not a workspace (invoked via `npm --prefix desktop`).

- `backend/` (`oct-backend`) — Express + WebSocket server → **Railway**.
- `frontend/` (`oct-console`) — React 19 + Vite console, served at `/dashboard` → **Vercel**.
- `landing/` — React + Vite marketing site, served at `/` → **Vercel**.
- `fomo-worker/` (`oct-fomo-worker`) — always-on Playwright worker for the
  Cloudflare-gated FOMO API → **VPS**. Its `dist/` is gitignored; `src/` is tracked.
- `lp-automation/` (`oct-lp-automation`) — autonomous Uniswap V3 LP position
  manager for Robinhood Chain → **Railway** (`ponslive-worker`, no public
  networking). **Holds a signing key over real funds**, which is exactly why it is
  a separate process rather than a backend module like the Discord bot: the
  backend ingests arbitrary Discord/Telegram input, and a bug there must not be
  able to reach a signer. Read `LP_AUTOMATION_PLAN.md` §4 before touching
  `contracts/` or anything that builds a transaction. Its Solidity is tested by
  Foundry in CI only — `npm run test` does not cover it.
- `desktop/` — Electron shell bundling backend + frontend.
- `supabase/` — migrations. (The generated Supabase types live in
  `packages/shared/src/database.types.ts` so backend + frontend can import them.)
- `scripts/` — `dev-local.mjs` (runs the three dev servers) and Vercel output merge.

### Commands (from repo root)

```bash
npm install              # installs all workspaces
npm run dev              # backend + frontend + landing together
npm run typecheck        # backend + frontend + lp-automation (tsc --noEmit)
npm run test             # backend + frontend + lp-automation (vitest)
npm run build            # backend + frontend
npm run build:vercel     # landing + frontend, merged for Vercel
npm run build:railway    # backend only
```

Per-workspace: `npm run <script> -w <workspace>` (e.g. `npm run typecheck -w landing`).
**Always run `npm run typecheck` and `npm run test` before considering a change
done.** `strict: true` is on everywhere. Coverage is unit tests over pure functions
only — there are no integration or end-to-end tests, so the compiler still carries
most of the weight on anything involving I/O.

<<<<<<< HEAD
The `lp-automation` Solidity is **not** covered by `npm run test`. It runs under
Foundry in CI (`.github/workflows/ci.yml`, job `contracts`), which is its only
automated verification — treat a red run there as blocking.
=======
**LP automation and the sniper do not live on this branch.** The
`lp-automation/` workspace, its dashboard page, its `/api/lp` routes and its
Foundry CI job are on `dev`, as is `backend/src/sniper/` (reverted from `main`
in #55). Don't re-add them here — see the branch topology below.
>>>>>>> main

---

## Backend (`backend/src`)

**Entry:** `bootstrap.ts` (preflight dependency check only) → `index.ts` (the real app).

**Startup order** (`index.ts`): env load (`override:false`, never clobber injected
secrets) → Express middleware (hosted-only: `trust proxy`, CORS allow-list, helmet,
rate limits) → HTTP server → `WsServer` at `/ws` → `/api` routes → `listen(3001)` →
`startFomoPoller` → `startMissedRunnerPoller` → (local only) auto-connect Discord/Telegram.

### Core data flow (Discord and Telegram share one pipeline)

```
ingest → room gating → processMessage (detectContractAddresses + matchKeywords)
  → per contract: storage.logContract → wsServer.broadcastContract → scheduleDexFallback (15s)
  → background EVM chain resolve → broadcastChainUpdate
  → (Discord only) Rick embed parse → storage.enrichContract → broadcastContractEnrichment
  → keyword/Pushover alerts → wsServer.broadcastMessage
```

Key files: `discord/gatewayManager.ts` + `discord/gateway.ts` (multi-token, deduped),
`telegram/clientManager.ts` + `telegram/client.ts` (MTProto via `teleproto`),
`utils/messageProcessor.ts`, `utils/contract.ts` (SOL + EVM detection),
`utils/keywordMatcher.ts`, `utils/rickEmbedParser.ts`, `ws/server.ts` (all `broadcast*`).

### Enrichment provider split (important, deliberate)

- **GMGN** (`utils/gmgnEnrichment.ts` → `utils/gmgnClient.ts`) → token enrichment +
  missed-runner live market cap. Used only when `GMGN_API_KEY` is set.
- **DexScreener** (`utils/tokenEnrichment.ts`) → fallback for symbol/metadata.
- **Birdeye** (`portfolio/`) → **portfolio only** (holdings/PnL/activity). Not used
  for enrichment.

Don't cross these wires. `enrichToken` in `utils/tokenSnapshot.ts` orchestrates the
GMGN→DexScreener order and persists to the token catalog (`storage/tokenCatalog.ts`).

### Storage abstraction

`storage/interface.ts` defines `StorageProvider` (every method takes `userId` first).
`storage/json.ts` (local, delegates to `config/store.ts` + `utils/contractLog.ts`) and
`storage/supabase.ts` (hosted, RLS-scoped, encrypts tokens) implement it.
`storage/index.ts` picks one via `getStorageProvider()` + `isHostedMode()`. **New
persistence should go through this interface, not directly to Supabase or the JSON store.**

### fomo-worker

fomo.family sits behind Cloudflare, so API calls must originate from a real stealth
Chromium page. Options:
- **In-process** (`fomo/client.ts` `FomoClient`) — backend drives Playwright itself.
- **Proxy** (`fomo/proxy-client.ts` `FomoProxyClient`) — backend HTTP-POSTs to the
  VPS worker when `FOMO_PROXY_URL` + `FOMO_WORKER_SECRET` are set (`isFomoProxyMode()`).

`ensureSharedFomoClient()` selects between them. The worker (`fomo-worker/src/`)
exchanges a Privy refresh token for short-lived JWTs, runs API calls inside
`page.evaluate`, and persists rotated tokens back to `fomo_poll_state`.
`fomo/poller.ts` polls each unique tracked trader once (deduped across subscribers),
stores swaps, then fans out via `wsServer.sendToUser(...{type:'fomo_trade'})`.
`fomo/cache.ts` is a TTL cache (leaderboard 5min, hodlers 15min).

### Auth

`auth/middleware.ts` sets `req.userId` (`'local'` in local mode; Supabase-verified in
hosted). `auth/encryption.ts` is AES-256-GCM (`TOKEN_ENCRYPTION_KEY`, 64 hex chars) for
Discord tokens at rest. `gateway/userGatewayPool.ts` manages per-user gateways with
30-min idle eviction; `gateway/state.ts` holds the single global gateway for local mode.

---

## Frontend (`frontend/src`)

**Entry:** `main.tsx` (pre-paint `initTheme()`; renders `PopoutView` if `?popout=1`,
else `App`) → `App.tsx` (`BrowserRouter`, base `/dashboard/`, all pages lazy) →
`AppProviders.tsx` (boots `useWebSocket`, `useClientGateway`, `useSignalConvergence`,
auth session, initial data loads) → `layout/AppShell.tsx` (persistent chrome + `<Outlet/>`).

Pages (`pages/`): Dashboard, Feed, Wallets, Portfolio, Callers (radar), Workspace, Settings, Login.

### State — `stores/appStore.ts` (one large Zustand store)

Holds auth/config, rooms + multi-pane layout, messages (keyed by room, capped 1000),
alerts + notification history, contracts (capped 2000), Discord/Telegram sources, FOMO
trades, and UI/gateway status. Also home to the REST client `apiFetch` (attaches the
Supabase bearer token; `API_BASE = VITE_API_URL + '/api'` or `/api`). Consume via
selectors (`useAppStore(s => s.x)`); non-React code uses `getState()/setState()/subscribe()`.
Smaller stores: `themeStore.ts`, `updatesUiStore.ts`. This file is a refactor target — see below.

### Real-time — two transports

1. **Backend WebSocket** (`hooks/useWebSocket.ts`) — connects to `${VITE_API_URL}/ws`,
   auto-reconnects, auth frame + `subscribe_all`, dispatches typed frames (`message`,
   `contract`, `contract_enrichment`, `fomo_trade`, `reaction_update`, …) into the store.
2. **Browser Discord gateway** (`discord/browserGateway.ts`, `gatewayManager.ts`,
   `clientGateway.ts`, `hooks/useClientGateway.ts`) — in hosted mode, a full Discord
   user-gateway client runs **in the browser** (direct `wss://gateway.discord.gg` +
   Discord REST). This keeps the user's Discord token off the server.

When the browser gateway is active, `useWebSocket` sets `skipDiscordWs` and ignores
Discord frames from the backend, but still consumes Telegram, FOMO, and enrichment.
The two transports are mutually exclusive for Discord, complementary for everything else.

### Backend calls + Supabase

There is no single API client — `apiFetch` (store) plus per-hook `portfolioFetch`/
`fomoFetch` each re-attach the bearer token (shared primitives in `lib/supabase.ts`:
`getAccessToken`, `authHeaders`). Supabase is used for **auth** and, in some hooks
(`useTrackedWallets`, `useHoldingWallets`, `useFomoTracking`), **direct RLS-scoped table
reads/writes** rather than going through the backend. `lib/supabase.ts` throws at import
if any `VITE_SUPABASE_SERVICE*` key is present (guards against leaking the service role).

---

## Conventions & gotchas

- **Dual env branding.** Vars are read as `OCT_*` with `TRENCHCORD_*` fallbacks
  (`OCT_MODE`, `OCT_DATA_DIR`, `OCT_FRONTEND_DIST`, `OCT_HOST`). The project was renamed
  from "Trenchcord" — keep both when touching env reads.
- **Local mode binds loopback.** Local mode has no auth (every request is `local`) and the
  API serves Discord tokens and Telegram session strings, so `index.ts` listens on
  `127.0.0.1`; hosted mode listens on `0.0.0.0` for Railway. `OCT_HOST` overrides both.
  Don't widen the local bind without adding authentication.
- **Never clobber injected secrets.** `index.ts` loads `.env` with `override:false` so
  Railway/Vercel-injected vars win. Don't change this.
- **WebSockets don't run on Vercel.** `VITE_API_URL` must point at the Railway backend,
  never the Vercel URL.
- **Provider split** (GMGN = enrichment/missed-runner, Birdeye = portfolio) is intentional.
- **Signals stay independent.** Convergence, FOMO buys, and missed-runner are distinct
  signals by design — route/display them together but never fuse the underlying
  detections. See the design-principle note in the [roadmap](https://arhamkhurram.github.io/Onchain-Tools/roadmap/).
- **`dist/` is gitignored** in every workspace; commit `src/` only.
- **Two Supabase projects** — dev (`zcvubfadvdwjxgodznxh`) and prod
  (`vmlxyqzjdaegkfylxfka`). Verify migrations against the right one.
- **Background subsystems self-gate** on Supabase presence, so the server runs cleanly
  in local mode without FOMO/missed-runner.

---

## Known oversized files (refactor targets)

These are being split incrementally — see the
[tech debt plan](https://arhamkhurram.github.io/Onchain-Tools/architecture/tech-debt/)
for the full detail. Prefer extracting into the planned structure over adding
more to them:

- `frontend/src/components/GlobalSettings.tsx` (~2.9k) · `Message.tsx` (~1.5k) · `RoomConfig.tsx` (~1k)

`backend/src/api/routes.ts` and `storage/supabase.ts` have already been split
(`routes/*.ts`, `storage/supabase/*.ts`); `frontend/src/stores/appStore.ts` is
already sliced.

---

## Working in this repo

### Branch topology

<<<<<<< HEAD
**You are on `dev`** — the integration branch. It carries *both* halves and
**nothing merges out of it**; it exists to prove they still compose.
=======
Two long-lived branches. **`dev` is an integration branch that nothing merges
out of** — it exists to prove production and the unshipped work still compose.
>>>>>>> main

```
                 production work
                         │
<<<<<<< HEAD
main      ───●───────────●────────────●─────►   production, NO lp-automation
              ╲           ╲            ╲
               ╲ merge     ╲ merge      ╲ merge
dev       ───────●───────────●────────────●─►   YOU ARE HERE (main ∪ LP-Feats)
              ╱           ╱            ╱
             ╱ merge     ╱ merge      ╱
LP-Feats  ───●───────────●────────────●─────►   lp-automation + LP dashboard
```

- **Non-LP feature** → PR into `main` → merge `main` down into `dev`.
- **LP feature** → PR into `LP-Feats` → merge `LP-Feats` down into `dev`.
- **Never merge `dev` into `main`** — it would re-add `lp-automation/` to
  production. The old `feature → dev → main` promotion no longer applies.
- Do not push straight to `main`; PR + green CI first.

Only `main` deploys (Railway backend, Vercel frontend + landing). `dev` and
`LP-Feats` are for CI and local work.

The commit that removed LP from `main` was merged here with `-s ours`, so git
already considers it merged. Ordinary `main → dev` merges from here are clean —
if one ever proposes deleting `lp-automation/` again, something has gone wrong;
do not accept it.
=======
main      ───●───────────●────────────●─────►   production (Railway + Vercel)
              ╲           ╲            ╲            no LP, no sniper
               ╲ merge     ╲ merge      ╲ merge
dev       ───────●─────●─────●─────●──────●─►   everything
                       │           │                (main ∪ LP ∪ sniper)
                    LP / sniper work
```

- **Production feature** → PR into `main` → then merge `main` down into `dev`.
- **LP or sniper work** → branch off `dev`, PR back into `dev`. It never reaches
  `main`.
- **Never merge `dev` into `main`.** It would drag `lp-automation/` and the
  sniper back in. This is why the old `feature → dev → main` promotion flow no
  longer applies.
- Do not push straight to `main`; PR + green CI first.

**Merging `main` down into `dev` deletes the sniper module.** `main` reverted
the dormant sniper in #55, and that revert propagates: it removes all 26 sniper
files with no conflict, because `dev`'s copy and the revert's deletion never
touch the same lines. Check `backend/src/sniper/` survives every `main` → `dev`
merge and restore it from the pre-merge commit if not.

`main` deploys to Railway (backend) and Vercel (frontend + landing). `dev`
deploys nowhere — it is for CI and local work. The `LP-Feats` branch was retired
on 2026-08-03 (tag `archive/LP-Feats`); its work had all landed on `dev`.
>>>>>>> main
- **Before finishing any change:** `npm run typecheck` (and the relevant `build`).
- **Docs:** update the [roadmap](https://arhamkhurram.github.io/Onchain-Tools/roadmap/)
  when scoping features, `CHANGELOG.md` when shipping.

### Discord announcements (automatic)

Adding a new `## <date>` section to `CHANGELOG.md` and merging it to `main`
posts that entry to the Discord announcements channel — no manual step.

`.github/workflows/announce.yml` → `scripts/announce-changelog.mjs` → the
existing `POST /api/v1/bot/announce`, which renders the branded Components V2
container via the already-connected bot client. No webhook, no second Discord
login, no new secret beyond the bot key.

It is **event-driven, not scheduled**: it fires on pushes to `main` that touch
`CHANGELOG.md`, and no-ops unless the push actually *added* a dated heading —
so rewording a shipped entry doesn't re-announce the release. Run it by hand
(Actions → Announce) with `dry_run` to preview, or `force` to backfill.

Requires two repo secrets: `OCT_BOT_API_KEY` (same value as the backend env)
and `OCT_API_BASE` (the Railway URL). Optional repo variable
`ANNOUNCE_LINK_URL` sets the "Open →" target.
