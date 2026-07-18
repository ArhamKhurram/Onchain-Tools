# OCT — Ideas & Backlog

A living list of features we've discussed but haven't shipped yet, so nothing gets
lost. Move items up to "Planned" when we commit to them, and into `CHANGELOG.md`
once shipped.

---

## In progress

### FOMO Tracking (fan-out)
Track FOMO (fomo.family) users; when a tracked user buys/sells, notify everyone
who tracks them.
- **Auth model:** Option A — single shared FOMO service account (creds in
  `backend/.env` as `FOMO_*`). Privy refresh-token → access JWT; API calls run
  inside stealth Chromium to clear Cloudflare.
- **Architecture:** fan-out-on-write. One global poll of `/feed/tradingActivity`
  for the whole platform → route each trade to the OCT users who track that FOMO
  user. O(1) polling regardless of user count.
- **UI:** tab on the Wallets page — `Wallets` (on-chain) | `FOMO Tracking` (FOMO users).
- **Delivery:** in-app live feed + Pushover.
- **Merged so far:** `backend/src/fomo/client.ts` (`FomoClient`) + `types.ts`;
  Playwright deps added; `FOMO_*` documented in `backend/.env.example`.
- **Blocked on:** shared `FOMO_REFRESH_TOKEN` to verify whether
  `/feed/tradingActivity` is a global firehose or following-only (changes whether
  adding a tracked user requires the shared account to follow them first).

---

## Planned next

### Signal convergence alerts ⭐
When a contract appears in the Discord/Telegram feed **and** a tracked FOMO user
buys the same token within X minutes → high-priority alert. Cross-source
confirmation (caller chatter + verified social buy) is the key differentiator.
Build after core FOMO tracking works.

---

## Deferred / backlog

### On-chain wallet detection engine
The Wallets page is currently a **watchlist only** (`user_tracked_wallets` CRUD in
Supabase). The `alerts_on_toast/feed/bubble` flags exist but nothing watches
addresses on-chain. Real detection needs a chain data provider (Helius / Bitquery
/ etc.) with its own cost + rate limits. Big build; deferred.
- Caveat: FOMO trades are gasless/relayed, so a FOMO user's exposed EOA may not
  show normal DEX swaps — on-chain detection could miss FOMO activity.

### Auto-bridge FOMO wallets → Wallet Tracker
FOMO's `/wallets` exposes each user's SOL/EVM addresses. When a user tracks a FOMO
account, auto-populate the on-chain watchlist with their real wallets. Only pays
off once the on-chain detection engine above exists — deferred until then.

### Holder overlap on contracts
In the Radar / contract view, show "N of your tracked traders hold this" via
`/hodlers/top`. Instant conviction signal on a contract.

### Leaderboard → one-click track
Surface FOMO's top traders (`/v2/leaderboard`, `/v2/leaderboard/24h`); tap a row
to add them to your FOMO track list.

### Unified alerts center
One place for every trigger — Discord highlight, contract detected, FOMO
tracked-user buy, (future) wallet movement — with per-source rules. Pushover is
already wired; this unifies routing/config.

### Per-tracked-user notification rules
Filters per tracked FOMO user: buys only, min $ size threshold, specific chains,
custom sound. Routes through existing Pushover triggers.

### FOMO auth — Options B / C (revisit later)
We chose Option A (shared account). Alternatives if it hits rate limits / ToS
issues:
- **B:** each user pastes their own FOMO refresh token once (encrypted per-user
  via existing `TOKEN_ENCRYPTION_KEY`); rotation hook means they never re-enter it.
- **C:** full "Login with FOMO" (embed Privy Apple/Google flow). Best UX, most
  work, possible ToS risk.

### Discord bot integration (Outpost)
Port the Outpost bot's slash commands (`/holders`, `/thesis`, `/wallets`) that
consume the FOMO client. Explicitly **not doing yet** — FOMO client is merged as a
reusable backend service; the Discord layer is future work.

---

## Known gaps / tech debt
- Frontend bundle > 500 kB (single chunk); consider code-splitting.
- Prod Supabase (`vmlxyqzjdaegkfylxfka`) migrations status vs dev — verify before
  relying on prod schema.
- FOMO integration needs Chromium at runtime → `nixpacks.toml` on Railway must
  install Playwright's browser (not yet configured).
