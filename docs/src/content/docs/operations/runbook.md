---
title: Runbook
description: Deploying, monitoring, and operating OCT across Railway, Vercel, and the VPS.
sidebar:
  order: 1
---

## Deploy targets

| Target | What | Trigger |
| --- | --- | --- |
| **Railway** | `oct-backend` (service `Onchain-Tools`, project `incredible-victory`, region asia-southeast1) | push to `main` (`npm run build:railway`) |
| **Vercel** | landing (`/`) + console (`/dashboard`) merged via `npm run build:vercel` | push to `main` |
| **VPS** (Vultr, `167.179.66.57`) | `fomo-worker` under systemd | manual: `git pull` + restart on the box |
| **GitHub Pages** | this docs site | push to `main` touching `docs/**` |
| **Desktop** | Electron installer (`npm run build:desktop`) | manual |

`main` is protected: PR + green CI only. `dev` deploys nowhere.

## Standard deploy (backend/frontend)

1. PR into `main`, CI green (typecheck ×4, tests ×2, builds ×3).
2. Merge — Railway and Vercel deploy automatically.
3. Watch the Railway deploy logs for the startup sequence; the boot lines
   report each subsystem's self-gate status (bot enabled/disabled, FOMO
   proxy mode, pollers).
4. If `CHANGELOG.md` gained a dated heading, the announce workflow posts to
   Discord automatically ([Announcements](../announcements/)).
5. After merge, merge `main` down into `dev`.

Rollback: Railway → redeploy the previous deployment; Vercel → promote the
previous build. Both are instant and safe — migrations are additive by
convention.

## Migrations

Two Supabase projects — dev `zcvubfadvdwjxgodznxh`, prod
`vmlxyqzjdaegkfylxfka`. Apply to dev first, verify, then prod. `main`'s
migration set must always describe the prod database (this is why the LP
migration stays on `main` even though LP code doesn't).

## fomo-worker (VPS)

```bash
ssh root@167.179.66.57
```

```bash
systemctl status fomo-worker
```

```bash
journalctl -u fomo-worker -n 100 --no-pager
```

```bash
curl -s http://127.0.0.1:3100/health
```

Update: `cd /opt/onchain-tools && git pull && npm install --workspaces=false --prefix fomo-worker && npm run build --prefix fomo-worker && systemctl restart fomo-worker`.

If FOMO calls start failing with Cloudflare challenges: restart the worker
first (fresh browser context), then check whether the Privy refresh token in
`fomo_poll_state` is still valid — re-seed it from a logged-in fomo.family
session if not (see `backend/.env.example` for the cookie procedure).

## Monitoring & health

| Check | How |
| --- | --- |
| Backend liveness | `GET https://<railway-host>/health` → `{"status":"ok"}` |
| Provider env | `GET /api/portfolio/status` (public probe) |
| FOMO pipeline | `GET /api/fomo/status` (poller active, last poll, last error, worker health) |
| Bot | Railway logs: `[Bot] OCT bot online as …` vs `DISCORD_BOT_TOKEN not set` |
| Worker | `GET http://<vps>:3100/health` |

Railway logs are the primary observability surface — there is no external
APM. Grep-worthy prefixes: `[Bot]`, `[Fomo]`, `[MissedRunner]`, `[Telegram]`,
`[Gateway]`.

## Common incidents

**Discord gateway won't connect (hosted user)** — the browser gateway emits
`gateway_auth_failed`; `tokenInvalid: true` means the user's token is dead,
`tokenBlocked` (backend/local only) means the IP is challenged — VPN off /
different network.

**Telegram feed silent but "connected"** — the 60 s health check should
catch and rebuild it (watch for reconnect logs). If it doesn't recover, the
session string may be revoked: user must re-login via
`/api/auth/telegram/start`.

**FOMO trades stopped** — `GET /api/fomo/status`: `pollerActive: false`
means no Supabase or no tracked users; `lastPollError` naming Cloudflare
means the worker needs a restart or a fresh refresh token.

**Bot offline** — it lives in the backend process; check Railway logs for
the `[Bot]` boot line. If `DISCORD_BOT_TOKEN not set`, the variable is
missing on the service.

## Secrets hygiene

- Never commit tokens; `.env` is gitignored, `gmgn_*.pem` is gitignored.
- `TOKEN_ENCRYPTION_KEY` must differ per environment and must never change
  once set (previously encrypted Discord tokens become undecryptable).
- The backend loads `.env` with `override: false` — platform-injected vars
  always win. Don't change this.
- Full variable reference: [Environments](../environments/).
