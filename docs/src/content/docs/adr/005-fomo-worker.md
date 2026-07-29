---
title: 'ADR-005: VPS Playwright worker for the FOMO API'
description: A stealth Chromium worker on a VPS fronts the Cloudflare-gated fomo.family API.
sidebar:
  order: 5
  label: '005 — fomo-worker'
---

**Status:** Accepted

## Context

fomo.family sits behind Cloudflare bot protection. Plain server-side `fetch`
from a datacenter IP gets challenged or blocked; the API is only reliably
reachable from a real browser context. Running Playwright inside the Railway
container works (nixpacks installs Chromium) but is heavy, cold-start
fragile, and ties browser lifecycle to backend deploys.

## Decision

A dedicated always-on worker (`fomo-worker/`) on a VPS runs stealth Chromium
(playwright-extra + stealth plugin), executes FOMO API calls inside
`page.evaluate`, and exposes them over HTTP guarded by a shared secret. The
backend selects between in-process `FomoClient` and remote `FomoProxyClient`
behind one interface (`FomoClientLike`, chosen by `isFomoProxyMode()`).
Privy token rotation persists to `fomo_poll_state` so restarts never need a
manual re-login.

## Consequences

- Backend deploys don't restart the browser session; the Cloudflare
  clearance lives on a stable residential-ish IP.
- One more deploy target (systemd on the VPS) and one more secret pair
  (`FOMO_PROXY_URL` + `FOMO_WORKER_SECRET`).
- The in-process path remains as dev/fallback — the selection is config, not
  code.
- All FOMO features share **one** service account and one poll stream,
  deduped across subscribers.
