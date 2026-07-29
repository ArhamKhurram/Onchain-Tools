---
title: 'ADR-003: Enrichment provider split'
description: GMGN for enrichment and missed-runner, DexScreener as fallback, Birdeye for portfolio only.
sidebar:
  order: 3
  label: '003 — Provider split'
---

**Status:** Accepted

## Context

Three market-data providers are integrated, each with different strengths,
rate limits, and pricing: GMGN (fast token snapshots, live MC), DexScreener
(free metadata), Birdeye (wallet-level portfolio analytics).

## Decision

Hard-wire the responsibilities and don't cross them:

- **GMGN** → token enrichment + missed-runner live market cap (only when
  `GMGN_API_KEY` is set).
- **DexScreener** → fallback for symbol/metadata when GMGN is absent or
  misses.
- **Birdeye** → portfolio **only** (stats, PnL, holdings, activity). Never
  used for enrichment.

`enrichToken` (`utils/tokenSnapshot.ts`) owns the GMGN → DexScreener order
and persists to the token catalog.

## Consequences

- Each provider's rate limit budget serves exactly one feature set;
  portfolio load can't starve enrichment or vice versa.
- Rick-embed data remains authoritative for MC-at-call
  (`mergeEnrichmentPatch`): fallback sources only fill gaps.
- Anyone "helpfully" pointing portfolio at GMGN or enrichment at Birdeye is
  reversing a deliberate decision — don't.
