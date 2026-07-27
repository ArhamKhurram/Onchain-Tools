# LP Dashboard — UX + Auto-Farming + PnL Plan

Scope for the next pass on the LP automation dashboard. Four independent work
items, all on the `dev`-side feature branch (`feat/lp-positions-view`), none of
which touch the signer's authority or the on-chain module. Read alongside
`LP_AUTOMATION_PLAN.md` (§3 indicative-vs-authoritative, §5 policy versioning,
§9 the dashboard/worker seam). Nothing here arms the worker or broadcasts.

Status legend: ☐ not started · ◐ in progress · ☑ done.

---

## 0. The one thing to internalize before touching "auto"

The worker **already farms autonomously**. This is the single most important
fact for items 3 and 4, and it changes what those items actually are.

- **Auto-rebalance already happens.** `lp-automation/src/lifecycle/loop.ts` runs
  a fast RPC watcher (`ingest/rpc/poolWatcher.ts`) that fires on a *confirmed*
  range crossing and funnels straight into `act()` → `rebalance`. Measured
  latency on the live position was **~10.5s request→mined**. It is **not**
  Krystal-driven — Krystal is the slow lane (60s poll) and only drives
  `compound`. So "rebalance from our side, not Krystal, because Krystal is slow"
  is **already the design** — the watcher path is ours and sub-second to detect.
- **Auto-compound already happens.** The slow poll (`runPositionTick` →
  `evaluateCompound`) fires `shouldCompound` every 60s.
- **What gates both:** whether the position's pool is in the *saved* policy's
  `allowedPools` (`positions.ts` → `positionCoverage`). "Managed" in the UI ==
  pool allowlisted == both auto-compound AND auto-rebalance are live for it.

**Therefore item 3 is not "build auto-rebalancing." It is (a) surface the
already-running engine as an explicit, legible per-position switch, and
(b) let compound and rebalance be turned on independently** (today they are
welded together by a single allowlist bit). No new signing path, no new
broadcast surface — the guard ladder, lock, dry-run and audit funnel in
`act()` stay exactly as they are.

---

## 1. Positions UI — lineage grouping + collapsible closed ☑

**Problem.** The panel renders one tile per position, flat. A rebalance mints a
*new* tokenId and closes the old one, so a single farm shows up as
`#414457 (open)` + `#401152 (closed)` + `#398701 (closed)` — three WETH/PONS
tiles for what is, to the operator, *one position that has been rebalanced
twice*. On a chain where every farm accumulates closed ancestors, the grid fills
with tombstones and the live position gets lost among them.

**Proposed solution.**
- Group tiles by **lineage**, not tokenId. A lineage = same pool + same Safe,
  ordered by open time. The open (or most recent) position is the visible head;
  its closed ancestors collapse into a `⌄ 2 earlier positions` disclosure on the
  tile, expandable in the detail drawer.
- Grid shows **one tile per live farm**. Closed-only lineages (fully exited)
  drop below a `Closed farms` divider, collapsed by default.
- The lineage is the natural home for item 4's PnL number (cost basis follows
  the lineage, not the tokenId).

**Files.**
- `frontend/src/components/lp/positions.ts` — add `buildLineages(positions)`:
  group by `poolAddress` (+ Safe once multi-Safe exists), sort by open time,
  designate head. New `LpPositionLineage` type. Keep `buildPositionGrid` for the
  flat view or refactor it to emit lineage heads.
- `frontend/src/components/lp/LpPositionsPanel.tsx` — render lineage heads;
  `Closed farms` collapsible section.
- `frontend/src/components/lp/LpPositionTile.tsx` — "N earlier positions" affordance.
- `frontend/src/components/lp/LpPositionDetail.tsx` — ancestor list in the drawer.
- New unit tests in `frontend/src/components/lp/positions.test.ts` for
  `buildLineages` (single open, open+ancestors, fully-closed, multi-pool).

**Decision needed.** Lineage linking key. Options, cheapest first:
1. **Pool + Safe + time order** (no on-chain lineage proof). Simple, works today,
   but two *unrelated* positions in the same pool would merge. Given one farm per
   pool today, acceptable short-term.
2. **Track the mint→burn lineage explicitly** — the worker knows `oldTokenId →
   newTokenId` at rebalance time; persist it (ties into item 4's ledger). Correct,
   slightly more work. Recommended once item 4 lands.

Start with (1) for the visual, upgrade to (2) when the PnL ledger exists.

---

## 2. Chrome slim-down — move Safe address out, readability pass ☑

**Problem (operator's words).** "The safe address thing is taking up like
majority of the space… should be in Sensitive tab or something. All this text is
really hard to read."

- `LpSafeAddressField` is rendered inline at the top of `LpPositionsPanel`
  (input + Save + a 3-line help paragraph) — a one-time setup control eating the
  top third of the daily-use view.
- The panel is prose-dense: stacked `text-[10px]`/`text-[11px]` mono lines in
  `text-oct-muted`, multiple explanatory paragraphs, low contrast.

**Proposed solution.**
- **New `Settings` tab** (`LpTabId` gains `'settings'`, `LpTabs.tsx` +
  `LpAutomationPage.tsx`). Move `LpSafeAddressField` there. It reads what the page
  looks at; it is not a per-glance control. (Naming: "Settings" over "Sensitive"
  — the Safe address is public on-chain, not a secret; nothing sensitive is
  entered in the browser. Confirm the label with the operator.)
- **Positions tab keeps a one-line context strip**, not the full field:
  `Reading 0x2461…2c64 · change in Settings`.
- **Readability pass** on `LpPositionsPanel`:
  - Promote the numbers that matter (value, unclaimed, PnL once it exists) to a
    larger, higher-contrast face; demote prose to `oct-muted`.
  - Collapse the multi-paragraph coverage explainer into one headline + an `(i)`
    tooltip. Keep the *consequence* sentence ("$X is not being managed"), move the
    *mechanism* prose (why a pool never appeared in the picker) behind the tooltip.
  - Fold the bottom "indicative values" disclaimer into a single `(i)` next to the
    "Last read" timestamp rather than a full-width footer paragraph.
  - Audit contrast against the prod red theme tokens (the theme fix from earlier
    — verify `oct-muted` on `oct-surface-raised` clears WCAG AA at these sizes).

**Files.** `LpTabs.tsx`, `LpAutomationPage.tsx`, `LpPositionsPanel.tsx`,
`LpSafeAddressField.tsx` (unchanged internally, just relocated), `styles.ts`
(any shared class tweaks).

**No backend change.** Pure presentation + tab placement.

---

## 3. Explicit auto-compound / auto-rebalance switches ☑

**Problem.** "An 'enable auto rebalancing' button which just uses the current
rebalance button to simply rebalance every time the position goes out of range…
automated from our side, not Krystal. Same for compounding."

As §0 explains, the *engine* is already this. Two real gaps remain:

1. **Legibility.** There is no switch that reads "auto-rebalance: on". The only
   control is the pool coverage toggle, whose label is about the *allowlist*, not
   about "this position will be auto-rebalanced." The operator can't tell the
   autonomous behavior is already running.
2. **Granularity.** Coverage is one bit → compound and rebalance are all-or-
   nothing together. There is no way to say "auto-compound this, but I'll
   rebalance it by hand," or vice-versa.

**Proposed solution — two per-behavior flags on the policy, surfaced as switches.**

- **Data model.** Add `auto_compound boolean` and `auto_rebalance boolean` to
  `lp_automation_policies` (new migration, **dev Supabase only**). Default both
  `true` so existing managed positions keep behaving identically. Thread through
  `supabasePolicySource.ts` (`rowToPolicy`), `types.ts`
  (`compoundTrigger.enabled` / `rebalanceTrigger.enabled`), and
  `backend/src/api/routes/lp.ts` policy read/write + validators.
- **Enforcement (worker).** Cheapest correct place is the rule/evaluation layer:
  - `evaluateCompound` returns early (records an `action:'none'`,
    `rule:'policy.auto_compound_off'` evaluation) when `!compoundTrigger.enabled`.
  - `onConfirmedCrossing` / `prepareRebalance` short-circuit to a recorded refusal
    when `!rebalanceTrigger.enabled`. **Manual** rebalance/compound via the command
    queue must still work regardless of the flags — the flags govern *autonomous*
    firing only. (`runCommand` path is untouched; only the watcher/poll paths
    check the flag.)
- **UI.** In `LpPositionDetail` (and a compact indicator on the tile): two toggles
  — `Auto-compound` and `Auto-rebalance` — plus the existing manual
  Compound/Rebalance/Exit buttons. A toggle writes into the same policy draft +
  Save cycle the allowlist uses (one draft, one Save, one meaning of "unsaved" —
  the invariant `positions.ts` already documents). Show the current
  `rangeStrategy` (narrow/wide/full) next to Auto-rebalance since that decides
  where it re-centers.

**Granularity decision needed.** Policy today is **global** (one active version
governs all positions unless pinned). Three ways to scope the flags:
- **(A) Global flags** — "auto-rebalance everything / nothing." Simplest, matches
  today's one-farm reality. One migration, no per-position storage.
- **(B) Per-pool flags** — natural fit with the allowlist (which is per-pool).
  Requires the flags to become per-pool structures, not scalars.
- **(C) Per-position (per-tokenId) flags** — most control, but tokenId churns on
  every rebalance, so it needs the lineage key from item 1 to be stable.

**Recommendation: (A) now** (unblocks the operator's ask immediately with one
migration), **design toward (B)** once there's more than one farm. (C) only if
per-position divergence is actually wanted — it's the most storage and the most
UI. Confirm before building.

**Files.** migration (dev), `types.ts`, `supabasePolicySource.ts`, `policy/
validate.ts` + `defaults.ts`, `lifecycle/loop.ts` (the two short-circuits),
`backend/src/api/routes/lp.ts`, `LpPositionDetail.tsx`, `LpPositionActions.tsx`,
`LpPolicyEditor.tsx`, tests in `lp-automation/test/` + `backend/test/lpPolicy.test.ts`.

**Note on "in literal seconds."** The detection→broadcast path is already
~10.5s and dominated by the Krystal calldata round-trip, not our polling. If the
operator wants it materially faster, that's a *separate* item: pre-build/refresh
warm calldata more aggressively, or bypass Krystal for the withdraw+mint calldata
on the hot path. Out of scope here; note it and move on.

---

## 4. PnL that survives rebalances ☑

**Problem (operator's words).** "After rebalancing it kinda just clears all
stats so it's hard to see the PnLs from these LP farms. I need that."

**Why it's broken today.**
- Krystal resets `initialUnderlying`/`pnl` on every rebalance (new tokenId, fresh
  cost basis) — its numbers are per-tokenId, not per-farm.
- Our audit log **does not record position value** on autonomous actions. The
  manual path (`manualDecision` in `loop.ts`) *does* put `valueUsd` in the
  snapshot, but the rule-driven `shouldCompound`/`shouldRebalance` decisions may
  not — and nothing records value at a *steady* cadence. So lifetime PnL can't be
  reconstructed from the log.
- The audit snapshot has `unclaimedFeesUsd` and `openedAt` but no realized-fee or
  value history keyed to a farm.

**Proposed solution — a lineage-keyed PnL ledger.**
1. **Record value + gas at every action.** Ensure every `Decision.snapshot` that
   reaches `act()` carries `valueUsd`, `unclaimedFeesUsd`, and — post-broadcast —
   the gas actually spent (from the receipt in `ActionExecutor`). This is additive
   to the existing audit entries; no schema break.
2. **Record the mint→burn lineage link** at rebalance: `oldTokenId → newTokenId`,
   the withdrawn amounts, and the re-minted amounts. This is the authoritative
   lineage key item 1 wants, and the join that lets PnL span tokenIds.
3. **Derive lifetime PnL per lineage:** `current value + Σ realized fees
   (compounded + withdrawn) − initial deposit − Σ gas`. Gas is a real cost even
   though it's paid from the operator wallet, not the position — show it as a line
   item (on the live $56 farm it was **$2.18 over 29 txs**, nearly the entire
   gross gain; on a tiny position the automation can run to stand still, and the
   operator should *see* that).
4. **Surface it** on the lineage head tile + detail drawer: Cost basis · Current
   value · Lifetime fees · Gas paid · **Net PnL** (abs + %).

**Storage decision needed.**
- **(A) Derive from the audit log** (append value+gas+lineage, compute in the
  backend `GET /api/lp/positions` or a new `/api/lp/pnl`). No new table; the log
  is already the source of truth and survives restarts. **Recommended.**
- **(B) A dedicated `lp_position_ledger` table.** Cleaner queries, but a second
  source of truth to keep consistent with the log. Only if (A)'s queries get ugly.

**Caveat to state in the UI.** Farms opened *before* this ships have no recorded
initial value — their cost basis is unknown and PnL starts from first-observed.
Label those "since <date>" rather than inventing a basis. The live farm's true
initial (~$56) predates this and will read as approximate.

**Files.** `lp-automation/src/audit/log.ts` (snapshot fields), `lifecycle/
executor.ts` (gas from receipt), `lifecycle/loop.ts` (lineage link on rebalance),
`backend/src/api/routes/lp.ts` (PnL derivation endpoint), `positions.ts` +
`LpPositionDetail.tsx`/`LpPositionTile.tsx` (display), tests.

---

## Sequencing

1. **Item 2 (chrome + readability)** — pure frontend, zero risk, immediate relief.
2. **Item 1 (lineage grouping, key option 1)** — frontend only, declutters the grid.
3. **Item 3 (auto switches, scope A)** — one dev migration + worker short-circuits
   + UI. Unblocks the explicit ask.
4. **Item 4 (PnL ledger)** — the deepest change; also upgrades item 1 to lineage
   key option 2. Do last, when the audit-snapshot changes can be verified on fork.

Items 1–3 are shippable to `dev` independently. Item 4 wants a fork-test pass
(`npm run forktest:rebalance`) to confirm the new snapshot fields and lineage
link are written correctly through a real rebalance before it's trusted.

## Guardrails (unchanged, restated)

- **`dev` branch only** until the operator says prod. No push to `main`.
- **Migrations apply to dev Supabase (`zcvubfadvdwjxgodznxh`) only.** Prod
  (`vmlxyqzjdaegkfylxfka`) is untouched until explicitly instructed.
- **No arming, no broadcast** from this work. Nothing here reaches `signer.submit`
  outside the existing `act()` funnel; the auto flags only *gate* the autonomous
  triggers, they don't add a path to the signer.
- `npm run typecheck` + `npm run test` green before each item is called done;
  item 4 additionally wants a fork-test.

## 5. Add liquidity / Zap In ☑ (code complete; live armed run pending module selector)

**Goal (operator's words).** "Add liquidity through OCT, not Krystal/Uniswap
directly." Open a *new* LP position from the dashboard, same queue→worker→module
path as compound/rebalance. No browser wallet signing.

**What already exists.** `buildSwapAndMint` (`swap_and_mint`) and
`buildSwapAndIncrease` (`swap_and_increase`) in `calldata/lpTxn.ts`;
`ExecutableAction` already includes `'enter'`; the executor funnel
(guards→dry-run→intent→submit→outcome) is ready. The gap is the *queue shape*
(enter has no tokenId), the *tick computation* (from live pool tick), a
`CalldataBuilder.enter` adapter, and the whole UI.

**Locked design decisions** (operator delegated — "u decide"):
1. **Queue shape — extend `lp_automation_commands`, don't add a table.** One
   queue, one worker poll, appears in History for free. `token_id` becomes
   nullable; add `token_in_address`, `amount_in` (base-units string),
   `range_strategy`, `swap_slippage`. Action `'enter'`. A table-level CHECK
   enforces two mutually-exclusive shapes (existing-position action vs enter) so a
   malformed enter cannot be inserted.
2. **Range — reuse `rangeStrategy`** (narrow/wide/full), default from policy,
   per-enter override. **Ticks computed in the worker at execution time from the
   pool's live on-chain tick** (`slot0`), never from a cached price — same rule as
   rebalance (§3, and `ingest/krystal/positions.ts`).
3. **Token in — ERC-20 (incl. WETH) only for v1.** Native-ETH zap deferred
   (`maxValueWei` anticipates it, but routing native `value` through the module is
   a separate careful step). tokenIn must be one of the pool's two tokens.

**Known live-execution dependency (flag, don't fix here).** Executing an armed
enter also needs the on-chain Module's selector allowlist to permit Krystal's
`swap_and_mint` selector. If it only allows the compound/rebalance selectors, an
enter will build + dry-run + queue but the module rejects the broadcast. Adding
the selector is a Safe-owner on-chain step, out of scope for this code change.

### Shared contract (the seam all three layers build against)

**DB migration (dev only, extend `lp_automation_commands`):**
- action CHECK += `'enter'`.
- `token_id` → drop NOT NULL (numeric CHECK still passes on null).
- add `token_in_address text` (addr regex when non-null), `amount_in text`
  (`^[1-9][0-9]*$` when non-null), `range_strategy text` (in narrow/wide/full),
  `swap_slippage numeric` (>0 and ≤0.05).
- shape CHECK: `action='enter'` ⇒ token_id null AND enter params non-null;
  `action<>'enter'` ⇒ token_id non-null AND all enter params null.

**Backend `POST /api/lp/enter`** (mirror `POST /positions/:tokenId/actions`):
- body `{ poolAddress, tokenInAddress, amountIn (base-units string),
  rangeStrategy?, swapSlippage? }`.
- validate: pool on the **saved** allowlist (409 like manual compound), addresses
  well-formed, `amountIn` positive-integer string, rangeStrategy in set,
  slippage ≤ 0.05. Insert `action='enter', token_id=null, …`. Return the created
  command view (same shape the History list renders).
- frontend converts human amount → base units using the token's decimals; backend
  only validates the integer string (no on-chain decimals lookup).

**Worker:**
- `CalldataBuilder.enter(request)` in `lifecycle/types.ts` + implemented in the
  Krystal adapter → wraps `buildSwapAndMint`.
- `LpCommand`/`rowToCommand` (`commandSource.ts`) gain a nullable `tokenId` and the
  enter fields; the claim loop is unchanged.
- Add an RPC pool-state read `readPoolState(pool) → { currentTick, feeUnits }`
  (`ingest/rpc`), and generalize `recenterRange`'s center-based math into
  `rangeFromCenter(currentTick, feeUnits, strategy)` (drop the "identical to
  current" guard — there is no current range for a new position).
- `loop.runCommand` branches: `action==='enter'` → `runEnter`: resolve policy →
  allowlist-check the pool → read pool state → compute ticks → build enter
  calldata → `executor.execute` with a **synthetic `LpPosition`** (`tokenId` =
  the command id for quarantine attribution, `pool.address/feeTierBps` = target)
  and `action:'enter'`. Reuses the entire guard ladder and LP_ARMED gate.

**Frontend:**
- "Add position" button on the Positions tab → `LpEnterForm` (modal/sub-flow):
  pool select (allowlisted pools only, with "allowlist it first" guard), tokenIn
  select (pool's two tokens), amount (human → base units via decimals), range
  segmented (default policy strategy), slippage (default 0.005, cap 0.05),
  preview/confirm, submit via `useLpEnter`.
- Copy: "This queues a transaction for the automation signer — it does not open a
  Safe pending transaction." After success, refresh `useLpPositions`.

### Build split
- **Migration + worker enter path** — done in-session (signer-adjacent, built by hand).
- **Backend route + validation + tests** — parallel agent.
- **Frontend form + hook + tests** — parallel agent.

### Acceptance
- [x] Queue an enter to an allowlisted pool from OCT without visiting Krystal
      (form → `POST /api/lp/enter` → `lp_automation_commands` row, `action='enter'`).
- [x] Worker claims it, reads the pool's live tick, computes the range, builds
      `swap_and_mint`, and runs the SAME guard→dry-run→intent→submit→outcome
      ladder (a disarmed worker records `skipped_disarmed`; armed run pending the
      module selector below).
- [ ] New position appears in Positions after refresh — needs an armed worker AND
      the module allowing the `swap_and_mint` selector (operator's on-chain step).
- [x] Tests: backend validation (40 in lpCommands), worker enter path + range +
      row mapping (commands/lifecycle), frontend conversion + validation (36 in lpEnter).
- [x] `npm run typecheck` (all workspaces) + full test suite green
      (backend 230 · frontend 247 · lp-automation 637). Not committed.

**Remaining for a LIVE armed enter (operator, on-chain):** add Krystal's
`swap_and_mint` selector to the Module's selector allowlist, then arm. Until then
enter builds, dry-runs, and queues but the module rejects the broadcast — by
design.

---

## 6. Bug: out-of-range position never auto-rebalanced (#418840) ☑

**Symptom.** Position #418840 sat "Out of range" for 20+ min and the autonomous
rebalance never fired.

**Root cause (from the audit log).** Rebalance was **edge-triggered only** — it
was evaluated *solely* on a watcher range-crossing event. #418840 crossed its
upper bound right at the boundary (`currentTick == tickUpper`, computed
`rangeExitPercent: 0` < the 5% threshold), so the one-shot check correctly
declined. But the watcher only emits on a side *change*; once "above" it never
re-fires, and the slow poll evaluated **compound only**. So as price kept
drifting out, nothing re-checked rebalance. Classic edge-vs-level bug.

**Fix.** Added a **level-triggered rebalance backstop to the slow poll**
(`lifecycle/loop.ts` → `evaluateRebalance`, called from `runPositionTick`). It
runs `shouldRebalance` against the position's **authoritative `slot0` tick**
(the feed already injects it — so this does NOT violate plan §3, which forbids
trading on Krystal's cached *price*, not the slot0 tick). The watcher stays the
sub-second fast path for a price that jumps past the threshold in one move; the
poll is the ≤60s catch-up for slow drift and the boundary-crossing gap. Both
funnel through `act()`'s per-position lock, so they can't race. Respects the
`auto_rebalance` flag; records `policy.auto_rebalance_off` for an out-of-range
position when autonomous rebalance is disabled. Tests: 3 added in
`lifecycle.test.ts`; worker suite 640 green.

**Note on the threshold.** Even with the backstop, autonomous rebalance waits
until price is `rangeExitPercent` (currently **5%**) *beyond* the range edge — a
position 0–5% out is intentionally left (not worth the gas/IL for small drift
that may revert in). To move sooner after going out of range, lower
`rangeExitPercent`; trade-off is more rebalances = more gas.

---

## Open decisions for the operator

- **§1** lineage key: start with pool+time (option 1), upgrade to explicit
  mint→burn link (option 2) with item 4? (recommended)
- **§2** tab label: "Settings" vs "Sensitive"? (recommend Settings)
- **§3** auto-flag scope: global (A) / per-pool (B) / per-position (C)?
  (recommend A now, B later)
- **§3** is sub-second rebalance (bypassing Krystal on the hot path) wanted as a
  follow-up, or is ~10s fine?
- **§4** PnL storage: derive from audit log (A) vs dedicated ledger table (B)?
  (recommend A)
