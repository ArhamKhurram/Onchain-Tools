# `OctAutomationModule` — the on-chain trust boundary

Solidity for the LP automation system's signer layer (`LP_AUTOMATION_PLAN.md` §4).
This is the component that decides, **on-chain**, what the automation hot key is
allowed to do with real money. Everything off-chain — the rule evaluator, the
Krystal calldata builder, the dry-run layer — is a convenience. This contract is
the part that still holds if all of that is compromised.

> **Status: unaudited, never deployed.** Written to be reviewed line by line
> before it touches mainnet. See [Residual risk](#residual-risk).

---

## 1. Why a Module and not a Guard

`LP_AUTOMATION_PLAN.md` §4 specifies "Safe + a custom Guard". **That construction
does not work for this use case**, and this contract deliberately supersedes it.

A Safe Guard is invoked by `execTransaction` — i.e. *after* the Safe has verified
owner signatures. So the Guard only ever sees transactions that already cleared
the signature threshold. That gives two mutually exclusive options:

| Safe threshold | Consequence |
| --- | --- |
| **1** (hot key can sign alone — required for unattended automation) | The hot key can also sign `safe.setGuard(address(0))`, which is just another Safe transaction. The Guard deletes itself on the attacker's command. The restriction is decorative. |
| **>1** (e.g. 2-of-2 with an offline key) | The hot key cannot sign anything alone, so there is no unattended automation at all. The entire point of the system is gone. |

The usual patch — have the Guard reject `to == safe` — fails too: it blocks
`setGuard`, but it *equally* blocks every legitimate owner-signed change to the
Safe (adding an owner, rotating a key, changing the threshold, and re-installing
a replacement Guard). You would be permanently locked out of administering your
own Safe by a contract the same key can't remove. Attempts to thread that needle
(allow `to == safe` only for some selectors) reintroduce the escalation path,
because owner administration and self-de-restriction are the same operation seen
from different angles.

A **Module** removes the contradiction by inverting the trust direction:

- The Safe keeps a **real threshold** (2-of-2 recommended) with **offline owner
  keys**. Owners administer the Safe normally — no Guard interferes.
- The automation hot key is **not a Safe owner**. It cannot produce a Safe
  transaction at all. It has exactly one reachable entry point in the entire
  system: `OctAutomationModule.execute(to, value, data)`.
- `execute` validates against allowlists and caps, then forwards through
  `execTransactionFromModuleReturnData(..., Enum.Operation.Call)`.
- **Every** administrative function on the module (`setOperator`,
  `setTargetAllowed`, `setSelectorAllowed`, `setSelectorsAllowed`,
  `setMaxValuePerTx`, `setDailyValueCap`, `setPaused`) is gated on
  `msg.sender == safe`. The Safe can only originate a call from itself via an
  owner-signed, threshold-satisfying `execTransaction`. So widening the module's
  bounds *is* an owner-signed action, enforced by the EVM.
- Disabling the module entirely (`safe.disableModule`) is likewise an owner-only
  Safe operation, handled by Safe's own audited code, not by anything here. The
  offline keys keep the ultimate kill switch even if this contract is buggy.

That is what makes the plan's *"no component may expand its own permissions at
runtime"* a real on-chain property instead of an off-chain promise.

The module is `safe`-immutable: there is no `setSafe`, because repointing the
administering Safe would itself be an escalation path.

---

## 2. Enforcement invariants

For any call reaching `execute`, **all** of the following hold, in this order:

1. `isOperator[msg.sender]` — otherwise `NotOperator`.
2. `!paused` — otherwise `ModulePaused`.
3. `to != safe && to != address(this) && to != address(0)` — otherwise
   `ForbiddenTarget`. Checked *before* the allowlist, so even a mistaken
   allowlist entry could not make the Safe or the module reachable from the
   operator path. (The allowlist setters reject those three addresses as well,
   so the mistake cannot be made in the first place — belt and braces.)
4. `data.length >= 4` — otherwise `CalldataTooShort`. A bare native transfer has
   no selector and therefore cannot be constrained by the selector allowlist, so
   it is rejected outright. Owners can still move native value with an ordinary
   Safe transaction.
5. `isAllowedTarget[to]` — otherwise `TargetNotAllowed`. **A freshly deployed
   module has an empty allowlist and can execute nothing.**
6. `isAllowedSelector[to][bytes4(data[:4])]` — otherwise `SelectorNotAllowed`.
   The selector allowlist is **scoped per destination**, not global: allowlisting
   `swapExactTokensForTokens` on router A does not allow it on router B.
7. `value <= maxValuePerTx` — otherwise `ValueCapExceeded`. Inclusive bound.
8. `spentInCurrentWindow() + value <= dailyValueCap` — otherwise
   `DailyValueCapExceeded`. Inclusive bound.
9. The Safe call is made with `Enum.Operation.Call`, always. **The contract
   exposes no path — parameterized or otherwise — that can produce a
   `DELEGATECALL` from the Safe.** The literal `Enum.Operation.Call` in `execute`
   is the only operation value this contract ever passes to a Safe.
10. If the destination call fails, the whole transaction reverts with
    `ExecutionFailed(returnData)` and the spend accounting is rolled back with
    it. No partial-spend accounting is possible.

Ordering note: the spend counter is written **before** the external call
(checks-effects-interactions), so a malicious destination re-entering `execute`
faces the already-incremented counter — and would have to be an authorized
operator to get past step 1 regardless.

Every state change and every execution emits an event (`OperatorSet`,
`TargetAllowedSet`, `SelectorAllowedSet`, `MaxValuePerTxSet`,
`DailyValueCapSet`, `PausedSet`, `SpendWindowRolled`, `Executed`) so the
off-chain audit log (plan §10 step 6) can be reconstructed from chain data alone,
independently of whatever the runner claims it did.

---

## 3. Daily window model — fixed UTC bucket, and its cost

The cumulative cap is a **fixed UTC-day bucket**: `block.timestamp / 86400`. It
is **not** a true rolling 24-hour window.

**Why:** the whole accumulator is one storage slot (`uint64 dayIndex` +
`uint192 spent`, packed to exactly 256 bits) — one `SLOAD` and one `SSTORE` per
value-bearing execution, and *zero* storage writes for zero-value executions
(which is most LP activity, since ERC-20 flows carry no native value). A genuine
sliding window needs a ring buffer or a timestamped list of spends, pruned on
every call: several times the gas, on every transaction, forever, for a system
designed to transact frequently.

**The honest downside:** up to **2x the daily cap can leave the Safe within a
couple of seconds** if the burst straddles 00:00 UTC — full cap at 23:59:59, full
cap again at 00:00:00. This is a real weakness, not a rounding detail.

Consequences you should internalize before setting a number:

- Size `dailyValueCap` such that losing **2x** of it in one burst is survivable.
- Treat the cap as **damage rate-limiting**, not damage prevention. It bounds how
  fast a compromised operator can bleed the Safe, not whether it can.
- If you ever need a hard 24h guarantee, that is a contract change (sliding
  window), not a config change.

`test_FixedUtcBucket_AllowsTwoFullCapsAcrossMidnightBoundary` in the test suite
exists specifically to keep this tradeoff visible in CI rather than buried in a
comment. If someone "fixes" that test, they have changed the security model.

Two further properties of the accumulator worth knowing:

- **Zero-value calls never touch it.** They consume no allowance and write no
  storage, so they keep working even if the cap is later lowered below what has
  already been spent today.
- **Lowering the cap does not claw back** value already spent; it just blocks
  further value-bearing executions until the next UTC day.

---

## 4. Scope of the caps (read this before trusting them)

`maxValuePerTx` and `dailyValueCap` bound **native value only** — the `value`
field the Safe forwards.

They do **not** bound ERC-20 amounts. Token amounts live inside `data`, and are
not interpretable without per-selector ABI knowledge that would make this
contract router-specific and fragile. ERC-20 exposure is constrained by the
**destination + selector allowlist** instead, and — critically — by **how much
approval the Safe has granted to each allowlisted contract**.

Practical consequence: on a chain where LP positions are held in ERC-20s and
WETH rather than native value, the caps here constrain much less than they
appear to. Approval hygiene does most of the real work. See
[Residual risk](#residual-risk).

---

## 5. Deployment and setup sequence

Every step after the deploys is an **owner-signed Safe transaction**. There is no
step in which the operator key participates in its own authorization.

1. **Deploy the Safe.**
   - Owners: your offline/hardware keys. **The automation hot key must not be an
     owner.**
   - Threshold: 2-of-2 recommended (plan §9 point 3 — the second key is the one
     that exists so the automation can never widen its own limits).
   - Fund it with **only the capital you intend to risk**.

2. **Generate a fresh operator key.** Never reuse a wallet holding unrelated
   funds (plan §4, "Operational requirement"). Fund it with gas only — it never
   needs to hold position capital, because value comes from the Safe.

3. **Deploy `OctAutomationModule`** with
   `constructor(safe, maxValuePerTx, dailyValueCap)`.
   - Deployed state is intentionally inert: **no operators, no allowlisted
     targets, no allowlisted selectors.** A freshly deployed module can execute
     nothing, even if it is enabled on the Safe.

4. **Owner-signed: `safe.enableModule(module)`.** Verify with
   `module.isModuleEnabledOnSafe()`.

5. **Owner-signed: seed the destination allowlist.**
   `module.setTargetAllowed(krystalRouter, true)` for each Krystal
   router/position-manager contract for the chosen platform on the target chain —
   *nothing else*. Verify each address against Krystal's own published
   deployments before signing; a wrong address here is the single highest-impact
   mistake available in this setup.

6. **Owner-signed: seed the selector allowlist per destination.**
   `module.setSelectorsAllowed(target, selectors, true)` with only the selectors
   the lifecycle actions actually need (compound / adjust_range / swap_and_mint /
   swap_and_increase / withdraw_and_swap entry points). Derive these from the
   actual calldata Krystal returns, not from guesses.

7. **Owner-signed: `module.setOperator(hotKey, true)`.** Do this **last**, after
   the bounds exist. Ordering matters: it means there is never a window in which
   an authorized operator faces an unconfigured module.

8. **Verify from a block explorer / `cast call`, not from the runner's logs:**
   `isOperator`, `isAllowedTarget`, `isAllowedSelector`, `maxValuePerTx`,
   `dailyValueCap`, `paused`, `remainingDailyAllowance`, and that the Safe's
   owner set does **not** include the hot key.

9. **Dry run with tiny caps first.** Set `maxValuePerTx` and `dailyValueCap` to
   near-dust values, run the full lifecycle end to end, then raise them via
   owner-signed transactions. Raising a cap is cheap; walking back a loss is not.

**Emergency response:** `module.setPaused(true)` (one owner-signed tx) halts all
operator execution immediately. `safe.disableModule(...)` removes the module
entirely and does not depend on this contract being correct.

---

## 6. What an operator-key compromise can and cannot do

Assume the hot key is fully stolen and the attacker can call `execute` at will.

**It CAN:**

- Call any **allowlisted selector** on any **allowlisted destination**, with
  arbitrary arguments. Within the allowlist, argument-level intent is *not*
  checked: it can pass hostile slippage, hostile recipients (where the ABI has a
  recipient parameter), hostile tick ranges, or hostile deadlines. **This is the
  most likely realistic loss path — not raw theft, but value destroyed through
  legitimate-looking calls.**
- Drain up to `dailyValueCap` of native value per UTC day, and up to **2x that**
  in one burst across midnight UTC (§3).
- Move any ERC-20 the Safe has **approved** to an allowlisted contract, if any
  allowlisted selector on that contract can be induced to transfer to an
  attacker-chosen address. Native-value caps do not constrain this (§4).
- Burn the Safe's gas indirectly and spam the allowlisted destinations.
- Grief availability: repeatedly consume the daily allowance so legitimate
  automation cannot act.

**It CANNOT:**

- Add or remove operators, targets, or selectors.
- Raise `maxValuePerTx` or `dailyValueCap`, or unpause the module.
- Call the Safe itself — no `enableModule`, `disableModule`, `addOwner`,
  `changeThreshold`, `setGuard`, `setFallbackHandler`. Blocked twice: by
  `ForbiddenTarget` in `execute`, and by the Safe never accepting the operator as
  a signer in the first place.
- Call the module itself through the Safe (`to == address(this)` rejected).
- Cause a `DELEGATECALL` from the Safe. No path exists; this is the class of bug
  that turns "limited access" into "total loss", so there is deliberately no
  parameter that could be set wrong.
- Send bare native value to an arbitrary address (`data.length < 4` rejected).
- Execute at all while paused.
- Persist through owner action: one owner-signed `setPaused(true)` or
  `disableModule` ends it.

**Recovery:** pause (or disable the module), rotate the operator key, then
`setOperator(old, false)` / `setOperator(new, true)`. The Safe's funds and owner
set are untouched by any of this.

---

## 7. Residual risk

Be honest about these before mainnet:

1. **Unaudited, and not executed by its author.** Foundry was not available on
   the machine where this was written, so the tests here have **never been run**.
   They are written to pass, but "written to pass" is not "passes". CI must run
   `forge test` green before anyone believes a word of this file.
2. **Argument-level intent is unchecked.** The allowlist proves *which function
   on which contract*, never *with what arguments*. Slippage, recipient and
   deadline parameters are entirely at the operator's discretion. This is the
   biggest gap between "the module is correct" and "the funds are safe", and it
   is not closable without router-specific decoding.
3. **ERC-20 approvals are the real perimeter.** Grant per-transaction or tightly
   bounded approvals rather than infinite ones. An infinite approval to an
   allowlisted router makes the native-value caps largely cosmetic for token
   value.
4. **Allowlisting a wrong or malicious address** is unrecoverable by design —
   the module will faithfully enforce a bad rule. Verify router addresses
   independently of any API response, including Krystal's.
5. **Midnight-UTC 2x burst** (§3), accepted deliberately.
6. **`block.timestamp` is validator-influenced** by a small margin. It can shift
   the bucket boundary by seconds. Irrelevant at day granularity; do not reuse
   this window logic for anything short-interval.
7. **Safe version assumptions.** The local `ISafe` interface matches Safe
   `ModuleManager` v1.3.0 / v1.4.1. Confirm the Safe factory version actually
   deployed on the target chain exposes
   `execTransactionFromModuleReturnData` with this exact signature before
   deploying. A signature mismatch means every `execute` reverts (fail-closed,
   but a total outage).
8. **No on-chain circuit breaker beyond the cap.** The module cannot detect that
   a series of individually-permitted calls is collectively destroying value.
   That judgement lives in the off-chain supervisory pass (plan §8), which is
   Phase 2 and pause/flag-only.
9. **`evm_version = "shanghai"` and Safe's own deployment on a ~4-week-old
   chain** should both be verified against the target chain before deploying.
10. **No formal verification, no invariant/handler-based fuzzing suite.** The
    fuzz tests here cover cap arithmetic and authorization, not stateful
    multi-actor sequences.

---

## 8. Build and test

Foundry is required (`forge`). It is **not** installed in the environment where
these files were written.

```bash
cd lp-automation/contracts

# One-time: forge-std is the only dependency, and lib/ is gitignored, so it is
# vendored rather than committed. Use the same pinned tag CI uses.
git clone --depth 1 --branch v1.9.6 https://github.com/foundry-rs/forge-std lib/forge-std

forge build
forge test -vvv
forge test --profile ci      # 5000 fuzz runs
forge coverage
```

CI runs `forge build` + `forge test -vvv` for this directory in the `contracts`
job of `.github/workflows/ci.yml`. Because the author could not run Foundry
locally, **that job is the only automated verification this Solidity gets** —
treat a red run there as blocking, never advisory.

`lib/`, `out/`, `cache/` and `broadcast/` are gitignored
(`lp-automation/.gitignore`).

### Layout

```
contracts/
  foundry.toml                     # solc 0.8.28, shanghai, optimizer 200
  remappings.txt                   # forge-std/=lib/forge-std/src/
  src/OctAutomationModule.sol      # the module + local ISafe/Enum declarations
  test/OctAutomationModule.t.sol   # MockSafe, MockTarget, unit + fuzz tests
  README.md                        # this file
```

No dependency on Safe's contracts: `ISafe` and `Enum.Operation` are declared
locally and are ABI-compatible with the real ones (`Call == 0`,
`DelegateCall == 1`).
