---
title: 'System overview (C4: Context & Containers)'
description: The SDD entry point — what OCT is, who uses it, and the containers it is made of.
sidebar:
  order: 1
---

This is the top of the System Design Document. It follows the
[C4 model](https://c4model.com/): this page covers **Context** (level 1) and
**Containers** (level 2); the per-container pages cover **Components**
(level 3) with sequence/state diagrams where behavior matters.

## Level 1 — System context

OCT sits between chat platforms where alpha is called, market-data providers
that price it, and the trader watching the console.

```mermaid
C4Context
  title System context — Onchain Tools
  Person(trader, "Trader", "Watches feeds, tracks callers and wallets, receives alerts")
  System(oct, "Onchain Tools", "Real-time crypto intelligence console")
  System_Ext(discord, "Discord", "Message source (user gateway) + Outpost bot surface")
  System_Ext(telegram, "Telegram", "Message source (MTProto)")
  System_Ext(fomo, "fomo.family", "Trader leaderboard + swap feed (Cloudflare-gated API)")
  System_Ext(dex, "Market data", "GMGN, DexScreener, Birdeye, Helius, Alchemy")
  System_Ext(supabase, "Supabase", "Postgres + Auth (hosted mode)")
  System_Ext(pushover, "Pushover", "Mobile push notifications")

  Rel(trader, oct, "Uses console / desktop app / bot commands")
  Rel(oct, discord, "Ingests messages; bot DMs & announcements")
  Rel(oct, telegram, "Ingests messages")
  Rel(oct, fomo, "Polls tracked traders")
  Rel(oct, dex, "Enriches contracts; portfolio & balances")
  Rel(oct, supabase, "Auth + storage (hosted)")
  Rel(oct, pushover, "Keyword alerts")
```

## Level 2 — Containers

```mermaid
flowchart TB
  trader((Trader))

  subgraph vercel["Vercel"]
    landing["Landing site<br/><i>React + Vite</i><br/>served at /"]
    console["Console (oct-console)<br/><i>React 19 + Vite</i><br/>served at /dashboard"]
  end

  subgraph railway["Railway"]
    backend["Backend (oct-backend)<br/><i>Express + WebSocket</i><br/>ingest, enrichment, alerts,<br/>REST /api, WS /ws, Outpost bot"]
  end

  subgraph vps["VPS"]
    worker["fomo-worker<br/><i>Playwright + Chromium</i><br/>Cloudflare-gated FOMO API proxy"]
  end

  subgraph desktop["Desktop (Electron)"]
    shell["Electron shell<br/>bundles backend + frontend<br/>(local mode)"]
  end

  supabase[("Supabase<br/>Postgres + Auth")]
  discord{{"Discord"}}
  telegram{{"Telegram"}}
  fomoapi{{"fomo.family API"}}
  providers{{"GMGN / DexScreener /<br/>Birdeye / Helius / Alchemy"}}

  trader --> console
  trader --> landing
  trader --> shell
  console -- "REST + WS<br/>(bearer token)" --> backend
  console -- "auth + RLS reads/writes" --> supabase
  console -. "browser Discord gateway<br/>(hosted mode only)" .-> discord
  backend --> supabase
  backend -- "HTTP + shared secret" --> worker
  worker --> fomoapi
  backend --> providers
  backend -- "gateway (local mode)<br/>+ Outpost bot" --> discord
  backend -- "MTProto" --> telegram
```

Notes that make this diagram honest:

- **WebSockets do not run on Vercel.** The console always connects its WS to
  the Railway backend (`VITE_API_URL`), never the Vercel URL.
- **In hosted mode the Discord user gateway runs in the browser**, not on the
  backend — the user's Discord token never touches the server
  ([ADR-002](../../adr/002-browser-gateway/)). In local mode the backend owns
  one global gateway connection.
- The desktop app is the same backend + frontend running in **local mode**
  inside Electron: one implicit user, JSON storage, loopback bind.
- The fomo-worker exists because fomo.family sits behind Cloudflare; API calls
  must originate from a real stealth Chromium page
  ([ADR-005](../../adr/005-fomo-worker/)).

## The core pipeline

Discord and Telegram share one ingest pipeline. This is the heart of the
system — most features hang off it:

```mermaid
flowchart LR
  ingest["Ingest<br/>(Discord gateway /<br/>Telegram MTProto)"]
  gate["Room gating"]
  process["processMessage<br/>detectContractAddresses<br/>+ matchKeywords"]
  log["storage.logContract"]
  bcast["WS broadcast<br/>(contract, message)"]
  dex["scheduleDexFallback<br/>(15s)"]
  chain["EVM chain resolve"]
  rick["Rick embed parse<br/>(Discord only)"]
  enrich["storage.enrichContract<br/>+ broadcastContractEnrichment"]
  alerts["Keyword / Pushover alerts<br/>+ bot DM alerts"]

  ingest --> gate --> process
  process -- "per contract" --> log --> bcast
  log --> dex --> enrich
  log --> chain --> enrich
  process --> rick --> enrich
  process --> alerts
```

Deep dives: [Backend components](../backend/), [Frontend](../frontend/),
[Signals](../signals/), [Discord bot](../discord-bot/),
[fomo-worker](../fomo-worker/).

## Monorepo layout (package diagram)

npm workspaces; `desktop` is deliberately **not** a workspace (invoked via
`npm --prefix desktop`).

```mermaid
flowchart TB
  subgraph repo["Onchain-Tools (npm workspaces)"]
    shared["packages/* → @oct/shared<br/>pure shared logic (scoring, types)"]
    backendPkg["backend/ (oct-backend)<br/>→ Railway"]
    frontendPkg["frontend/ (oct-console)<br/>→ Vercel /dashboard"]
    landingPkg["landing/<br/>→ Vercel /"]
    workerPkg["fomo-worker/ (oct-fomo-worker)<br/>→ VPS systemd"]
    docsPkg["docs/ (oct-docs)<br/>→ GitHub Pages"]
    supabaseDir["supabase/<br/>migrations + generated types"]
    scriptsDir["scripts/<br/>dev orchestration, Vercel merge,<br/>changelog announce"]
    desktopDir["desktop/ (not a workspace)<br/>Electron shell"]
  end

  backendPkg --> shared
  frontendPkg --> shared
  desktopDir --> backendPkg
  desktopDir --> frontendPkg
  backendPkg -.-> supabaseDir
```

## Design principles worth knowing

1. **Two modes everywhere.** Local vs hosted is the axis nearly every branch
   keys off — [read it first](../two-modes/).
2. **Signals stay independent.** Convergence, FOMO buys, and missed-runner are
   distinct detections; they are routed and displayed together but never fused
   ([ADR-004](../../adr/004-independent-signals/)).
3. **Provider split is deliberate.** GMGN → enrichment + missed-runner;
   DexScreener → metadata fallback; Birdeye → portfolio only
   ([ADR-003](../../adr/003-provider-split/)).
4. **Storage goes through the interface.** `StorageProvider` methods take
   `userId` first; JSON and Supabase implementations sit behind it
   ([Data model](../../data/storage/)).
5. **Background subsystems self-gate** on their env vars, so the server runs
   cleanly with any subset configured.
