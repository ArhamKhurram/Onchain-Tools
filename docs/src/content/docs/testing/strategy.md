---
title: Test plan & strategy
description: What is tested, how, and what deliberately isn't.
sidebar:
  order: 1
---

## Philosophy

The repo's testing stance is explicit and consistent:

1. **Unit tests over pure functions only.** Both vitest configs
   (`backend/vitest.config.ts`, `frontend/vitest.config.ts`) run
   `environment: 'node'` with the stated intent *"pure functions only — no
   network, no browser."* Where a boundary must be crossed, tests mock at the
   module seam (`vi.mock` + dynamic import), never spin up services.
2. **The compiler is the primary backstop.** `strict: true` everywhere; CI
   runs four typecheck steps and three builds against two test steps. Shared
   types were consolidated into `@oct/shared` precisely so cross-workspace
   drift is a compile error rather than a runtime surprise.
3. **Logic is extracted to be testable.** Pure modules exist *because* of
   tests: `enrichmentMerge`, `fomo/retention`, `signalConvergence`,
   `callerQuality`, the bot's `mapHolders`/`resolveNetworkId`. If you need to
   test I/O-adjacent logic, extract the pure part first.
4. **Tests are regression pins with prose.** Several suites carry comments
   naming the exact production bug they guard (the OAuth trailing-slash bug
   in `routes.test.ts`, the live-feed symbol fix in `fomoTradeSymbol.test.ts`).
5. **Tests live outside `src/`** (`backend/test/`, `frontend/test/`) so the
   production build/typecheck never includes them.
6. **No coverage thresholds, no e2e, no component tests** — deliberate.
   There are no integration or end-to-end tests, so the compiler carries the
   weight on anything involving I/O.

## Running

```bash
npm run test
```

Runs `build:shared` first (backend/frontend resolve `@oct/shared` from its
built dist), then one-shot vitest in backend and frontend. Per-workspace:
`npm run test -w backend`.

## CI gate

`.github/workflows/ci.yml` (PRs and pushes to `main`/`dev`, Node 20,
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`):

1. `npm ci` → build `@oct/shared`
2. Typecheck: backend, frontend, landing, fomo-worker
3. Test: backend, frontend
4. Build: backend, frontend, landing

Wire this to branch protection — a red run blocks the merge, and that is the
gate that stops a broken commit reaching Railway/Vercel. (The Foundry job for
the LP Safe module lives on `LP-Feats`/`dev`.)

## Test inventory (18 files, ~179 cases)

### Backend (`backend/test/`)

| Suite | Covers | Cases |
| --- | --- | --- |
| `contract.test.ts` | Address detection: EVM regex boundaries, Solana length/charset heuristics, GMGN-link chain extraction | 12 |
| `keywordMatcher.test.ts` | Match modes (`includes`/`exact`/`regex`), case-insensitivity, labels | 8 |
| `messageProcessor.test.ts` | The shared message transform end-to-end against a stubbed gateway | 6 |
| `enrichmentMerge.test.ts` | Fallback-vs-Rick patch precedence | 6 |
| `callerQuality.test.ts` | The entire scoring model: keys, tiers, bands, medians, ranking | 21 |
| `fomoTradeSymbol.test.ts` | Swap side + subject-token selection, network→chain mapping | 10 |
| `fomoRetention.test.ts` | Retention window parsing, 1-day floor | 4 |
| `botService.test.ts` | `resolveNetworkId`, holder/token mapping, bot auth middleware | 12 |
| `botWallet.test.ts` | Fuzzy search → wallet profile flow, error codes | 8 |
| `botAlerts.test.ts` | DM trigger mapping, opt-in gating, container rendering | 12 |
| `botLayout.test.ts` | Formatting helpers + command-registry integrity | 9 |
| `botIdentity.test.ts` | Discord→OCT identity resolution + cache | 8 |
| `botAnnounce.test.ts` | Announcement components + error paths | 13 |
| `releaseNotes.test.ts` | Opt-in selection, recipient cap, backoff | 12 |
| `changelogAnnounce.test.ts` | Changelog parsing / "is this heading new in the diff" | 13 |

### Frontend (`frontend/test/`)

| Suite | Covers | Cases |
| --- | --- | --- |
| `signalConvergence.test.ts` | Window math, address matching, convergence keys | 14 |
| `fomoTradeDisplay.test.ts` | Trade row rendering + link templating | 7 |
| `routes.test.ts` | OAuth `redirectTo` trailing-slash correctness | 4 |

`@oct/shared` has no suite of its own — its logic is tested from
`backend/test/`. `landing`, `fomo-worker`, and `desktop` have zero tests
(typecheck-only).

## Known coverage gaps

The compiler is the only gate on, most notably:

- **The connection layer** — `discord/gateway.ts` (reconnect/backoff/resume),
  `telegram/client.ts` (health check, UTF-16 entity offsets),
  `browserGateway.ts`, `userGatewayPool` idle eviction, and the
  security-relevant `WsServer.shouldSendToClient` tenant-isolation predicate.
  Several of these are pure enough to unit test and would be the
  highest-value additions.
- All enrichment/provider clients, the pollers, the Supabase repos, the API
  route layer, and the entire fomo-worker.

When touching those areas, lean on the typechecker, keep changes small, and
extract pure logic where a regression pin would have caught your bug.
