# lp-automation

Autonomous Uniswap V3 LP position manager for **Robinhood Chain** (id `4663`).

Design doc: [`../LP_AUTOMATION_PLAN.md`](../LP_AUTOMATION_PLAN.md). Read §4 (the
trust boundary) before touching anything in `contracts/` or `signer/`.

> **This process signs transactions over real funds.** It is a separate workspace
> and a separate deployed process from `backend/` on purpose: the backend handles
> arbitrary Discord/Telegram input and public HTTP traffic, and a bug in unrelated
> ingestion code must not be able to reach a signing key. It has **no inbound
> network surface** — outbound calls only. Do not add an HTTP listener to it.

## Status

Phase 1 components are built and unit-tested. **Nothing here moves funds yet** —
the signer integration (plan §10 step 5) is not written.

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
