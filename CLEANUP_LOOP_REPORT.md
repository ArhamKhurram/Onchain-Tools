# OCT Code-Cleanliness Loop — Report

Session date: 2026-08-31. Base: origin/main @ `b2b52a0` (after the perf-loop sweep).
End: origin/main @ `1163c4f`. Goal: make the code **cleaner and more maintainable**
without changing behavior — dead code, over-abstraction, duplication, convoluted
logic, loose types. Explicitly **not** a performance pass (a prior loop did that).

Method: 3 rounds × 20 isolated worktree agents (60 agent-runs). Each agent owned a
distinct scope, produced one focused behavior-preserving PR (or an honest no-op),
and had to pass `npm run typecheck` **and** the full `npm run test` before pushing.
Between rounds, green PRs were squash-merged and the next round re-scoped from the
deferred findings.

**Final state verified on merged main (`1163c4f`):** `npm run typecheck` clean;
tests **1298 backend + 363 frontend + 18 fomo-worker — all passing.**

## Totals

| Round | PRs merged | Honest no-ops | Focus |
| --- | --- | --- | --- |
| 1 | 18 (#285–#302) | 2 (sniper, pages-lib) | broad per-subsystem dead-code + dedup sweep |
| 2 | 20 (#303–#322) | 0 | deferred items + deeper structural cleanups |
| 3 | 13 (#323–#335) | 7 | finish the tail + final polish |
| **Total** | **51 PRs** | **9 no-ops** | 60 agent-runs, all CI-green |

Every PR was squash-merged with green CI; both cross-round shared-file merges
(`packages/shared/src/index.ts`, `PriceAlerts.tsx`) were verified coherent by a
full typecheck + test run on the combined main.

## What changed (themes)

- **Dead code removed** — dead methods/exports/types/fields/imports across telegram,
  discord (backend + browser gateway), fomo client + types, portfolio (GMGN wallet
  fetcher + cache), storage shim, pollers' test seams, shared barrel re-exports,
  frontend types, landing components, and the sniper UI. The browser Discord gateway
  alone shed ~85 lines of dead self-user/role + readiness code.
- **Duplication collapsed** — `formatCompact` (4 copies → one `@oct/shared/format.ts`);
  the 4× enrichment→patch literal in the contracts route; the `useWalletCrud` factory
  (two ~90-line CRUD hooks → typed wrappers, −168 lines); channel-insert mapper;
  panel-count helper; pill-colour decision; `shortAddress`; landing scroll-to-top.
- **Oversized files reduced by extraction** — `ContractDashboard` 1066→421 (ContractFeedRows),
  `Message.tsx` split its triplicated attachment/embed JSX into `MessageAttachments`/
  `MessageEmbeds` (−353 net), `ChatPane` → `HiddenUsersPanel`, and a shared
  `FullPageSpinner` replaced the inline spinner in 12 pages/components.
- **Types tightened** — `updateRoom` now uses `TablesUpdate<'rooms'>` (last `any` in
  that write path gone); `EncryptedToken` de-exported; dead generics/casts dropped;
  20 dead entries removed from the `useSettingsForm` return object (197→177 keys).
- **Docs/comments corrected** — CLAUDE.md "oversized files" line counts fixed to
  measured values (RadarTable 1012→555, ContractDashboard 909→422 now off the list);
  stale comments referencing deleted FOMO methods fixed in code, tests, and docs.

## Guardrails honored

- **Sniper (the only money-spending subsystem) was locked to dead-code/rename only.**
  Round 1's sniper agent read all 5,672 lines and correctly opened **no PR**.
- Two-mode branches, the provider split, the storage/SniperStore split, the
  token-off-server browser-gateway guarantee, crypto internals, RLS scoping, and
  startup ordering were all left behavior-identical. The one PR that revisited a
  documented "intended-together" design (Message.tsx, #318) was flagged
  `refactor(message)!` with an ARCHITECTURAL CHANGE note for human review.

## Open items for a human (NOT done by the loop)

1. **SECURITY — leaked live secret.** `scripts/configure-fomo-vps.mjs:16` hardcodes a
   real `FOMO_WORKER_SECRET` (64-hex) in committed code, so it is in git history.
   Needs **rotation** (backend env + the VPS worker) **and a history scrub** — deleting
   the line is not enough. Left untouched deliberately.
2. **Orphaned GMGN request-signing cluster.** `gmgnSignedGet` (utils/gmgnClient.ts) has
   zero callers → the `signed` branch of `gmgnRequest`, `normalizePrivateKeyPem`, and
   `buildSignatureMessage`/`signMessage` are all dead. But it's entangled with
   private-key infra (`portfolio/status.ts`, a Railway key script, `.env.example`, docs,
   and frontend `needsPrivateKey` hints). Removal is a product-intent decision: is
   GMGN signed-holdings abandoned? If yes, one cross-cutting PR.
3. **Deferred structural refactors** (flagged, not forced): `messageReplyCache.ts` is
   byte-identical across backend/frontend (a stateful-singleton move to shared);
   regrouping the ~177-key `useSettingsForm` return into sub-objects.
4. **Minor nits:** stray NUL byte in `packages/shared/src/callerQuality.ts` (pre-existing,
   compiles fine); stale `window.trenchcord` comment in `desktop/preload.js:3`.
