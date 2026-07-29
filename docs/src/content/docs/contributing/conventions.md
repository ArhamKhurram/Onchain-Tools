---
title: Conventions & gotchas
description: The working rules that keep this codebase coherent.
sidebar:
  order: 2
---

The short list every change should respect. Most of these have an ADR or an
architecture page behind them — follow the links before "fixing" one.

## Hard rules

- **Two modes everywhere.** Know [local vs hosted](../../architecture/two-modes/)
  before touching anything conditional.
- **Dual env branding.** Read vars as `OCT_*` with `TRENCHCORD_*` fallbacks —
  the project was renamed from "Trenchcord"; keep both.
- **Never clobber injected secrets.** `.env` loads with `override: false`.
- **Don't widen the local bind** without adding auth
  ([ADR-008](../../adr/008-local-loopback/)).
- **WebSockets don't run on Vercel** — `VITE_API_URL` points at Railway.
- **Provider split is law**: GMGN = enrichment/missed-runner, Birdeye =
  portfolio, DexScreener = fallback ([ADR-003](../../adr/003-provider-split/)).
- **Signals stay independent** ([ADR-004](../../adr/004-independent-signals/)).
- **New user-scoped persistence goes through `StorageProvider`**
  ([ADR-007](../../adr/007-storage-interface/)).
- **`dist/` is never committed** — every workspace gitignores it; commit
  `src/` only (fomo-worker included).
- **Two Supabase projects** — verify migrations against the right one (dev
  `zcvubfadvdwjxgodznxh`, prod `vmlxyqzjdaegkfylxfka`).

## Code shape

- TypeScript `strict: true` everywhere; ESM modules (`type: "module"`).
- Cross-workspace types and pure logic live in `@oct/shared` — if backend and
  frontend both need it, it belongs there (build it with `npm run
  build:shared` before typechecking).
- Extract pure functions from I/O code — that is where the
  [tests](../../testing/strategy/) live.
- Tests go in `<workspace>/test/`, outside `src/`.

## Known oversized files (refactor targets)

Being split incrementally — see [Tech debt](../../architecture/tech-debt/) for
the full plan. Prefer extracting into the planned structure over adding more to
them:

- `frontend/src/components/GlobalSettings.tsx` (~2.9k) · `Message.tsx`
  (~1.5k) · `RoomConfig.tsx` (~1k)
- `backend/src/api/routes.ts` and `backend/src/storage/supabase.ts` — already
  split into `routes/*.ts` / `storage/supabase/*.ts`, done.
- `frontend/src/stores/appStore.ts` — already sliced; keep new state in the
  right slice.

## Docs upkeep

- [Roadmap](../../roadmap/) — when scoping features.
- `CHANGELOG.md` — when shipping (drives the Discord announcement).
- `frontend/src/data/updates.ts` — the in-app announcement modal.
- This site (`docs/`) — when architecture or APIs change; diagrams are
  Mermaid in Markdown, so update them like code.
