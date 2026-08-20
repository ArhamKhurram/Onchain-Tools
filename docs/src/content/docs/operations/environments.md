---
title: Environment variables
description: Every variable the backend, frontend, and workers read — and which subsystem gates on it.
sidebar:
  order: 2
---

The backend reads `backend/.env` (not a repo-root `.env`), loaded with
`override: false` so platform-injected values win. Vars are read as `OCT_*`
with `TRENCHCORD_*` fallbacks — keep both when touching env reads.

**Every subsystem self-gates**: unset variables disable features cleanly
rather than crashing.

## Core (backend)

| Variable | Default | Purpose |
| --- | --- | --- |
| `OCT_MODE` | `local` | `local` or `hosted` — [the mode switch](../../architecture/two-modes/). |
| `PORT` | `3001` | HTTP + WS port. |
| `OCT_HOST` | mode-dependent | Override the bind (`127.0.0.1` local / `0.0.0.0` hosted). |
| `OCT_DATA_DIR` | `backend/data` | Local-mode JSON store location. |
| `OCT_FRONTEND_DIST` | — | Where the backend serves the console from (desktop packaging). |
| `ALLOWED_ORIGINS` | — | Comma-separated CORS/WS allow-list (hosted). |

## Supabase (hosted mode)

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | dev `zcvubfadvdwjxgodznxh` / prod `vmlxyqzjdaegkfylxfka`. |
| `SUPABASE_SERVICE_KEY` | Service-role key (`SUPABASE_SERVICE_ROLE_KEY` also accepted). |
| `TOKEN_ENCRYPTION_KEY` | 64 hex chars (32 bytes) for AES-256-GCM token encryption. **Distinct per environment; never rotate casually** — old ciphertexts become unreadable. |

## FOMO

| Variable | Purpose |
| --- | --- |
| `FOMO_REFRESH_TOKEN` | Privy refresh token, first boot only — after that `fomo_poll_state` is DB-first and auto-rotates. |
| `FOMO_PROXY_URL` / `FOMO_WORKER_SECRET` | Set both → proxy mode via the VPS worker; backend never launches Playwright. |
| `FOMO_POLL_INTERVAL_MS` | Poll interval override (default 10 000; idle default 60 000 via `FOMO_POLL_IDLE_INTERVAL_MS`). |
| `FOMO_USER_ACTIVITY_LIMIT` | Activities fetched per trader per poll (default 15). |
| `FOMO_LEADERBOARD_CACHE_MS` / `FOMO_HODLERS_CACHE_MS` | Cache TTLs (default 5 min / 15 min). |
| `FOMO_TRADE_RETENTION_DAYS` | Trade-event retention (default 7). |
| `FOMO_PRIVY_*`, `FOMO_CF_*` | Cold-start reliability extras (app id, client ids, CF cookies). |

## Providers

| Variable | Gates |
| --- | --- |
| `GMGN_API_KEY` (+ optional `GMGN_PRIVATE_KEY` PEM) | GMGN enrichment + missed-runner live MC. |
| `BIRDEYE_API_KEY` | Portfolio tab (only). |
| `HELIUS_API_KEY` | Solana balance checks (missed-runner). |
| `ALCHEMY_API_KEY` | EVM `balanceOf` (falls back to public RPCs). |
| `MISSED_RUNNER_POLL_INTERVAL_MS` | Poller interval (default 180 000). |

## OCT Discord bot

| Variable | Purpose |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Unset ⇒ bot disabled, backend unchanged. |
| `DISCORD_APP_ID` | For slash-command deploys (`npm run bot:deploy -w backend`). |
| `DISCORD_DEV_GUILD_ID` | Instant command deploys to a test server. |
| `DISCORD_ANNOUNCE_CHANNEL_ID` | Target for `POST /api/v1/bot/announce` (unset ⇒ 503). |
| `OCT_BOT_API_KEY` | Machine secret for the `/api/v1/bot` HTTP surface (unset ⇒ 503). |

## pump.fun callouts → Discord channel

Public reposting of tracked pump.fun callouts through the same in-process bot.
**Default OFF** — it posts to a public channel, so both headline vars must be
set or the feature no-ops silently. All of these also honour the
`TRENCHCORD_CALLOUT_DISCORD_*` fallback branding.

| Variable | Purpose |
| --- | --- |
| `OCT_CALLOUT_DISCORD_ENABLED` | Master switch (`true`/`1`/`yes`/`on`). Default `false`. |
| `OCT_CALLOUT_DISCORD_CHANNEL_ID` | Target channel. Unset ⇒ nothing is posted. |
| `OCT_CALLOUT_DISCORD_CALLERS` | Optional comma-separated caller **wallet** allowlist. Unset ⇒ the global Top Callers board. Users' private follow lists are never a source. |
| `OCT_CALLOUT_DISCORD_MAX_PER_WINDOW` | Burst cap per rolling window (default 5). |
| `OCT_CALLOUT_DISCORD_WINDOW_MS` | The rolling window (default 60 000). |
| `OCT_CALLOUT_DISCORD_TOP_LIMIT` / `_MIN_CALLS` / `_BOARD_WINDOW_MS` | Top Callers board slice (defaults 25 / 3 / 7 days). |
| `OCT_CALLOUT_DISCORD_SOURCE_TTL_MS` | How long the resolved caller set is cached (default 600 000). |

## Frontend (Vite, build-time)

| Variable | Purpose |
| --- | --- |
| `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` | Presence of the URL **is** the hosted-mode switch client-side. |
| `VITE_API_URL` | The Railway backend origin — never the Vercel URL (WS doesn't run on Vercel). |

`lib/supabase.ts` throws at import if any `VITE_SUPABASE_SERVICE*` key
exists — the service role must never reach a browser bundle.

## fomo-worker (VPS)

| Variable | Purpose |
| --- | --- |
| `FOMO_WORKER_SECRET` | Must match the backend's value. |
| `PORT` | Default 3100. |
| Privy/CF extras | Same semantics as the backend's `FOMO_*` set. |

## CI / repo secrets

| Secret | Used by |
| --- | --- |
| `OCT_BOT_API_KEY` | announce workflow → `POST /api/v1/bot/announce`. |
| `OCT_API_BASE` | announce workflow — the Railway URL. |
| repo var `ANNOUNCE_LINK_URL` | Optional "Open →" target on announcements. |
