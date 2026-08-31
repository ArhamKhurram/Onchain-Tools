# OCT Performance Loop — Before/After Progress Spec Sheet

Session date: 2026-08-30. Base: origin/main @ c4f5c73 (#212). End: origin/main @ 2ec7824 (#219).
All numbers from `vite build` on the same machine/config; gzip figures are vite's own.
Final state verified on merged main: `npm run typecheck` green, tests **1226 backend + 324 frontend + 14 fomo-worker, all passing**.

> **Continuation — 2026-08-31.** A parallel perf batch (#220–#271) landed on `main`
> independently, and this session then cleared the remaining **12 open PRs (#272–#284)**,
> squash-merging all of them with green CI. Two required conflict resolution because both
> edited `backend/src/ws/server.ts` on top of #274's backpressure guard:
> - **#275** (lazy-serialize WS broadcasts) — folded lazy `JSON.stringify` into `guardedSend` + the `essential` flag.
> - **#278** (heartbeat-sweep dead connections) — a superset of #275; kept the new `isAlive`/pong/`sweepDeadConnections` code and reconciled `fanout`/`fanoutToRooms` to the guarded+lazy+essential form. `ClientState` now carries both `isAlive` and `skippedFrames`.
>
> Merged-main `ws/server.ts` verified to carry all three features (heartbeat + lazy fanout + backpressure guard) coexisting. `main` HEAD after the sweep: `b2b52a0` (#278). No open PRs remain.

## Shipped PRs (7, all squash-merged with green CI)

| PR | Title | Dimension | Before → After |
| --- | --- | --- | --- |
| #213 | perf(frontend): lazy-load PopoutView | Console bundle | index chunk 257.99 kB (71.76 gzip) → 151.85 kB (44.00 gzip); chat stack (ChatPane 99.4 kB) now lazy |
| #214 | perf(landing): parse CHANGELOG.md at build time | Landing bundle | 377.20 kB (123.93 gzip) → 359.01 kB (116.69 gzip); + fixed a real CRLF parser bug that rendered WHAT'S NEW empty on Windows checkouts |
| #215 | perf(landing): LazyMotion + `m` components | Landing bundle | 377.20 kB (123.93 gzip) → 334.33 kB (111.36 gzip) measured alone; `strict` guard makes it regression-proof |
| #216 | chore(landing): delete dead pre-redesign components | Hygiene | −1,545 lines / 12 files; bundle byte-identical (proof of deadness); bonus: landing CSS later dropped 27.70 → 19.94 kB once tailwind stopped scanning them |
| #217 | perf(frontend): lazy-load the RoomConfig modal | Console bundle | index chunk 151.85 kB (44.00 gzip) → 110.39 kB (34.58 gzip); RoomConfig 30.97 kB fetched on first open |
| #218 | perf(frontend): lazy-load demo/preview fixtures | Console bundle | index chunk 110.39 kB (34.58 gzip) → 93.33 kB (28.71 gzip); fixtures 17.53 kB fetched on "Watch the live demo feed" |
| #219 | chore(frontend): remove unreferenced update screenshots | Hygiene / shipped assets | frontend/public 6.7 MB → ~40 KB (4 PNGs referenced by nothing; verified repo-wide) |

## Aggregate before → after per dimension

### Console (frontend) initial JS — every page load, both local and hosted
| | before | after | delta |
| --- | --- | --- | --- |
| `index` chunk | 257.99 kB (71.76 gzip) | **93.33 kB (28.71 gzip)** | −64% raw, −60% gzip |
| Full initial JS (index + vendor-react/router/icons) | 535.4 kB (~155.4 gzip) | **370.7 kB (~112.4 gzip)** | −165 kB raw / −43 kB gzip |

Feed page pays the same totals as before (chat stack loads in parallel); Dashboard, Callers, Portfolio, Sniper, Settings, Login pay the full savings. Hosted builds additionally carry vendor-supabase 174 kB — already split into its own cacheable chunk (the local build's "empty vendor-supabase chunk" warning is env-gated tree-shaking, not a bug).

### Landing (marketing site, first paint)
| | before | after | delta |
| --- | --- | --- | --- |
| JS | 377.20 kB (123.93 gzip) | **316.14 kB (104.21 gzip)** | −16% raw |
| CSS | 27.70 kB (6.27 gzip) | **19.94 kB (4.89 gzip)** | −28% |
| Changelog markdown shipped | 32.7 kB (all 24 sections) | ~8 kB (8 rendered entries as JSON) | |

### Shipped static assets
frontend/public: **6.7 MB → ~40 KB** (also removed from every desktop-app package, which embeds frontend/dist).

### Hygiene
−1,545 lines of dead landing components; rollup "static+dynamic import" warning eliminated; a real CRLF parsing bug fixed (WHAT'S NEW silently empty on Windows dev).

### Backend egress / runtime — audited, at floor, no change shipped
- Every timer-driven Supabase read is already column-scoped (#202/#209/#212 plus the revival, journal, price-alert, peak-sampler, caller-recorder, missed-runner paths — each verified against its mapper's field list this session).
- The revival poller's `getContracts` select('*') call is **local-mode only** (JSON file reads — free); its hosted path is column-scoped with the chain filter pushed into the query.
- Journal tables are narrow and their mappers read every column — nothing to scope.
- Auth middleware: token verification cached (#209); no other per-request Supabase round-trip.
- WS broadcasts serialize once per broadcast, not per client.
- Frontend direct-Supabase hooks (`useTrackedWallets`, `useHoldingWallets`) fetch once on mount, small tables, no polling; `useFomoTracking` already column-scoped.
- Caller board serves from persistent aggregates with the derived fold as fallback only.
- `addMessage`/`addContract` store updates are O(room cap) with stable refs for untouched keys — no fresh-reference selectors found anywhere (grep for object-literal and array-op selectors came back empty).
- Unused-dependency audit across all four workspaces: every declared dependency has import sites.

## Audited and deliberately NOT shipped
- **UpdatesModal stack (~21 kB raw / ~6 kB gzip in index)** — its visibility decision needs the slide data itself; lazy-loading requires either a second source of truth for slide IDs or restructuring the seen-tracking. Cost/benefit poor; last non-core item in index.
- **vendor-icons (44 kB) / CSS (81 kB) / vendor-react** — already tree-shaken/JIT-minimal/irreducible.
- **Marginal `.select()` sites** (rooms/config/token-catalog/limit-1 lookups) — small tables or single rows on user-initiated paths; scoping them is churn, not egress.

## SUPERVISED-only work (documented, not gambled)
1. **Replace `@supabase/supabase-js` with direct `@supabase/auth-js` + `postgrest-js` clients** (hosted console). vendor-supabase is 174 kB min / 45.9 gzip; the app uses auth + table reads only, but `createClient` instantiates realtime/functions/storage un-shakeably. Risk: session/token refresh semantics — auth-critical, needs a human on the hosted login/refresh flow.
2. **recharts → lighter chart lib** (vendor-charts 393 kB, lazy on chart open). Product/visual quality call.
3. **Delete or officially retire the `VITE_DEMO_MODE` build** (nothing in CI/deploy sets it; the in-app seeded preview supersedes it). Product decision; would let demo fixtures disappear outright.
4. **Lossy-optimize `landing/public/og.png` (332 kB)** — needs a human eye on visual quality.
5. **GlobalSettings chunk internals** (162 kB lazy; SoundsSection/PushoverSection/HelpSection ~36 kB source each) — settings-page-only cost; any slimming is a UX/content edit, not mechanical.

## Iterations used
**10 of 50.** Stopped early at the honest floor: the console index chunk is down to core boot code (store, WS dispatch, shell), landing is at its framework floor, backend egress hot paths were already column-scoped by the five preceding perf PRs and re-verified rather than re-done, and every remaining opportunity either needs a human judgment call (listed above) or is indistinguishable from noise. No manufactured iterations.
