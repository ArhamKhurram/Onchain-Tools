# Onchain Tools (OCT)

A real-time crypto intelligence console. OCT ingests **Discord** and **Telegram**
message streams, detects and enriches **contract addresses** on the fly, tracks
**fomo.family** traders, and surfaces convergence signals — contract calls and
smart-money buys landing on the same token inside a time window — across a live
web console, a marketing landing site, and an optional desktop app.

> Status: private, actively developed. Version `1.1.1`. Licensed **AGPL-3.0-only**.

---

## Full documentation

**https://arhamkhurram.github.io/Onchain-Tools/**

Architecture (C4 diagrams, sequence/state diagrams), architecture decision
records, REST + WebSocket API reference, database schema, test plan, the
operations runbook, and the roadmap all live there. This README stays a quick
orientation for cloning and running the project — everything else has moved.

---

## What's in the box

OCT is an **npm-workspaces monorepo**. Each workspace is independently deployable:

| Workspace       | Package name       | What it is                                             | Deploys to |
| --------------- | ------------------ | ------------------------------------------------------ | ---------- |
| `backend/`      | `oct-backend`      | Express + WebSocket server; ingestion, enrichment, API | Railway    |
| `frontend/`     | `oct-console`      | React 19 + Vite console (served at `/dashboard`)       | Vercel     |
| `landing/`      | —                  | React + Vite marketing site (served at `/`)            | Vercel     |
| `fomo-worker/`  | `oct-fomo-worker`  | Always-on Playwright worker for Cloudflare-gated FOMO API | VPS     |
| `docs/`         | `oct-docs`         | This documentation site (Astro Starlight)               | GitHub Pages |
| `desktop/`      | —                  | Electron wrapper (bundles backend + frontend)          | local pack |

`supabase/` holds migrations. `scripts/` holds dev/build helpers.

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
Full setup, configuration, and the command reference:
[Getting Started](https://arhamkhurram.github.io/Onchain-Tools/getting-started/setup/).

---

## Contributing

[`CLAUDE.md`](CLAUDE.md) — architecture, conventions, and gotchas for
contributors (and coding agents). Before finishing any change:

```bash
npm run typecheck
```

```bash
npm run test
```

Branch topology, working conventions, and known refactor targets:
[Contributing](https://arhamkhurram.github.io/Onchain-Tools/contributing/branching/).
