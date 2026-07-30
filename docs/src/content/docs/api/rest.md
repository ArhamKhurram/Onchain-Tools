---
title: REST API
description: Every backend HTTP endpoint, grouped by domain.
sidebar:
  order: 2
---

Base URL: the Railway backend (`VITE_API_URL`) + `/api`, or `/api` when the
frontend is served by the backend itself (local mode / desktop).

Unless marked otherwise, every endpoint is **public in local mode** and
requires a **Supabase bearer token in hosted mode** — see
[Authentication](../authentication/). Error bodies are `{ "error": string }`;
in hosted mode `safeError` replaces real error messages with a generic string
so internals don't leak.

Routes were split out of the old monolithic `routes.ts` into
`backend/src/api/routes/*.ts`; `routes.ts` is now a small composition root.

## Health

| Method & path | Purpose |
| --- | --- |
| `GET /health` | Liveness probe → `{ status: "ok" }`. Public, outside `/api`. |

## Auth & Discord tokens (`routes/auth.ts`)

| Method & path | Purpose |
| --- | --- |
| `GET /api/auth/status` | Discord + Telegram connection state → `{ configured, connected, telegramConfigured, telegramConnected }`. Hosted adds `clientGateway: true` (gateway runs in the browser). |
| `GET /api/auth/profile` | Account profile. Local: `{ email: null, provider: "local" }`. Hosted: id, email, provider, Discord username/avatar, timestamps. |
| `POST /api/auth/token` | Set Discord token(s) (comma-separated allowed) and connect the gateway. Hosted: stores nothing, returns `{ clientGateway: true }`. |
| `POST /api/auth/disconnect` | Clear tokens, disconnect gateway. |
| `GET /api/auth/tokens` | Masked token list → `{ tokens: [{ index, masked, invalid }], count }`. |
| `POST /api/auth/tokens/add` | Append one token and reconnect. `409` on duplicate. |
| `DELETE /api/auth/tokens/:index` | Remove token at index. |

## Telegram (`routes/telegram.ts`)

| Method & path | Purpose |
| --- | --- |
| `POST /api/auth/telegram/start` | Begin MTProto login: `{ apiId, apiHash, phoneNumber }` → sends code, returns `{ phoneCodeHash }`. Pending session expires after 5 min. |
| `POST /api/auth/telegram/verify` | Submit the code (`{ phoneCode, password? }`). May return `{ needs2FA: true }`. |
| `POST /api/auth/telegram/2fa` | Submit the 2FA password. |
| `POST /api/auth/telegram/disconnect` | Clear sessions, disconnect. |
| `GET /api/auth/telegram/status` | `{ configured, connected, hasApiCredentials, sessionCount }`. |
| `GET /api/telegram/avatar/:peerId` | Profile photo (JPEG, 1 h cache). |
| `GET /api/telegram/media/:chatId/:messageId` | Message media passthrough (≤10 MB cached). |
| `GET /api/telegram/chats` | Dialog/chat list. |

Telegram routes that need a live client return
`503 { "error": "Telegram not connected. …" }`.

## Discord data (`routes/discord.ts`)

| Method & path | Purpose |
| --- | --- |
| `GET /api/history` | Backfill: last 30 messages per configured channel across all rooms (Discord + Telegram), de-duped → `Record<roomId, FrontendMessage[]>`. |
| `GET /api/guilds` | Guilds + channels visible to the connected token(s). |
| `GET /api/dm-channels` | DM channels. |
| `GET /api/reactions/:channelId/:messageId?name=…&id=…` | Users who reacted with an emoji. |

Gateway-dependent routes return `503 { "error": "Discord not connected. …" }`.

## Rooms (`routes/rooms.ts`)

Standard CRUD: `GET /api/rooms`, `GET /api/rooms/:id`, `POST /api/rooms`
(requires `name`; `201`), `PUT /api/rooms/:id` (partial — only supplied keys
applied, including `keywordPatterns`, `highlightMode`,
`highlightedUserColors`, `hotkey`), `DELETE /api/rooms/:id`.

## Config (`routes/config.ts`)

| Method & path | Purpose |
| --- | --- |
| `GET /api/config` | Full `AppConfig` with credentials stripped (`discordTokens`, `telegramSessions`). |
| `PUT /api/config` | Partial update against a **whitelist** of ~50 keys (display prefs, alert settings, caller tiers, layout, …). Server-side validation clamps `missedRunner` numbers, `signalConvergenceWindowMinutes` (1–240), sanitizes `callerTiers` (≤2000 entries), and **rejects `discordProxyUrl` in hosted mode** (SSRF guard). |
| `GET /api/config/export` | Versioned settings backup. Strips `userNameCache`, proxy URL, Pushover keys; hosted additionally strips all credentials. |
| `POST /api/config/import` | Restore a backup — replaces all rooms. |

## Sounds (`routes/sounds.ts`)

| Method & path | Purpose |
| --- | --- |
| `POST /api/sounds/:soundType` | Upload an alert sound (multipart `file`, ≤2 MB, `.mp3/.wav/.ogg/.webm/.m4a`). `soundType` ∈ `highlight`, `contractAlert`, `keywordAlert`, `fomoTrade`. |
| `DELETE /api/sounds/:soundType` | Remove it. |
| `POST /api/channel-sounds/:channelId` · `DELETE …` | Per-channel variants (`channelId` must be numeric). |

Hosted stores in the Supabase `sounds` bucket (`<userId>/<name><ext>`, public
URL); local writes `backend/data/sounds/` and serves `/api/sounds/<filename>`.

## Messaging (`routes/messaging.ts`)

| Method & path | Purpose |
| --- | --- |
| `POST /api/send-message` | Send a Discord or Telegram message. Multipart: `files` (≤10 × 25 MB) + `{ channelId, content, source }` (`source: 'telegram'` routes to Telegram). `403` if `chattingEnabled` is off. |

## Contracts & tokens (`routes/contracts.ts`)

| Method & path | Purpose |
| --- | --- |
| `GET /api/tokens/:chain/:address/snapshot` | Cached token snapshot (`{ found, symbol, name, pair, marketCap, source, enrichedAt, stale }`); also patches the caller's contract log. |
| `GET /api/contracts?limit=&since=` | The contract-detection feed (default limit 100). |
| `POST /api/contracts` | Log a contract detected **client-side** (hosted browser gateway path); schedules a Dex fallback enrich after 8 s. Requires `{ address, messageId, channelId, timestamp }`. |
| `POST /api/contracts/rick-enrich` | Apply enrichment parsed from a Rick bot embed (browser gateway sends the embed here). |
| `POST /api/contracts/dex-enrich` | Force DexScreener/GMGN enrichment for `{ address, channelId }`. |
| `DELETE /api/contracts` | Clear the log. |
| `DELETE /api/contracts/:messageId/:address` | Delete one entry. |

Successful enrichment also emits WS `contract_enrichment` (and possibly
`chain_update`).

## Alerts, callers, Pushover

| Method & path | Purpose |
| --- | --- |
| `POST /api/alerts/missed-runner/test` | Dry-run/fire a missed-runner alert for `{ address, force? }` → rich `diagnostics` object (`wouldAlert`, `blockReason`, `multiplier`, …). Rate-limited 12/min per user in both modes. |
| `GET /api/callers/scores?windowDays=` | Caller-quality scores (120 s per-user cache; window clamped 1–90 days). |
| `POST /api/pushover/signal-convergence` | Send a convergence push (`{ contractAddress, tokenSymbol, traderName, … }`) → `{ sent }`. |

## FOMO (`fomo/routes.ts`, mounted at `/api/fomo`)

| Method & path | Purpose |
| --- | --- |
| `GET /api/fomo/status` | Shared account + poller health (`configured, proxyMode, worker, pollerActive, lastPollAt, lastPollError, …`). |
| `GET /api/fomo/leaderboard?window=&limit=` | Trader leaderboard (cached 5 min; `window` = `24h` or all; limit ≤100). `503` without a service account, `502` on upstream failure. |
| `POST /api/fomo/hodlers/overlap` | For ≤40 tokens, which tracked traders hold each → `{ overlaps: { <addr>: { trackedCount, trackedHandles } } }`. |
| `POST /api/fomo/resolve` | Resolve a handle/query to a FOMO user (no write). |
| `GET /api/fomo/trades?hours=&limit=` | Replay trades **delivered to this user** (default 24 h, ≤168) — powers the feed backfill on reload. |
| `GET /api/fomo/tracked` | Tracked traders. |
| `POST /api/fomo/tracked` | Resolve + track (`201`; `409` if already tracked). |
| `PATCH /api/fomo/tracked/:id` | Update `{ notify_pushover }`. |
| `DELETE /api/fomo/tracked/:id` | Untrack. |

All DB-backed FOMO routes `503` without Supabase.

## Portfolio (`portfolio/routes.ts`, mounted at `/api/portfolio`)

| Method & path | Purpose |
| --- | --- |
| `GET /api/portfolio/status` | Provider env probe. **Public** (explicit auth bypass); optional `probeChain`/`probeAddress` run a live provider probe. |
| `GET /api/portfolio/:chain/:address/stats?period=` | Wallet PnL/trade stats (`7d`/`30d`). |
| `GET /api/portfolio/:chain/:address/holdings?limit=` | Current holdings. |
| `GET /api/portfolio/:chain/:address/activity?limit=` | Recent swaps. |
| `GET /api/portfolio/:chain/:address/pnl-daily?period=` | Daily PnL series. |

All four data routes enforce **wallet ownership**: the address must be in the
caller's My Wallets list, else `403`. Data comes from Birdeye — portfolio
only, never enrichment ([ADR-003](../../adr/003-provider-split/)).

## Bot API (`routes/bot.ts`, mounted at `/api/v1/bot` — bot API key)

Machine-to-machine surface for external bot consumers; the in-process OCT
bot calls the service layer directly and skips HTTP entirely.

| Method & path | Purpose |
| --- | --- |
| `GET /api/v1/bot/status` | Auth check + endpoint discovery. |
| `GET /api/v1/bot/tokens/:network/:address/holders` | Top holders (`:network` = FOMO network id or OCT slug: `sol`, `eth`, `bsc`, `base`, `robinhood`). |
| `GET /api/v1/bot/tokens/:chain/:address/snapshot` | Token snapshot, bot-shaped DTO. |
| `GET /api/v1/bot/fomo/leaderboard?window=&limit=` | Leaderboard for Discord commands. |
| `GET /api/v1/bot/fomo/tracked` | Tracked traders for a linked Discord user — requires header `X-Discord-User-Id`; `403 not_linked` if the Discord account isn't linked to an OCT user. |
| `POST /api/v1/bot/announce` | Post an announcement to `DISCORD_ANNOUNCE_CHANNEL_ID` via the in-process bot client: `{ title, description, kind?: 'site'\|'bot', imageUrl?, linkUrl?, dmOptIns? }`. Used by the [changelog workflow](../../operations/announcements/). |

Error mapping: `not_configured` → `503`, `not_found` → `404`, `not_linked` →
`403`, `upstream` → `502`. DTOs live in `packages/shared/src/bot.ts`.
