# LP Automation — open items

Status as of the current session. Nothing here was formally tracked before this
file — it was scattered across chat and two background-task chips.

## 0. Not merged yet (the big one)

All the recent LP work — positions view, command queue, range strategy, poll
fix, tabs — lives on branch **`feat/lp-positions-view`**, 5 commits, **no PR
opened, not on `main`, CI has not run on it**. It works locally against dev, but
it is not shipped. Open a PR and merge before anything else is considered done.

## 1. Blocks "trust it unattended"

- [ ] **Exit doesn't execute.** Krystal's `withdraw_and_swap` needs a
      `targetToken` (which asset to exit into); the policy has no field for it,
      so exit queues then refuses. Needs: a `exitToken` policy field + UI +
      validation + wiring. This is why the tester will see Exit refuse.
- [ ] **Deploy the worker to Railway** (`ponslive-worker`). Today it only runs
      on a laptop. Requires: a persistent volume for `data/audit.jsonl` (the
      startup quarantine reads it to detect in-flight txs — ephemeral storage
      loses that), and a **single-worker guard** (see below).
- [ ] **Two-worker hazard.** The per-position lock is in-memory, so it does not
      span processes. Two live workers could both rebalance the same position.
      The manual command queue is safe (atomic claim); the autonomous path is
      not. Add a singleton/health guard before running laptop + Railway.
- [ ] **Apply migrations to PROD.** Only **dev** has them. Prod
      (`vmlxyqzjdaegkfylxfka`) needs: policies, settings, commands, and
      range_strategy migrations. The live dashboard needs these to work.

## 2. Correctness / polish

- [ ] **Commit the fork-test harness.** `forkCompound` / `forkRebalance` exist
      only in scratchpad. Commit as `npm run forktest:*` so anyone can verify
      the broadcast path without real funds (see §"Fork scripts" in chat).
- [ ] **Stale-fee eagerness.** The compound decision reads Krystal's cached fee
      number; execution sees fresh chain state. Right after a compound this
      causes a redundant attempt that 400s and self-heals — harmless, but noisy.
      Consider gating the decision on an on-chain fee read.
- [ ] **`maxIlRiskScore` is accepted but unenforced** — no IL model exists.
      Either build a model or hide the field until one does.
- [ ] **`enter` / switching-buffer not wired** — both need the IL model. The
      automation manages positions; it does not open them. Opening is manual.
- [ ] **PnL chart is empty** — Krystal returns no history for chain 4663. Slot
      renders an honest empty state; revisit if/when they index it.

## 3. Security / ops

- [ ] **1-of-1 Safe threshold.** Fine at $56; add a hardware co-signer as a
      second owner before scaling. Protects against your own key being lost or
      stolen, not against the operator (which isn't an owner).
- [ ] **Rotate exposed secrets** — the Discord bot token and the Alchemy key
      were pasted into chat earlier this session. Low-stakes and rotatable, but
      do it.

## 4. Repo hygiene (background tasks, may already be running)

- [ ] **ESLint + `react-hooks/rules-of-hooks`** — the repo has none. A hook
      after an early return blanked the LP page with no console error this
      session; this rule catches that class at build time. (Task chip started.)
- [ ] **Tailwind opacity modifiers on `oct-*`** generated no CSS — ~106 usages
      across existing pages fell back to defaults. (Task chip started; fixed for
      the dev server already, needs the PR.)
