---
title: Architecture Decision Records
description: The high-level design choices and the context behind them.
sidebar:
  order: 0
  label: About ADRs
---

These records capture decisions that shape the codebase — the *why* behind
structures that would otherwise look arbitrary. Each follows the classic
format: **Context** (the forces at play), **Decision** (what was chosen),
**Consequences** (what we live with as a result).

Status legend: all ADRs here are **Accepted** and reflect the code on `main`
as of 2026-07. When a decision is revisited, supersede the record rather than
editing history.

| # | Decision |
| --- | --- |
| [001](../001-two-modes/) | One codebase, two deployment modes (local / hosted) |
| [002](../002-browser-gateway/) | The Discord user gateway runs in the browser in hosted mode |
| [003](../003-provider-split/) | Enrichment provider split: GMGN / DexScreener / Birdeye |
| [004](../004-independent-signals/) | Signals stay independent — never fused |
| [005](../005-fomo-worker/) | A VPS Playwright worker fronts the Cloudflare-gated FOMO API |
| [006](../006-in-process-bot/) | The OCT bot runs in-process with the backend |
| [007](../007-storage-interface/) | All user-scoped persistence behind `StorageProvider` |
| [008](../008-local-loopback/) | Local mode binds loopback |
| [009](../009-branch-topology/) | Branch topology: `main` / `dev` |
| [010](../010-event-driven-announce/) | Changelog announcements are event-driven, not scheduled |
| [011](../011-sniper-custody/) | The sniper never holds a wallet key |
| [012](../012-venue-tenancy/) | Users bring their own venue accounts (multi-tenant) |
| [013](../013-candles-library/) | Candlestick charts use `lightweight-charts`, lazy-loaded |
