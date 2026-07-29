---
title: Tech debt — breaking up the god files
description: The incremental, behavior-preserving plan for splitting the six largest files in the codebase.
sidebar:
  order: 8
---

Six files carry a disproportionate share of the codebase's complexity. This plan
splits each into cohesive units **without changing behavior**. It's incremental:
one file per PR, typecheck + build between each, public surfaces preserved so
callers never change.

## Guiding rules

1. **Preserve the public surface.** Every target file exposes a narrow surface
   (a single propless component, one router factory, one store, one class). Keep
   those exports and signatures identical — all decomposition is internal.
2. **One file per PR.** Small, reviewable, revertible. Never split two god files
   in the same PR.
3. **Green between every step.** `npm run typecheck` + the relevant `build` must
   pass before moving on.
4. **No behavior change.** This is a move-code refactor. Any bug you notice goes
   in the [Roadmap](../../roadmap/), not into the same PR.

## Recommended sequence (safest → highest value)

| # | File | Why this order | Risk |
| - | ---- | -------------- | ---- |
| 1 | `backend/src/api/routes.ts` | Mechanical; the fomo/portfolio sub-routers already prove the pattern — **done**, see [API reference](../../api/rest/) | Low |
| 2 | `backend/src/storage/supabase.ts` | Interface-guarded; pure mapper helpers lift out cleanly — **done**, see [Storage abstraction](../../data/storage/) | Low–Med |
| 3 | `frontend/src/components/Message.tsx` | The markdown/render cluster is self-contained | Low–Med |
| 4 | `frontend/src/stores/appStore.ts` | Enables cleaner component splits; needs Zustand slices — **done**, see [Frontend architecture](../frontend/) | Medium |
| 5 | `frontend/src/components/RoomConfig.tsx` | Shares a keyword editor with #6 | Medium |
| 6 | `frontend/src/components/GlobalSettings.tsx` | Biggest, hardest seam (dirty-check triad) — do last | Med–High |

Items 1, 2, and 4 have shipped since this plan was written (`api/routes/*`,
`storage/supabase/*`, `stores/slices/*`) — see the linked architecture pages for
the structure that landed. 3, 5, and 6 remain open.

---

## 1. `backend/src/api/routes.ts` (1512 → ~150 shell + domain routers) — shipped

**Pattern already in the file:** it delegates `/fomo` and `/portfolio` via
`router.use(prefix, createXRouter(wsServer))`. Replicate that for every group.

**Target structure**
```
backend/src/api/
  routes.ts                 # shell: createRouter(wsServer) → mounts sub-routers only
  shared.ts                 # getUserId, safeError, multer configs, SOUNDS_DIR
  routes/
    auth.ts                 # /auth/* (status, profile, token, tokens/*)
    telegram.ts             # /auth/telegram/*, /telegram/*
    history.ts              # /history
    discord.ts              # /guilds, /dm-channels, /reactions/*
    rooms.ts                # /rooms/*
    config.ts               # /config, /config/export, /config/import
    sounds.ts                # /sounds/*, /channel-sounds/*, static mount
    messaging.ts             # /send-message
    tokens.ts                # /tokens/:chain/:address/snapshot
    alerts.ts                # /alerts/missed-runner/test
    contracts.ts             # /contracts/* incl. rick/dex-enrich
    pushover.ts              # /pushover/signal-convergence
```

**Extraction rules**
- Each sub-router is `export function createXRouter(wsServer): Router`, mirroring
  `createFomoRouter`. Handlers that don't need `wsServer` can omit the param.
- Move `getUserId`, `safeError`, `SOUNDS_DIR`, and the multer instances (`upload`,
  `channelSoundUpload`, `memoryUpload`, `messageUpload`) into `api/shared.ts` — they're
  used across sounds + messaging + config.
- `contracts.ts` is the heaviest: it pulls in `rickEmbedParser`, `enrichmentMerge`,
  `tokenSnapshot`. Those imports move with it — fine, they belong together.

**Public surface:** `createRouter(wsServer)` stays exactly as `index.ts` expects.
Zero changes outside `api/`.

---

## 2. `backend/src/storage/supabase.ts` (1045 → mappers + per-entity repos) — shipped

`SupabaseStorageProvider implements StorageProvider` — the interface is the safety net.

**Target structure**
```
backend/src/storage/supabase/
  index.ts        # SupabaseStorageProvider — composes repos, keeps the class surface
  client.ts       # createServiceClient, throwIfError, the getCached/setCache/invalidate cache layer
  mappers.ts      # DEFAULT_SETTINGS + all row↔app mappers
  configRepo.ts   # getConfig/updateConfig
  tokensRepo.ts   # getTokens/setTokens
  roomsRepo.ts    # rooms + highlight/keyword sync helpers
  contractsRepo.ts# contracts + mapContractRow
  telegramRepo.ts # telegram creds/sessions (encrypted)
  userCacheRepo.ts# cacheUserName + getter
```

**Extraction rules**
- Repos take the Supabase client + cache helpers via constructor injection (or extend
  a small `BaseRepo` holding `supabase` + `getCached/setCache/invalidateUser`). The
  TTL cache must stay shared — pass one instance to all repos.
- **The awkward seam:** rooms ↔ config ↔ highlights/keywords. `createRoom`/`updateRoom`
  call `syncHighlights`/`syncKeywords`, and `getConfig` also touches highlights. Keep
  the highlight/keyword sync helpers in `roomsRepo.ts` and have `configRepo` import them,
  rather than duplicating.
- `SupabaseStorageProvider` becomes a thin façade that instantiates the repos and
  forwards each `StorageProvider` method — the class still `implements StorageProvider`.

**Public surface:** `SupabaseStorageProvider` unchanged for `storage/index.ts`.

---

## 3. `frontend/src/components/Message.tsx` (1513 → renderer + sub-components + shell)

**Target structure**
```
frontend/src/components/message/
  Message.tsx           # the component + its 3 render branches (memoized default export)
  content.tsx           # markdown/linkify renderer: the entire regex/render cluster
  reactions.tsx         # ReactionUserList + ReactionPills
  TelegramExtras.tsx    # Telegram-specific render bits
  badges.tsx            # DeletedBadge + EditedIndicator
  avatar.ts             # getAvatarUrl + formatTimestamp
```

**Extraction rules**
- **Do `content.tsx` first** — the regexes + `linkifyText`, `applyInlineFormatting`,
  `renderInlineMarkdown`, `renderContent`, `splitByRegex`, `detectAddresses`,
  `renderEmbedDescription` are a self-contained pure renderer. Export the functions the
  component and embeds call. **Ideal unit-test target** — pin `detectAddresses`/`renderContent`
  (see [Testing strategy](../../testing/strategy/) for the project's testing philosophy).
- `getAvatarUrl` (named export) has no external importers — safe to move to `avatar.ts`.
- The three render branches (compact / consecutive / full) share ~15 derived values.
  Keep them in `Message.tsx` for the first pass; only extract each branch into a
  sub-component once the shared values are grouped into one object you can pass as a
  single prop (avoid threading 15 props).

**Public surface:** default `memo(Message)` + `MessageProps` unchanged for `ChatPane.tsx`.

---

## 4. `frontend/src/stores/appStore.ts` (1361 → Zustand slices) — shipped

Uses the **Zustand slices pattern**: each slice is a `StateCreator<AppState, [], [], SliceShape>`
over the shared store, combined in one `create<AppState>()`. Same store object, same
selectors — consumers don't change. See [Frontend architecture](../frontend/#state--one-zustand-store-nine-slices)
for the structure that shipped (nine slices under `stores/slices/`).

---

## 5. `frontend/src/components/RoomConfig.tsx` (1034 → modal shell + tab components)

**Target structure**
```
frontend/src/components/room-config/
  RoomConfig.tsx        # modal shell, tab bar, hydration effects, handleSave (owns state)
  ChannelsTab.tsx       # discord + telegram sub-tabs (platformTab)
  UsersTab.tsx          # highlighted users, highlight mode, colors
  FilterTab.tsx         # filtered users
  KeywordsTab.tsx       # room keyword patterns
```

**Extraction rules**
- Keep all state + `handleSave` in `RoomConfig.tsx` (the save assembles the full room
  payload from every field). Pass each tab its slice of state + setters as props. This
  avoids lifting the hydration effects.
- `ChannelsTab` is the biggest and depends on `selectedChannels`/`toggleChannel`/
  `toggleChannelEmbeds`/`search`/`guilds`/`telegramChats` — pass them down.
- **Shared with #6:** the keyword-draft UI (`newKeywordPattern`/`MatchMode`/`Label`) is
  near-identical to GlobalSettings' keyword section. Extract a shared
  `components/settings/KeywordEditor.tsx` and use it in both `KeywordsTab` here and
  GlobalSettings' keywords section.

**Public surface:** propless default `RoomConfig` unchanged for `AppProviders.tsx`.

---

## 6. `frontend/src/components/GlobalSettings.tsx` (2899 → shell + section components)

Biggest file, hardest seam — do it last, after the store slices and the shared
`KeywordEditor` exist.

**Target structure**
```
frontend/src/components/settings/
  GlobalSettings.tsx        # shell: nav + section routing; owns config state via the hook below
  useSettingsForm.ts        # the hydration effect + hasUnsavedChanges + handleSave + guardNavigation
  constants.ts              # Section type, SECTIONS nav, default* config objects
  fields.tsx                # Toggle, authedFetch/apiBase, shared field primitives
  sections/
    TokensSection.tsx       GeneralSection.tsx
    ContractsSection.tsx    SoundsSection.tsx
    PushoverSection.tsx     KeywordsSection.tsx (uses shared KeywordEditor)
    MentionsSection.tsx     UsersSection.tsx
    HelpSection.tsx         GuildsSection.tsx
```

**Extraction rules — the critical part**
- The hard seam is the **three-way lock**: the hydration effect, the
  `hasUnsavedChanges` memo, and `handleSave` all read/write the entire ~90-field
  state cluster. **Extract these into a `useSettingsForm()` hook first**, before
  touching any section. The hook owns all the state + the dirty-check + save + nav
  guard, and returns `{ values, setters, hasUnsavedChanges, save }`.
- Then each section becomes a presentational component receiving its slice of
  `values`/`setters` from the hook. `Toggle`, `authedFetch`, `apiBase` move to `fields.tsx`.
- `SECTIONS`, the `Section` type, and the `default*` objects go to `constants.ts`
  (referenced by both hydration and dirty-check — one home).
- Start extraction with the **leaf sections** (Mentions, Users, Help — small, few
  dependencies) to validate the hook contract, then do the big ones (Sounds, Pushover).

**Public surface:** propless default `GlobalSettings`, still lazy-loaded by `SettingsPage.tsx`.

---

## Per-PR verification checklist

- [ ] `npm run typecheck` passes (backend and/or frontend as relevant)
- [ ] `npm run build -w <workspace>` passes
- [ ] The file's public export(s) are byte-for-byte the same signature
- [ ] Behavior manually spot-checked (settings save, room create, message render, etc.)
- [ ] No new logic — moves only; any bug found is filed in the [Roadmap](../../roadmap/)
- [ ] Diff is one god file, reviewable in a sitting
