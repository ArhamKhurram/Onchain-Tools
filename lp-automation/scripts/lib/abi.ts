// Hand-written ABI fragments for the two contracts these scripts talk to.
//
// Written out by hand, `as const`, rather than read from a Foundry artifact, on
// purpose: `preflight.ts` and `verifySetup.ts` must work on a machine that has
// never run `forge build` — including someone else's machine auditing a setup
// they did not deploy. Only `deployModule.ts` needs the artifact, and only for
// its bytecode.
//
// These fragments must stay in sync with
// `lp-automation/contracts/src/OctAutomationModule.sol`. A mismatch here is
// fail-loud rather than fail-silent: viem's ABI encoding would produce a
// selector the contract does not implement, and the call reverts.

/** Every function and event `preflight` / `verifySetup` / the payload builders need. */
export const MODULE_ABI = [
  // --- constructor ---------------------------------------------------------
  {
    type: 'constructor',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'safe_', type: 'address' },
      { name: 'maxValuePerTx_', type: 'uint256' },
      { name: 'dailyValueCap_', type: 'uint256' },
    ],
  },

  // --- views ---------------------------------------------------------------
  { type: 'function', name: 'safe', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'maxValuePerTx', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'dailyValueCap', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'SPEND_WINDOW', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'MAX_DAILY_VALUE_CAP',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'spendWindow',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'dayIndex', type: 'uint64' },
      { name: 'spent', type: 'uint192' },
    ],
  },
  { type: 'function', name: 'currentDayIndex', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  {
    type: 'function',
    name: 'spentInCurrentWindow',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'remainingDailyAllowance',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'isModuleEnabledOnSafe',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'isOperator',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'isAllowedTarget',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'isAllowedSelector',
    stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'bytes4' }],
    outputs: [{ type: 'bool' }],
  },

  // --- admin (owner-signed only; encoded here, never sent from here) -------
  {
    type: 'function',
    name: 'setOperator',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'operator', type: 'address' },
      { name: 'allowed', type: 'bool' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setTargetAllowed',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'allowed', type: 'bool' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setSelectorAllowed',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'selector', type: 'bytes4' },
      { name: 'allowed', type: 'bool' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setSelectorsAllowed',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'selectors', type: 'bytes4[]' },
      { name: 'allowed', type: 'bool' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setMaxValuePerTx',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newCap', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setDailyValueCap',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newCap', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setPaused',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newPaused', type: 'bool' }],
    outputs: [],
  },

  // --- events (the ONLY way to enumerate the allowlist mappings) -----------
  //
  // Solidity mappings are not enumerable. `verifySetup` can ask "is X allowed?"
  // but cannot ask "what is allowed?" without replaying these events. That is
  // why they exist and why every setter emits one unconditionally.
  {
    type: 'event',
    name: 'OperatorSet',
    inputs: [
      { name: 'operator', type: 'address', indexed: true },
      { name: 'allowed', type: 'bool', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'TargetAllowedSet',
    inputs: [
      { name: 'target', type: 'address', indexed: true },
      { name: 'allowed', type: 'bool', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'SelectorAllowedSet',
    inputs: [
      { name: 'target', type: 'address', indexed: true },
      { name: 'selector', type: 'bytes4', indexed: true },
      { name: 'allowed', type: 'bool', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'PausedSet',
    inputs: [{ name: 'isPaused', type: 'bool', indexed: false }],
  },
] as const;

/** Minimal Safe surface. Matches Safe v1.3.0 / v1.4.1. */
export const SAFE_ABI = [
  { type: 'function', name: 'getOwners', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'getThreshold', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'nonce', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'VERSION', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  {
    type: 'function',
    name: 'isModuleEnabled',
    stateMutability: 'view',
    inputs: [{ name: 'module', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'getModulesPaginated',
    stateMutability: 'view',
    inputs: [
      { name: 'start', type: 'address' },
      { name: 'pageSize', type: 'uint256' },
    ],
    outputs: [
      { name: 'array', type: 'address[]' },
      { name: 'next', type: 'address' },
    ],
  },
  {
    type: 'function',
    name: 'enableModule',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'module', type: 'address' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'disableModule',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'prevModule', type: 'address' },
      { name: 'module', type: 'address' },
    ],
    outputs: [],
  },
] as const;
