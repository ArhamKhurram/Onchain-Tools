---
title: 'Backend components (C4: Components)'
description: The oct-backend service — ingest, gateways, enrichment, storage, and the WS hub.
sidebar:
  order: 3
---

Entry: `bootstrap.ts` (preflight only) → `index.ts` (the real app). This page
is the C4 component view of the Railway container plus the class/state
diagrams for its stateful parts.

## Component diagram

```mermaid
flowchart TB
  subgraph ingest["Ingest"]
    dgw["discord/<br/>GatewayManager → DiscordGateway (per token)"]
    tgw["telegram/<br/>TelegramClientManager → TelegramClientWrapper"]
    pool["gateway/userGatewayPool<br/>(hosted: per-user, 30-min idle eviction)"]
    state["gateway/state<br/>(local: one global manager)"]
  end

  subgraph pipeline["Message pipeline"]
    proc["utils/messageProcessor<br/>(shim → @oct/shared processDiscordMessage)"]
    contract["utils/contract<br/>SOL + EVM detection"]
    kw["utils/keywordMatcher"]
    rick["utils/rickEmbedParser"]
    merge["utils/enrichmentMerge"]
  end

  subgraph enrichment["Enrichment"]
    snapshot["utils/tokenSnapshot.enrichToken<br/>(orchestrates order)"]
    gmgn["utils/gmgnEnrichment → gmgnClient"]
    dexs["utils/tokenEnrichment (DexScreener)"]
    catalog["storage/tokenCatalog<br/>(global cache, 5-min staleness)"]
  end

  subgraph signals["Signals & alerts"]
    missed["alerts/missedRunnerPoller"]
    peaks["alerts/tokenPeakSampler + tokenPeakStore"]
    push["utils/pushover"]
  end

  subgraph fomo["FOMO"]
    fclient["fomo/client (Playwright)<br/>or fomo/proxy-client (VPS)"]
    fpoller["fomo/poller (adaptive 10s/60s)"]
    fdispatch["fomo/dispatch + store + cache"]
  end

  subgraph platform["Platform"]
    ws["ws/WsServer (/ws)"]
    api["api/routes/* (composition root routes.ts)"]
    storage["storage/StorageProvider<br/>json | supabase"]
    auth["auth/middleware + botAuth + encryption"]
    bot["bot/* (OCT bot, in-process)"]
  end

  dgw --> proc
  tgw --> proc
  proc --> contract
  proc --> kw
  proc --> storage
  proc --> ws
  dgw --> rick --> merge --> storage
  snapshot --> gmgn
  snapshot --> dexs
  snapshot --> catalog
  merge --> ws
  missed --> gmgn
  missed --> push
  missed --> ws
  peaks --> catalog
  fpoller --> fclient
  fpoller --> fdispatch --> ws
  api --> storage
  api --> snapshot
  bot --> fclient
  bot --> storage
  ws -- "onAlert seam" --> bot
```

## The ingest pipeline (sequence)

The exact order for a Discord message in local mode (Telegram is identical
minus the Rick step):

```mermaid
sequenceDiagram
  participant G as DiscordGateway
  participant M as GatewayManager
  participant P as processMessage
  participant S as StorageProvider
  participant W as WsServer
  participant E as Enrichment

  G->>M: MESSAGE_CREATE
  M->>M: dedup across tokens (10s window)
  M->>P: message event
  P->>S: room gating (getRoomsForChannel)
  P->>P: detectContractAddresses + matchKeywords
  loop per detected contract
    P->>S: logContract
    P->>W: broadcastContract
    P->>E: scheduleDexFallback (15s delay)
    P->>E: background EVM chain resolve
    E-->>W: broadcastChainUpdate / broadcastContractEnrichment
  end
  opt Rick bot embed arrives
    P->>P: rickEmbedParser
    P->>S: enrichContract (Rick is authoritative for MC@call)
    P->>W: broadcastContractEnrichment
  end
  P->>W: broadcastAlert (highlight/keyword/contract)
  Note over W: onAlert seam → OCT bot DMs
  P->>W: broadcastMessage
```

In **hosted mode** the browser gateway performs detection client-side and
posts results to `POST /api/contracts` / `POST /api/contracts/rick-enrich`,
after which the server-side flow (enrichment, broadcast, catalog) is the same.

## Gateway classes

Backend and frontend deliberately mirror each other — the browser twin is a
near line-for-line port:

```mermaid
classDiagram
  class GatewayManager {
    -gateways: DiscordGateway[]
    -recentMessageIds: Map~string,number~
    +connect() / disconnect()
    +waitUntilReady(timeoutMs)
    +getGuilds() / getDMChannels()
    +getChannelName(id) / getGuildName(id) / getRoleName(id)
    +sendChannelMessage(channelId, content, attachments?)
    +fetchChannelMessages(channelId, limit)
    +fetchReactionUsers(channelId, messageId, emoji)
  }
  class DiscordGateway {
    -ws / sessionId / resumeGatewayUrl / lastSequence
    -reconnectAttempts (max 30)
    -lastBlockStatus
    +connect() / disconnect()
    -identify() : RESUME if sessionId else IDENTIFY
    -startHeartbeat(intervalMs)
    -attemptReconnect() : exp backoff 1s→30s
  }
  class TelegramClientManager {
    -clients: TelegramClientWrapper[]
    +connect() / disconnect()
    +getChats() / fetchMessages() / sendMessage()
    +downloadMediaByIds() / downloadProfilePhoto()
  }
  class TelegramClientWrapper {
    -client: GramJS (teleproto)
    -healthTimer (60s GetState probe)
    -reconnectAttempts (uncapped, 5s→5min)
    +connect() / disconnect()
    -runHealthCheck() / scheduleReconnect()
  }
  class UserGatewayPool {
    -gateways: Map~userId, PoolEntry~
    +getOrCreate(userId, tokens, wireEvents)
    +markClientConnected / markClientDisconnected
    -disconnectIdle() : 30-min idle sweep
  }
  GatewayManager "1" o-- "N" DiscordGateway : one per token
  TelegramClientManager "1" o-- "N" TelegramClientWrapper : one per session
  UserGatewayPool "1" o-- "N" GatewayManager : hosted, per user
```

Both managers dedup across their children (10 s window, 5000-entry cap;
Discord keys on message id, Telegram on `chatId:messageId`) and expose a
best-effort readiness barrier (`waitUntilReady` resolves on timeout rather
than rejecting).

## Connection lifecycles (state machines)

### Discord gateway

```mermaid
stateDiagram-v2
  [*] --> Connecting : connect()
  Connecting --> Identifying : HELLO → heartbeat + identify
  Identifying --> Ready : READY (reset attempts, store session_id)
  Identifying --> Resuming : RESUME (sessionId present)
  Resuming --> Ready
  Ready --> Reconnecting : close / RECONNECT opcode
  Reconnecting --> Connecting : backoff 1s·2ⁿ, cap 30s, max 30 tries
  Ready --> InvalidSession : INVALID_SESSION
  InvalidSession --> Identifying : re-identify after 1–5s jitter
  Reconnecting --> AuthFailed : close 4004 (invalid token)
  Reconnecting --> Blocked : upgrade 403/429 → budget cut to 5
  Reconnecting --> Fatal : close 4010/4011/4014
  AuthFailed --> [*]
  Blocked --> [*]
  Fatal --> [*]
  Ready --> Stopped : disconnect()
  Stopped --> [*]
```

Notes: heartbeat ACKs are **not** tracked (no zombie detection — Discord must
close the socket); the browser twin lacks the 403/429 block fast-fail because
the browser WebSocket API can't see the failed upgrade response.

### Telegram client

```mermaid
stateDiagram-v2
  [*] --> Connecting : connect()
  Connecting --> Connected : ready (getMe, wire handlers once)
  Connecting --> Backoff : failure (also emits fatal)
  Connected --> Unhealthy : 60s GetState probe fails/times out (15s)
  Unhealthy --> Backoff : scheduleReconnect
  Backoff --> Reconnecting : delay 5s·2ⁿ, cap 5min, no attempt cap
  Reconnecting --> Connected : success (reset attempts)
  Reconnecting --> Backoff : failure
  Connected --> Disposed : disconnect()
  Disposed --> [*]
```

The health probe exists because teleproto can silently drop the update stream
while reporting connected — the socket looks fine, messages just stop.
Handlers are wired once (`handlersWired`) so a reconnect can't duplicate
messages. Unlike Discord there is no give-up state: it retries forever at a
5-minute ceiling.

### Hosted per-user pool

`UserGatewayPool.getOrCreate` fingerprints the token list (first 8 chars of
each, sorted). Same fingerprint → reuse; different → tear down and rebuild.
`WsServer` lifecycle callbacks refcount active sockets per user; a 60 s sweep
evicts entries with zero clients idle past 30 minutes.

## Enrichment provider split

Deliberate and easy to get wrong — see [ADR-003](../../adr/003-provider-split/):

| Provider | Used for | Never used for |
| --- | --- | --- |
| **GMGN** (`gmgnEnrichment` → `gmgnClient`) | token enrichment + missed-runner live MC (only when `GMGN_API_KEY` set) | portfolio |
| **DexScreener** (`tokenEnrichment`) | symbol/metadata fallback | — |
| **Birdeye** (`portfolio/`) | portfolio only (stats/PnL/holdings/activity) | enrichment |

`enrichToken` (`utils/tokenSnapshot.ts`) enforces the GMGN → DexScreener
order and persists results to the token catalog. `mergeEnrichmentPatch`
(`utils/enrichmentMerge.ts`) makes Rick-embed data authoritative for
MC-at-call: a Rick patch overrides a fallback's FDV; any other source only
fills gaps.
