// ABI for `OctAutomationModule` (contracts/src/OctAutomationModule.sol).
//
// Hand-derived from the Solidity source in this repo, NOT from a build artifact
// and NOT from memory: every signature below was read off the contract. Two
// details are easy to get wrong and both matter:
//
//   * `execute(address,uint256,bytes)` is NOT payable. The native `value` is
//     drawn from the SAFE's balance by `execTransactionFromModuleReturnData`,
//     never from the operator's. The operator transaction therefore carries
//     `value: 0` and `value` travels only as an ABI argument. Sending real value
//     with the call would revert (no `receive`/`fallback` on the module) and, if
//     it somehow didn't, would spend the hot key's own funds.
//
//   * `isAllowedTarget` / `isAllowedSelector` / `isOperator` are public mappings,
//     so their getters take the mapping keys as unnamed arguments. The selector
//     key is `bytes4`, not `bytes` — encoding it as anything else silently reads
//     a different storage slot and would return `false` for a genuinely
//     allowlisted selector.
//
// The custom errors are included so viem can decode a simulation revert into
// something diagnosable ("SelectorNotAllowed") instead of a raw 0x-blob. A
// rejection that cannot be explained is barely better than no rejection.

import { parseAbi } from 'viem';

export const OCT_AUTOMATION_MODULE_ABI = parseAbi([
  // --- operator path -------------------------------------------------------
  'function execute(address to, uint256 value, bytes data) returns (bytes returnData)',

  // --- views used by the preflight ladder ----------------------------------
  'function safe() view returns (address)',
  'function paused() view returns (bool)',
  'function maxValuePerTx() view returns (uint256)',
  'function dailyValueCap() view returns (uint256)',
  'function spentInCurrentWindow() view returns (uint256)',
  'function remainingDailyAllowance() view returns (uint256)',
  'function isModuleEnabledOnSafe() view returns (bool)',
  'function currentDayIndex() view returns (uint64)',
  'function isOperator(address) view returns (bool)',
  'function isAllowedTarget(address) view returns (bool)',
  'function isAllowedSelector(address, bytes4) view returns (bool)',

  // --- custom errors, for decodable revert reasons -------------------------
  'error OnlySafe(address caller)',
  'error NotOperator(address caller)',
  'error ModulePaused()',
  'error ForbiddenTarget(address target)',
  'error TargetNotAllowed(address target)',
  'error SelectorNotAllowed(address target, bytes4 selector)',
  'error CalldataTooShort(uint256 length)',
  'error ValueCapExceeded(uint256 value, uint256 cap)',
  'error DailyValueCapExceeded(uint256 value, uint256 spentInWindow, uint256 cap)',
  'error ExecutionFailed(bytes returnData)',
]);

export type OctAutomationModuleAbi = typeof OCT_AUTOMATION_MODULE_ABI;
