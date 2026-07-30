---
title: OCT Discord bot
description: The in-process bot — commands, DM alerts, announcements, and tenancy.
sidebar:
  order: 6
---

The bot runs **in-process with the backend** ([ADR-006](../../adr/006-in-process-bot/)):
command handlers call `bot/service.ts` directly — no HTTP hop, no second
deploy target. It self-gates on `DISCORD_BOT_TOKEN` and swallows every
failure path, so a bot problem can never take down feed ingestion, the API,
or the WS.

Intents: `Guilds` only — slash commands, no message content, no privileged
intents.

## Component view

```mermaid
flowchart TB
  subgraph botpkg["backend/src/bot/"]
    idx["index.ts<br/>startBot / stopBot / getBotClient"]
    inter["interactions.ts<br/>dispatch via commandMap"]
    cmds["commands/*<br/>ping · token · holders ·<br/>leaderboard · tracked · wallet · context"]
    svc["service.ts<br/>BotServiceError, resolveNetworkId,<br/>getBotHolders / Leaderboard / Tracked / Wallet / Snapshot"]
    alerts["alerts.ts<br/>createAlertDmListener,<br/>shouldDmAlert, buildAlertDm"]
    ident["identity.ts<br/>resolveOctUserByDiscordId (cached)"]
    ann["announce.ts + releaseNotes.ts"]
    layout["layout.ts (Components V2 builders)"]
  end

  discord{{Discord}}
  wsrv["WsServer.onAlert"]
  fomoc["fomo client (shared)"]
  snap["utils/tokenSnapshot"]
  store["StorageProvider"]
  rpc["Supabase RPC<br/>oct_user_id_by_discord_id"]

  discord -- "InteractionCreate" --> idx --> inter --> cmds --> svc
  svc --> fomoc
  svc --> snap
  wsrv --> alerts --> discord
  alerts --> store
  cmds --> ident --> rpc
  ann --> discord
```

## Slash command flow

```mermaid
sequenceDiagram
  participant U as Discord user
  participant D as Discord
  participant B as Bot client (in-process)
  participant S as bot/service.ts
  participant F as FOMO client
  U->>D: /leaderboard
  D->>B: InteractionCreate
  B->>B: commandMap lookup, defer reply
  B->>S: getBotLeaderboard(window, limit)
  S->>F: ensureSharedFomoClientReady → getLeaderboard
  F-->>S: entries (TTL-cached 5 min)
  S-->>B: BotLeaderboardResponse
  B->>D: editReply (branded Components V2 container)
```

Errors map through `BotServiceError` codes (`not_configured`, `upstream`,
`not_found`, `not_linked`) to friendly ephemeral replies; the stale
"Unknown interaction" (10062) is silently dropped.

## Tenancy

The bot is DM-first and multi-tenant-aware: a Discord user maps to an OCT
account via the Supabase **Discord OAuth identity** — the `SECURITY DEFINER`
function `oct_user_id_by_discord_id` reads `auth.identities` (service-role
only, cached in `identity.ts`). Commands that need user data (`/tracked`)
return `not_linked` if the Discord account has no linked OCT login.

## Alert DMs (opt-in)

`startBot(wsServer)` subscribes `createAlertDmListener` to the
`WsServer.onAlert` seam — the single integration point, chosen so no alert
emission site needed changes. Delivery is gated per user by
`discordBotDm` config (master switch AND per-trigger:
`highlighted_user`, `contract_address`, `keyword_match`, `missed_runner`,
`releaseNotes`) — all **off by default**. Release-notes DMs additionally
walk opted-in users sequentially with a 600 ms floor gap, retry-after
handling, and a 2000-recipient cap.

## Announce API

`POST /api/v1/bot/announce` (bot-key auth) renders a branded announcement in
`DISCORD_ANNOUNCE_CHANNEL_ID` through the in-process client, optionally
DMing release-notes opt-ins (`dmOptIns`, default false — a CI push can never
DM). This is what the [changelog workflow](../../operations/announcements/)
calls.

## Command registration

Slash commands are registered out-of-band with
`npm run bot:deploy -w backend` (`bot/deployCommands.ts`) — instant to
`DISCORD_DEV_GUILD_ID` when set, `-- --global` for global rollout.

:::note[Hosting]
The bot lives wherever the backend runs with `DISCORD_BOT_TOKEN` set — in
production that is the Railway backend. The variable being unset simply
disables the bot; everything else runs unchanged.
:::
