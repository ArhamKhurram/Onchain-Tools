// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Local, dependency-free mirror of Safe's `Enum` contract.
/// @dev    Declared here on purpose so this repo has zero Solidity dependencies
///         outside of forge-std (tests only). The ABI encoding of
///         `Enum.Operation` is a plain `uint8`, so this is wire-compatible with
///         the real Safe contracts: `Call == 0`, `DelegateCall == 1`.
library Enum {
    enum Operation {
        Call,
        DelegateCall
    }
}

/// @notice Minimal subset of the Safe (Gnosis Safe) module interface we depend on.
/// @dev    Matches Safe `ModuleManager` v1.3.0 / v1.4.1.
interface ISafe {
    function execTransactionFromModuleReturnData(
        address to,
        uint256 value,
        bytes memory data,
        Enum.Operation operation
    ) external returns (bool success, bytes memory returnData);

    function isModuleEnabled(address module) external view returns (bool);
}

/**
 * @title  OctAutomationModule
 * @notice Safe module that lets a hot "operator" key execute a *narrow*,
 *         pre-authorized set of transactions out of a Safe, without the
 *         operator being a Safe owner and without it being able to widen its own
 *         permissions.
 *
 * @dev ## Why a module and not a Guard
 *
 * The original design note called for "Safe + Guard". That construction does not
 * hold up here. For the automation key to sign alone, the Safe threshold must be
 * 1 — but then that same single key can execute `setGuard(address(0))` on the
 * Safe and delete its own restrictions. Blocking `to == safe` inside the Guard
 * "fixes" that only by also blocking every legitimate owner-signed configuration
 * change, including changing the Guard's own bounds.
 *
 * A module inverts the trust direction and removes the contradiction:
 *
 *  - The Safe keeps a real threshold (e.g. 2-of-2) with *offline* owner keys.
 *  - The operator hot key is **not** a Safe owner. It has no ability to produce a
 *    Safe transaction at all.
 *  - The operator's only reachable entry point is {execute} on this module, which
 *    validates, then forwards through `execTransactionFromModule*` as a CALL.
 *  - Every administrative function here is gated on `msg.sender == safe`, so the
 *    only way to change the allowlists, the caps, the operator set, or the pause
 *    flag is an **owner-signed Safe transaction**. The operator cannot reach any
 *    of them.
 *  - Disabling this module entirely is itself an owner-only Safe operation, so
 *    the offline keys retain the ultimate kill switch independent of this code.
 *
 * That is what makes "no component may expand its own permissions at runtime" an
 * on-chain property rather than an off-chain promise.
 *
 * ## Daily spend window model
 *
 * The daily cap is a **fixed UTC-day bucket**: `block.timestamp / 86400`. It is
 * not a true rolling/sliding 24h window.
 *
 *  - Cost: one storage slot (`SpendWindow` packs `uint64` + `uint192`), one SLOAD
 *    and one SSTORE per value-bearing execution. A genuine sliding window needs a
 *    ring buffer or a timestamped list of spends — many times the gas, on every
 *    single transaction, forever.
 *  - Honest downside: **up to 2x the daily cap can leave the Safe within a very
 *    short span straddling 00:00 UTC** (cap spent at 23:59:59, cap spent again at
 *    00:00:00). This is a real weakness, not a rounding detail. Size
 *    `dailyValueCap` such that losing 2x of it in one burst is survivable, and
 *    treat the cap as "damage rate limiting", not "damage prevention".
 *    `test_FixedUtcBucket_AllowsTwoFullCapsAcrossMidnightBoundary` in the test
 *    suite exists specifically to keep this tradeoff visible.
 *
 * ## Scope of the caps
 *
 * The caps here bound **native value** (`msg.value` forwarded by the Safe) only.
 * They do **not** bound ERC-20 amounts, which are encoded inside `data` and are
 * not interpretable without per-selector ABI knowledge. ERC-20 exposure is
 * constrained by the destination + selector allowlist instead (see README,
 * "Residual risk").
 *
 * ## Reentrancy
 *
 * {execute} follows checks-effects-interactions: the spend counter is written
 * *before* the Safe call. A malicious target that calls back into {execute}
 * therefore faces the already-incremented counter, and must in any case be an
 * authorized operator to get past the first check. No separate reentrancy guard
 * is used; re-entering grants no capability that a second sequential call would
 * not also grant.
 */
contract OctAutomationModule {
    /*//////////////////////////////////////////////////////////////
                                  TYPES
    //////////////////////////////////////////////////////////////*/

    /// @dev Packed into a single storage slot (64 + 192 == 256 bits).
    struct SpendWindow {
        uint64 dayIndex; // block.timestamp / SPEND_WINDOW when `spent` was last written
        uint192 spent; // native value spent during that UTC day
    }

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error ZeroAddress();
    error OnlySafe(address caller);
    error NotOperator(address caller);
    error ModulePaused();
    /// @dev Raised for `safe`, `address(this)` and `address(0)` on both the
    ///      operator path and the allowlist admin path.
    error ForbiddenTarget(address target);
    error InvalidOperator(address operator);
    error TargetNotAllowed(address target);
    error SelectorNotAllowed(address target, bytes4 selector);
    error CalldataTooShort(uint256 length);
    error ValueCapExceeded(uint256 value, uint256 cap);
    error DailyValueCapExceeded(uint256 value, uint256 spentInWindow, uint256 cap);
    error DailyValueCapTooLarge(uint256 cap, uint256 maxCap);
    error EmptySelectorList();
    error ExecutionFailed(bytes returnData);

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event OperatorSet(address indexed operator, bool allowed);
    event TargetAllowedSet(address indexed target, bool allowed);
    event SelectorAllowedSet(address indexed target, bytes4 indexed selector, bool allowed);
    event MaxValuePerTxSet(uint256 previousCap, uint256 newCap);
    event DailyValueCapSet(uint256 previousCap, uint256 newCap);
    event PausedSet(bool isPaused);
    event SpendWindowRolled(uint64 indexed previousDayIndex, uint64 indexed newDayIndex, uint192 previousSpent);
    event Executed(
        address indexed operator,
        address indexed to,
        bytes4 indexed selector,
        uint256 value,
        bytes32 dataHash,
        uint192 spentInWindowAfter
    );

    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Length of one spend bucket. Fixed UTC day.
    uint256 public constant SPEND_WINDOW = 1 days;

    /// @notice Upper bound on `dailyValueCap`, imposed by the packed accumulator.
    /// @dev    ~6.2e57 wei — far above any plausible cap. Enforcing it lets
    ///         `_recordSpend` downcast to uint192 without any possibility of
    ///         truncation.
    uint256 public constant MAX_DAILY_VALUE_CAP = type(uint192).max;

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice The Safe this module executes out of, and the only address that
    ///         may administer this module. Immutable by design — repointing it
    ///         would be an escalation path.
    address public immutable safe;

    /// @notice Maximum native value a single operator execution may forward.
    uint256 public maxValuePerTx;

    /// @notice Maximum cumulative native value per UTC day.
    uint256 public dailyValueCap;

    /// @notice When true, all operator execution is halted.
    bool public paused;

    /// @notice Current UTC-day spend accumulator.
    SpendWindow public spendWindow;

    /// @notice Keys authorized to call {execute}. Never Safe owners.
    mapping(address => bool) public isOperator;

    /// @notice Destinations the operator may call.
    mapping(address => bool) public isAllowedTarget;

    /// @notice Per-destination 4-byte selector allowlist. A destination is only
    ///         reachable through selectors explicitly enabled for it.
    mapping(address => mapping(bytes4 => bool)) public isAllowedSelector;

    /*//////////////////////////////////////////////////////////////
                                MODIFIERS
    //////////////////////////////////////////////////////////////*/

    /// @dev The Safe can only originate a call from itself via an owner-signed,
    ///      threshold-satisfying `execTransaction`. This modifier is therefore
    ///      equivalent to "owner-authorized".
    modifier onlySafe() {
        if (msg.sender != safe) revert OnlySafe(msg.sender);
        _;
    }

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @param safe_          The Safe this module executes out of.
    /// @param maxValuePerTx_ Per-transaction native value cap.
    /// @param dailyValueCap_ Per-UTC-day cumulative native value cap.
    /// @dev No operators and no allowlist entries are seeded here on purpose: a
    ///      freshly deployed module can execute nothing at all until the owners
    ///      sign the seeding transactions.
    constructor(address safe_, uint256 maxValuePerTx_, uint256 dailyValueCap_) {
        if (safe_ == address(0)) revert ZeroAddress();
        if (dailyValueCap_ > MAX_DAILY_VALUE_CAP) revert DailyValueCapTooLarge(dailyValueCap_, MAX_DAILY_VALUE_CAP);

        safe = safe_;
        maxValuePerTx = maxValuePerTx_;
        dailyValueCap = dailyValueCap_;

        emit MaxValuePerTxSet(0, maxValuePerTx_);
        emit DailyValueCapSet(0, dailyValueCap_);
    }

    /*//////////////////////////////////////////////////////////////
                             OPERATOR PATH
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Execute a pre-authorized transaction out of the Safe.
     * @param to    Destination. Must be allowlisted, and must not be the Safe or
     *              this module.
     * @param value Native value to forward. Bounded by {maxValuePerTx} and
     *              {dailyValueCap}.
     * @param data  Calldata. Must be at least 4 bytes; its selector must be
     *              allowlisted *for this specific destination*.
     * @return returnData Raw return data from the destination call.
     *
     * @dev Always forwarded as `Enum.Operation.Call`. This contract exposes no
     *      path — parameterized or otherwise — that can produce a DELEGATECALL
     *      from the Safe. The literal `Enum.Operation.Call` below is the only
     *      operation value this contract ever passes to the Safe.
     *
     *      Not payable: value is drawn from the Safe's balance, never from the
     *      caller. This module is not designed to hold funds and has no
     *      `receive`/`fallback`.
     */
    function execute(address to, uint256 value, bytes calldata data) external returns (bytes memory returnData) {
        if (!isOperator[msg.sender]) revert NotOperator(msg.sender);
        if (paused) revert ModulePaused();

        // Self-administration guard. Checked before the allowlist so that even a
        // mistaken allowlist entry (which the setters also reject) cannot make
        // the Safe or this module reachable from the operator path.
        if (to == safe || to == address(this) || to == address(0)) revert ForbiddenTarget(to);

        // A bare native transfer has no selector and therefore cannot be
        // constrained by the selector allowlist, so it is rejected outright.
        // Owners can still move native value with a normal Safe transaction.
        if (data.length < 4) revert CalldataTooShort(data.length);

        if (!isAllowedTarget[to]) revert TargetNotAllowed(to);

        bytes4 selector = bytes4(data[:4]);
        if (!isAllowedSelector[to][selector]) revert SelectorNotAllowed(to, selector);

        if (value > maxValuePerTx) revert ValueCapExceeded(value, maxValuePerTx);

        // Effects before interaction.
        uint192 spentAfter = _recordSpend(value);

        bool success;
        (success, returnData) =
            ISafe(safe).execTransactionFromModuleReturnData(to, value, data, Enum.Operation.Call);
        if (!success) revert ExecutionFailed(returnData);

        emit Executed(msg.sender, to, selector, value, keccak256(data), spentAfter);
    }

    /*//////////////////////////////////////////////////////////////
                        ADMIN (OWNER-SIGNED ONLY)
    //////////////////////////////////////////////////////////////*/

    /// @notice Authorize or revoke an operator key.
    function setOperator(address operator, bool allowed) external onlySafe {
        if (operator == address(0) || operator == safe || operator == address(this)) {
            revert InvalidOperator(operator);
        }
        isOperator[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    /// @notice Add or remove a destination from the allowlist.
    /// @dev Removing a target leaves its selector entries in place; they are
    ///      inert while the target is not allowlisted, but re-allowlisting the
    ///      target restores them. Clear selectors explicitly if that matters.
    function setTargetAllowed(address target, bool allowed) external onlySafe {
        _requireAllowlistableTarget(target);
        isAllowedTarget[target] = allowed;
        emit TargetAllowedSet(target, allowed);
    }

    /// @notice Allow or disallow one selector on one destination.
    function setSelectorAllowed(address target, bytes4 selector, bool allowed) external onlySafe {
        _requireAllowlistableTarget(target);
        isAllowedSelector[target][selector] = allowed;
        emit SelectorAllowedSet(target, selector, allowed);
    }

    /// @notice Batch form of {setSelectorAllowed}, to keep owner-signed setup to
    ///         a small number of transactions.
    function setSelectorsAllowed(address target, bytes4[] calldata selectors, bool allowed) external onlySafe {
        _requireAllowlistableTarget(target);
        uint256 length = selectors.length;
        if (length == 0) revert EmptySelectorList();
        for (uint256 i; i < length; ++i) {
            isAllowedSelector[target][selectors[i]] = allowed;
            emit SelectorAllowedSet(target, selectors[i], allowed);
        }
    }

    /// @notice Set the per-transaction native value cap.
    function setMaxValuePerTx(uint256 newCap) external onlySafe {
        emit MaxValuePerTxSet(maxValuePerTx, newCap);
        maxValuePerTx = newCap;
    }

    /// @notice Set the per-UTC-day cumulative native value cap.
    /// @dev Lowering the cap below what has already been spent today does not
    ///      claw anything back; it simply blocks further value-bearing
    ///      executions until the next UTC day. Zero-value executions are
    ///      unaffected (they never touch the accumulator).
    function setDailyValueCap(uint256 newCap) external onlySafe {
        if (newCap > MAX_DAILY_VALUE_CAP) revert DailyValueCapTooLarge(newCap, MAX_DAILY_VALUE_CAP);
        emit DailyValueCapSet(dailyValueCap, newCap);
        dailyValueCap = newCap;
    }

    /// @notice Halt or resume all operator execution.
    function setPaused(bool newPaused) external onlySafe {
        paused = newPaused;
        emit PausedSet(newPaused);
    }

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice Index of the current fixed UTC-day spend bucket.
    function currentDayIndex() public view returns (uint64) {
        return uint64(block.timestamp / SPEND_WINDOW);
    }

    /// @notice Native value already spent in the current bucket (0 if the stored
    ///         bucket is stale).
    function spentInCurrentWindow() public view returns (uint256) {
        SpendWindow memory window = spendWindow;
        return window.dayIndex == currentDayIndex() ? uint256(window.spent) : 0;
    }

    /// @notice Native value still spendable in the current bucket.
    function remainingDailyAllowance() external view returns (uint256) {
        uint256 spent = spentInCurrentWindow();
        uint256 cap = dailyValueCap;
        return cap > spent ? cap - spent : 0;
    }

    /// @notice Whether the Safe currently has this module enabled. Purely
    ///         informational; a health-check hook for the off-chain runner.
    function isModuleEnabledOnSafe() external view returns (bool) {
        return ISafe(safe).isModuleEnabled(address(this));
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNAL
    //////////////////////////////////////////////////////////////*/

    function _requireAllowlistableTarget(address target) private view {
        if (target == address(0) || target == safe || target == address(this)) revert ForbiddenTarget(target);
    }

    /// @dev Charges `value` against the current UTC-day bucket, rolling the
    ///      bucket over first if the day changed. Returns the post-charge total.
    ///      Zero-value executions short-circuit: they consume no allowance and
    ///      write no storage, so they keep working even if the cap is later
    ///      lowered below what has already been spent.
    function _recordSpend(uint256 value) private returns (uint192 spentAfter) {
        uint64 today = currentDayIndex();
        SpendWindow memory window = spendWindow;

        if (value == 0) {
            return window.dayIndex == today ? window.spent : uint192(0);
        }

        uint256 base;
        if (window.dayIndex == today) {
            base = uint256(window.spent);
        } else {
            emit SpendWindowRolled(window.dayIndex, today, window.spent);
        }

        uint256 cap = dailyValueCap;

        // Checked first so that `base + value` below cannot overflow: after this
        // line `value <= cap <= type(uint192).max` and `base <= type(uint192).max`.
        if (value > cap) revert DailyValueCapExceeded(value, base, cap);

        uint256 newSpent = base + value;
        if (newSpent > cap) revert DailyValueCapExceeded(value, base, cap);

        // Safe downcast: newSpent <= cap <= MAX_DAILY_VALUE_CAP == type(uint192).max.
        spentAfter = uint192(newSpent);
        spendWindow = SpendWindow({dayIndex: today, spent: spentAfter});
    }
}
