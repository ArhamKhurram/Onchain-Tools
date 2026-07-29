---
title: Setup & first run
description: Clone, install, configure, and run the OCT monorepo locally.
sidebar:
  order: 1
---

## Prerequisites

- **Node 20+** (CI runs on Node 20)
- npm (the repo uses npm workspaces; no pnpm/yarn)
- For FOMO features locally: Chromium via Playwright (`cd backend && npx playwright install chromium`)

## Install

```bash
git clone https://github.com/ArhamKhurram/Onchain-Tools.git
cd Onchain-Tools
npm install
```

`npm install` installs every workspace and runs the root `prepare` script,
which builds the shared package (`@oct/shared`) so the backend and frontend
can resolve it.

## Configure

Copy the backend env template and fill in what you need:

```bash
cp backend/.env.example backend/.env
```

The backend loads `backend/.env`, **not** a repo-root `.env`. Every feature
self-gates on its own variables — with an empty `.env` the server still runs
in local mode with feed ingestion and the console working, and FOMO /
missed-runner / bot subsystems disabled. See the
[environment variable reference](../operations/environments/) for the full list.

Key defaults:

| Variable | Default | Meaning |
| --- | --- | --- |
| `OCT_MODE` | `local` | `local` = single user, JSON storage, no auth. `hosted` = Supabase multi-tenant. |
| `PORT` | `3001` | Backend HTTP + WebSocket port. |
| `OCT_HOST` | mode-dependent | Local mode binds `127.0.0.1`; hosted binds `0.0.0.0`. |

:::caution
Local mode has **no authentication** and the API serves Discord tokens and
Telegram session strings. That is why local mode binds loopback. Do not widen
the bind without adding auth — see [ADR-008](../adr/008-local-loopback/).
:::

## Run

```bash
npm run dev
```

This starts three dev servers via `scripts/dev-local.mjs`:

- **backend** — Express + WS on `http://127.0.0.1:3001`
- **frontend** — the console (Vite) on `http://localhost:5173`, served at `/dashboard`
- **landing** — the marketing site (Vite)

Individual pieces: `npm run dev:backend`, `npm run dev:frontend`, `npm run dev:landing`.

## Verify a change

Always run before considering a change done:

```bash
npm run typecheck
```

```bash
npm run test
```

`strict: true` is on everywhere; the test suites are unit tests over pure
functions, so the compiler carries most of the weight on I/O-heavy code. See
the [testing strategy](../testing/strategy/).

## Command reference

| Command | What it does |
| --- | --- |
| `npm run dev` | backend + frontend + landing together |
| `npm run typecheck` | backend + frontend `tsc --noEmit` (builds `@oct/shared` first) |
| `npm run test` | backend + frontend vitest |
| `npm run build` | backend + frontend production builds |
| `npm run build:vercel` | landing + frontend, merged into one Vercel output |
| `npm run build:railway` | backend only |
| `npm run docs:dev` / `npm run docs:build` | this documentation site |
| `npm run dev:desktop` / `npm run pack:desktop` | Electron shell (not a workspace — invoked via `--prefix`) |

Per-workspace scripts: `npm run <script> -w <workspace>`, e.g.
`npm run typecheck -w landing`.
