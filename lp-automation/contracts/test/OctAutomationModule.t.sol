// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {OctAutomationModule, Enum} from "../src/OctAutomationModule.sol";

/*//////////////////////////////////////////////////////////////
                                MOCKS
//////////////////////////////////////////////////////////////*/

/// @notice Minimal stand-in for a Safe's module-execution surface.
/// @dev Records the `Enum.Operation` it was handed and refuses anything other
///      than CALL, so any accidental DELEGATECALL path in the module under test
///      would surface as a hard failure rather than a silent success.
contract MockSafe {
    error UnsupportedOperation(uint8 operation);

    /// @dev Sentinel: 255 means "never called". A default of 0 would be
    ///      indistinguishable from a genuine `Operation.Call`.
    uint8 public lastOperation = type(uint8).max;
    uint256 public callCount;

    mapping(address => bool) public modules;

    receive() external payable {}

    function enableModule(address module) external {
        modules[module] = true;
    }

    function isModuleEnabled(address module) external view returns (bool) {
        return modules[module];
    }

    function execTransactionFromModule(address to, uint256 value, bytes memory data, Enum.Operation operation)
        external
        returns (bool success)
    {
        (success,) = _exec(to, value, data, operation);
    }

    function execTransactionFromModuleReturnData(
        address to,
        uint256 value,
        bytes memory data,
        Enum.Operation operation
    ) external returns (bool success, bytes memory returnData) {
        return _exec(to, value, data, operation);
    }

    function _exec(address to, uint256 value, bytes memory data, Enum.Operation operation)
        internal
        returns (bool, bytes memory)
    {
        lastOperation = uint8(operation);
        callCount += 1;
        if (operation != Enum.Operation.Call) revert UnsupportedOperation(uint8(operation));
        return to.call{value: value}(data);
    }
}

/// @notice Destination contract with a couple of distinct selectors.
contract MockTarget {
    uint256 public pokeCount;
    uint256 public forbiddenCount;
    uint256 public lastValue;

    function poke(uint256 x) external payable returns (uint256) {
        pokeCount += 1;
        lastValue = msg.value;
        return x + 1;
    }

    function forbidden(uint256) external payable returns (uint256) {
        forbiddenCount += 1;
        return 0;
    }

    function boom() external payable {
        revert("boom");
    }

    receive() external payable {}
}

/*//////////////////////////////////////////////////////////////
                                TESTS
//////////////////////////////////////////////////////////////*/

contract OctAutomationModuleTest is Test {
    // Events re-declared locally so the test contract can `emit` them as
    // expectations. Topic hashes are identical to the module's.
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

    MockSafe internal safe;
    MockTarget internal target;
    OctAutomationModule internal module;

    address internal operator = address(0xA11CE);
    address internal stranger = address(0xBEEF);

    uint256 internal constant MAX_PER_TX = 1 ether;
    uint256 internal constant DAILY_CAP = 5 ether;

    // A timestamp deliberately *inside* a UTC day (80_000s past midnight), so
    // day-boundary tests exercise a real rollover rather than starting at one.
    uint256 internal constant START_TIME = 1_700_000_000;

    function setUp() public {
        vm.warp(START_TIME);

        safe = new MockSafe();
        target = new MockTarget();
        module = new OctAutomationModule(address(safe), MAX_PER_TX, DAILY_CAP);

        safe.enableModule(address(module));
        vm.deal(address(safe), 1000 ether);

        vm.startPrank(address(safe));
        module.setOperator(operator, true);
        module.setTargetAllowed(address(target), true);
        module.setSelectorAllowed(address(target), MockTarget.poke.selector, true);
        vm.stopPrank();
    }

    function pokeData(uint256 x) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(MockTarget.poke.selector, x);
    }

    function exec(uint256 value) internal returns (bytes memory) {
        vm.prank(operator);
        return module.execute(address(target), value, pokeData(1));
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    function test_ConstructorSetsState() public {
        assertEq(module.safe(), address(safe));
        assertEq(module.maxValuePerTx(), MAX_PER_TX);
        assertEq(module.dailyValueCap(), DAILY_CAP);
        assertFalse(module.paused());
        assertEq(module.SPEND_WINDOW(), 1 days);
        assertEq(module.MAX_DAILY_VALUE_CAP(), uint256(type(uint192).max));
        assertTrue(module.isModuleEnabledOnSafe());
    }

    function test_RevertWhen_ConstructedWithZeroSafe() public {
        vm.expectRevert(OctAutomationModule.ZeroAddress.selector);
        new OctAutomationModule(address(0), 1 ether, 5 ether);
    }

    function test_RevertWhen_ConstructedWithOversizedDailyCap() public {
        uint256 tooBig = uint256(type(uint192).max) + 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                OctAutomationModule.DailyValueCapTooLarge.selector, tooBig, uint256(type(uint192).max)
            )
        );
        new OctAutomationModule(address(safe), 1 ether, tooBig);
    }

    /*//////////////////////////////////////////////////////////////
                              HAPPY PATH
    //////////////////////////////////////////////////////////////*/

    function test_OperatorCanExecuteAllowlistedCall() public {
        uint256 safeBalanceBefore = address(safe).balance;

        bytes memory ret = exec(0.25 ether);

        assertEq(abi.decode(ret, (uint256)), 2);
        assertEq(target.pokeCount(), 1);
        assertEq(target.lastValue(), 0.25 ether);
        assertEq(address(target).balance, 0.25 ether);
        assertEq(address(safe).balance, safeBalanceBefore - 0.25 ether);
        assertEq(module.spentInCurrentWindow(), 0.25 ether);
        assertEq(module.remainingDailyAllowance(), DAILY_CAP - 0.25 ether);
    }

    function test_ZeroValueCallsDoNotConsumeDailyAllowance() public {
        exec(0);
        exec(0);
        exec(0);

        assertEq(target.pokeCount(), 3);
        assertEq(module.spentInCurrentWindow(), 0);
        assertEq(module.remainingDailyAllowance(), DAILY_CAP);

        (uint64 dayIndex, uint192 spent) = module.spendWindow();
        assertEq(dayIndex, 0, "zero-value calls must not write the spend window");
        assertEq(spent, 0);
    }

    /*//////////////////////////////////////////////////////////////
                         DESTINATION ALLOWLIST
    //////////////////////////////////////////////////////////////*/

    function test_RevertWhen_TargetNotAllowlisted() public {
        MockTarget other = new MockTarget();

        vm.expectRevert(abi.encodeWithSelector(OctAutomationModule.TargetNotAllowed.selector, address(other)));
        vm.prank(operator);
        module.execute(address(other), 0, pokeData(1));
    }

    function test_EmptyAllowlistExecutesNothing() public {
        OctAutomationModule fresh = new OctAutomationModule(address(safe), MAX_PER_TX, DAILY_CAP);
        vm.prank(address(safe));
        fresh.setOperator(operator, true);

        vm.expectRevert(abi.encodeWithSelector(OctAutomationModule.TargetNotAllowed.selector, address(target)));
        vm.prank(operator);
        fresh.execute(address(target), 0, pokeData(1));
    }

    function test_RemovingTargetBlocksExecution() public {
        exec(0);

        vm.prank(address(safe));
        module.setTargetAllowed(address(target), false);

        vm.expectRevert(abi.encodeWithSelector(OctAutomationModule.TargetNotAllowed.selector, address(target)));
        vm.prank(operator);
        module.execute(address(target), 0, pokeData(1));
    }

    /*//////////////////////////////////////////////////////////////
                          SELECTOR ALLOWLIST
    //////////////////////////////////////////////////////////////*/

    function test_RevertWhen_SelectorNotAllowlisted() public {
        bytes memory data = abi.encodeWithSelector(MockTarget.forbidden.selector, uint256(1));

        vm.expectRevert(
            abi.encodeWithSelector(
                OctAutomationModule.SelectorNotAllowed.selector, address(target), MockTarget.forbidden.selector
            )
        );
        vm.prank(operator);
        module.execute(address(target), 0, data);

        assertEq(target.forbiddenCount(), 0);
    }

    function test_SelectorAllowlistIsScopedPerDestination() public {
        MockTarget other = new MockTarget();

        // `other` is allowlisted as a destination, but no selector was enabled
        // on it — a blanket address allowlist would have let this through.
        vm.prank(address(safe));
        module.setTargetAllowed(address(other), true);

        vm.expectRevert(
            abi.encodeWithSelector(
                OctAutomationModule.SelectorNotAllowed.selector, address(other), MockTarget.poke.selector
            )
        );
        vm.prank(operator);
        module.execute(address(other), 0, pokeData(1));
    }

    function test_BatchSelectorSeedingWorks() public {
        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = MockTarget.forbidden.selector;
        selectors[1] = MockTarget.boom.selector;

        vm.prank(address(safe));
        module.setSelectorsAllowed(address(target), selectors, true);

        assertTrue(module.isAllowedSelector(address(target), MockTarget.forbidden.selector));
        assertTrue(module.isAllowedSelector(address(target), MockTarget.boom.selector));

        vm.prank(operator);
        module.execute(address(target), 0, abi.encodeWithSelector(MockTarget.forbidden.selector, uint256(7)));
        assertEq(target.forbiddenCount(), 1);
    }

    function test_RevertWhen_BatchSelectorListEmpty() public {
        bytes4[] memory selectors = new bytes4[](0);
        vm.expectRevert(OctAutomationModule.EmptySelectorList.selector);
        vm.prank(address(safe));
        module.setSelectorsAllowed(address(target), selectors, true);
    }

    function test_RevertWhen_CalldataTooShort() public {
        vm.expectRevert(abi.encodeWithSelector(OctAutomationModule.CalldataTooShort.selector, uint256(0)));
        vm.prank(operator);
        module.execute(address(target), 0, "");

        vm.expectRevert(abi.encodeWithSelector(OctAutomationModule.CalldataTooShort.selector, uint256(3)));
        vm.prank(operator);
        module.execute(address(target), 0, hex"010203");
    }

    /*//////////////////////////////////////////////////////////////
                          PER-TRANSACTION CAP
    //////////////////////////////////////////////////////////////*/

    function test_PerTxCap_JustUnderAndExactlyAtCapSucceed() public {
        exec(MAX_PER_TX - 1);
        assertEq(module.spentInCurrentWindow(), MAX_PER_TX - 1);

        exec(MAX_PER_TX);
        assertEq(module.spentInCurrentWindow(), 2 * MAX_PER_TX - 1);
        assertEq(target.pokeCount(), 2);
    }

    function test_RevertWhen_PerTxCapExceededByOneWei() public {
        vm.expectRevert(
            abi.encodeWithSelector(OctAutomationModule.ValueCapExceeded.selector, MAX_PER_TX + 1, MAX_PER_TX)
        );
        vm.prank(operator);
        module.execute(address(target), MAX_PER_TX + 1, pokeData(1));

        assertEq(target.pokeCount(), 0);
        assertEq(module.spentInCurrentWindow(), 0);
    }

    /*//////////////////////////////////////////////////////////////
                              DAILY CAP
    //////////////////////////////////////////////////////////////*/

    function test_DailyCapAccumulatesAcrossTransactions() public {
        for (uint256 i; i < 5; ++i) {
            exec(1 ether);
            assertEq(module.spentInCurrentWindow(), (i + 1) * 1 ether);
        }

        assertEq(module.remainingDailyAllowance(), 0);

        vm.expectRevert(
            abi.encodeWithSelector(
                OctAutomationModule.DailyValueCapExceeded.selector, uint256(1), DAILY_CAP, DAILY_CAP
            )
        );
        vm.prank(operator);
        module.execute(address(target), 1, pokeData(1));

        assertEq(target.pokeCount(), 5);
        assertEq(address(target).balance, 5 ether);
    }

    function test_RevertWhen_SingleValueExceedsDailyCap() public {
        vm.startPrank(address(safe));
        module.setMaxValuePerTx(100 ether); // per-tx cap must not be what stops us
        vm.stopPrank();

        vm.expectRevert(
            abi.encodeWithSelector(
                OctAutomationModule.DailyValueCapExceeded.selector, DAILY_CAP + 1, uint256(0), DAILY_CAP
            )
        );
        vm.prank(operator);
        module.execute(address(target), DAILY_CAP + 1, pokeData(1));
    }

    function test_DailyCapResetsAtUtcDayBoundary() public {
        for (uint256 i; i < 5; ++i) {
            exec(1 ether);
        }

        uint256 boundary = (block.timestamp / 1 days + 1) * 1 days;

        // One second before midnight UTC: still blocked.
        vm.warp(boundary - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                OctAutomationModule.DailyValueCapExceeded.selector, uint256(1), DAILY_CAP, DAILY_CAP
            )
        );
        vm.prank(operator);
        module.execute(address(target), 1, pokeData(1));

        // Exactly at midnight UTC: the bucket rolls.
        vm.warp(boundary);
        assertEq(module.spentInCurrentWindow(), 0);
        assertEq(module.remainingDailyAllowance(), DAILY_CAP);

        exec(1 ether);
        assertEq(module.spentInCurrentWindow(), 1 ether);
    }

    /// @notice Documents the deliberate weakness of the fixed-UTC-day bucket:
    ///         2x the daily cap can leave the Safe within two seconds if the
    ///         burst straddles midnight UTC. This is the accepted tradeoff for
    ///         not paying sliding-window gas on every transaction.
    function test_FixedUtcBucket_AllowsTwoFullCapsAcrossMidnightBoundary() public {
        uint256 boundary = (block.timestamp / 1 days + 1) * 1 days;

        vm.warp(boundary - 1);
        for (uint256 i; i < 5; ++i) {
            exec(1 ether);
        }
        assertEq(address(target).balance, 5 ether);

        vm.warp(boundary);
        for (uint256 i; i < 5; ++i) {
            exec(1 ether);
        }

        assertEq(address(target).balance, 10 ether, "2x cap in ~1 second is the documented tradeoff");
    }

    function test_LoweringDailyCapBelowSpentBlocksValueButNotZeroValueCalls() public {
        // Three separate 1-ether calls: the per-tx cap is 1 ether, so this is
        // the only way to reach 3 ether of spend.
        exec(1 ether);
        exec(1 ether);
        exec(1 ether);
        assertEq(module.spentInCurrentWindow(), 3 ether);

        vm.prank(address(safe));
        module.setDailyValueCap(1 ether);

        assertEq(module.remainingDailyAllowance(), 0);

        vm.expectRevert(
            abi.encodeWithSelector(
                OctAutomationModule.DailyValueCapExceeded.selector, uint256(1), uint256(3 ether), uint256(1 ether)
            )
        );
        vm.prank(operator);
        module.execute(address(target), 1, pokeData(1));

        // Zero-value calls (the common case for ERC-20 LP operations) still work.
        exec(0);
        assertEq(target.pokeCount(), 4);
    }

    /*//////////////////////////////////////////////////////////////
                        OPERATION MUST BE CALL
    //////////////////////////////////////////////////////////////*/

    function test_ModuleAlwaysForwardsOperationCall() public {
        assertEq(safe.lastOperation(), type(uint8).max, "sentinel: safe not yet called");

        exec(0.1 ether);

        assertEq(safe.callCount(), 1);
        assertEq(safe.lastOperation(), uint8(Enum.Operation.Call));
        assertTrue(uint8(Enum.Operation.DelegateCall) != safe.lastOperation());
    }

    /*//////////////////////////////////////////////////////////////
                                 PAUSE
    //////////////////////////////////////////////////////////////*/

    function test_PauseBlocksExecutionAndUnpauseRestoresIt() public {
        vm.prank(address(safe));
        module.setPaused(true);
        assertTrue(module.paused());

        vm.expectRevert(OctAutomationModule.ModulePaused.selector);
        vm.prank(operator);
        module.execute(address(target), 0, pokeData(1));

        vm.prank(address(safe));
        module.setPaused(false);

        exec(0);
        assertEq(target.pokeCount(), 1);
    }

    /*//////////////////////////////////////////////////////////////
                          CALLER AUTHORIZATION
    //////////////////////////////////////////////////////////////*/

    function test_RevertWhen_NonOperatorCallsExecute() public {
        vm.expectRevert(abi.encodeWithSelector(OctAutomationModule.NotOperator.selector, stranger));
        vm.prank(stranger);
        module.execute(address(target), 0, pokeData(1));

        // Even the Safe itself is not an operator unless explicitly authorized.
        vm.expectRevert(abi.encodeWithSelector(OctAutomationModule.NotOperator.selector, address(safe)));
        vm.prank(address(safe));
        module.execute(address(target), 0, pokeData(1));
    }

    function test_RevokedOperatorCannotExecute() public {
        exec(0);

        vm.prank(address(safe));
        module.setOperator(operator, false);

        vm.expectRevert(abi.encodeWithSelector(OctAutomationModule.NotOperator.selector, operator));
        vm.prank(operator);
        module.execute(address(target), 0, pokeData(1));
    }

    function test_RevertWhen_NonSafeCallsAnyAdminFunction() public {
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = MockTarget.poke.selector;

        bytes memory err = abi.encodeWithSelector(OctAutomationModule.OnlySafe.selector, address(this));

        vm.expectRevert(err);
        module.setOperator(stranger, true);

        vm.expectRevert(err);
        module.setTargetAllowed(address(target), false);

        vm.expectRevert(err);
        module.setSelectorAllowed(address(target), MockTarget.poke.selector, false);

        vm.expectRevert(err);
        module.setSelectorsAllowed(address(target), selectors, false);

        vm.expectRevert(err);
        module.setMaxValuePerTx(1000 ether);

        vm.expectRevert(err);
        module.setDailyValueCap(1000 ether);

        vm.expectRevert(err);
        module.setPaused(true);
    }

    function test_RevertWhen_OperatorTriesToAdministerModule() public {
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = MockTarget.forbidden.selector;

        bytes memory err = abi.encodeWithSelector(OctAutomationModule.OnlySafe.selector, operator);

        vm.expectRevert(err);
        vm.prank(operator);
        module.setOperator(operator, true);

        vm.expectRevert(err);
        vm.prank(operator);
        module.setTargetAllowed(stranger, true);

        vm.expectRevert(err);
        vm.prank(operator);
        module.setSelectorsAllowed(address(target), selectors, true);

        vm.expectRevert(err);
        vm.prank(operator);
        module.setMaxValuePerTx(type(uint256).max);

        vm.expectRevert(err);
        vm.prank(operator);
        module.setDailyValueCap(type(uint192).max);

        vm.expectRevert(err);
        vm.prank(operator);
        module.setPaused(false);
    }

    /*//////////////////////////////////////////////////////////////
                        SELF-ADMINISTRATION GUARD
    //////////////////////////////////////////////////////////////*/

    function test_RevertWhen_ExecuteTargetsTheSafe() public {
        vm.expectRevert(abi.encodeWithSelector(OctAutomationModule.ForbiddenTarget.selector, address(safe)));
        vm.prank(operator);
        module.execute(address(safe), 0, pokeData(1));
    }

    function test_RevertWhen_ExecuteTargetsTheModule() public {
        vm.expectRevert(abi.encodeWithSelector(OctAutomationModule.ForbiddenTarget.selector, address(module)));
        vm.prank(operator);
        module.execute(address(module), 0, pokeData(1));
    }

    function test_RevertWhen_ExecuteTargetsZeroAddress() public {
        vm.expectRevert(abi.encodeWithSelector(OctAutomationModule.ForbiddenTarget.selector, address(0)));
        vm.prank(operator);
        module.execute(address(0), 0, pokeData(1));
    }

    function test_RevertWhen_OwnerTriesToAllowlistSafeOrModule() public {
        vm.startPrank(address(safe));

        vm.expectRevert(abi.encodeWithSelector(OctAutomationModule.ForbiddenTarget.selector, address(safe)));
        module.setTargetAllowed(address(safe), true);

        vm.expectRevert(abi.encodeWithSelector(OctAutomationModule.ForbiddenTarget.selector, address(module)));
        module.setTargetAllowed(address(module), true);

        vm.expectRevert(abi.encodeWithSelector(OctAutomationModule.ForbiddenTarget.selector, address(0)));
        module.setTargetAllowed(address(0), true);

        vm.expectRevert(abi.encodeWithSelector(OctAutomationModule.ForbiddenTarget.selector, address(safe)));
        module.setSelectorAllowed(address(safe), MockTarget.poke.selector, true);

        vm.stopPrank();
    }

    function test_RevertWhen_OwnerTriesToMakeSafeOrModuleAnOperator() public {
        vm.startPrank(address(safe));

        vm.expectRevert(abi.encodeWithSelector(OctAutomationModule.InvalidOperator.selector, address(safe)));
        module.setOperator(address(safe), true);

        vm.expectRevert(abi.encodeWithSelector(OctAutomationModule.InvalidOperator.selector, address(module)));
        module.setOperator(address(module), true);

        vm.expectRevert(abi.encodeWithSelector(OctAutomationModule.InvalidOperator.selector, address(0)));
        module.setOperator(address(0), true);

        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                          FAILURE PROPAGATION
    //////////////////////////////////////////////////////////////*/

    function test_FailedDestinationCallRevertsAndConsumesNoAllowance() public {
        vm.prank(address(safe));
        module.setSelectorAllowed(address(target), MockTarget.boom.selector, true);

        exec(1 ether);
        assertEq(module.spentInCurrentWindow(), 1 ether);

        vm.expectRevert(
            abi.encodeWithSelector(
                OctAutomationModule.ExecutionFailed.selector, abi.encodeWithSignature("Error(string)", "boom")
            )
        );
        vm.prank(operator);
        module.execute(address(target), 1 ether, abi.encodeWithSelector(MockTarget.boom.selector));

        // Spend accounting rolled back with the rest of the transaction.
        assertEq(module.spentInCurrentWindow(), 1 ether);
    }

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    function test_EmitsExecutedEvent() public {
        // First call establishes the spend window (and emits SpendWindowRolled),
        // so the second call's first log is the one under test.
        exec(1 ether);

        bytes memory data = pokeData(9);

        vm.expectEmit(true, true, true, true, address(module));
        emit Executed(
            operator, address(target), MockTarget.poke.selector, 1 ether, keccak256(data), uint192(2 ether)
        );

        vm.prank(operator);
        module.execute(address(target), 1 ether, data);
    }

    function test_EmitsSpendWindowRolledEvent() public {
        uint64 today = module.currentDayIndex();

        vm.expectEmit(true, true, true, true, address(module));
        emit SpendWindowRolled(0, today, 0);

        exec(1 ether);
    }

    function test_EmitsAdminEvents() public {
        vm.startPrank(address(safe));

        vm.expectEmit(true, true, true, true, address(module));
        emit OperatorSet(stranger, true);
        module.setOperator(stranger, true);

        vm.expectEmit(true, true, true, true, address(module));
        emit TargetAllowedSet(stranger, true);
        module.setTargetAllowed(stranger, true);

        vm.expectEmit(true, true, true, true, address(module));
        emit SelectorAllowedSet(stranger, MockTarget.poke.selector, true);
        module.setSelectorAllowed(stranger, MockTarget.poke.selector, true);

        vm.expectEmit(true, true, true, true, address(module));
        emit MaxValuePerTxSet(MAX_PER_TX, 3 ether);
        module.setMaxValuePerTx(3 ether);

        vm.expectEmit(true, true, true, true, address(module));
        emit DailyValueCapSet(DAILY_CAP, 9 ether);
        module.setDailyValueCap(9 ether);

        vm.expectEmit(true, true, true, true, address(module));
        emit PausedSet(true);
        module.setPaused(true);

        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                                 FUZZ
    //////////////////////////////////////////////////////////////*/

    /// @notice Cap arithmetic across two sequential spends in one UTC day.
    function testFuzz_DailyCapArithmetic(uint96 capRaw, uint96 firstRaw, uint96 secondRaw) public {
        uint256 cap = uint256(capRaw);
        uint256 first = uint256(firstRaw);
        uint256 second = uint256(secondRaw);

        vm.startPrank(address(safe));
        module.setDailyValueCap(cap);
        module.setMaxValuePerTx(type(uint256).max);
        vm.stopPrank();

        vm.deal(address(safe), uint256(type(uint96).max) * 2 + 1 ether);

        uint256 expectedSpent = 0;

        if (first > cap) {
            vm.expectRevert(
                abi.encodeWithSelector(OctAutomationModule.DailyValueCapExceeded.selector, first, uint256(0), cap)
            );
            vm.prank(operator);
            module.execute(address(target), first, pokeData(1));
        } else {
            vm.prank(operator);
            module.execute(address(target), first, pokeData(1));
            expectedSpent = first;
        }

        assertEq(module.spentInCurrentWindow(), expectedSpent);

        if (expectedSpent + second > cap) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    OctAutomationModule.DailyValueCapExceeded.selector, second, expectedSpent, cap
                )
            );
            vm.prank(operator);
            module.execute(address(target), second, pokeData(1));
        } else {
            vm.prank(operator);
            module.execute(address(target), second, pokeData(1));
            expectedSpent += second;
        }

        assertEq(module.spentInCurrentWindow(), expectedSpent);
        assertEq(module.remainingDailyAllowance(), cap - expectedSpent);
        assertEq(address(target).balance, expectedSpent);
        assertLe(module.spentInCurrentWindow(), cap);
    }

    /// @notice The per-transaction cap is inclusive: `value == cap` is allowed,
    ///         `value == cap + 1` is not.
    function testFuzz_PerTxCapBoundary(uint96 capRaw, uint96 valueRaw) public {
        uint256 cap = uint256(capRaw);
        uint256 value = uint256(valueRaw);

        vm.startPrank(address(safe));
        module.setMaxValuePerTx(cap);
        module.setDailyValueCap(module.MAX_DAILY_VALUE_CAP());
        vm.stopPrank();

        vm.deal(address(safe), uint256(type(uint96).max) + 1 ether);

        if (value > cap) {
            vm.expectRevert(
                abi.encodeWithSelector(OctAutomationModule.ValueCapExceeded.selector, value, cap)
            );
            vm.prank(operator);
            module.execute(address(target), value, pokeData(1));
            assertEq(address(target).balance, 0);
        } else {
            vm.prank(operator);
            module.execute(address(target), value, pokeData(1));
            assertEq(address(target).balance, value);
        }
    }

    /// @notice The accumulator resets exactly when the UTC-day index changes,
    ///         and never before.
    function testFuzz_SpendWindowResetsOnlyOnDayIndexChange(uint32 secondsAhead) public {
        exec(1 ether);
        assertEq(module.spentInCurrentWindow(), 1 ether);

        uint64 dayBefore = module.currentDayIndex();
        vm.warp(block.timestamp + uint256(secondsAhead));
        uint64 dayAfter = module.currentDayIndex();

        if (dayAfter == dayBefore) {
            assertEq(module.spentInCurrentWindow(), 1 ether);
            assertEq(module.remainingDailyAllowance(), DAILY_CAP - 1 ether);
        } else {
            assertEq(module.spentInCurrentWindow(), 0);
            assertEq(module.remainingDailyAllowance(), DAILY_CAP);
        }
    }

    /// @notice No fuzzed caller other than an authorized operator can execute.
    function testFuzz_OnlyOperatorCanExecute(address caller) public {
        vm.assume(caller != operator);
        vm.assume(caller != address(vm));

        vm.expectRevert(abi.encodeWithSelector(OctAutomationModule.NotOperator.selector, caller));
        vm.prank(caller);
        module.execute(address(target), 0, pokeData(1));
    }

    /// @notice No fuzzed caller other than the Safe can administer the module.
    function testFuzz_OnlySafeCanAdminister(address caller) public {
        vm.assume(caller != address(safe));
        vm.assume(caller != address(vm));

        vm.expectRevert(abi.encodeWithSelector(OctAutomationModule.OnlySafe.selector, caller));
        vm.prank(caller);
        module.setTargetAllowed(stranger, true);
    }
}
