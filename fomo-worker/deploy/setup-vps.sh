#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/onchain-tools}"
WORKER_DIR="$REPO_DIR/fomo-worker"
ENV_FILE="/etc/fomo-worker.env"
SERVICE_NAME="fomo-worker"

echo "==> Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git ca-certificates jq \
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
  libasound2 libpango-1.0-0 libcairo2 fonts-liberation

if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != v20* ]]; then
  echo "==> Installing Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi

echo "==> Building fomo-worker in $WORKER_DIR"
mkdir -p /var/lib/fomo-worker/profile
cd "$WORKER_DIR"
npm install
npx playwright install chromium
npm run build

if [[ ! -f "$ENV_FILE" ]]; then
  echo "==> Creating $ENV_FILE from example"
  cp .env.example "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo ""
  echo "IMPORTANT: edit $ENV_FILE and set FOMO_WORKER_SECRET + FOMO_REFRESH_TOKEN (+ Supabase for prod)"
  echo "Generate secret: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
fi

echo "==> Installing systemd unit"
cp deploy/fomo-worker.service /etc/systemd/system/${SERVICE_NAME}.service
systemctl daemon-reload

echo ""
echo "Done. Next steps:"
echo "  1. nano $ENV_FILE"
echo "  2. systemctl enable --now $SERVICE_NAME"
echo "  3. curl -s http://127.0.0.1:3100/health | jq"
echo "  4. Set FOMO_PROXY_URL + FOMO_WORKER_SECRET on Railway"
