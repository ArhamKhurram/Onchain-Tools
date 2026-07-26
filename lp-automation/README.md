# lp-automation

Autonomous Uniswap V3 LP position manager for **Robinhood Chain** (id `4663`).

Design doc: [`../LP_AUTOMATION_PLAN.md`](../LP_AUTOMATION_PLAN.md). Read §4 (the
trust boundary) before touching anything in `contracts/` or `signer/`.

> **This process signs transactions over real funds.** It is a separate workspace
> and a separate deployed process from `backend/` on purpose: the backend handles
> arbitrary Discord/Telegram input and public HTTP traffic, and a bug in unrelated
> ingestion code must not be able to reach a signing key. It has **no inbound
> network surface** — outbound calls only. Do not add an HTTP listener to it.

## Deployed — Robinhood Chain mainnet (chain 4663)

Live as of 2026-07-26. All public addresses.

| | Address |
| --- | --- |
| Safe (holds the capital) | `0x2461B1CF2686c3D24E1492219E447C10Fe762C64` |
| `OctAutomationModule` | `0x1f754BC2fF3Bd1b125aC31Ee7261554D0486A7FA` (deploy block `19635827`) |
| Operator hot key | `0xf56f73d983027242de8398d74887D3a57F872d86` |
| Safe owner | `0x1748e99e5514C0DAa5974eF8B48D4fFcA50bbC19` (threshold 1 of 1) |

Caps: `maxValuePerTx` 0.01 ETH · `dailyValueCap` 0.03 ETH (native value only).

Audit the whole setup at any time — read-only, sends nothing:

```bash
npx tsx scripts/verifySetup.ts --rpc-url https://rpc.mainnet.chain.robinhood.com \
  --from-block 19635827 --expect-max-value-eth 0.01 --expect-daily-cap-eth 0.03
```

**Use the public RPC for that command.** Alchemy's free tier caps `eth_getLogs`
at a 10-block range, which silently disables the "is anything allowlisted that
shouldn't be" check — the one that would catch a tampered setup. The script
reports that failure rather than passing, but you still want it running.

For the same reason `LP_RPC_URL` points at the public endpoint and only
`LP_RPC_WS_URL` uses Alchemy: in degraded/polling mode the watcher polls
`eth_getLogs`, which at 0.1s blocks lands exactly on that 10-block limit.

### Kill switch

One owner-signed transaction removes the module entirely. It runs through
Safe's own audited code, so it works even if `OctAutomationModule` is buggy:

```
to     0x2461b1cf2686c3d24e1492219e447c10fe762c64
value  0
data   0xe009cfde00000000000000000000000000000000000000000000000000000000000000010000000000000000000000001f754bc2ff3bd1b125ac31ee7261554d0486a7fa
```

(`prevModule` is the sentinel `0x…01`, correct only while this is the *first*
module on the Safe. If others are added, read the real predecessor from
`getModulesPaginated`. Signing the wrong one reverts — a nuisance, not a hazard.)

Faster, softer option: an owner-signed `setPaused(true)` on the module halts all
operator execution without dismantling anything.

## Opening positions — read this first

**The automation manages positions; it does not open them.** `enter` is
deliberately not wired: `evaluateSwitch` needs an impermanent-loss estimate and
there is no IL model yet (plan §11 item 8), so wiring it would mean inventing a
number nobody chose.

So you open the first position yourself — but **it must be owned by the Safe,
not by your Rabby wallet.** The module executes calls *from the Safe*, so a
position held by any other address is invisible and unmanageable to this system.

To do that, connect Krystal (or the Uniswap UI) to your **Safe**, not to Rabby:
Safe UI → **Apps** → **WalletConnect** → paste the dApp's pairing URI. Every
transaction then executes as the Safe and you approve it with your owner key.

Once a Safe-owned position exists and its pool is on the policy allowlist, the
automation takes over compounding and rebalancing.

## Status

Phase 1 is complete and deployed. The runtime is live and **disarmed**.

| Module | What it does | Tests |
| --- | --- | --- |
| `src/policy/` | Policy schema, validation, versioning, pool allowlist | 78 |
| `src/rules/` | Efficiency scoring, compound/rebalance triggers, switching buffer | 71 |
| `src/ingest/krystal/` | Pool discovery + position state via Krystal's public API | 77 (shared file) |
| `src/calldata/` | Krystal `lp-txn` wrapper, response validation, dry-run seam | ↑ |
| `src/ingest/rpc/` | WebSocket pool watcher, tick math, reorg confirmation, staleness | 65 |
| `src/audit/` | Append-only action log | 18 |
| `contracts/` | `OctAutomationModule` — the on-chain trust boundary | 40 (Foundry) |

```bash
npm run typecheck -w lp-automation
npm run test -w lp-automation
```

The Solidity is **not** covered by those commands. It builds and tests under
Foundry, which runs in CI (`.github/workflows/ci.yml`, job `contracts`). To run it
locally you need Foundry installed:

```bash
cd lp-automation/contracts && forge test -vvv
```

## The two hard seams

Two boundaries in here are load-bearing. Both are easy to erase by accident.

**1. Krystal builds calldata; it never signs.** Nothing under `src/calldata/` may
hold a key, construct a signer, or broadcast. `PreparedTransaction` is frozen,
inert data. Krystal's response is treated as **untrusted third-party input** and
validated (destination allowlist, `from` must equal the Safe, hex well-formedness,
value bounds) before it can reach a signer. That validation is a security control,
not a formality.

**2. `currentTick` comes from RPC, never from Krystal.** Krystal exposes no tick
data. Range *bounds* are exactly recoverable from its prices; the *current* tick is
not — deriving it from `pool.price` was measured off by up to 66 ticks against
`slot0()`. Since that is precisely the range-exit trigger, positions without an
RPC-supplied `currentTick` are skipped rather than backfilled. See plan §3.

## Configuration

Copy `.env.example` to `.env`. Two values deserve care:

- `LP_OPERATOR_PRIVATE_KEY` — the automation hot key. **Must be freshly
  generated.** The module confines what it can do, but treat its compromise as
  "lose up to the daily cap" and size the cap accordingly.
- `LP_RPC_WS_URL` — without a WebSocket endpoint the watcher degrades to polling
  and reports `lowLatency: false`. It says so loudly rather than silently claiming
  sub-second reaction it can't deliver.

The **policy** is not configured here. It is authored in the OCT dashboard and
only ever *read* by this process (plan §9 point 1). `DEFAULT_POLICY` ships with an
empty `allowedPools`, so a fresh install can do nothing until a human explicitly
ticks a pool — a pool-discovery bug fails to "does nothing" rather than "entered a
pool nobody approved".

## Where the real risk is

Read `contracts/README.md` for the full compromise analysis. The short version, so
nobody is surprised later:

- The module's spend caps bound **native value only**. ERC-20 amounts live inside
  calldata and are not capped on-chain. The destination + selector allowlist does
  most of the real work for token value.
- The daily cap is a **fixed UTC-day bucket**, not a sliding window — up to 2× the
  cap can leave in one burst straddling midnight UTC. Deliberate gas tradeoff,
  with a test asserting the behaviour so it isn't "fixed" silently.
- An allowlisted selector can still be called with hostile argument values
  (slippage, recipient, deadline). Off-chain validation narrows this; it does not
  close it.
