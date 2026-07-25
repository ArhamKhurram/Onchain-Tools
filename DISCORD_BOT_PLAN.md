# DISCORD_BOT_PLAN.md — Outpost bot (in-process) + OCT bot API

Design + build spec for the Discord bot layer. **Spec only — no code yet.**

Decisions locked (2026-07-26):
- **Multi-tenant** product, **one global bot** (not one-per-user).
- **In-process module** in the OCT backend (`backend/src/bot/`) — **no new Railway
  service**. The backend boots the bot on startup, self-gated on `DISCORD_BOT_TOKEN`.
- **Also expose `/api/v1/bot`** HTTP endpoints (machine-auth) for future/external
  consumers — both it and the in-process bot call one shared service layer.
- **Slash commands work in guilds AND DMs**; **alerts are DM-only** and opt-in.
- **Tenancy = OCT's existing Discord OAuth identity** (no guild table, no linking).
- v1 = slash commands (pull). Alerts + Settings come later.

---

## 1. The shape

The bot is a **module of the OCT backend monolith**, not a separate microservice. It
sheds the one thing your old Outpost bot did wrong — running its own stealth-Chromium
FOMO client — and instead calls OCT's internal logic directly.

```
Discord ──interactions──▶ backend/src/bot (discord.js client, in-process)
                               │ calls
                               ▼
                     backend/src/bot/service.ts  ──▶ FOMO client / storage / snapshot
                               ▲ also called by
                               │
        external ──Bearer key──┴── /api/v1/bot/* (HTTP, requireBotAuth)
```

- **One Railway service** (the existing backend). The bot self-gates on
  `DISCORD_BOT_TOKEN` — absent → the bot simply doesn't start (like other subsystems
  gate on Supabase).
- **Single-instance safe:** the backend is already single-instance (FOMO/missed-runner
  pollers + gateway state are singletons), so one bot gateway connection is fine — no
  new constraint.
- **Tradeoff (accepted):** a backend deploy briefly drops the bot's Discord connection
  (~seconds, auto-reconnects). Fine for slash commands (rare, self-healing) and DM
  alerts (slight delay). Splitting into its own service later is easy because the logic
  lives in `service.ts`.

**Carry forward from the old bot** (it was good): the Components V2 layout system
(`makeContainer/makeSection/makeThumbnail/makeNavRow`, `BRAND`), slash-command
structure, button-pagination collectors, the `10062` unknown-interaction guard, and the
dev/prod staging (test bot in a dev guild).

---

## 2. Auth & tenancy

### 2a. The in-process bot needs no auth to reach OCT logic

It calls `service.ts` functions directly — no HTTP, no token. Simplest path.

### 2b. `/api/v1/bot` uses one shared machine secret

For external consumers (and a possible future split-out), the HTTP layer is guarded by
`requireBotAuth` — a single `OCT_BOT_API_KEY` env secret (like `fomo-worker`'s), checked
by middleware mounted **only** on `/api/v1/bot`. Mount it **before** the user-auth `/api`
router so it isn't caught by `authMiddleware`.

### 2c. Tenancy = the Discord identity OCT already stores

Users who signed into OCT via **Discord OAuth** already have their Discord user id in
Supabase (`auth.identities`, provider `discord` — it powers `auth/profile`). So the
**OCT-account ↔ Discord-user mapping already exists**; no table, no linking step.

- **Slash commands:** Discord signs `interaction.user.id`. For user-scoped commands, the
  handler resolves it to an OCT account via the stored Discord identity (service-role
  lookup) and returns that account's data. For the HTTP API, the caller passes
  `X-Discord-User-Id`.
- **Global commands** (`/holders`, `/leaderboard`) need no identity at all.
- **Non-Discord-OAuth users are gatekept** (decision): a user-scoped command from an
  unrecognized Discord id replies "link Discord on OCT to use this." No `/link` fallback.

### 2d. Command visibility

- **Global commands** (`/holders`, `/leaderboard`) reply publicly — fine in a channel.
- **User-scoped commands** (`/wallets`) reply **ephemerally** (only the invoker sees it),
  so personal data isn't dumped into a public guild channel.

---

## 3. The service layer + API contract

**`backend/src/bot/service.ts`** holds the real logic and returns **bot-shaped DTOs**
(short fields for embed limits — never raw `FrontendMessage`/internal types). DTOs are
defined in **`@oct/shared/src/bot.ts`** so the service, the HTTP routes, and (later) any
external consumer share one contract.

| Slash command | Service fn | HTTP (external) | Scope | Backing logic |
| --- | --- | --- | --- | --- |
| `/holders <addr> [net]` | `getHolders` | `GET /api/v1/bot/tokens/:chain/:address/holders` | global | FOMO `/hodlers/top` + snapshot |
| `/leaderboard [window]` | `getLeaderboard` | `GET /api/v1/bot/fomo/leaderboard?window=24h\|all` | global | existing FOMO leaderboard |
| `/wallets` | `getTracked(discordUserId)` | `GET /api/v1/bot/fomo/tracked` (+ `X-Discord-User-Id`) | **user** | tracked traders for the resolved account |
| (token info) | `getSnapshot` | `GET /api/v1/bot/tokens/:chain/:address/snapshot` | global | `contracts.ts` snapshot logic |

Example DTO (`@oct/shared/src/bot.ts`):

```ts
export interface BotHoldersResponse {
  token: { address: string; symbol: string; name: string; marketCap?: number;
           price?: number; iconUrl?: string; socials?: { twitter?: string; telegram?: string; website?: string } };
  networkId: number;
  holders: { rank: number; name: string; address: string; valueUsd: number; pnlUsd: number }[];
}
```

Reuse OCT's caching (leaderboard 5 min, hodlers 15 min) so commands stay inside Discord's
~3 s ACK window (always `deferReply` first, then call `service.ts`).

---

## 4. `backend/src/bot/` module layout

```
backend/src/bot/
  index.ts            # startBot(): if DISCORD_BOT_TOKEN → create discord.js Client, wire events. Called from index.ts startup.
  client.ts           # Client bootstrap (intents: Guilds; command/context config for guild + DM)
  service.ts          # getHolders / getLeaderboard / getTracked / getSnapshot → @oct/shared bot DTOs
  identity.ts         # resolveOctUserByDiscordId(discordUserId) via Supabase identities (service role)
  layout.ts           # ported Components V2 builder from the old Outpost bot
  commands/{ping,holders,leaderboard,wallets}.ts   # command data + handler (handler calls service.ts)
  events/{ready,interactionCreate}.ts
  deployCommands.ts   # register slash commands (guild for dev, global for prod)

backend/src/api/routes/bot.ts   # createBotRouter(): /v1/bot/* HTTP routes → service.ts (requireBotAuth)
backend/src/auth/botAuth.ts     # requireBotAuth middleware (OCT_BOT_API_KEY)
packages/shared/src/bot.ts      # bot DTOs (contract)
```

- `startBot()` is invoked from `backend/src/index.ts` after `listen()` (next to
  `startFomoPoller` / `startMissedRunnerPoller`), self-gated on the token.
- `discord.js` becomes a backend dependency. Commands registered with **both** guild and
  user-install contexts so they work in servers and DMs.
- New env (backend `.env`): `DISCORD_BOT_TOKEN`, `DISCORD_APP_ID`, `DISCORD_DEV_GUILD_ID`
  (dev command deploys), `OCT_BOT_API_KEY` (HTTP API secret).

---

## 5. Reuse vs. do-not-duplicate

**Reuse (call directly via `service.ts`):** the FOMO client (through `fomo-worker` +
`fomo/cache.ts`), token enrichment / DexScreener snapshot, storage for tracked traders.

**Port from the old Outpost bot:** `layout.ts` (Components V2), interaction patterns,
`deployCommands`, dev/prod split.

**Do NOT bring into the bot:** Playwright / the FOMO stealth client, the user Discord
gateway, room/channel subscription logic, the Rick-wait / contract-pending queue.

---

## 6. Phased plan

**Phase 1 — service layer + contract + HTTP API (backend)** — ✅ **shipped (PR #14)**
- `@oct/shared/src/bot.ts` DTOs.
- `backend/src/bot/service.ts`: `getBotHolders`, `getBotLeaderboard`, `getBotSnapshot`.
- `auth/botAuth.ts` + `api/routes/bot.ts` mounted at `/api/v1/bot` (before `/api`).

**Phase 2a — in-process bot, global commands** — ✅ **shipped**
- `bot/index.ts` `startBot()` (self-gated on `DISCORD_BOT_TOKEN`, all failures swallowed),
  `bot/interactions.ts`, ported `bot/layout.ts`.
- `/ping`, `/holders`, `/leaderboard`, `/token` — all global, public replies, usable in
  guilds **and** DMs (`anywhere()` sets contexts + integration types).
- `bot/deployCommands.ts` + `npm run bot:deploy -w backend` (guild deploy when
  `DISCORD_DEV_GUILD_ID` is set, else global with `-- --global`).
- Commands are a **static registry** (`bot/commands/index.ts`) — the standalone bot's
  runtime folder scan doesn't survive the backend's tsc→ESM build.

**Phase 2b — user-scoped command (Discord identity)** — ✅ **shipped**
- Migration `20260726120000_bot_discord_identity.sql`: `oct_user_id_by_discord_id()`
  SECURITY DEFINER function (service-role only) — PostgREST can't read `auth`, so this
  is the narrow read that maps a Discord id → OCT user id from the stored OAuth identity.
  **Must be applied to dev + prod Supabase.**
- `bot/identity.ts`: `resolveOctUserByDiscordId()` with memoisation; never throws
  (infra failure reads as "not linked" → gatekeep message).
- `getBotTracked(discordUserId)` + `/wallets` (**ephemeral** reply) + HTTP
  `GET /api/v1/bot/fomo/tracked` reading `X-Discord-User-Id` (400 without it,
  403 `not_linked`).
- Non-Discord-OAuth users are gatekept with instructions to link Discord.

**Phase 3 — alert DMs (push)** — ✅ **shipped**
- `AppConfig.discordBotDm` ({ enabled, triggers }) — prefs live in the existing user
  config (like `pushover`), so no new table/RLS. **Off by default.**
- `WsServer.onAlert()` — every alert in the app funnels through `broadcastAlert`, so DM
  delivery subscribes to that ONE seam instead of touching the 6 emission sites.
- `bot/alerts.ts` — trigger mapping (incl. the highlighted-user-with-contract split),
  `shouldDmAlert` gating, Components V2 DM rendering, and graceful handling of Discord
  error 50007 (bot may only DM users who share a server with it).
- `bot/identity.ts` — `resolveDiscordIdByOctUser()` reverse lookup via the admin API
  (same call `/auth/profile` uses), so no extra SQL surface.
- Settings → **Discord Bot** section: master toggle + 5 per-type triggers.
- Signal-convergence is NOT deliverable: those alerts are raised client-side and never
  reach the backend broadcast. Documented in the UI; would need a frontend endpoint
  like the existing Pushover convergence route.

**Phase 4** *(optional):* buttons linking back to the OCT dashboard, rate limits, audit log.

---

## 7. Constraints to respect

- **3 s ACK** — always `deferReply` first; lean on OCT caching for hot data.
- **Deploy coupling** — backend deploys blip the bot; acceptable, self-heals.
- **Single-instance** — required by the in-process bot; already true of the backend.
- **Visibility gap** — the bot only sees servers it's invited to; OCT's user gateway
  remains the source for private alpha channels. The bot complements, doesn't replace.
- **Discord ToS** — bot path is compliant (Bot API + its own token); the OCT user-token
  gateway stays a separate, user-consent surface.
- **Proactive DM rule (Phase 3)** — a bot can only DM a user it shares a server with;
  design alert onboarding around it. Does not affect slash-command replies.

---

## 8. Decisions

**Locked:** in-process module (no new service) · single shared `OCT_BOT_API_KEY` for the
HTTP layer · DM-only alerts (opt-in) · commands in guild + DM (user-scoped ephemeral) ·
tenancy via Discord OAuth identity · gatekeep non-Discord users · command order:
`/holders` + `/leaderboard` first, then `/wallets`.

**Resolved during build:**
1. **Network/chain in `/holders`** — accepts **both** a numeric FOMO network id and an
   OCT chain slug (`sol`/`eth`/`bsc`/`base`/`hood`), defaulting to Solana
   (`resolveNetworkId` in `bot/service.ts`).
2. **Extra commands** — shipped `/token <address> [chain]` (free: reuses `getBotSnapshot`).
   Still unported from the old bot: `/thesis`. Not built: `/convergence`, `/missedrunners`.
3. **Bot install type** — **both** enabled (GuildInstall + UserInstall) with contexts
   Guild/BotDM/PrivateChannel, which is what makes guild+DM work.
4. **`deferReply` flags** — `IsComponentsV2` is a *message* flag and is rejected on
   `deferReply` (the standalone bot got away with it by typing `interaction` as `any`).
   Defer plain; set the flag on the `editReply` that carries components.

**Still open:**
- Whether to port `/thesis`, and whether OCT-native commands (`/convergence`,
  `/missedrunners`) are worth adding once Phase 2b lands.

---

## 9. First concrete PRs (when we start)

1. `@oct/shared/src/bot.ts` DTOs + `auth/botAuth.ts` + empty `/api/v1/bot` router mounted.
2. `bot/service.ts` global fns + wire the three global HTTP endpoints.
3. `bot/` discord.js client (self-gated) + `/ping` end-to-end (proves the in-process loop).
4. `/holders` + `/leaderboard` with the ported layout system.
5. `identity.ts` + `/wallets` (ephemeral) + gatekeeping.
6. (later) alert DMs + `bot_prefs` + Settings toggles.
