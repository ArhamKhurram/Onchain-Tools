# Onchain Tools (OCT)

A real-time crypto intelligence console. OCT ingests **Discord** and **Telegram**
message streams, detects and enriches **contract addresses** on the fly, tracks
**fomo.family** traders, and surfaces convergence signals — contract calls and
smart-money buys landing on the same token inside a time window — across a live
web console, a marketing landing site, and an optional desktop app.

> Status: private, actively developed. Version `1.1.1`. Licensed **AGPL-3.0-only**.

---

## What's in the box

OCT is an **npm-workspaces monorepo**. Each workspace is independently deployable:

| Workspace       | Package name       | What it is                                             | Deploys to |
| --------------- | ------------------ | ------------------------------------------------------ | ---------- |
| `backend/`      | `oct-backend`      | Express + WebSocket server; ingestion, enrichment, API | Railway    |
| `frontend/`     | `oct-console`      | React 19 + Vite console (served at `/dashboard`)       | Vercel     |
| `landing/`      | —                  | React + Vite marketing site (served at `/`)            | Vercel     |
| `fomo-worker/`  | `oct-fomo-worker`  | Always-on Playwright worker for Cloudflare-gated FOMO API | VPS     |
| `desktop/`      | —                  | Electron wrapper (bundles backend + frontend)          | local pack |

`supabase/` holds migrations and generated types. `scripts/` holds dev/build helpers.

### High-level architecture

```
                 Discord (user token)        Telegram (MTProto)
                        │                            │
      ┌─────────────────┴────────────────────────────┴───────────────┐
      │  backend  (Express + ws)                                       │
      │   ingest → contract detect → enrich (GMGN → DexScreener)       │
      │          → store → broadcast over /ws                          │
      │   pollers: FOMO fan-out · missed-runner                        │
      └───────────────┬───────────────────────────┬──────────────────┘
          REST /api   │            WS /ws          │   HTTP (secret)
                      ▼                            ▼        ▼
                  frontend (console) ◀── live ──┐    fomo-worker (VPS)
                      │                          │    stealth Chromium →
                      └── Supabase (auth + RLS data)   prod-api.fomo.family
```

**Two deployment modes**, switched by a single env flag:

- **Local** (`OCT_MODE=local`, default) — single user, JSON-file storage
  (`backend/data/`), one global Discord/Telegram connection, no auth. This is
  what the desktop app runs.
- **Hosted** (`OCT_MODE=hosted`) — multi-tenant. Supabase auth + row-level
  security, per-user gateway pools, encrypted tokens at rest. In hosted mode the
  **Discord gateway runs in the browser** so a user's Discord token never touches
  the server; the backend still supplies Telegram, FOMO, and enrichment streams.

For the full internal map (data flow, module responsibilities, conventions), see
[`CLAUDE.md`](CLAUDE.md).

---

## Getting started

**Prerequisites:** Node 20+, npm 10+. (The backend and fomo-worker use Playwright;
run `npx playwright install chromium` when you need live FOMO/enrichment locally.)

```bash
# from the repo root — installs every workspace
npm install

# run backend + frontend + landing together
npm run dev
```

- Landing → http://localhost:5174
- Console → http://localhost:5174/dashboard
- Backend API/WS → http://localhost:3001

Run pieces individually with `npm run dev:backend` / `dev:frontend` / `dev:landing`.

### Configuration

Each app reads its own `.env` (copy from the checked-in `.env.example`):

- **`backend/.env`** — mode, CORS origins, Supabase service key, `TOKEN_ENCRYPTION_KEY`,
  and integration keys (FOMO, `BIRDEYE_API_KEY`, `GMGN_API_KEY`, `HELIUS_API_KEY`, …).
  See [`backend/.env.example`](backend/.env.example) — it documents every variable.
- **`frontend/.env`** — `VITE_API_URL` (backend origin, used for both REST and WS),
  `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. Only `VITE_`-prefixed (publishable)
  values belong here — the app throws if a service-role key is present.

> Two Supabase projects are used: `onchain-tools-dev` and `onchain-tools` (prod).
> Never point a dev build at the prod anon key by accident.

---

## Common scripts (run from repo root)

| Command                     | Does                                                        |
| --------------------------- | ---------------------------------------------------------- |
| `npm run dev`               | Backend + frontend + landing together (`scripts/dev-local`) |
| `npm run typecheck`         | Typecheck backend + frontend                                |
| `npm run build`             | Build backend + frontend                                    |
| `npm run build:vercel`      | Build landing + frontend and merge output (Vercel)          |
| `npm run build:railway`     | Build backend only (Railway)                                |
| `npm run dev:desktop`       | Run the Electron desktop shell                              |
| `npm run pack:desktop`      | Package the desktop app                                     |

Per-workspace commands use npm's `-w` flag, e.g. `npm run typecheck -w backend`.

---

## Deployment

- **Backend → Railway.** Nixpacks builds the backend and installs Chromium + system
  libs for Playwright (`nixpacks.toml`). Start command `npm run start -w backend`,
  health check `/health`.
- **Frontend + landing → Vercel.** `build:vercel` builds both and merges them so the
  landing serves at `/` and the console at `/dashboard` (`vercel.json` rewrites).
  WebSockets do **not** run on Vercel, so `VITE_API_URL` must point at the Railway
  backend, not the Vercel URL.
- **fomo-worker → VPS.** See [`fomo-worker/README.md`](fomo-worker/README.md). When
  `FOMO_PROXY_URL` + `FOMO_WORKER_SECRET` are set on the backend, the backend proxies
  FOMO calls to the worker instead of launching Playwright itself.

CI (`.github/workflows/ci.yml`) typechecks and builds every workspace on each PR.

---

## Documentation map

- [`CLAUDE.md`](CLAUDE.md) — architecture, conventions, and gotchas for contributors (and agents).
- [`IDEAS.md`](IDEAS.md) — backlog, planned work, and design principles.
- [`CHANGELOG.md`](CHANGELOG.md) — shipped changes.
