#!/usr/bin/env bash
curl -s -X POST http://127.0.0.1:3100/v1/call \
  -H "Authorization: Bearer $(grep FOMO_WORKER_SECRET /etc/fomo-worker.env | cut -d= -f2)" \
  -H "Content-Type: application/json" \
  -d '{"path":"/feed/tradingActivity?limit=2","method":"GET"}' \
  | head -c 500
