# FOMO Worker

Always-on **Playwright + Chromium** gateway for `prod-api.fomo.family`. Runs on your VPS; the OCT backend on Railway calls it over HTTP instead of launching a browser in a datacenter container.

## Architecture

```
Railway (OCT backend)  ──HTTP + secret──►  VPS (this worker)  ──browser──►  fomo.family API
         │                                         │
         └──────────── Supabase fomo_poll_state ───┘   (shared refresh token)
```

## Quick deploy (Vultr / Ubuntu 22.04)

On the VPS as `root`:

```bash
# 1. Clone or copy the repo
git clone https://github.com/ArhamKhurram/Onchain-Tools.git /opt/onchain-tools
cd /opt/onchain-tools/fomo-worker

# 2. Run setup (installs Node 20, deps, Playwright Chromium, systemd unit)
chmod +x deploy/setup-vps.sh
./deploy/setup-vps.sh

# 3. Edit secrets
nano /etc/fomo-worker.env
# Set at minimum:
#   FOMO_WORKER_SECRET=<random hex>
#   FOMO_REFRESH_TOKEN=<ap1wp_... from fomo.family cookies>
#   SUPABASE_URL + SUPABASE_SERVICE_KEY (prod — for token rotation)

# 4. Start
systemctl enable --now fomo-worker
systemctl status fomo-worker
curl -s http://127.0.0.1:3100/health | jq
```

## Railway env (OCT backend)

```env
FOMO_PROXY_URL=http://167.179.66.57:3100
FOMO_WORKER_SECRET=<same secret as worker>
```

Optional tuning:

```env
FOMO_POLL_IDLE_INTERVAL_MS=60000
FOMO_LEADERBOARD_CACHE_MS=300000
FOMO_HODLERS_CACHE_MS=900000
```

## Security

- Port `3100` is protected by `FOMO_WORKER_SECRET` (Bearer token on `/v1/*`).
- Restrict inbound `:3100` to Railway's egress IP if your provider supports it; otherwise rely on the secret.
- Rotate `FOMO_WORKER_SECRET` if exposed.

## Local dev

```bash
cd fomo-worker
cp .env.example .env
# fill FOMO_REFRESH_TOKEN + FOMO_WORKER_SECRET
npm install
npm run dev
```

Backend local `.env`:

```env
FOMO_PROXY_URL=http://127.0.0.1:3100
FOMO_WORKER_SECRET=dev-secret
```

## Endpoints

| Route | Auth | Purpose |
|-------|------|---------|
| `GET /health` | none | Worker + browser status |
| `POST /v1/session/sync` | Bearer | Sync refresh token from Railway |
| `POST /v1/call` | Bearer | Proxy a FOMO API path |
| `GET /v1/status` | Bearer | Detailed status |

Persistent Chromium profile lives at `FOMO_PROFILE_DIR` (default `/var/lib/fomo-worker/profile`).
