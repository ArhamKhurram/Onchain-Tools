# LP automation — deployment checklist

Operator runbook for shipping LP dashboard + worker changes. Read alongside
`LP_AUTOMATION_PLAN.md` (architecture, trust boundary) and `LP_DASHBOARD_PLAN.md`
(feature scope). Nothing here arms the worker or widens on-chain caps.

---

## What ships where

| Component | Host | Role |
| --- | --- | --- |
| `frontend/` LP tab | Vercel | Policy editor, positions, command queue UI |
| `backend/` `/api/lp/*` | Railway (`oct-backend`) | Policy CRUD, Krystal proxy, PnL from audit log |
| `lp-automation/` worker | Railway (`ponslive-worker`) | Signer process — watches, evaluates, broadcasts |
| `supabase/migrations/*lp*` | Supabase | Policy, settings, command queue tables |

The worker has **no inbound network surface**. Do not expose a port or health HTTP
endpoint on it.

---

## Environment variables (cross-service)

| Variable | Worker | Backend | Notes |
| --- | --- | --- | --- |
| `LP_AUDIT_LOG_PATH` | **required** on Railway | recommended | Append-only JSONL. Worker writes; backend reads for PnL. Use a **persistent volume** on the worker; point the backend at the same path when co-located or via a shared mount. |
| `LP_NATIVE_TOKEN_USD` | recommended | recommended | ETH/USD for gas pricing and zap deposit sizing in audit snapshots. Keep both processes in sync when split across hosts. |
| `LP_ALERT_WEBHOOK_URL` | optional | — | Discord webhook for operator alerts (rebalance fired, failures, out-of-range, gas threshold). Backend does not read this — set on the worker only. |

See `lp-automation/.env.example` and `backend/.env.example` for the full variable
list per process.

---

## Supabase migrations — apply order

Migrations are timestamp-prefixed; apply in this order (oldest first). On dev,
run from repo root:

```bash
npx supabase db push --project-ref zcvubfadvdwjxgodznxh
```

Or apply individually via the Supabase SQL editor / dashboard migration runner.

| # | File | What it adds |
| --- | --- | --- |
| 1 | `20260726160000_lp_automation_policies.sql` | Versioned policy table + `activate_lp_policy` RPC |
| 2 | `20260726170000_lp_automation_settings.sql` | Per-user Safe + module address (mutable) |
| 3 | `20260726180000_lp_automation_commands.sql` | Manual-action command queue |
| 4 | `20260726190000_lp_policy_range_strategy.sql` | `range_strategy` column on policies |
| 5 | `20260727120000_lp_policy_auto_flags.sql` | `auto_compound` / `auto_rebalance` flags |
| 6 | `20260727130000_lp_command_compound_rebalance.sql` | `compound` + `rebalance` command actions |
| 7 | `20260727150000_lp_command_enter.sql` | `enter` command (zap in) + nullable `token_id` |
| 8 | `20260727160000_lp_command_increase.sql` | `increase` command (add liquidity) |

**Dev** (`zcvubfadvdwjxgodznxh`) — apply when merging LP features to `dev`.

**Prod** (`vmlxyqzjdaegkfylxfka`) — apply only when explicitly instructed. The
dashboard LP tab will 500 on missing tables until migrations land.

Verify after apply:

```sql
select table_name from information_schema.tables
where table_schema = 'public' and table_name like 'lp_automation%'
order by 1;
```

Expect: `lp_automation_commands`, `lp_automation_policies`, `lp_automation_settings`.

---

## Deployment checklist

### 1. Merge to `dev`

- [ ] Open PR from the LP feature branch → `dev` (not `main`).
- [ ] `npm run typecheck` and `npm run test` green locally and in CI.
- [ ] Review: no accidental `LP_ARMED=true`, no private keys in the diff.

### 2. Supabase (dev)

- [ ] Apply migrations 1–8 in order (see above) to **dev** Supabase.
- [ ] Confirm the three `lp_automation_*` tables exist.
- [ ] Smoke-test: save a policy in the dashboard, confirm a new row in
      `lp_automation_policies` with `is_active = true`.

### 3. Railway backend (`oct-backend`)

- [ ] Merge to `dev` triggers auto-deploy (or redeploy manually).
- [ ] Set `LP_AUDIT_LOG_PATH` if the backend can reach the worker's audit log.
- [ ] Set `LP_NATIVE_TOKEN_USD` to the current ETH/USD estimate.
- [ ] Confirm `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` point at **dev** Supabase.
- [ ] Smoke-test: `GET /api/lp/policy` returns 200 for an authenticated user.

### 4. Railway worker (`ponslive-worker`)

- [ ] Create or update the `lp-automation` service in project `ponslive-worker`.
- [ ] **Root directory:** repo root (monorepo) or `lp-automation/` with adjusted
      build/start commands.
- [ ] **Build:** `npm ci --include=dev && npm run build -w lp-automation`
- [ ] **Start:** `npm run start -w lp-automation` (runs `node dist/index.js`).
- [ ] **Networking:** disable public networking (outbound-only).
- [ ] **Volume:** mount persistent storage at `/data` (or similar).
- [ ] Set env from `lp-automation/.env.example`:
      - `LP_AUDIT_LOG_PATH=/data/audit.jsonl`
      - `LP_SAFE_ADDRESS`, `LP_MODULE_ADDRESS`, `LP_OPERATOR_PRIVATE_KEY`
      - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `LP_POLICY_USER_ID`
      - `LP_RPC_URL`, `LP_RPC_WS_URL`
      - `LP_NATIVE_TOKEN_USD`, `LP_ALERT_WEBHOOK_URL` (optional)
      - `LP_ARMED=false` until fork-test + operator sign-off
- [ ] Redeploy the worker after env or code changes.
- [ ] Watch startup logs: confirm **DISARMED**, policy version, allowlist size.

### 5. Vercel (frontend)

- [ ] `dev` deploy picks up LP tab changes automatically on merge.
- [ ] Confirm `VITE_API_URL` points at the Railway backend (not Vercel).
- [ ] Smoke-test: open `/dashboard/lp`, positions load, policy saves.

### 6. Post-deploy verification

- [ ] Dashboard shows positions for the configured Safe address (Settings tab).
- [ ] Queue a disarmed compound/rebalance — worker records `skipped_disarmed` in audit log.
- [ ] If `LP_AUDIT_LOG_PATH` is wired on the backend, PnL section shows
      `auditLogAvailable: true` in the positions API response.
- [ ] If `LP_ALERT_WEBHOOK_URL` is set, trigger a test alert (e.g. out-of-range
      threshold) and confirm Discord delivery.

### 7. Before prod (`main`)

- [ ] Repeat migrations 1–8 on **prod** Supabase (`vmlxyqzjdaegkfylxfka`).
- [ ] Update Railway prod backend + worker env to prod Supabase + prod paths.
- [ ] Merge `dev` → `main` only after operator sign-off.
- [ ] `LP_ARMED=true` only after: module selector allowlist includes all needed
      Krystal selectors, fork-test passes, and a disarmed dry-run audit log review.

---

## Operational hazards

- **Single worker.** The per-position lock is in-memory. Never run two live workers
  against the same Safe — they can double-rebalance. See `lp-automation/TODO.md`.
- **Ephemeral audit log.** If the worker restarts without a persistent volume, in-flight
  intent quarantine state is lost. Always mount `/data` on Railway.
- **Split audit path.** If the backend cannot read the worker's log, PnL shows as
  unavailable — positions still work, only lineage PnL is missing.
