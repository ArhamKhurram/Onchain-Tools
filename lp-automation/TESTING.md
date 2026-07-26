# LP Automation — Tester Brief

You are testing an autonomous Uniswap-V3 LP manager on **Robinhood Chain
(4663)**. It has two processes and one deliberate safety gate — understand these
three things before touching anything.

## The model (read first)

1. **The console** (browser) shows positions and lets you queue actions. It
   **cannot sign anything** — it writes an intent to a database.
2. **The worker** (`lp-automation`, a terminal process) polls those intents and
   executes them on-chain. It holds the only key. It has **no inbound network**
   — you cannot make it do anything except through the queue.
3. **The arm gate** — `LP_ARMED` in `lp-automation/.env`. `false` (default) =
   the worker does everything (validate, build calldata, simulate, audit) and
   **skips only the broadcast**. `true` = it broadcasts real transactions with
   real funds.

**Do your functional testing DISARMED, or on a fork (below). Do NOT arm mainnet
unless the owner explicitly tells you to — that spends real money.**

## Environment (dev)

- Console: `http://localhost:5173/dashboard/lp` (sign in as the dev account)
- Worker: `cd lp-automation && npx tsx src/index.ts` — watch the startup banner
  for `ARM STATE: DISARMED` and `watchedRanges: 1`
- Chain explorer: `https://robinhoodchain.blockscout.com`
- Safe (holds funds): `0x2461B1CF2686c3D24E1492219E447C10Fe762C64`
- Module: `0x1f754BC2fF3Bd1b125aC31Ee7261554D0486A7FA`
- Operator (gas only): `0xf56f73d983027242de8398d74887D3a57F872d86`
- Pool under test: WETH/PONS `0x10cc6bd38112cac182db90b6a71d8bb5939526ba`
  (1% fee, tick spacing 200)

**Always restart the worker after pulling code** — it does not hot-reload.

## What to test

### A. Console / policy (disarmed, no worker needed)
1. **Positions grid + detail** — open the LP tab, click a position tile, confirm
   the detail drawer shows range / value / fees / coverage.
2. **Coverage states** — a position whose pool is NOT allowlisted must clearly
   read as *not managed*; an allowlisted one as *managed*. Tick a pool from the
   position card → it shows *ticked, not saved* until you Save.
3. **Policy tabs** — Positions / Pools / Policy / History. Editing on any tab
   keeps the Save bar visible; the Policy tab shows an alert dot when a field is
   invalid.
4. **Range strategy** — in Policy → Rebalance, switch Narrow / Wide / Full,
   Save, confirm a new version appears in History. Narrow is the default.
5. **Safe address setting** — clearing/entering it changes whether positions
   load.

### B. Actions (worker running, DISARMED)
For each of **Compound**, **Rebalance**, **Exit**, click the button and watch
both the console lifecycle strip and the worker log:

| Action | Expected result (disarmed) |
| --- | --- |
| Compound | `queued → running → skipped`. Log: `outcome: skipped_disarmed`. Console shows "Nothing was broadcast." |
| Rebalance | Same skipped flow. Worker log should show an **aligned** target range (both ticks multiples of 200). |
| Exit | **Refuses** with a message about a missing `targetToken` — see "not a bug" below. |

Pickup should be **~1 second**, not 5.

### C. Broadcast path (a FORK — real execution, zero real funds)
This is how you verify actions actually execute without spending anything. Ask
the owner to run / share the fork harness (`scripts/` fork tests). Against a
local anvil fork it broadcasts a real signed tx through operator → module →
Safe and you inspect the on-chain result:
- **Compound** → `Collect` + `IncreaseLiquidity` events, `tokensOwed` → 0.
- **Rebalance** → old NFT liquidity → 0, a **new** NFT minted at the narrow band
  (ticks aligned to 200).

### D. Armed testing (REAL funds — owner decision, read every line)

Only do this if the **owner** has explicitly authorised it. Armed = the worker
broadcasts real transactions moving real value. Before you start:

- **The operator private key must be on the machine running the worker.** If
  that is not the owner's own machine, the owner is handing a signing key to a
  third party — that is a deliberate decision, not a testing convenience. Prefer
  testing on the owner's machine, or with a key funded with only throwaway
  capital.
- On-chain caps limit the damage: **0.01 native/tx, 0.03/day**. The Safe holds
  only the test position (~$56). Size any additional funding as "willing to
  lose."
- Each armed action costs gas (~$0.05); each **rebalance** also pays a swap to
  re-balance token ratios, so the position value drops slightly every time — a
  normal cost, not a bug.

Steps:
1. Set `LP_ARMED=true` in `lp-automation/.env`, restart the worker, confirm the
   banner reads **`ARM STATE: ARMED`** (in red).
2. **Compound first** — cheapest, most reversible. Expect a real tx hash;
   verify `Collect` + `IncreaseLiquidity` on the explorer and `tokensOwed → 0`.
3. **Rebalance** — expect the old position emptied and a **new tokenId** minted
   at the narrow band (ticks multiples of 200). Verify on the explorer.
4. **Exit** — will still refuse (see "not a bug"); nothing to broadcast.
5. When done, set `LP_ARMED=false` and restart, so nothing keeps acting.

Report the tx hash for every armed action so it can be checked on-chain.

## NOT bugs — do not file these

- **Disarmed shows "skipped."** That is the arm gate working. Only report it if
  it says `done` while disarmed (that would be a bug).
- **Exit refuses.** Known gap: Krystal's withdraw needs a `targetToken` (which
  asset to exit into) and the policy has no field for it yet. It queues and then
  honestly reports why it can't run.
- **Rebalance changes the tokenId.** Withdraw-and-remint mints a new NFT. The
  allowlist keys on the pool, not the id, so coverage carries over.
- **A compound right after a compound may 400 and self-heal.** Krystal's cached
  fee number lags; the calldata builder sees fresh state and declines. Refused
  safely, no double-compound.
- **The console's numbers lag / differ slightly from Krystal or the chain.**
  This data is display-grade (cached, up to ~66 ticks off). The worker never
  trades on it — it reads the chain directly. On-chain is truth.
- **The PnL chart is empty.** Krystal returns no history series for this chain
  yet; the empty state is intentional.

## How to verify on-chain

Any real tx hash → `https://robinhoodchain.blockscout.com/tx/<hash>`. For a
compound, confirm `Collect` + `IncreaseLiquidity`. For a rebalance, confirm the
old position emptied and a new one minted with **spacing-aligned** ticks
(multiples of 200).

## What to report

For each failure: the action, armed/disarmed, the console lifecycle state, the
**worker log line** (it carries the real reason), and the tx hash if one exists.
A red "FAILED" whose worker error begins `skipped_` is expected disarmed
behaviour, not a failure.
