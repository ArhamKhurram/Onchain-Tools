# REFACTOR.md — Breaking up the god files

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
   pass before moving on. There's no test suite yet, so the compiler is the net —
   consider landing the Vitest scaffolding (see `IDEAS.md` roadmap) first so pure
   helpers extracted here get pinned.
4. **No behavior change.** This is a move-code refactor. Any bug you notice goes
   in `IDEAS.md`, not into the same PR.

## Recommended sequence (safest → highest value)

| # | File | Why this order | Risk |
| - | ---- | -------------- | ---- |
| 1 | `backend/src/api/routes.ts` | Mechanical; the fomo/portfolio sub-routers already prove the pattern | Low |
| 2 | `backend/src/storage/supabase.ts` | Interface-guarded; pure mapper helpers lift out cleanly | Low–Med |
| 3 | `frontend/src/components/Message.tsx` | The markdown/render cluster is self-contained | Low–Med |
| 4 | `frontend/src/stores/appStore.ts` | Enables cleaner component splits; needs Zustand slices | Medium |
| 5 | `frontend/src/components/RoomConfig.tsx` | Shares a keyword editor with #6 | Medium |
| 6 | `frontend/src/components/GlobalSettings.tsx` | Biggest, hardest seam (dirty-check triad) — do last | Med–High |

Do the two easy backend ones first to validate the workflow (branch → PR → CI green
→ merge), then move to the frontend.

---

## 1. `backend/src/api/routes.ts` (1512 → ~150 shell + domain routers)

**Pattern already in the file:** it delegates `/fomo` and `/portfolio` via
`router.use(prefix, createXRouter(wsServer))` (lines 1508–1509). Replicate that for
every group.

**Target structure**
```
backend/src/api/
  routes.ts                 # shell: createRouter(wsServer) → mounts sub-routers only
  shared.ts                 # getUserId, safeError, multer configs, SOUNDS_DIR
  routes/
    auth.ts                 # /auth/* (status, profile, token, tokens/*)  144–323
    telegram.ts             # /auth/telegram/*, /telegram/*              327–566
    history.ts              # /history                                    568–662
    discord.ts              # /guilds, /dm-channels, /reactions/*         664–711
    rooms.ts                # /rooms/*                                    712–767
    config.ts               # /config, /config/export, /config/import    768–1034
    sounds.ts               # /sounds/*, /channel-sounds/*, static mount 1035–1144
    messaging.ts            # /send-message                              1145–1187
    tokens.ts               # /tokens/:chain/:address/snapshot           1188–1218
    alerts.ts               # /alerts/missed-runner/test                 1219–1233
    contracts.ts            # /contracts/* incl. rick/dex-enrich         1234–1463
    pushover.ts             # /pushover/signal-convergence               1464–1507
```

**Extraction rules**
- Each sub-router is `export function createXRouter(wsServer): Router`, mirroring
  `createFomoRouter`. Handlers that don't need `wsServer` can omit the param.
- Move `getUserId`, `safeError`, `SOUNDS_DIR`, and the multer instances (`upload`,
  `channelSoundUpload`, `memoryUpload`, `messageUpload`) into `api/shared.ts` — they're
  used across sounds + messaging + config.
- `contracts.ts` is the heaviest: it pulls in `rickEmbedParser`, `enrichmentMerge`,
  `tokenSnapshot`. Those imports move with it — fine, they belong together.

**Public surface:** `createRouter(wsServer)` stays exactly as `index.ts:22/649` expects.
Zero changes outside `api/`.

---

## 2. `backend/src/storage/supabase.ts` (1045 → mappers + per-entity repos)

`SupabaseStorageProvider implements StorageProvider` — the interface is the safety net.

**Target structure**
```
backend/src/storage/supabase/
  index.ts        # SupabaseStorageProvider — composes repos, keeps the class surface
  client.ts       # createServiceClient, throwIfError, the getCached/setCache/invalidate cache layer
  mappers.ts      # DEFAULT_SETTINGS + all row↔app mappers (105–156)
  configRepo.ts   # getConfig/updateConfig                       284–399
  tokensRepo.ts   # getTokens/setTokens                          400–443
  roomsRepo.ts    # rooms + highlight/keyword sync helpers       211–282, 444–669
  contractsRepo.ts# contracts + mapContractRow                   671–933
  telegramRepo.ts # telegram creds/sessions (encrypted)          935–1024
  userCacheRepo.ts# cacheUserName + getter                       1025–1045
```

**Extraction rules**
- Repos take the Supabase client + cache helpers via constructor injection (or extend
  a small `BaseRepo` holding `supabase` + `getCached/setCache/invalidateUser`). The
  10s TTL cache must stay shared — pass one instance to all repos.
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
  content.tsx           # markdown/linkify renderer: the entire 68–444 cluster
  reactions.tsx         # ReactionUserList + ReactionPills          446–563
  TelegramExtras.tsx    # 564–637
  badges.tsx            # DeletedBadge + EditedIndicator             638–678
  avatar.ts             # getAvatarUrl + formatTimestamp             43–66
```

**Extraction rules**
- **Do `content.tsx` first** — lines 68–444 (regexes + `linkifyText`, `applyInlineFormatting`,
  `renderInlineMarkdown`, `renderContent`, `splitByRegex`, `detectAddresses`,
  `renderEmbedDescription`) are a self-contained pure renderer. Export the functions the
  component and embeds call. **Ideal Vitest target** — pin `detectAddresses`/`renderContent`.
- `getAvatarUrl` (named export) has no external importers — safe to move to `avatar.ts`.
- The three render branches (compact / consecutive / full, lines 817–1512) share ~15
  derived values (700–815). Keep them in `Message.tsx` for the first pass; only extract
  each branch into a sub-component once the shared values are grouped into one object you
  can pass as a single prop (avoid threading 15 props).

**Public surface:** default `memo(Message)` + `MessageProps` unchanged for `ChatPane.tsx`.

---

## 4. `frontend/src/stores/appStore.ts` (1361 → Zustand slices)

Use the **Zustand slices pattern**: each slice is a `StateCreator<AppState, [], [], SliceShape>`
over the shared store, combined in one `create<AppState>()`. Same store object, same
selectors — consumers (~30 files) don't change.

**Target structure**
```
frontend/src/stores/
  appStore.ts        # create<AppState>()((...a) => ({ ...authSlice(...a), ...roomsSlice(...a), ... }))
  slices/
    authSlice.ts        # authStatus/authLoading/maskedTokens + token actions
    roomsSlice.ts       # rooms/activeRoomId + room CRUD
    layoutSlice.ts      # panes/locks/popouts/grid + persistLayout   (+ pane persistence helpers)
    messagesSlice.ts    # messages/unreadCounts + add/update/delete/history
    alertsSlice.ts      # alerts/notificationHistory + notification helpers
    contractsSlice.ts   # contracts/addressChains + CRUD/enrich       (+ contractKey/merge helpers)
    configSlice.ts      # config/config-modal + fetch/update/import
    sourcesSlice.ts     # guilds/dmChannels/telegramChats + fetch, hide/unhide, telegram auth
    fomoSlice.ts        # fomoTrades + add/clear, gateway/preview flags
  appStore.helpers.ts   # IS_POPOUT + localStorage persistence helpers (notifications, panes, layout)
```

**Extraction rules**
- Keep the single `AppState` interface (compose it from per-slice interfaces:
  `type AppState = AuthSlice & RoomsSlice & …`). Every existing selector key must survive.
- **Cross-slice actions are the risk.** `addMessage` touches unread + alerts; `setActiveRoom`
  touches panes; `importSettings` touches config + rooms. In the slices pattern every slice
  receives the same `get`/`set`, so a slice can call `get().otherSliceAction()` — no circular
  imports. Verify each cross-slice call still resolves after splitting.
- `createDemoOverrides` (wraps the whole store at ~286) stays in `appStore.ts` around the
  composed object.
- Move the `MAX_*` caps + pure helpers (`contractKey`, `mergeContractLists`,
  `deriveAddressChains`, notification/pane persistence) into `appStore.helpers.ts`.

**Public surface:** `useAppStore` + `IS_POPOUT` unchanged. This is the highest-value
refactor because it unlocks cleaner component work.

---

## 5. `frontend/src/components/RoomConfig.tsx` (1034 → modal shell + tab components)

**Target structure**
```
frontend/src/components/room-config/
  RoomConfig.tsx        # modal shell, tab bar, hydration effects, handleSave (owns state)
  ChannelsTab.tsx       # discord + telegram sub-tabs (platformTab)   257–683
  UsersTab.tsx          # highlighted users, highlight mode, colors    684–792
  FilterTab.tsx         # filtered users                              793–870
  KeywordsTab.tsx       # room keyword patterns                       871–1010
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
    TokensSection.tsx       # 610–810      GeneralSection.tsx     # 811–996
    ContractsSection.tsx    # 997–1164     SoundsSection.tsx      # 1165–1689
    PushoverSection.tsx     # 1690–2157    KeywordsSection.tsx    # 2158–2268 (uses shared KeywordEditor)
    MentionsSection.tsx     # 2269–2302    UsersSection.tsx       # 2303–2360
    HelpSection.tsx         # 2361–2659    GuildsSection.tsx      # 2660–2899
```

**Extraction rules — the critical part**
- The hard seam is the **three-way lock**: the hydration effect (169–230), the
  `hasUnsavedChanges` memo (232–306), and `handleSave` (325–380) all read/write the entire
  ~90-field state cluster. **Extract these into a `useSettingsForm()` hook first**, before
  touching any section. The hook owns all the state + the dirty-check + save + nav guard,
  and returns `{ values, setters, hasUnsavedChanges, save }`.
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
- [ ] No new logic — moves only; any bug found is filed in `IDEAS.md`
- [ ] Diff is one god file, reviewable in a sitting
