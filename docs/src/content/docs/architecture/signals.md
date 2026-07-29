---
title: Signals & alerts
description: Convergence, missed-runner, FOMO trades, and caller quality — independent by design.
sidebar:
  order: 5
---

OCT raises four kinds of "pay attention" signals. They are **deliberately
independent detections** — routed and displayed together, never fused
([ADR-004](../../adr/004-independent-signals/)).

## Use-case view

```mermaid
flowchart LR
  trader((Trader))
  uc1["See live feeds<br/>(rooms, panes)"]
  uc2["Get keyword / highlight /<br/>contract alerts"]
  uc3["Track FOMO traders<br/>(live trades)"]
  uc4["Spot signal convergence"]
  uc5["Catch missed runners"]
  uc6["Rank callers<br/>(quality bands)"]
  uc7["Use Outpost bot<br/>(slash commands, DMs)"]

  trader --> uc1
  trader --> uc2
  trader --> uc3
  trader --> uc4
  trader --> uc5
  trader --> uc6
  trader --> uc7
```

## FOMO trade tracking

`fomo/poller.ts` polls each **unique** tracked trader once (deduped across
subscribers), stores swaps, then fans out per user:

```mermaid
sequenceDiagram
  participant P as FomoPoller
  participant C as FomoClient / ProxyClient
  participant DB as Supabase
  participant W as WsServer

  loop every 10s (60s with no clients)
    P->>DB: load tracked users (deduped)
    loop per unique trader
      P->>C: getUserActivity(userId)
      C-->>P: swaps
      P->>DB: insert fomo_trade_events (idempotent on trade_id)
      P->>DB: insert fomo_trade_deliveries per subscriber
      P->>W: sendToUser(fomo_trade) per subscriber
      P->>DB: upsert fomo_activity_cursors
    end
  end
```

The interval is adaptive: `10 s` while any authenticated WS client is
connected, `60 s` idle. On reload the console backfills 24 h of trades from
`GET /api/fomo/trades` (read from the *delivery* log, so a user only sees
trades that were actually fanned out to them), merging live frames deduped by
`trade_id` in both directions. A retention sweeper prunes events past
`FOMO_TRADE_RETENTION_DAYS` (default 7).

## Missed-runner alerts

The poller (`alerts/missedRunnerPoller.ts`, default every 3 min) walks recent
contract calls, compares MC-at-call against live MC (GMGN), checks the user
actually *held* nothing (Helius/Alchemy balance checks on holding wallets),
and alerts when the multiplier clears the configured threshold.

```mermaid
stateDiagram-v2
  [*] --> Called : contract logged with MC@call
  Called --> Watching : poller sees it in lookback window
  Watching --> Triggered : live MC ≥ minMultiplier × MC@call\nand user balance = 0
  Watching --> Expired : leaves lookback window (1–168h)
  Triggered --> Cooldown : alert sent (toast/Pushover)\nrow in missed_runner_alerts
  Cooldown --> Watching : cooldown_until elapses
  Expired --> [*]
```

Test/dry-run endpoint: `POST /api/alerts/missed-runner/test` returns full
diagnostics (`wouldAlert`, `blockReason`, `multiplier`, …).

## Signal convergence

Client-side correlation ([frontend](../frontend/#signal-convergence-client-side)):
a contract call and a tracked trader's **buy** of the same address within the
configured window (default via `signalConvergenceWindowMinutes`). Compares
the trade's `occurredAt`, not arrival time, so replayed history can't fire
false convergences after a reload.

## Caller quality

Two layers, manual always overriding earned
(`@oct/shared/callerQuality.ts` — pure, 21 unit tests):

- **Manual tiers**: `muted` / `normal` / `trusted` per caller, global or
  per-room; room entry beats global; when a contract lands in several rooms
  the most restrictive tier wins.
- **Earned bands**: each caller scored on *their own* calls — MC when they
  posted vs the token's peak since (`token_peaks`, sampled by
  `tokenPeakSampler`). One caller/token pair counts once; below
  `MIN_RATED_CALLS = 10` a caller stays `unrated`. Bands:
  `unrated | slop | mixed | solid | elite`.

Scores surface in the contract feed and Callers radar
(`GET /api/callers/scores`, 120 s cache); chat only colors the username since
reordering chat would break reply context. Quality is a display/filter layer
— deliberately **not** folded into convergence scoring.

## Alert delivery matrix

| Signal | Toast | Pushover | Bot DM (opt-in) | WS frame |
| --- | --- | --- | --- | --- |
| Highlighted user | ✔ | ✔ (filtered) | ✔ | `alert` |
| Keyword match | ✔ | ✔ | ✔ | `alert` |
| Contract detected | ✔ | ✔ | ✔ | `alert` + `contract` |
| Missed runner | ✔ | ✔ | ✔ | `alert` |
| FOMO trade | feed | per-trader `notify_pushover` | — | `fomo_trade` |
| Convergence | ✔ (client) | ✔ (via REST) | — | client-only |

Bot DMs ride the `WsServer.onAlert` seam and are gated per user per trigger
(`discordBotDm.triggers`) — see [Discord bot](../discord-bot/).
