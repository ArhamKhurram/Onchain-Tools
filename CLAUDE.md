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
`workspaces: [packages/*, backend, frontend, landing, fomo-worker]`.
`desktop` is not a workspace (invoked via `npm --prefix desktop`).

- `backend/` (`oct-backend`) — Express + WebSocket server → **Railway**.
- `frontend/` (`oct-console`) — React 19 + Vite console, served at `/dashboard` → **Vercel**.
- `landing/` — React + Vite marketing site, served at `/` → **Vercel**.
- `fomo-worker/` (`oct-fomo-worker`) — always-on Playwright worker for the
  Cloudflare-gated FOMO API → **VPS**. Its `dist/` is gitignored; `src/` is tracked.
- `desktop/` — Electron shell bundling backend + frontend.
- `supabase/` — migrations. (The generated Supabase types live in
  `packages/shared/src/database.types.ts` so backend + frontend can import them.)
- `scripts/` — `dev-local.mjs` (runs the three dev servers) and Vercel output merge.

### Commands (from repo root)

```bash
npm install              # installs all workspaces
npm run dev              # backend + frontend + landing together
npm run typecheck        # backend + frontend (tsc --noEmit)
npm run test             # backend + frontend (vitest)
npm run build            # backend + frontend
npm run build:vercel     # landing + frontend, merged for Vercel
npm run build:railway    # backend only
```

Per-workspace: `npm run <script> -w <workspace>` (e.g. `npm run typecheck -w landing`).
**Always run `npm run typecheck` and `npm run test` before considering a change
done.** `strict: true` is on everywhere. Coverage is unit tests over pure functions
only — there are no integration or end-to-end tests, so the compiler still carries
most of the weight on anything involving I/O.

**LP automation is retired.** It lived only on `dev`, never shipped, and was
deleted in #80 — workspace, dashboard page, `/api/lp` routes and Foundry CI job.
Don't re-add it to either branch. The applied migrations were left in place and a
new migration drops the tables; `lp_automation_policies` survives because prod
has the table.

**The sniper ships from `main`.** `backend/src/sniper/` came onto `main` in #79
(dormant and unwired) and is now wired: the `/sniper/v1` control plane
(`backend/src/api/sniper/`) and the console's Sniper tab
(`frontend/src/pages/SniperPage.tsx`).

With LP gone and the sniper shipped, `dev` currently holds nothing that `main`
lacks except the video work. It stays as the integration branch — the split is by
intent, not by feature list.

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

### Sniper — the one subsystem that spends money

`backend/src/sniper/` executes operator-declared buys at a custodial venue
(Slotshark, Solana). Four things about it are structural, not stylistic:

- **`executeFire` is the only function allowed to spend**, and every control —
  kill switch, trigger claim, per-fire/per-trigger/daily caps, max open positions
  — is a step *inside* it. `fireOrchestrator.ts` is its only caller.
- **The control plane mounts at `/sniper/v1`, not under `/api`, and it is mounted
  in `index.ts` *before* `app.use(cors())`.** Local `/api` is wildcard-CORS with
  `userId = 'local'` and no credential, which is survivable for read endpoints and
  not for one that spends. It carries its own body parser, rate limit and auth
  (`api/sniper/auth.ts`: per-boot bearer token in a `0600` file for local,
  Supabase bearer for hosted, plus a strict `Origin`/`Host` check). Don't
  "tidy" it into `api/routes/`.
- **`SniperStore` (`sniper/storeInterface.ts`) is a sibling of `StorageProvider`,
  not an extension** — same `userId`-first convention, different shape. JSON in
  local, Supabase in hosted, picked by `sniper/stores/index.ts`.
- **The venue token is read late and never escapes the call frame.** In hosted
  mode the user's own client writes it straight into Supabase Vault; the backend
  reads it via a service-role RPC at the moment of firing. It is never logged,
  never returned by any response, never held in frontend state.

In the alpha OCT runs no tweet feed: the automatic tweet→buy loop lives inside the
operator's Slotshark account and never calls back, so OCT's caps and kill switch
bind console-fired buys only. The console says so permanently and the docs lead
with it — see the [sniper overview](https://arhamkhurram.github.io/Onchain-Tools/architecture/sniper/).

---

## Frontend (`frontend/src`)

**Entry:** `main.tsx` (pre-paint `initTheme()`; renders `PopoutView` if `?popout=1`,
else `App`) → `App.tsx` (`BrowserRouter`, base `/dashboard/`, all pages lazy) →
`AppProviders.tsx` (boots `useWebSocket`, `useClientGateway`, `useSignalConvergence`,
auth session, initial data loads) → `layout/AppShell.tsx` (persistent chrome + `<Outlet/>`).

Pages (`pages/`): Dashboard, Feed, Wallets, Portfolio, Callers (radar), Sniper,
Workspace, Settings, Login.

The Sniper page is page-local state, not a store slice (like Portfolio and FOMO),
and talks to `/sniper/v1` through `lib/sniperApi.ts` rather than `apiFetch` —
`API_BASE` is `VITE_API_URL + '/api'`, which is the one prefix the control plane
must not sit behind.

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

**The six-item [tech debt plan](https://arhamkhurram.github.io/Onchain-Tools/architecture/tech-debt/)
has fully shipped.** `api/routes.ts` → `routes/*.ts`, `storage/supabase.ts` →
`storage/supabase/*.ts`, `appStore.ts` → `stores/slices/*`, `RoomConfig.tsx` →
`room-config/*`, `GlobalSettings.tsx` → `settings/sections/*`, and `Message.tsx`
→ `message/*`. Don't re-plan those; the structure that landed is documented on
the linked page.

`Message.tsx` still measures ~910 lines. That is the plan's intended end state,
not leftover debt — the three render branches share ~15 derived values and were
deliberately kept together rather than threaded through as props.

Two files have since grown past the threshold and are **not** covered by any
plan. Prefer extracting from them over adding more:

- `frontend/src/components/ChatPane.tsx` (~960) · `callers/RadarTable.tsx` (~880)

(`packages/shared/src/database.types.ts` is ~1k but generated — never hand-edit.)

---

## Working in this repo

### Branch topology

Two long-lived branches. **`dev` is an integration branch that nothing merges
out of** — it exists to prove production and the unshipped work still compose.

```
                 production work
                         │
main      ───●───────────●────────────●─────►   production (Railway + Vercel)
              ╲           ╲            ╲            production code only
               ╲ merge     ╲ merge      ╲ merge
dev       ───────●─────●─────●─────●──────●─►   integration: main ∪ unshipped work
                       │           │
                   unshipped work
```

- **Production feature** → PR into `main` → then merge `main` down into `dev`.
- **Work that must not deploy yet** (today that is `lp-automation/`) → branch off
  `dev`, PR back into `dev`. It never reaches `main`.
- **Never merge `dev` into `main`.** It would drag whatever `dev` is holding into
  production. This is why the old `feature → dev → main` promotion flow no longer
  applies.
- Do not push straight to `main`; PR + green CI first.

**The sniper is production code and lives on `main`.** It was reverted from
`main` in #55, restored dormant in #79, and wired up immediately after; ignore
any older note claiming `main` ships without it. In particular the warning that a
`main` → `dev` merge silently deletes `backend/src/sniper/` is **obsolete** —
that deletion was the #55 revert propagating downward, and #79 superseded it.

`main` deploys to Railway (backend) and Vercel (frontend + landing). `dev`
deploys nowhere — it is for CI and local work. The `LP-Feats` branch was retired
on 2026-08-03 (tag `archive/LP-Feats`); its work had all landed on `dev`.
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
